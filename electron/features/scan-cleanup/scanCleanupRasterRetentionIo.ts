import {join} from 'path';
import type {IPdfPageSize} from '@electron/pdf/pdfPageSizes';
import type {
    IRetainedDocument,
    IRetainedRawRaster,
    IScanCleanupRasterDependencies,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {SCAN_CLEANUP_MAX_DIMENSION_PX} from '@contracts/scan-cleanup/inputLimits';
import {
    readScanCleanupPngDimensions as readPngDimensions,
    resolveScanCleanupRasterRenderLimits as resolveRasterRenderLimits,
    SCAN_CLEANUP_RASTER_MAX_PIXELS,
} from '@evb/scan-cleanup/core/rasterValidation';
import {
    encodePngFromPpm,
    readPpmDimensions,
} from '@evb/scan-cleanup/core/rasterLayerDimensions';
import {getErrorMessage} from '@electron/utils/error';
import {createLogger} from '@electron/utils/createLogger';

const logger = createLogger('scan-cleanup-raster-retention-io');
const PREVIEW_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const PPM_HEADER_MAX_BYTES = 4_096;
const MAX_PREVIEW_PPM_BYTES = SCAN_CLEANUP_RASTER_MAX_PIXELS * 3 + PPM_HEADER_MAX_BYTES;

function isPpmSignature(bytes: Uint8Array) {
    return bytes.byteLength >= 2 && bytes[0] === 0x50 && bytes[1] === 0x36;
}

async function isPpmFile(
    path: string,
    open: NonNullable<IScanCleanupRasterDependencies['open']>,
) {
    const handle = await open(path, 'r');
    try {
        const magic = Buffer.alloc(2);
        const {bytesRead} = await handle.read(magic, 0, 2, 0);
        return bytesRead === 2 && isPpmSignature(magic);
    } finally {
        await handle.close();
    }
}
export function logScanCleanupMessage(level: 'debug' | 'error' | 'info' | 'warn', message: string) {
    if (level === 'error') {
        logger.error(message, {code: 'MAIN_SCAN_CLEANUP_FAILED'});
        return;
    }
    logger[level](message);
}

export function closeScanCleanupPageSizeStores(
    document: IRetainedDocument,
    pendingClosures: Set<Promise<void>>,
) {
    const stores = document.pageSizeStores;
    document.pageSizeStores = new Set();
    document.pageSizeStore = null;
    document.rasterPageSourceStore = null;
    document.rasterPageSource = null;
    document.rasterPageSourceReader = null;
    const closing = Promise.all([...stores].map(store => store.close().catch(error => {
        logger.warn(`Scan cleanup could not close the raster page-size store: ${getErrorMessage(error)}`);
    }))).then(() => undefined);
    pendingClosures.add(closing);
    void closing.finally(() => pendingClosures.delete(closing));
    return closing;
}

export function createScanCleanupPathOperationQueue() {
    const operations = new Map<string, Promise<void>>();
    const enqueue = <T>(path: string, operation: () => Promise<T>) => {
        const previous = operations.get(path) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(operation);
        const tracked = next.then(() => undefined, () => undefined);
        operations.set(path, tracked);
        void next.finally(() => {
            if (operations.get(path) === tracked) {operations.delete(path);}
        }).catch(() => undefined);
        return next;
    };
    enqueue.drain = async () => {
        while (operations.size > 0) {
            await Promise.all([...operations.values()]);
        }
    };
    return enqueue;
}

/**
 * A page rendered through its MediaBox is a different raster from its CropBox
 * render at the same DPI, so the view is part of the raster's identity.
 */
export type TScanCleanupRasterView = 'mediabox' | undefined;

export function stableScanCleanupRasterPath(dir: string, pageNumber: number, dpi: number, view?: TScanCleanupRasterView) {
    return join(dir, `page-${pageNumber}-${dpi}${view === undefined ? '' : `-${view}`}.png`);
}

export function createScanCleanupReadLifecycle() {
    let pendingCount = 0;
    let resolveSettled: (() => void) | null = null;
    let settled = Promise.resolve();
    return {
        begin() {
            if (pendingCount === 0) {
                settled = new Promise(resolve => {
                    resolveSettled = resolve;
                });
            }
            pendingCount += 1;
        },
        finish() {
            pendingCount -= 1;
            if (pendingCount === 0) {
                resolveSettled?.();
                resolveSettled = null;
            }
        },
        get pendingCount() {
            return pendingCount;
        },
        get settled() {
            return settled;
        },
    };
}

export function createScanCleanupRasterRemovalCoordinator(input: {
    enqueue: ReturnType<typeof createScanCleanupPathOperationQueue>;
    rasters: Map<string, IRetainedRawRaster>;
    removePath: (
        path: string,
        options: {
            force: boolean;
            recursive: boolean;
        },
    ) => Promise<void>;
}) {
    const pendingCleanups = new Set<Promise<void>>();
    const removeQuietly = (path: string): Promise<void> => input.removePath(path, {
        force: true,
        recursive: true,
    }).catch(error => logger.warn(
        `Failed to drop a retained scan cleanup raster: ${getErrorMessage(error)}`,
    ));
    const remove = (path: string) => {
        const cleanup: Promise<void> = input.enqueue(path, async () => {
            await removeQuietly(path);
        });
        pendingCleanups.add(cleanup);
        void cleanup.finally(() => pendingCleanups.delete(cleanup)).catch(() => undefined);
    };
    const removeRaster = (raster: IRetainedRawRaster) => {
        void input.enqueue(raster.path, async () => {
            if ([...input.rasters.values()].some(current => (
                current.path === raster.path && current !== raster
            ))) {
                return;
            }
            await removeQuietly(raster.path);
        });
    };
    return {
        pendingCleanups,
        remove,
        removeQuietly,
        removeRaster,
    };
}

export interface IScanCleanupRetainedReadOperation {
    raster: IRetainedRawRaster;
    token: symbol;
}

export function createScanCleanupRasterKey(
    document: IRetainedDocument,
    pageNumber: number,
    dpi: number,
    view?: TScanCleanupRasterView,
) {
    return JSON.stringify([
        document.sourcePdfPath,
        document.documentRevision,
        document.sourceStatIdentity,
        pageNumber,
        dpi,
        ...(view === undefined ? [] : [view]),
    ]);
}

type IRequiredRasterDependencies = IScanCleanupRasterDependencies & Required<Pick<
    IScanCleanupRasterDependencies,
    'fileSystem' | 'getAvailableScratchBytes' | 'getSourceStatIdentity'
>>;

export function requireScanCleanupRasterDependencies(
    dependencies: IScanCleanupRasterDependencies,
): IRequiredRasterDependencies {
    const {
        fileSystem,
        getAvailableScratchBytes,
        getSourceStatIdentity,
    } = dependencies;
    if (!fileSystem || !getAvailableScratchBytes || !getSourceStatIdentity) {
        throw new Error('Scan cleanup retention requires complete injected capabilities');
    }
    return {
        ...dependencies,
        fileSystem,
        getAvailableScratchBytes,
        getSourceStatIdentity,
    };
}

export async function readRetainedRaster<TValue>(input: {
    key: string;
    generation: number;
    document: IRetainedDocument;
    raster: IRetainedRawRaster;
    rasters: Map<string, IRetainedRawRaster>;
    inFlightReads: Map<string, IScanCleanupRetainedReadOperation>;
    pendingRasterReleases: Set<symbol>;
    currentGeneration: () => number;
    beginRead: () => void;
    finishRead: (key: string, operation: IScanCleanupRetainedReadOperation) => void;
    adjustBytes: (delta: number) => void;
    adopt: (key: string) => void;
    load: (raster: IRetainedRawRaster) => Promise<TValue>;
    refresh: (raster: IRetainedRawRaster, value: TValue) => IRetainedRawRaster;
}): Promise<{
    value: TValue;
    raster: IRetainedRawRaster
} | null> {
    input.beginRead();
    input.rasters.delete(input.key);
    const operation: IScanCleanupRetainedReadOperation = {
        raster: input.raster,
        token: Symbol('scan-cleanup-retained-read'),
    };
    input.inFlightReads.set(input.key, operation);
    try {
        const value = await input.load(input.raster);
        const refreshed = input.refresh(input.raster, value);
        input.adjustBytes(refreshed.sizeBytes - input.raster.sizeBytes);
        const canRestore = input.inFlightReads.get(input.key)?.token === operation.token
            && input.currentGeneration() === input.generation
            && !input.document.removeWhenIdle
            && !input.pendingRasterReleases.has(operation.token)
            && !input.rasters.has(input.key);
        if (canRestore) {
            input.rasters.set(input.key, refreshed);
            input.adopt(input.key);
        } else {
            input.adjustBytes(-refreshed.sizeBytes);
        }
        input.finishRead(input.key, operation);
        return canRestore ? {
            value,
            raster: refreshed,
        } : null;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            const canRestore = input.inFlightReads.get(input.key)?.token === operation.token
                && input.currentGeneration() === input.generation
                && !input.document.removeWhenIdle
                && !input.pendingRasterReleases.has(operation.token)
                && !input.rasters.has(input.key);
            if (canRestore) {input.rasters.set(input.key, input.raster);}
            else {input.adjustBytes(-input.raster.sizeBytes);}
            input.finishRead(input.key, operation);
            throw error;
        }
        input.adjustBytes(-input.raster.sizeBytes);
        input.finishRead(input.key, operation);
        return null;
    }
}

