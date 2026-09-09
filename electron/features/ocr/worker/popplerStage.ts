import {
    rm,
    stat,
} from 'node:fs/promises';
import {join} from 'node:path';
import type {IOcrPageSizeInches} from '@electron/features/ocr/worker/pdfPageSizeProbe';
import type {
    IWorkerPaths,
    TWorkerLog,
} from '@electron/ocr/worker/types';
import {
    runOcrCommand,
    type TOcrRunCommandOptions,
} from '@electron/features/ocr/worker/runOcrCommand';
import {isAbortError} from '@electron/utils/abort';
import {getErrorMessage} from '@electron/utils/error';
import {createScanCleanupRenderers} from '@evb/scan-cleanup/adapters/createScanCleanupRenderers';
import {readPngDimensions} from '@evb/scan-cleanup/core/rasterLayerDimensions';
import type {IScanCleanupRasterRenderLimits} from '@evb/scan-cleanup/core/types';
export {buildPopplerEnv} from '@electron/native-tools/buildPopplerEnv';

const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
const OCR_MAX_RASTER_PIXELS = 45_000_000;
const OCR_MAX_RASTER_DIMENSION_PX = 40_000;
// Coarse enough that even a wall-sized page stays a few thousand pixels, fine
// enough that the recovered size is within 1/8 inch of the real page box.
const OCR_PAGE_SIZE_PROBE_DPI = 8;

export interface IPreparedPopplerPdf {
    pdfPath: string;
    warnings: string[];
}

const renderers = createScanCleanupRenderers(runOcrCommand, {
    maxDimensionPx: OCR_MAX_RASTER_DIMENSION_PX,
    maxPixels: OCR_MAX_RASTER_PIXELS,
});
export const renderPdfPageToPng = renderers.renderPage;
export const renderPdfPageToPpm = renderers.renderPagePpm;

export function createOcrRasterRenderLimits(
    pageSize: IOcrPageSizeInches,
    dpi: number,
): IScanCleanupRasterRenderLimits {
    return {
        expectedWidthPx: Math.max(1, Math.ceil(pageSize.width * dpi)),
        expectedHeightPx: Math.max(1, Math.ceil(pageSize.height * dpi)),
        maxPixels: OCR_MAX_RASTER_PIXELS,
        maxDimensionPx: OCR_MAX_RASTER_DIMENSION_PX,
    };
}

// A failed probe falls back to the post-render guard rather than failing a
// page that the full render might still handle; only an abort propagates.
export interface IOcrPageSizeProbeSource {
    popplerSourcePdfPath: string;
    popplerEnv?: NodeJS.ProcessEnv | undefined;
    signal?: AbortSignal | undefined;
}

export async function probeOcrPageSizeInches(
    paths: Parameters<typeof renderPdfPageToPng>[0],
    log: TWorkerLog,
    pageNumber: number,
    source: IOcrPageSizeProbeSource,
    probeImagePath: string,
): Promise<IOcrPageSizeInches | undefined> {
    const {signal} = source;
    try {
        await renderPdfPageToPng(
            paths,
            log,
            pageNumber,
            source.popplerSourcePdfPath,
            probeImagePath,
            OCR_PAGE_SIZE_PROBE_DPI,
            source.popplerEnv,
            signal,
        );
        const dimensions = await readPngDimensions(probeImagePath);
        return {
            width: dimensions.width / OCR_PAGE_SIZE_PROBE_DPI,
            height: dimensions.height / OCR_PAGE_SIZE_PROBE_DPI,
        };
    } catch (err) {
        if (signal?.aborted || isAbortError(err)) {
            throw err;
        }
        log('warn', `Page ${pageNumber} size probe failed; relying on the post-render raster guard: ${getErrorMessage(err)}`);
        return undefined;
    } finally {
        await rm(probeImagePath, {force: true}).catch(() => undefined);
    }
}

export async function preparePdfForPoppler(
    paths: Pick<IWorkerPaths, 'qpdfBinary' | 'tempDir'>,
    log: TWorkerLog,
    sourcePdfPath: string,
    sessionId: string,
    trackTempFile: (path: string) => string,
    signal?: AbortSignal,
): Promise<IPreparedPopplerPdf> {
    const normalizedPdfPath = trackTempFile(join(paths.tempDir, `${sessionId}-poppler-input.pdf`));

    try {
        const commandOptions: TOcrRunCommandOptions = {
            commandLabel: 'qpdf(poppler-preflight)',
            allowedExitCodes: [
                0,
                3,
            ],
            timeoutMs: QPDF_TIMEOUT_MS,
            log,
        };
        if (signal !== undefined) {
            commandOptions.signal = signal;
        }

        await runOcrCommand(paths.qpdfBinary, [
            sourcePdfPath,
            normalizedPdfPath,
        ], commandOptions);

        const normalizedStat = await stat(normalizedPdfPath);
        if (normalizedStat.size <= 0) {
            throw new Error('qpdf produced an empty normalized PDF');
        }

        log('debug', `Prepared Poppler input via qpdf: ${normalizedPdfPath} (${normalizedStat.size} bytes)`);
        return {
            pdfPath: normalizedPdfPath,
            warnings: [],
        };
    } catch (err) {
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : err;
        }
        const warning = `qpdf preflight failed; falling back to original PDF for Poppler commands: ${getErrorMessage(err)}`;
        log('warn', warning);
        return {
            pdfPath: sourcePdfPath,
            warnings: [warning],
        };
    }
}
