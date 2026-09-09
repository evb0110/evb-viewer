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

async function waitForFile(path: string) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
            await access(path);
            return;
        } catch {
            await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        }
    }
    throw new Error(`Timed out waiting for ${path}`);
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

        await expect(readFile(destinationPath)).resolves.toEqual(newBytes);
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
            await expect(readFile(destinationPath)).resolves.toEqual(oldBytes);
        } finally {
            await writeFile(`${readyPath}.release`, 'release');
            await new Promise<void>(resolvePromise => {
                reader.once('close', () => resolvePromise());
            });
        }
    }, 60_000);
});
