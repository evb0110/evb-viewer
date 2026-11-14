const {readFile, writeFile} = require('node:fs/promises');
const {pathToFileURL} = require('node:url');
const {join, dirname} = require('node:path');
const esbuild = require('esbuild');
const {app, utilityProcess} = require('electron');

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
    await esbuild.build({
        ...bundleOptions,
        entryPoints: ['electron/features/documents/main/documentSaveUtilityProcess.ts'],
        outfile: join(runtimeDirectory, 'document-save-utility.js'),
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
    // Validation no longer owns publication. Inject a real validator cancellation
    // at the publication stage barrier, after the sibling copy exists, so both
    // the utility terminator and the current publication cleanup are exercised.
    let utilityExited = false;
    async function cancelValidationAtPublicationBarrier() {
        const fork = utilityProcess.fork.bind(utilityProcess);
        utilityProcess.fork = (...args) => {
            const child = fork(...args);
            child.once('exit', () => { utilityExited = true; });
            const postMessage = child.postMessage.bind(child);
            child.postMessage = message => {
                if (message.type === 'validate') {
                    void writeFile(`${controlPath}.utility-ready`, String(child.pid));
                    return;
                }
                return postMessage(message);
            };
            return child;
        };
        const controller = new AbortController();
        // A targeted validation selects the actual utility for this small fixture.
        const validation = verifyPdfTempFile(sourcePath, {signal: controller.signal, changedObjectRefs: ['1 0 R']});
        const outcome = validation.then(() => null, error => error);
        await waitForPath(`${controlPath}.cancel`);
        controller.abort(new Error('Windows integration utility cancellation'));
        const error = await outcome;
        if (!error) throw new Error('Utility completed despite the dispatch barrier');
        throw error;
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
