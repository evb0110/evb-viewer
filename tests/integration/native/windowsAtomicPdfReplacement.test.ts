import {execFile} from 'node:child_process';
import {
    access,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {
    PDFDocument,
    StandardFonts,
} from 'pdf-lib';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {atomicReplace} from '@electron/utils/atomicReplace';

const holdFileHandleScript = resolve('scripts/windows-test/guest/powershell/hold-file-handle.ps1');
const publicationHarness = resolve('tests/integration/native/windowsAtomicPdfPublicationHarness.js');

async function makePdf(text: string) {
    const document = await PDFDocument.create();
    const page = document.addPage([
        612,
        792,
    ]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText(text, {
        font,
        size: 20,
        x: 72,
        y: 720,
    });
    return document.save();
}

async function readPdfText(path: string) {
    const document = await PDFDocument.load(await readFile(path));
    return document.getPageCount();
}

async function waitForFile(path: string, attempts = 80) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            await access(path);
            return;
        } catch {
            await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        }
    }
    throw new Error(`Timed out waiting for ${path}`);
}

async function runPublicationHarness(
    operation: string,
    sourcePath: string,
    destinationPath: string,
    resultPath: string,
    controlPath: string,
    options: {
        barrier?: boolean;
        utility?: boolean;
    } = {},
) {
    const electronPath = resolve('node_modules/electron/dist/electron.exe');
    const child = execFile(electronPath, [
        '--no-sandbox',
        publicationHarness,
        operation,
        sourcePath,
        destinationPath,
        resultPath,
        controlPath,
    ], {
        cwd: resolve('.'),
        env: {
            ...process.env,
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_ATOMIC_REPLACE_TEST_BARRIER: options.barrier === true ? 'before-publish' : '',
            EVB_ATOMIC_REPLACE_TEST_BARRIER_FILE: controlPath,
            EVB_DOCUMENT_SAVE_UTILITY_THRESHOLD_BYTES: options.utility === true ? '1' : '999999999',
        },
    });
    return child;
}