export async function readPreviewBytes(
    path: string,
    dependencies: IScanCleanupRasterDependencies,
): Promise<Uint8Array> {
    if (!dependencies.stat || !dependencies.readFile) {
        throw new Error('Scan cleanup raster I/O requires injected stat and readFile capabilities');
    }
    const file = await dependencies.stat(path);
    if (file.size < 1) {
        throw new Error(`Scan cleanup preview image exceeds ${PREVIEW_MAX_IMAGE_BYTES} bytes`);
    }
    if (file.size <= MAX_PREVIEW_PPM_BYTES && dependencies.open && await isPpmFile(path, dependencies.open)) {
        try {
            const {bytes} = await encodePngFromPpm(path, {
                maxPixels: SCAN_CLEANUP_RASTER_MAX_PIXELS,
                maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
                maxOutputBytes: PREVIEW_MAX_IMAGE_BYTES,
                open: dependencies.open,
            });
            return bytes;
        } catch (error) {
            if (error instanceof RangeError && error.message.includes('Encoded PNG exceeds')) {
                throw new Error(`Scan cleanup preview image exceeds ${PREVIEW_MAX_IMAGE_BYTES} bytes`, {cause: error});
            }
            throw error;
        }
    }
    if (file.size > PREVIEW_MAX_IMAGE_BYTES) {
        throw new Error(`Scan cleanup preview image exceeds ${PREVIEW_MAX_IMAGE_BYTES} bytes`);
    }
    const contents = await dependencies.readFile(path);
    const bytes = typeof contents === 'string' ? Buffer.from(contents) : new Uint8Array(contents);
    readPngDimensions(bytes, undefined, 'preview');
    return bytes;
}

