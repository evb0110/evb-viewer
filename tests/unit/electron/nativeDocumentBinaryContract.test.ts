import { execFile } from 'node:child_process';
import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import { promisify } from 'node:util';
import {
    PDFDocument,
    StandardFonts,
} from 'pdf-lib';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    readPdfPageTexts,
    streamPdfPageTexts,
} from '@electron/features/search/pdfPageTexts';

const execFileAsync = promisify(execFile);
const hostResourceDirectory = `${process.platform}-${process.arch}`;
const executableSuffix = process.platform === 'win32' ? '.exe' : '';
const hostIsPackaged = [
    'darwin-arm64',
    'linux-x64',
    'win32-x64',
].includes(hostResourceDirectory);
const nativeToolCommandTimeoutMs = 15_000;
const nativeToolContractTestTimeoutMs = nativeToolCommandTimeoutMs + 5_000;

function nativeToolPath(tool: 'ddjvu' | 'djvused' | 'pdftotext' | 'qpdf') {
    const packageName = tool === 'qpdf'
        ? 'qpdf'
        : tool === 'pdftotext'
            ? 'poppler'
            : 'djvulibre';
    return resolve(
        process.cwd(),
        'resources',
        packageName,
        hostResourceDirectory,
        'bin',
        `${tool}${executableSuffix}`,
    );
}

describe.skipIf(!hostIsPackaged)('shipped native document binary contracts', () => {
    it('keeps qpdf JSON compatible with the JavaScript page contract', async () => {
        const fixture = resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf');
        const {stdout} = await execFileAsync(nativeToolPath('qpdf'), [
            '--json',
            fixture,
        ], {
            maxBuffer: 8 * 1024 * 1024,
            timeout: nativeToolCommandTimeoutMs,
        });
        const result = JSON.parse(stdout) as {
            pages?: unknown[];
            qpdf?: unknown;
            version?: number
        };

        expect(result.version).toBe(2);
        expect(result.pages).toHaveLength(1);
        expect(result.qpdf).toBeTruthy();
    }, nativeToolContractTestTimeoutMs);

    it('keeps pdftotext output compatible with the JavaScript text contract', async () => {
        const fixture = resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf');
        const {stdout} = await execFileAsync(nativeToolPath('pdftotext'), [
            fixture,
            '-',
        ], {timeout: nativeToolCommandTimeoutMs});

        expect(stdout).toContain('Hello Arabic world');
        expect(stdout).toContain('First');
        expect(stdout).toContain('Second text box');
    }, nativeToolContractTestTimeoutMs);

    it('extracts every page across Poppler windows and releases aborted or stale extraction', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-search-text-pages-'));
        try {
            const pdfPath = join(directory, 'search-text-pages.pdf');
            const document = await PDFDocument.create();
            const font = await document.embedFont(StandardFonts.Helvetica);
            const expectedPageNumbers = Array.from({length: 260}, (_value, index) => index + 1);
            for (const pageNumber of expectedPageNumbers) {
                const page = document.addPage([
                    612,
                    792,
                ]);
                page.drawText(`EVB_SEARCH_WINDOW_PAGE_${pageNumber}`, {
                    font,
                    size: 18,
                    x: 24,
                    y: 720,
                });
            }
            await writeFile(pdfPath, await document.save());

            const pages = [];
            for await (const page of streamPdfPageTexts(pdfPath)) {
                pages.push(page);
            }

            expect(pages.map(page => page.pageNumber)).toEqual(expectedPageNumbers);
            pages.forEach((page, index) => {
                expect(page.text).toContain(`EVB_SEARCH_WINDOW_PAGE_${expectedPageNumbers[index]}`);
            });

            const selected = await readPdfPageTexts(pdfPath, [
                1,
                259,
            ]);
            expect(selected.map(page => page.text)).toEqual([
                'EVB_SEARCH_WINDOW_PAGE_1',
                'EVB_SEARCH_WINDOW_PAGE_259',
            ]);
            expect(await readPdfPageTexts(pdfPath, [])).toEqual([]);

            const controller = new AbortController();
            const aborted = streamPdfPageTexts(pdfPath, {signal: controller.signal});
            expect((await aborted.next()).value?.text).toContain('EVB_SEARCH_WINDOW_PAGE_1');
            controller.abort();
            await expect(aborted.next()).rejects.toThrow(/abort/iu);

            const stale = streamPdfPageTexts(pdfPath);
            for (let index = 0; index < 256; index += 1) await stale.next();
            document.getPages()[0]?.drawText('New revision', {font});
            await writeFile(pdfPath, await document.save());
            await expect(stale.next()).rejects.toThrow('PDF source changed during text extraction');
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    }, nativeToolContractTestTimeoutMs);

    it('runs the shipped DjVuLibre command-line pair', async () => {
        const captureStderr = (error: unknown) => ({stderr: error && typeof error === 'object' && 'stderr' in error
            ? String(error.stderr)
            : String(error)});
        const [
            ddjvuHelpResult,
            djvusedVersionResult,
        ] = await Promise.all([
            execFileAsync(nativeToolPath('ddjvu'), ['--help'], {timeout: nativeToolCommandTimeoutMs}).catch((error: unknown) => ({stderr: error && typeof error === 'object' && 'stderr' in error
                ? String(error.stderr)
                : String(error)})),
            execFileAsync(nativeToolPath('djvused'), ['--version'], {timeout: nativeToolCommandTimeoutMs}).catch(captureStderr),
        ]);

        expect(ddjvuHelpResult.stderr).toContain('Usage: ddjvu');
        expect(djvusedVersionResult.stderr).toContain('DjVuLibre-');
    }, nativeToolContractTestTimeoutMs);
});
