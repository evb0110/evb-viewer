import {execFile} from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import {promisify} from 'node:util';
import {decode} from 'fast-png';
import {
    afterAll,
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {getActiveWorkspaceWorkingCopyPath} from '@tests/e2e/electron/helpers/electronApiHelpers';
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';
import type {TDocumentRef} from '@contracts/documentRef';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {createMultiPageTextFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {createVisibleWindowElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    requirePageNumber,
    type TPageNumber,
} from '@contracts/pageNumbers';
import {openPdfInApp} from '@tests/e2e/electron/helpers/viewerCore';

const execFileAsync = promisify(execFile);
const PRINT_ACCEPTANCE_TIMEOUT_MS = 15 * 60_000;
const PRINT_VALIDATION_DPI = 96;
const MIN_PRINT_INK_PIXELS = 500;
const printLayoutSmokeDir = resolve(process.cwd(), '.devkit', 'tmp', `macos-print-layout-smoke-${Date.now()}`);
const printLayoutSmokeOutputPath = join(printLayoutSmokeDir, 'facing-first-single-output.pdf');
const printLayoutSmokeDescribe = process.platform === 'darwin' ? describe : describe.skip;
const printLayoutSmokeSessionEnv = {
    EVB_PRINT_DIALOG_TEST_MODE: 'print-to-pdf',
    EVB_PRINT_DIALOG_TEST_OUTPUT_PATH: printLayoutSmokeOutputPath,
};

afterAll(() => {
    rmSync(printLayoutSmokeDir, {
        force: true,
        recursive: true,
    });
});

async function renderPdfPage(pdfPath: string, pageNumber: number, outputPrefix: string) {
    mkdirSync(dirname(outputPrefix), {recursive: true});
    await execFileAsync(getPdfNativeToolPaths().pdftoppm, [
        '-png',
        '-singlefile',
        '-r',
        String(PRINT_VALIDATION_DPI),
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        pdfPath,
        outputPrefix,
    ], {
        maxBuffer: 128 * 1024,
        timeout: 30_000,
    });
}

interface IPrintRasterMetrics {
    totalPixels: number;
    nonWhitePixels: number;
    substantialLightPixels: number;
    luminanceVariance: number;
    luminanceRange: number;
    distinctColorBuckets: number;
}

interface IPrintRasterRegion {
    startXRatio: number;
    endXRatio: number;
}

function inspectPrintedPageRaster(
    pngPath: string,
    region: IPrintRasterRegion = {
        startXRatio: 0,
        endXRatio: 1,
    },
): IPrintRasterMetrics {
    const image = decode(readFileSync(pngPath));
    const channelCount = Math.floor(image.data.length / (image.width * image.height));
    if (channelCount < 3) {
        throw new Error(`Printed page PNG has fewer than three color channels: ${channelCount}`);
    }

    const startX = Math.max(0, Math.min(image.width, Math.floor(image.width * region.startXRatio)));
    const endX = Math.max(startX, Math.min(image.width, Math.ceil(image.width * region.endXRatio)));
    const totalPixels = (endX - startX) * image.height;
    let nonWhitePixels = 0;
    let substantialLightPixels = 0;
    let luminanceMinimum = 255;
    let luminanceMaximum = 0;
    let luminanceMean = 0;
    let luminanceM2 = 0;
    let sampleCount = 0;
    const distinctColorBuckets = new Set<number>();

    for (let y = 0; y < image.height; y += 1) {
        for (let x = startX; x < endX; x += 1) {
            const offset = (y * image.width + x) * channelCount;
            const alpha = channelCount >= 4 ? image.data[offset + 3] ?? 255 : 255;
            const red = image.data[offset] ?? 255;
            const green = image.data[offset + 1] ?? 255;
            const blue = image.data[offset + 2] ?? 255;
            if (
                alpha > 8
                && (
                    red < 245
                    || green < 245
                    || blue < 245
                )
            ) {
                nonWhitePixels += 1;
            }

            if (alpha <= 8) {
                continue;
            }

            const luminance = (red * 0.2126) + (green * 0.7152) + (blue * 0.0722);
            if (luminance >= 220) {
                substantialLightPixels += 1;
            }
            luminanceMinimum = Math.min(luminanceMinimum, luminance);
            luminanceMaximum = Math.max(luminanceMaximum, luminance);
            sampleCount += 1;
            const delta = luminance - luminanceMean;
            luminanceMean += delta / sampleCount;
            luminanceM2 += delta * (luminance - luminanceMean);
            distinctColorBuckets.add((red >> 4) << 8 | (green >> 4) << 4 | (blue >> 4));
        }
    }

    return {
        totalPixels,
        nonWhitePixels,
        substantialLightPixels,
        luminanceVariance: sampleCount > 0 ? luminanceM2 / sampleCount : 0,
        luminanceRange: sampleCount > 0 ? luminanceMaximum - luminanceMinimum : 0,
        distinctColorBuckets: distinctColorBuckets.size,
    };
}

printLayoutSmokeDescribe('Electron E2E - macOS PDF print composition smoke', () => {
    const sessionFixture = createVisibleWindowElectronE2ESessionFixture({
        sessionName: () => `e2e-macos-print-layout-smoke-${Date.now()}`,
        extraEnv: printLayoutSmokeSessionEnv,
        timeoutMs: PRINT_ACCEPTANCE_TIMEOUT_MS,
    });

    it('composes first-page-single output as uniform landscape spreads before native handoff', async () => {
        const session = sessionFixture.getSession();

        rmSync(printLayoutSmokeOutputPath, {force: true});
        mkdirSync(printLayoutSmokeDir, {recursive: true});
        onTestFinished(() => rmSync(printLayoutSmokeOutputPath, {force: true}));

        const sourcePath = await createMultiPageTextFixturePdf(
            'macos-print-layout-four-pages.pdf',
            4,
        );
        await openPdfInApp(session.page, sourcePath, PRINT_ACCEPTANCE_TIMEOUT_MS);
        const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        const pageNumbers: TPageNumber[] = [
            requirePageNumber(1),
            requirePageNumber(2),
            requirePageNumber(3),
            requirePageNumber(4),
        ];
        const printResult = await session.page.evaluate(async ({
            path,
            pageNumbers,
        }: {
            path: TDocumentRef;
            pageNumbers: TPageNumber[];
        }) => {
            const printPdfPath = (window as IE2EWindow).electronAPI?.documentPdf?.printPdfPath;
            if (!printPdfPath) {
                throw new Error('electronAPI.documentPdf.printPdfPath is unavailable');
            }

            return printPdfPath(path, 'facing-first-single-print-smoke.pdf', {
                pageNumbers,
                viewMode: 'facing-first-single',
                orientation: 'auto',
            });
        }, {
            path: workingCopyPath,
            pageNumbers,
        });

        expect(printResult).toEqual(expect.objectContaining({success: true}));
        expect(existsSync(printLayoutSmokeOutputPath)).toBe(true);

        const qpdfPath = getPdfNativeToolPaths().qpdf;
        await execFileAsync(qpdfPath, [
            '--check',
            printLayoutSmokeOutputPath,
        ], {
            maxBuffer: 128 * 1024,
            timeout: 60_000,
        });
        const {stdout: pageCountOutput} = await execFileAsync(qpdfPath, [
            '--show-npages',
            printLayoutSmokeOutputPath,
        ], {
            maxBuffer: 16 * 1024,
            timeout: 60_000,
        });
        expect(Number.parseInt(pageCountOutput.trim(), 10)).toBe(3);

        const sheetPaths: string[] = [];
        for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
            const outputPrefix = join(printLayoutSmokeDir, `facing-first-single-page-${pageNumber}`);
            const sheetPath = `${outputPrefix}.png`;
            await renderPdfPage(printLayoutSmokeOutputPath, pageNumber, outputPrefix);
            sheetPaths.push(sheetPath);
            const rasterMetrics = inspectPrintedPageRaster(sheetPath);
            expect(rasterMetrics.totalPixels).toBeGreaterThan(0);
            expect(rasterMetrics.nonWhitePixels).toBeGreaterThan(MIN_PRINT_INK_PIXELS);
        }
        const firstPageSheetPath = sheetPaths[0]!;
        expect(inspectPrintedPageRaster(firstPageSheetPath, {
            startXRatio: 0,
            endXRatio: 0.5,
        }).nonWhitePixels).toBeLessThan(MIN_PRINT_INK_PIXELS);
        expect(inspectPrintedPageRaster(firstPageSheetPath, {
            startXRatio: 0.5,
            endXRatio: 1,
        }).nonWhitePixels).toBeGreaterThan(MIN_PRINT_INK_PIXELS);

        const facingSheetPath = sheetPaths[1]!;
        expect(inspectPrintedPageRaster(facingSheetPath, {
            startXRatio: 0,
            endXRatio: 0.5,
        }).nonWhitePixels).toBeGreaterThan(MIN_PRINT_INK_PIXELS);
        expect(inspectPrintedPageRaster(facingSheetPath, {
            startXRatio: 0.5,
            endXRatio: 1,
        }).nonWhitePixels).toBeGreaterThan(MIN_PRINT_INK_PIXELS);

        const trailingPageSheetPath = sheetPaths[2]!;
        expect(inspectPrintedPageRaster(trailingPageSheetPath, {
            startXRatio: 0,
            endXRatio: 0.5,
        }).nonWhitePixels).toBeGreaterThan(MIN_PRINT_INK_PIXELS);
        expect(inspectPrintedPageRaster(trailingPageSheetPath, {
            startXRatio: 0.5,
            endXRatio: 1,
        }).nonWhitePixels).toBeLessThan(MIN_PRINT_INK_PIXELS);
    }, PRINT_ACCEPTANCE_TIMEOUT_MS);
});
