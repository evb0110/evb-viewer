import { execFile } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import {
    join,
    resolve,
} from 'node:path';
import { promisify } from 'node:util';
import { decode } from 'fast-png';
import { PDFDocument } from 'pdf-lib';
import {
    afterAll,
    describe,
    expect,
    it,
} from 'vitest';
import { resolvePlatformArchTag } from '@electron/utils/platformArch';
import {
    resolveDjvuFixturePath,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';
import { openDjvuInApp } from '@tests/e2e/electron/helpers/viewerCore';

const execFileAsync = promisify(execFile);
const PRINT_HANDOFF_TIMEOUT_MS = 240_000;
const DJVU_OPEN_TIMEOUT_MS = 90_000;
const PRINT_HANDOFF_SELECTED_PAGES = [
    1,
    2,
];
const PRINT_VALIDATION_DPI = 96;
const smokeDir = resolve(process.cwd(), '.devkit', 'tmp', `djvu-print-handoff-${Date.now()}`);
const capturedPdfPath = join(smokeDir, 'captured-print.pdf');
const renderedFirstPagePrefix = join(smokeDir, 'captured-first-page');
const renderedFirstPagePath = `${renderedFirstPagePrefix}.png`;
const djvuFixture = resolveDjvuFixturePath({corpusFixturePath: resolve(
    process.cwd(),
    'tests',
    'fixtures',
    'djvu',
    'sources',
    'mixed-dpi.djvu',
)});
const runDjvuPrintHandoffOrSkip = selectFixtureDescribe(describe, djvuFixture);

const printHandoffSessionEnv = {
    EVB_PRINT_DIALOG_TEST_MODE: 'print-to-pdf',
    EVB_PRINT_DIALOG_TEST_OUTPUT_PATH: capturedPdfPath,
    EVB_PRINT_RASTER_DPI: String(PRINT_VALIDATION_DPI),
};

afterAll(() => {
    rmSync(smokeDir, {
        force: true,
        recursive: true,
    });
});

function resolveBundledPdftoppmPath() {
    const executable = process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm';
    return resolve(
        process.cwd(),
        'resources',
        'poppler',
        resolvePlatformArchTag(),
        'bin',
        executable,
    );
}

async function renderFirstPdfPage(pdfPath: string) {
    const pdftoppmPath = resolveBundledPdftoppmPath();
    if (!existsSync(pdftoppmPath)) {
        throw new Error(`Missing bundled pdftoppm: ${pdftoppmPath}`);
    }

    await execFileAsync(pdftoppmPath, [
        '-png',
        '-singlefile',
        '-r',
        String(PRINT_VALIDATION_DPI),
        '-f',
        '1',
        '-l',
        '1',
        pdfPath,
        renderedFirstPagePrefix,
    ], { timeout: 30_000 });
}

function countNonWhitePixels(pngPath: string) {
    const image = decode(readFileSync(pngPath));
    const channelCount = Math.floor(image.data.length / (image.width * image.height));
    let nonWhitePixels = 0;

    for (let offset = 0; offset < image.data.length; offset += channelCount) {
        const alpha = channelCount >= 4 ? image.data[offset + 3] ?? 255 : 255;
        if (
            alpha > 8
            && (
                (image.data[offset] ?? 255) < 245
                || (image.data[offset + 1] ?? 255) < 245
                || (image.data[offset + 2] ?? 255) < 245
            )
        ) {
            nonWhitePixels += 1;
        }
    }

    return nonWhitePixels;
}

runDjvuPrintHandoffOrSkip('Electron E2E - DjVu Print Handoff', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-djvu-print-handoff-${Date.now()}`,
        extraEnv: printHandoffSessionEnv,
    });

    it('prints selected DjVu pages to a multi-page nonblank PDF surface', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        rmSync(smokeDir, {
            force: true,
            recursive: true,
        });
        mkdirSync(smokeDir, { recursive: true });
        await openDjvuInApp(session.page, djvuFixture.path, DJVU_OPEN_TIMEOUT_MS);

        const result = await session.page.evaluate(async (
            sourcePath: string,
            pageNumbers: number[],
        ) => {
            const api = (window as typeof globalThis & IE2EWindow & {electronAPI?: {djvu?: {printDjvuPath?: (
                path: string,
                options: {
                    fileName: string;
                    orientation: string;
                    pageNumbers: number[];
                    requestId: string;
                    viewMode: string;
                },
            ) => Promise<{
                success: boolean;
                canceled?: boolean;
                error?: string;
                jobId?: string;
            }>;};};}).electronAPI;

            const printDjvuPath = api?.djvu?.printDjvuPath;
            if (!printDjvuPath) {
                throw new Error('electronAPI.djvu.printDjvuPath is unavailable');
            }

            return printDjvuPath(sourcePath, {
                fileName: 'djvu-print-handoff-smoke.djvu',
                orientation: 'auto',
                pageNumbers,
                requestId: `e2e-${Date.now()}`,
                viewMode: 'single',
            });
        }, djvuFixture.path, PRINT_HANDOFF_SELECTED_PAGES);

        expect(result).toEqual(expect.objectContaining({
            jobId: expect.stringMatching(/^djvu-print-e2e-/u),
            success: true,
        }));
        expect(existsSync(capturedPdfPath)).toBe(true);

        const capturedData = readFileSync(capturedPdfPath);
        const capturedDocument = await PDFDocument.load(capturedData, { updateMetadata: false });
        expect(capturedDocument.getPageCount()).toBe(PRINT_HANDOFF_SELECTED_PAGES.length);

        await renderFirstPdfPage(capturedPdfPath);
        expect(countNonWhitePixels(renderedFirstPagePath)).toBeGreaterThan(500);
    }, PRINT_HANDOFF_TIMEOUT_MS);
});
