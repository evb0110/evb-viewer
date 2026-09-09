require('tsx/cjs');

const {
    readFile,
    writeFile,
} = require('node:fs/promises');
const {pathToFileURL} = require('node:url');
const {join} = require('node:path');
const {app} = require('electron');

const [
    operation,
    sourcePath,
    destinationPath,
    resultPath,
    controlPath,
] = process.argv.slice(2);

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
    const {commitPdfTempFile} = await import(pathToFileURL(join(
        process.cwd(),
        'electron/features/documents/main/commitPdfTempFile.ts',
    )).href);
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