export async function readPreviewMetadata(
    path: string,
    dependencies: IScanCleanupRasterDependencies,
) {
    if (!dependencies.stat || !dependencies.open) {
        throw new Error('Scan cleanup raster metadata requires injected stat and open capabilities');
    }
    // A path-only raster is native input, never IPC bytes, so the preview
    // byte budget does not apply; its pixel cap is the one it was rendered to.
    const file = await dependencies.stat(path);
    if (file.size < 1) {
        throw new Error('Scan cleanup raster is empty');
    }
    const handle = await dependencies.open(path, 'r');
    let header: Buffer;
    let bytesRead: number;
    try {
        header = Buffer.alloc(24);
        ({bytesRead} = await handle.read(header, 0, header.byteLength, 0));
    } finally {
        await handle.close();
    }
    if (bytesRead >= 2 && isPpmSignature(header)) {
        const dimensions = await readPpmDimensions(path, dependencies.open);
        if (dimensions.width * dimensions.height > SCAN_CLEANUP_RASTER_MAX_PIXELS) {
            throw new Error(
                `Scan cleanup preview PPM dimensions ${dimensions.width}x${dimensions.height} exceed limits`,
            );
        }
        return {
            width: dimensions.width,
            height: dimensions.height,
            sizeBytes: file.size,
        };
    }
    if (bytesRead !== header.byteLength) {throw new Error('Scan cleanup raster produced a truncated PNG');}
    return {
        ...readPngDimensions(header, undefined, 'preview'),
        sizeBytes: file.size,
    };
}

interface IRawRasterMaterializer {
    pageCount(document: IRetainedDocument, signal: AbortSignal): Promise<number>;
    rasterScratchPath(document: IRetainedDocument, pageNumber: number, dpi: number): Promise<string>;
}

export async function renderUnretainedRawRaster(
    document: IRetainedDocument,
    pageNumber: number,
    signal: AbortSignal,
    retention: IRawRasterMaterializer,
    dependencies: IScanCleanupRasterDependencies,
    knownTotalPages: number | undefined,
    dpi: number,
    pageSize: IPdfPageSize | undefined,
) {
    const totalPages = knownTotalPages ?? await retention.pageCount(document, signal);
    if (pageNumber > totalPages) {
        throw new Error('Scan cleanup preview page is out of range');
    }
    const scratchPath = await retention.rasterScratchPath(document, pageNumber, dpi);
    await dependencies.renderPage(
        {pdftoppmBinary: dependencies.getPdftoppmBinary()},
        logScanCleanupMessage,
        pageNumber,
        document.sourcePdfPath,
        scratchPath,
        dpi,
        undefined,
        signal,
        undefined,
        resolveRasterRenderLimits(pageSize, dpi),
        pageSize?.renderBox ?? 'cropbox',
        'exclude',
    );
    return {
        scratchPath,
        totalPages,
    };
}
