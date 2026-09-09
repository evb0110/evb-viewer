const {
    readFile,
    writeFile,
} = require('node:fs/promises');
const {pathToFileURL} = require('node:url');
const {join} = require('node:path');
const esbuild = require('esbuild');
const {app} = require('electron');

const [
    operation,
    sourcePath,
    destinationPath,
    resultPath,
    controlPath,
] = process.argv.slice(2);
require('node:fs').writeFileSync(`${resultPath}.launch`, `${String(process.pid)}\n`, 'utf8');

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
    await writeFile(`${resultPath}.ready`, `${String(process.pid)}\n`, 'utf8');
    const runtimeDirectory = join(resultPath, '..');
    const alias = {
        '@contracts': join(process.cwd(), 'packages/contracts'),
        '@electron': join(process.cwd(), 'electron'),
        '@electron-worker-bundles': join(process.cwd(), 'packages/electron-worker-bundles'),
        '@pdf-core': join(process.cwd(), 'packages/pdf-core'),
    };
    const bundleOptions = {
        absWorkingDir: process.cwd(),
        alias,
        bundle: true,
        external: ['electron'],
        platform: 'node',
    };
    const commitBundlePath = join(runtimeDirectory, 'commitPdfTempFile.mjs');
    await esbuild.build({
        ...bundleOptions,
        entryPoints: ['electron/features/documents/main/commitPdfTempFile.ts'],
        format: 'esm',
        outfile: commitBundlePath,
    });
    await esbuild.build({
        ...bundleOptions,
        entryPoints: ['electron/features/documents/main/documentSaveUtilityProcess.ts'],
        format: 'esm',
        outfile: join(runtimeDirectory, 'document-save-utility.js'),
    });
    const {commitPdfTempFile} = await import(pathToFileURL(commitBundlePath).href);
    await writeFile(`${resultPath}.imported`, `${String(process.pid)}\n`, 'utf8');
    if (operation === 'cancel-utility') {
        const controller = new AbortController();
        const commit = commitPdfTempFile(sourcePath, destinationPath, {
            expectedBytes: (await readFile(sourcePath)).byteLength,
            signal: controller.signal,
        });
        await waitForPath(`${controlPath}.cancel`);
        controller.abort(new Error('Windows integration utility cancellation'));
        await commit.then(
            () => writeFile(resultPath, JSON.stringify({ok: true}), 'utf8'),
            error => writeFile(resultPath, JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            }), 'utf8'),
        );
        return;
    }
    try {
        await commitPdfTempFile(sourcePath, destinationPath, {expectedBytes: (await readFile(sourcePath)).byteLength});
        await writeFile(resultPath, JSON.stringify({ok: true}), 'utf8');
    } catch (error) {
        await writeFile(resultPath, JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        }), 'utf8');
        process.exitCode = 1;
    }
}

void main()
    .catch(async error => {
        await writeFile(resultPath, JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        }), 'utf8');
        process.exitCode = 1;
    })
    .finally(() => {
        void app.quit();
    });
