const {readFile, writeFile} = require('node:fs/promises');
const {pathToFileURL} = require('node:url');
const {join, dirname} = require('node:path');
const cp = require('node:child_process');
const moduleApi = require('node:module');
const esbuild = require('esbuild');
const {app} = require('electron');

const [operation, sourcePath, destinationPath, resultPath, controlPath] = process.argv.slice(2);
const profile = join(dirname(resultPath), 'electron-user-data');
require('node:fs').mkdirSync(profile, {recursive: true});
app.setPath('userData', profile);
process.env.EVB_APP_STATE_DIR = join(dirname(resultPath), 'app-state');
require('node:fs').writeFileSync(`${resultPath}.launch`, `${process.pid}\n`, 'utf8');

async function waitForPath(path) {
    while (true) {
        try {
            await readFile(path);
            return;
        } catch {
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }
}

async function main() {
    await app.whenReady();
    await writeFile(`${resultPath}.ready`, `${process.pid}\n`);
    const runtimeDirectory = dirname(resultPath);
    const bundleOptions = {
        absWorkingDir: process.cwd(),
        alias: Object.fromEntries([
            ['@contracts', 'packages/contracts'],
            ['@document-store', 'packages/document-store'],
            ['@electron', 'electron'],
            ['@electron-worker-bundles', 'packages/electron-worker-bundles'],
            ['@pdf-core', 'packages/pdf-core'],
        ].map(([name, path]) => [name, join(process.cwd(), path)])),
        bundle: true,
        external: ['electron'],
        platform: 'node',
        format: 'esm',
    };
    const bundlePath = join(runtimeDirectory, 'publication.mjs');
    await esbuild.build({
        ...bundleOptions,
        stdin: {
            contents: [
                "export {createDocument, openDocument} from '@document-store/documentDirectory';",
                "export {createNodeStorePort} from '@document-store/nodeStorePort';",
                "export {saveDocument} from '@document-store/saveDocument';",
                "export {createDesktopPublication} from '@electron/file-access/documentPublication';",
                "export {verifyPdfTempFile} from '@electron/features/documents/main/verifyPdfTempFile';",
            ].join('\n'),
            resolveDir: process.cwd(),
        },
        outfile: bundlePath,
    });
    const {createDocument, openDocument, createNodeStorePort, saveDocument, createDesktopPublication, verifyPdfTempFile} = await import(pathToFileURL(bundlePath).href);
    await writeFile(`${resultPath}.imported`, `${process.pid}\n`);
    const root = join(runtimeDirectory, 'store');
    const publication = createDesktopPublication(path => join(root, ...path.split('/')));
    const store = {port: createNodeStorePort(root), publication};
    let document;
    try {
        document = await openDocument(store, 'interrupted-save');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (!document) {
        document = await createDocument(store, {ext: 'pdf', id: 'interrupted-save', destination: destinationPath});
        const changed = await document.mutate(null, {kind: 'rewrite', source: sourcePath, drafts: 'clear'});
        if (changed.status !== 'committed') throw new Error(`Mutation failed: ${changed.status}`);
    }
    // Validation runs directly in main and spawns qpdf as a native child.
    // Hold that validation child at the publication stage barrier, after the
    // sibling copy exists, so both native cancellation and publication cleanup
    // are exercised.
    let utilityExited = false;
    async function cancelValidationAtPublicationBarrier() {
        const heldScript = join(runtimeDirectory, 'held-validation-child.cjs');
        await writeFile(heldScript, `const fs = require('node:fs');
fs.watch(${JSON.stringify(runtimeDirectory)}, () => {});
fs.writeFileSync(${JSON.stringify(`${controlPath}.utility-ready`)}, String(process.pid));
`);
        const originalSpawn = cp.spawn;
        let trackedChildExit = null;
        cp.spawn = function(command, args, options) {
            if (Array.isArray(args) && args.includes('--check')) {
                const separatorIndex = args.indexOf('--');
                const spawnCommand = separatorIndex >= 0 ? command : process.execPath;
                const spawnArgs = separatorIndex >= 0
                    ? [
                        ...args.slice(0, separatorIndex + 1),
                        process.execPath,
                        heldScript,
                    ]
                    : [heldScript];
                const child = originalSpawn.call(this, spawnCommand, spawnArgs, {
                    ...options,
                    env: {
                        ...(options && options.env ? options.env : process.env),
                        ELECTRON_RUN_AS_NODE: '1',
                    },
                });
                trackedChildExit = new Promise(resolve => {
                    const markExited = () => {
                        utilityExited = true;
                        resolve();
                    };
                    child.once('exit', markExited);
                    child.once('close', markExited);
                });
                return child;
            }
            return originalSpawn.call(this, command, args, options);
        };
        moduleApi.syncBuiltinESMExports();
        try {
            const controller = new AbortController();
            // A targeted validation selects the validation path for this small fixture.
            const validation = verifyPdfTempFile(sourcePath, {signal: controller.signal, changedObjectRefs: ['1 0 R']});
            const outcome = validation.then(() => null, error => error);
            await waitForPath(`${controlPath}.cancel`);
            controller.abort(new Error('Windows integration utility cancellation'));
            const error = await outcome;
            if (trackedChildExit) {
                await Promise.race([
                    trackedChildExit,
                    new Promise(resolve => setTimeout(resolve, 2_000)),
                ]);
            }
            if (!error) throw new Error('Validation completed despite the dispatch barrier');
            throw error;
        } finally {
            cp.spawn = originalSpawn;
            moduleApi.syncBuiltinESMExports();
        }
    }
    if (process.env.EVB_PUBLICATION_TEST_BARRIER === '1') {
        const publish = publication.publish;
        publication.publish = (destination, source, expected, stage) => publish(destination, source, expected, async witness => {
            // The real adapter has copied the complete sibling temporary file, and
            // Save has durably staged pendingPublish, before this process is killed.
            await stage(witness);
            if (operation === 'cancel-utility') {
                await cancelValidationAtPublicationBarrier();
                return;
            }
            await writeFile(`${controlPath}.before-publish`, 'ready');
            await waitForPath(`${controlPath}.continue`);
        });
    }
    let result;
    try {
        result = await saveDocument(document, {expected: document.snapshot().current.id});
    } catch (error) {
        await document.close();
        await writeFile(resultPath, JSON.stringify({ok: false, utilityExited, error: String(error)}));
        return;
    }
    if (result.status !== 'saved') throw new Error(`Save failed: ${result.status}`);
    await document.close();
    await writeFile(resultPath, JSON.stringify({ok: true}));
}

void main().catch(async error => {
    await writeFile(resultPath, JSON.stringify({ok: false, error: String(error)}));
    process.exitCode = 1;
}).finally(() => { app.exit(process.exitCode || 0); });
