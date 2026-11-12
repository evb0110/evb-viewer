import {
    readFile,
    rm,
    stat,
} from 'fs/promises';
import {decode as decodePng} from 'fast-png';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    encodePnm,
    readPnmSize,
} from '@ocr-core/ppmRaster';
import type {IOcrPageRaster} from '@ocr-core/recognizeOcrPages';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import type {TWorkerLog} from '@electron/features/ocr/pipeline/types';
import { getErrorMessage } from '@electron/utils/error';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';
import type {IOcrDiagnostic} from '@contracts/electronApiOcr';
import {decodeNativeScanCleanupOutputMetadataJson} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import type {IScanCleanupPreviewAffine} from '@contracts/scan-cleanup/geometry';
import {
    createOcrPreprocessingGeometryDiagnostic,
    createOcrScanCleanupOptions,
    readOcrScanCleanupGeometry,
    type TOcrScanCleanupMode,
} from '@contracts/scan-cleanup/ocrPreprocessing';

export interface IOcrPreprocessedImage {
    path: string;
    inverseTransform?: IScanCleanupPreviewAffine;
}

const OCR_PREPROCESS_TIMEOUT_MS = 30_000;
function createOptionalPreprocessingLog(log: TWorkerLog): TWorkerLog {
    return (level, message) => {
        log(level === 'error' ? 'warn' : level, message);
    };
}

async function isNonEmptyFile(path: string) {
    try {
        return (await stat(path)).size > 0;
    } catch {
        return false;
    }
}

async function readNativePreprocessResult(
    outputPath: string,
    metadataPath: string,
    log: TWorkerLog,
    onDiagnostic?: (diagnostic: IOcrDiagnostic) => void,
): Promise<IOcrPreprocessedImage | null> {
    try {
        const metadata = decodeNativeScanCleanupOutputMetadataJson(await readFile(metadataPath, 'utf8'));
        return {
            path: outputPath,
            ...readOcrScanCleanupGeometry(metadata),
        };
    } catch (error) {
        const message = `OCR preprocessing metadata is unusable; using raw page render: ${getErrorMessage(error)}`;
        log('warn', message);
        onDiagnostic?.({
            code: 'OCR_PREPROCESSING_FAILED',
            severity: 'warning',
            message,
        });
        return null;
    }
}

export async function tryPreprocessOcrImage(
    inputPath: string,
    outputPath: string,
    log: TWorkerLog,
    signal: AbortSignal,
    onDiagnostic?: (diagnostic: IOcrDiagnostic) => void,
    scanCleanupBinary?: string,
    metadataPath = `${outputPath}.json`,
    dpi = 300,
    mode: TOcrScanCleanupMode = 'clean',
    grantedCpuTokens?: number,
): Promise<IOcrPreprocessedImage> {
    if (scanCleanupBinary) {
        try {
            await runNativeToolCommand(scanCleanupBinary, [
                '--input',
                inputPath,
                '--output',
                outputPath,
                '--metadata',
                metadataPath,
                '--ocr-mode',
                '--options',
                JSON.stringify(createOcrScanCleanupOptions(mode, dpi)),
            ], {
                ...(grantedCpuTokens === undefined ? {} : {env: {
                    ...process.env,
                    RAYON_NUM_THREADS: String(grantedCpuTokens),
                }}),
                timeoutMs: OCR_PREPROCESS_TIMEOUT_MS,
                commandLabel: 'evb-scan-cleanup(ocr-preprocess)',
                signal,
                log: createOptionalPreprocessingLog(log),
            });
            if (await isNonEmptyFile(outputPath)) {
                const result = await readNativePreprocessResult(outputPath, metadataPath, log, onDiagnostic);
                if (result !== null) {
                    return result;
                }
            }
            log('warn', 'Native scan cleanup produced no usable image; using raw page render');
        } catch (error) {
            if (signal.aborted || getUnprovenNativeTerminationDetail(error) !== undefined) {
                throw error;
            }
            log('warn', `Native scan cleanup failed; using raw page render: ${getErrorMessage(error)}`);
        }
    }

    const message = scanCleanupBinary
        ? 'OCR preprocessing failed; using raw page render'
        : 'OCR preprocessing requested, but scan cleanup is unavailable for this platform';
    log('warn', message);
    onDiagnostic?.({
        code: scanCleanupBinary ? 'OCR_PREPROCESSING_FAILED' : 'OCR_PREPROCESSING_UNAVAILABLE',
        severity: 'warning',
        message,
    });
    return {path: inputPath};
}

/** A rendered page file (Poppler's PPM, or a PNG) as the PNM the engine reads. */
async function readOcrRasterFile(path: string) {
    const bytes = await readFile(path);
    if (bytes[0] === 0x50) {
        return {
            ...readPnmSize(bytes),
            image: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        };
    }
    const png = decodePng(bytes);
    if (png.depth !== 8 || (png.channels !== 1 && png.channels !== 3)) {
        throw new Error(`OCR raster is an unsupported ${png.depth}-bit, ${png.channels}-channel PNG`);
    }
    return {
        width: png.width,
        height: png.height,
        image: encodePnm(png.width, png.height, png.channels, png.data as Uint8Array),
    };
}

/**
 * The raster the engine reads for a rendered page: with a preprocessing mode,
 * the cleaned page as the browser cleans it ('off' still normalizes
 * polarity); a cleanup that failed or changed the page size leaves the
 * rendered page with a diagnostic. Cleanup files go beside `renderedPath`.
 */
export async function prepareOcrPageRaster(input: {
    renderedPath: string;
    pageNumber: number;
    dpi: number;
    cleanupMode: TOcrScanCleanupMode | undefined;
    scanCleanupBinary: string | undefined;
    cleanupThreads?: number;
    log: TWorkerLog;
    signal: AbortSignal;
}): Promise<IOcrPageRaster<Uint8Array>> {
    const rendered = await readOcrRasterFile(input.renderedPath);
    if (input.cleanupMode === undefined) return rendered;
    const cleanedPath = `${input.renderedPath}-clean.png`;
    const pageNumber = requirePageNumber(input.pageNumber);
    let diagnostic: IOcrDiagnostic | undefined;
    try {
        const cleaned = await tryPreprocessOcrImage(
            input.renderedPath,
            cleanedPath,
            input.log,
            input.signal,
            (reported) => {
                diagnostic = {
                    ...reported,
                    pageNumber,
                };
            },
            input.scanCleanupBinary,
            `${cleanedPath}.json`,
            input.dpi,
            input.cleanupMode,
            input.cleanupThreads,
        );
        if (cleaned.path === input.renderedPath) {
            return {
                ...rendered,
                ...(diagnostic ? {diagnostic} : {}),
            };
        }
        const page = await readOcrRasterFile(cleaned.path);
        if (page.width !== rendered.width || page.height !== rendered.height) {
            return {
                ...rendered,
                diagnostic: createOcrPreprocessingGeometryDiagnostic(pageNumber, rendered, page),
            };
        }
        return {
            ...rendered,
            image: page.image,
            ...(cleaned.inverseTransform ? {preprocessInverse: {
                rasterWidthPx: rendered.width,
                rasterHeightPx: rendered.height,
                matrix: cleaned.inverseTransform.matrix,
            }} : {}),
        };
    } finally {
        await Promise.all([
            cleanedPath,
            `${cleanedPath}.json`,
        ].map(path => rm(path, {force: true}))).catch(() => undefined);
    }
}
