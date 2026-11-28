import {
    access,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    PDFDocument,
    StandardFonts,
    rgb,
} from 'pdf-lib';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/public/nativePageOpsPath';
import {copyFileAtomic} from '@electron/file-access/documentFileWriteAtomic';
import {runDesktopQpdfWasm} from '@electron/native-tools/qpdfWasmWorkerClient';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';

const NATIVE_INTEGRATION_TIMEOUT_MS = 120_000;

async function runQpdf(args: string[]) {
    return runDesktopQpdfWasm(args, {
        maxStdoutBytes: 256 * 1024,
        maxStderrBytes: 256 * 1024,
        timeoutMs: NATIVE_INTEGRATION_TIMEOUT_MS,
    });
}

async function createTinyPdf(path: string) {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([
        612,
        792,
    ]);
    page.drawText('Native PDF integration fixture', {
        color: rgb(0.12, 0.12, 0.12),
        font,
        size: 20,
        x: 72,
        y: 720,
    });
    await writeFile(path, await document.save());
}

async function expectCommandFailure(command: string, args: string[]) {
    await expect(runNativeToolCommand(command, args, {
        timeoutMs: NATIVE_INTEGRATION_TIMEOUT_MS,
    })).rejects.toMatchObject({code: expect.anything()});
}

describe('native PDF save integration', () => {
    let tempRoot = '';

    afterEach(async () => {
        if (tempRoot) {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
            tempRoot = '';
        }
    });

    it('saves a real tiny PDF with page-ops WASM, validates qpdf, publishes atomically, and reopens after failure', async () => {
        tempRoot = await mkdtemp(join(tmpdir(), 'evb-native-pdf-save-'));
        const inputPath = join(tempRoot, 'input.pdf');
        const mutationsPath = join(tempRoot, 'mutations.json');
        const nativeOutputPath = join(tempRoot, 'native-output.pdf');
        const publishedPath = join(tempRoot, 'published.pdf');
        const malformedMutationsPath = join(tempRoot, 'malformed-mutations.json');
        const failedOutputPath = join(tempRoot, 'failed-output.pdf');
        const nativeBinaryPath = resolveNativePageOpsPath();
        expect(nativeBinaryPath).not.toBeNull();
        await access(nativeBinaryPath!);
        await createTinyPdf(inputPath);
        await writeFile(mutationsPath, `${JSON.stringify({freeTextNotes: [{
            author: 'native-integration',
            color: null,
            createdAt: 1,
            markerRect: {
                height: 0.08,
                left: 0.2,
                top: 0.2,
                width: 0.2,
            },
            pageIndex: 0,
            stableKey: 'native-integration:note',
            text: 'native integration annotation',
        }]})}\n`, 'utf8');

        await runNativeToolCommand(nativeBinaryPath!, [
            'save-mutations',
            '--input',
            inputPath,
            '--output',
            nativeOutputPath,
            '--mutations-file',
            mutationsPath,
            '--modified-at',
            'D:20260829000000Z',
        ], {
            timeoutMs: NATIVE_INTEGRATION_TIMEOUT_MS,
        });
        expect((await stat(nativeOutputPath)).size).toBeGreaterThan((await stat(inputPath)).size);
        await expect(runQpdf([
            '--check',
            nativeOutputPath,
        ])).resolves.toBeTruthy();
        await expect(runQpdf([
            '--show-npages',
            nativeOutputPath,
        ])).resolves.toMatchObject({stdout: expect.stringMatching(/^1\r?\n$/u)});

        await copyFileAtomic(nativeOutputPath, publishedPath);
        await expect(runQpdf([
            '--check',
            publishedPath,
        ])).resolves.toBeTruthy();
        await expect(runQpdf([
            '--show-npages',
            publishedPath,
        ])).resolves.toMatchObject({stdout: expect.stringMatching(/^1\r?\n$/u)});
        await expect(PDFDocument.load(await readFile(publishedPath))).resolves.toMatchObject({getPageCount: expect.any(Function)});
        const publishedBeforeFailure = await readFile(publishedPath);

        await writeFile(malformedMutationsPath, '{"unknown":true}\n', 'utf8');
        await expectCommandFailure(nativeBinaryPath!, [
            'save-mutations',
            '--input',
            inputPath,
            '--output',
            failedOutputPath,
            '--mutations-file',
            malformedMutationsPath,
            '--modified-at',
            'D:20260829000000Z',
        ]);
        await expect(access(failedOutputPath)).rejects.toMatchObject({code: 'ENOENT'});

        await expect(copyFileAtomic(failedOutputPath, publishedPath, {durable: true})).rejects.toBeTruthy();
        await expect(runQpdf([
            '--check',
            publishedPath,
        ])).resolves.toBeTruthy();
        await expect(runQpdf([
            '--show-npages',
            publishedPath,
        ])).resolves.toMatchObject({stdout: expect.stringMatching(/^1\r?\n$/u)});
        await expect(readFile(publishedPath)).resolves.toEqual(publishedBeforeFailure);
        await expect(PDFDocument.load(await readFile(publishedPath))).resolves.toMatchObject({getPageCount: expect.any(Function)});

        // Exclusive staging guard: copyFileAtomic must refuse an existing temporaryPath without deleting it.
        const existingTempPath = join(tempRoot, 'preexisting.tmp');
        await writeFile(existingTempPath, 'do-not-clobber', 'utf8');
        await expect(copyFileAtomic(nativeOutputPath, publishedPath, {temporaryPath: existingTempPath})).rejects.toMatchObject({
            code: 'EEXIST',
        });
        await expect(readFile(existingTempPath, 'utf8')).resolves.toBe('do-not-clobber');
        await expect(readFile(publishedPath)).resolves.toEqual(publishedBeforeFailure);

        // Competing directory and symlink-to-directory guards on copyNewFile (including racing past initial lstat).
        const {copyNewFile} = await import('@document-store/nodeStorePort');
        const competingDir = join(tempRoot, 'competing-dir');
        await mkdir(competingDir);
        await expect(copyNewFile(nativeOutputPath, competingDir)).rejects.toMatchObject(
            process.platform === 'win32' ? {code: expect.stringMatching(/^(?:EEXIST|EPERM)$/u)} : {code: 'EEXIST'},
        );
        expect(await readdir(competingDir)).toEqual([]);

        if (process.platform !== 'win32') {
            const symlinkTargetDir = join(tempRoot, 'symlink-target-dir');
            const competingSymlink = join(tempRoot, 'competing-symlink');
            await mkdir(symlinkTargetDir);
            await symlink(symlinkTargetDir, competingSymlink);
            await expect(copyNewFile(nativeOutputPath, competingSymlink)).rejects.toMatchObject({code: 'EEXIST'});
            expect(await readdir(symlinkTargetDir)).toEqual([]);
        }
    }, NATIVE_INTEGRATION_TIMEOUT_MS);
});
