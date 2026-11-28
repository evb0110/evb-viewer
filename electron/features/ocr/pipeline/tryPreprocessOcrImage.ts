import {open, readFile, rm, stat} from 'fs/promises';
import {decode as decodePng} from 'fast-png';
import {requirePageNumber} from '@contracts/pageNumbers';
import {encodePnm, readPnmSize} from '@ocr-core/ppmRaster';
import type {IOcrPageRaster} from '@ocr-core/recognizeOcrPages';
import type {IOcrEngineImageFile} from '@electron/features/ocr/main/ocrEngineHostProtocol';
import {resolveOcrPreprocessResources} from '@electron/features/ocr/main/ocrRuntimePolicy';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import type {TWorkerLog} from '@electron/features/ocr/pipeline/types';
import {mainJobBroker, type IJobBrokerRunContext, type JobBroker} from '@electron/resources/jobBroker';
import {isAbortError} from '@electron/utils/abort';
import {getErrorMessage} from '@electron/utils/error';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';
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
    brokerRun?: IJobBrokerRunContext,
): Promise<IOcrPreprocessedImage> {
    if (scanCleanupBinary) {
        try {
            await runNativeToolCommand(
                scanCleanupBinary,
                [
                    '--input',
                    inputPath,
                    '--output',
                    outputPath,
                    '--metadata',
                    metadataPath,
                    '--ocr-mode',
                    '--options',
                    JSON.stringify(createOcrScanCleanupOptions(mode, dpi)),
                ],
                {
                    ...(grantedCpuTokens === undefined
                        ? {}
                        : {
                              env: {
                                  ...process.env,
                                  RAYON_NUM_THREADS: String(grantedCpuTokens),
                              },
                          }),
                    ...(brokerRun === undefined ? {} : {brokerRun}),
                    timeoutMs: OCR_PREPROCESS_TIMEOUT_MS,
                    commandLabel: 'evb-scan-cleanup(ocr-preprocess)',
                    signal,
                    log: createOptionalPreprocessingLog(log),
                },
            );
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

const RASTER_HEADER_PROBE_BYTES = 64;

function isPngIhdrHeader(header: Buffer, bytesRead: number) {
    return (
        bytesRead >= 24 &&
        header[0] === 0x89 &&
        header[1] === 0x50 &&
        header[2] === 0x4e &&
        header[3] === 0x47 &&
        header[4] === 0x0d &&
        header[5] === 0x0a &&
        header[6] === 0x1a &&
        header[7] === 0x0a &&
        header.toString('ascii', 12, 16) === 'IHDR'
    );
}

/**
 * Inspects a rendered PNM or PNG raster's dimensions by reading only its header
 * bytes instead of loading a 15-35 MiB raw PPM into memory.
 */
export async function readOcrRasterDimensions(path: string): Promise<{
    width: number;
    height: number;
}> {
    const handle = await open(path, 'r');
    try {
        const header = Buffer.alloc(RASTER_HEADER_PROBE_BYTES);
        const {bytesRead} = await handle.read(header, 0, header.length, 0);
        if (bytesRead > 0 && header[0] === 0x50) {
            return readPnmSize(header.subarray(0, bytesRead));
        }
        if (isPngIhdrHeader(header, bytesRead)) {
            const width = header.readUInt32BE(16);
            const height = header.readUInt32BE(20);
            if (width > 0 && height > 0) {
                return {
                    width,
                    height,
                };
            }
        }
    } finally {
        await handle.close();
    }
    const decoded = decodePng(await readFile(path));
    return {
        width: decoded.width,
        height: decoded.height,
    };
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

interface IPrepareOcrPageRasterInput {
    renderedPath: string;
    pageNumber: number;
    dpi: number;
    cleanupMode: TOcrScanCleanupMode | undefined;
    scanCleanupBinary: string | undefined;
    cleanupThreads?: number;
    broker?: JobBroker;
    brokerOwnerId?: string;
    log: TWorkerLog;
    signal: AbortSignal;
}

async function runPreprocessWithBrokerLease(input: {
    renderedPath: string;
    cleanedPath: string;
    metadataPath: string;
    renderedSize: {width: number; height: number};
    dpi: number;
    cleanupMode: TOcrScanCleanupMode;
    scanCleanupBinary: string | undefined;
    cleanupThreads?: number;
    broker?: JobBroker;
    brokerOwnerId?: string;
    log: TWorkerLog;
    signal: AbortSignal;
    onDiagnostic: (diagnostic: IOcrDiagnostic) => void;
}) {
    if (!input.scanCleanupBinary) {
        return tryPreprocessOcrImage(
            input.renderedPath,
            input.cleanedPath,
            input.log,
            input.signal,
            input.onDiagnostic,
            input.scanCleanupBinary,
            input.metadataPath,
            input.dpi,
            input.cleanupMode,
            input.cleanupThreads,
        );
    }
    const broker = input.broker ?? mainJobBroker;
    const resources = resolveOcrPreprocessResources({
        pixelCount: input.renderedSize.width * input.renderedSize.height,
        mode: input.cleanupMode,
        cleanupThreads: input.cleanupThreads ?? 1,
        capacity: broker.getSnapshot().capacity,
    });
    try {
        return await broker.run(
            {
                ownerId: input.brokerOwnerId ?? 'ocr:preprocess',
                kind: 'ocr-preprocess',
                priority: 'user',
                resources,
                signal: input.signal,
            },
            (brokerRun) =>
                tryPreprocessOcrImage(
                    input.renderedPath,
                    input.cleanedPath,
                    input.log,
                    input.signal,
                    input.onDiagnostic,
                    input.scanCleanupBinary,
                    input.metadataPath,
                    input.dpi,
                    input.cleanupMode,
                    Math.max(1, brokerRun.lease.resources.cpuTokens),
                    brokerRun,
                ),
        );
    } catch (error) {
        if (input.signal.aborted || isAbortError(error) || getUnprovenNativeTerminationDetail(error) !== undefined) {
            throw error;
        }
        const message = 'OCR preprocessing failed; using raw page render';
        input.log('warn', `Native scan cleanup admission failed; using raw page render: ${getErrorMessage(error)}`);
        input.onDiagnostic({
            code: 'OCR_PREPROCESSING_FAILED',
            severity: 'warning',
            message,
        });
        return {path: input.renderedPath};
    }
}

/**
 * The raster the engine reads for a rendered page: with a preprocessing mode,
 * the cleaned page as the browser cleans it ('off' still normalizes
 * polarity); a cleanup that failed or changed the page size leaves the
 * rendered page with a diagnostic. Cleanup files go beside `renderedPath`.
 */
export async function prepareOcrPageRaster(input: IPrepareOcrPageRasterInput): Promise<IOcrPageRaster<Uint8Array>> {
    if (input.cleanupMode === undefined) {
        return readOcrRasterFile(input.renderedPath);
    }
    const renderedSize = await readOcrRasterDimensions(input.renderedPath);
    const cleanedPath = `${input.renderedPath}-clean.pnm`;
    const metadataPath = `${cleanedPath}.json`;
    const pageNumber = requirePageNumber(input.pageNumber);
    let diagnostic: IOcrDiagnostic | undefined;
    try {
        const cleaned = await runPreprocessWithBrokerLease({
            renderedPath: input.renderedPath,
            cleanedPath,
            metadataPath,
            renderedSize,
            dpi: input.dpi,
            cleanupMode: input.cleanupMode,
            scanCleanupBinary: input.scanCleanupBinary,
            ...(input.cleanupThreads === undefined ? {} : {cleanupThreads: input.cleanupThreads}),
            ...(input.broker === undefined ? {} : {broker: input.broker}),
            ...(input.brokerOwnerId === undefined ? {} : {brokerOwnerId: input.brokerOwnerId}),
            log: input.log,
            signal: input.signal,
            onDiagnostic: (reported) => {
                diagnostic = {
                    ...reported,
                    pageNumber,
                };
            },
        });
        if (cleaned.path === input.renderedPath) {
            const rendered = await readOcrRasterFile(input.renderedPath);
            return {
                ...rendered,
                ...(diagnostic ? {diagnostic} : {}),
            };
        }
        const page = await readOcrRasterFile(cleaned.path);
        if (page.width !== renderedSize.width || page.height !== renderedSize.height) {
            const rendered = await readOcrRasterFile(input.renderedPath);
            return {
                ...rendered,
                diagnostic: createOcrPreprocessingGeometryDiagnostic(pageNumber, renderedSize, page),
            };
        }
        return {
            width: renderedSize.width,
            height: renderedSize.height,
            image: page.image,
            ...(cleaned.inverseTransform
                ? {
                      preprocessInverse: {
                          rasterWidthPx: renderedSize.width,
                          rasterHeightPx: renderedSize.height,
                          matrix: cleaned.inverseTransform.matrix,
                      },
                  }
                : {}),
        };
    } finally {
        await Promise.all([cleanedPath, metadataPath].map((path) => rm(path, {force: true}))).catch(() => undefined);
    }
}

/**
 * File-backed variant of `prepareOcrPageRaster` for desktop OCR: avoids reading
 * 15-35 MiB PNM rasters into main-process memory or structured-cloning them
 * over utility-process IPC. The caller owns deleting the returned file path
 * after recognition settles; unused sibling files are removed immediately.
 */
export async function prepareOcrPageRasterFile(input: IPrepareOcrPageRasterInput): Promise<IOcrPageRaster<IOcrEngineImageFile>> {
    const renderedSize = await readOcrRasterDimensions(input.renderedPath);
    if (input.cleanupMode === undefined) {
        return {
            ...renderedSize,
            image: {
                kind: 'file',
                path: input.renderedPath,
                ...renderedSize,
            },
        };
    }
    const cleanedPath = `${input.renderedPath}-clean.pnm`;
    const metadataPath = `${cleanedPath}.json`;
    const pageNumber = requirePageNumber(input.pageNumber);
    let diagnostic: IOcrDiagnostic | undefined;
    let keepCleanedPath = false;
    let failure: unknown;
    try {
        const cleaned = await runPreprocessWithBrokerLease({
            renderedPath: input.renderedPath,
            cleanedPath,
            metadataPath,
            renderedSize,
            dpi: input.dpi,
            cleanupMode: input.cleanupMode,
            scanCleanupBinary: input.scanCleanupBinary,
            ...(input.cleanupThreads === undefined ? {} : {cleanupThreads: input.cleanupThreads}),
            ...(input.broker === undefined ? {} : {broker: input.broker}),
            ...(input.brokerOwnerId === undefined ? {} : {brokerOwnerId: input.brokerOwnerId}),
            log: input.log,
            signal: input.signal,
            onDiagnostic: (reported) => {
                diagnostic = {
                    ...reported,
                    pageNumber,
                };
            },
        });
        if (cleaned.path === input.renderedPath) {
            return {
                ...renderedSize,
                image: {
                    kind: 'file',
                    path: input.renderedPath,
                    ...renderedSize,
                },
                ...(diagnostic ? {diagnostic} : {}),
            };
        }
        const cleanedSize = await readOcrRasterDimensions(cleaned.path);
        if (cleanedSize.width !== renderedSize.width || cleanedSize.height !== renderedSize.height) {
            return {
                ...renderedSize,
                image: {
                    kind: 'file',
                    path: input.renderedPath,
                    ...renderedSize,
                },
                diagnostic: createOcrPreprocessingGeometryDiagnostic(pageNumber, renderedSize, cleanedSize),
            };
        }
        keepCleanedPath = true;
        await rm(input.renderedPath, {force: true}).catch(() => undefined);
        return {
            ...renderedSize,
            image: {
                kind: 'file',
                path: cleaned.path,
                ...cleanedSize,
            },
            ...(cleaned.inverseTransform
                ? {
                      preprocessInverse: {
                          rasterWidthPx: renderedSize.width,
                          rasterHeightPx: renderedSize.height,
                          matrix: cleaned.inverseTransform.matrix,
                      },
                  }
                : {}),
        };
    } catch (error) {
        failure = error;
        throw error;
    } finally {
        if (getUnprovenNativeTerminationDetail(failure) === undefined) {
            const pathsToRemove = keepCleanedPath ? [metadataPath] : [cleanedPath, metadataPath];
            await Promise.all(pathsToRemove.map((path) => rm(path, {force: true}))).catch(() => undefined);
        }
    }
}
