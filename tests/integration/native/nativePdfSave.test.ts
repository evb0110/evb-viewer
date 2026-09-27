import {execFile} from 'node:child_process';
import {
    access,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {promisify} from 'node:util';
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
import {copyFileAtomic} from '@electron/file-access/documentFileWriteAtomic';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';

const execFileAsync = promisify(execFile);
const NATIVE_INTEGRATION_TIMEOUT_MS = 120_000;

function resolveNativePageOpsPath() {
    const configured = process.env.EVB_PDF_PAGE_OPS_PATH?.trim();
    if (configured) {
        return resolve(configured);
    }
    const extension = process.platform === 'win32' ? '.exe' : '';
    return resolve(
        '.tmp',
        'pdf-page-ops',
        `${process.platform}-${process.arch}`,
        'bin',
        `evb-pdf-page-ops${extension}`,
    );
}

async function runQpdf(args: string[]) {
    return execFileAsync(getPdfNativeToolPaths().qpdf, args, {
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
        timeout: NATIVE_INTEGRATION_TIMEOUT_MS,
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
    await expect(execFileAsync(command, args, {
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
        timeout: NATIVE_INTEGRATION_TIMEOUT_MS,
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

    it('saves a real tiny PDF with the native binary, validates qpdf, publishes atomically, and reopens after failure', async () => {
        tempRoot = await mkdtemp(join(tmpdir(), 'evb-native-pdf-save-'));
        const inputPath = join(tempRoot, 'input.pdf');
        const mutationsPath = join(tempRoot, 'mutations.json');
        const nativeOutputPath = join(tempRoot, 'native-output.pdf');
        const publishedPath = join(tempRoot, 'published.pdf');
        const malformedMutationsPath = join(tempRoot, 'malformed-mutations.json');
        const failedOutputPath = join(tempRoot, 'failed-output.pdf');
        const nativeBinaryPath = resolveNativePageOpsPath();
        await access(nativeBinaryPath);
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

        await execFileAsync(nativeBinaryPath, [
            'save-mutations',
            '--input',
            inputPath,
            '--output',
            nativeOutputPath,
            '--mutations-file',
            mutationsPath,
            '--modified-at',
            'D:20260829000000Z',
            '--qpdf',
            getPdfNativeToolPaths().qpdf,
        ], {
            encoding: 'utf8',
            maxBuffer: 512 * 1024,
            timeout: NATIVE_INTEGRATION_TIMEOUT_MS,
        });
        expect((await stat(nativeOutputPath)).size).toBeGreaterThan((await stat(inputPath)).size);
        await expect(runQpdf([
            '--check',
            nativeOutputPath,
        ])).resolves.toBeTruthy();
        await expect(runQpdf([
            '--show-npages',
            nativeOutputPath,
        ])).resolves.toMatchObject({stdout: '1\n'});

        await copyFileAtomic(nativeOutputPath, publishedPath, {linkImmutableSource: false});
        await expect(runQpdf([
            '--check',
            publishedPath,
        ])).resolves.toBeTruthy();
        await expect(runQpdf([
            '--show-npages',
            publishedPath,
        ])).resolves.toMatchObject({stdout: '1\n'});
        await expect(PDFDocument.load(await readFile(publishedPath))).resolves.toMatchObject({getPageCount: expect.any(Function)});
        const publishedBeforeFailure = await readFile(publishedPath);

        await writeFile(malformedMutationsPath, '{"unknown":true}\n', 'utf8');
        await expectCommandFailure(nativeBinaryPath, [
            'save-mutations',
            '--input',
            inputPath,
            '--output',
            failedOutputPath,
            '--mutations-file',
            malformedMutationsPath,
            '--modified-at',
            'D:20260829000000Z',
            '--qpdf',
            getPdfNativeToolPaths().qpdf,
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
        ])).resolves.toMatchObject({stdout: '1\n'});
        await expect(readFile(publishedPath)).resolves.toEqual(publishedBeforeFailure);
        await expect(PDFDocument.load(await readFile(publishedPath))).resolves.toMatchObject({getPageCount: expect.any(Function)});
    }, NATIVE_INTEGRATION_TIMEOUT_MS);
});