describe.skipIf(process.platform !== 'win32')('Windows atomic PDF replacement', () => {
    const rootPaths: string[] = [];

    afterEach(async () => {
        await Promise.all(rootPaths.splice(0).map(path => rm(path, {
            force: true,
            recursive: true,
        })));
    });

    it('keeps the original pathname on complete old or new PDF bytes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-windows-atomic-pdf-'));
        rootPaths.push(root);
        const sourcePath = join(root, 'staged.pdf');
        const destinationPath = join(root, 'document.pdf');
        const oldBytes = await makePdf('old Windows fixture');
        const newBytes = await makePdf('new Windows fixture');
        await writeFile(destinationPath, oldBytes);
        await writeFile(sourcePath, newBytes);

        await atomicReplace(sourcePath, destinationPath);

        await expect(readFile(destinationPath)).resolves.toEqual(Buffer.from(newBytes));
        await expect(readPdfText(destinationPath)).resolves.toBe(1);
    });

    it('rejects a symlink destination without changing its referent', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-windows-atomic-symlink-'));
        rootPaths.push(root);
        const sourcePath = join(root, 'staged.pdf');
        const referentPath = join(root, 'referent.pdf');
        const destinationPath = join(root, 'document.pdf');
        await writeFile(sourcePath, await makePdf('new Windows fixture'));
        await writeFile(referentPath, await makePdf('referent Windows fixture'));
        await symlink(referentPath, destinationPath);

        await expect(atomicReplace(sourcePath, destinationPath)).rejects.toThrow(/symlink path segment/u);
        await expect(readPdfText(referentPath)).resolves.toBe(1);
    });

    it('fails closed while a third-party reader denies delete sharing', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-windows-atomic-sharing-'));
        rootPaths.push(root);
        const sourcePath = join(root, 'staged.pdf');
        const destinationPath = join(root, 'document.pdf');
        const readyPath = join(root, 'reader.ready');
        const oldBytes = await makePdf('old Windows fixture');
        await writeFile(destinationPath, oldBytes);
        await writeFile(sourcePath, await makePdf('new Windows fixture'));
        const reader = execFile('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            holdFileHandleScript,
            '-Path',
            destinationPath,
            '-DurationSeconds',
            '30',
            '-ReadyFile',
            readyPath,
        ]);
        try {
            await waitForFile(readyPath);
            await expect(atomicReplace(sourcePath, destinationPath)).rejects.toBeDefined();
        } finally {
            await writeFile(`${readyPath}.release`, 'release');
            await new Promise<void>(resolvePromise => {
                reader.once('close', () => resolvePromise());
            });
        }
        await expect(readFile(destinationPath)).resolves.toEqual(Buffer.from(oldBytes));
    }, 60_000);

    it('keeps complete bytes when the production commit process dies before publication', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-windows-atomic-process-kill-'));
        rootPaths.push(root);
        const sourcePath = join(root, 'staged.pdf');
        const destinationPath = join(root, 'document.pdf');
        const resultPath = join(root, 'first.result.json');
        const restartResultPath = join(root, 'restart.result.json');
        const controlPath = join(root, 'commit.control');
        const oldBytes = await makePdf('old Windows process boundary');
        const newBytes = await makePdf('new Windows process boundary');
        await writeFile(destinationPath, oldBytes);
        await writeFile(sourcePath, newBytes);

        const first = await runPublicationHarness('commit', sourcePath, destinationPath, resultPath, controlPath, {barrier: true});
        try {
            await waitForFile(`${controlPath}.before-publish`, 1_200);
            first.kill();
            await new Promise<void>(resolvePromise => first.once('close', () => resolvePromise()));
        } finally {
            first.kill();
        }

        const restart = await runPublicationHarness('commit', sourcePath, destinationPath, restartResultPath, controlPath);
        await new Promise<void>((resolvePromise, reject) => {
            restart.once('error', reject);
            restart.once('close', code => code === 0 ? resolvePromise() : reject(new Error(`restart exited ${String(code)}`)));
        });
        await expect(readFile(restartResultPath)).resolves.toContain('"ok":true');
        await expect(readFile(destinationPath)).resolves.toEqual(Buffer.from(newBytes));
        await expect(readPdfText(destinationPath)).resolves.toBe(1);
    }, 90_000);

    it('cancels the real utility publisher through its parent terminator before publication', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-windows-atomic-utility-cancel-'));
        rootPaths.push(root);
        const sourcePath = join(root, 'staged.pdf');
        const destinationPath = join(root, 'document.pdf');
        const resultPath = join(root, 'cancel.result.json');
        const controlPath = join(root, 'utility.control');
        const oldBytes = await makePdf('old Windows utility cancellation');
        await writeFile(destinationPath, oldBytes);
        await writeFile(sourcePath, await makePdf('new Windows utility cancellation'));

        const utility = await runPublicationHarness('cancel-utility', sourcePath, destinationPath, resultPath, controlPath, {
            barrier: true,
            utility: true,
        });
        try {
            await waitForFile(`${controlPath}.before-publish`, 1_200);
            await writeFile(`${controlPath}.cancel`, 'cancel');
            await new Promise<void>((resolvePromise, reject) => {
                utility.once('error', reject);
                utility.once('close', code => code === 0 ? resolvePromise() : reject(new Error(`utility harness exited ${String(code)}`)));
            });
        } finally {
            utility.kill();
        }
        await expect(readFile(resultPath).then(bytes => JSON.parse(bytes.toString()))).resolves.toMatchObject({ok: false});
        await expect(readFile(destinationPath)).resolves.toEqual(Buffer.from(oldBytes));
        await expect(readPdfText(destinationPath)).resolves.toBe(1);
    }, 90_000);
});
