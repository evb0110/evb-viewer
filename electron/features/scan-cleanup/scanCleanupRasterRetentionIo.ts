import {join} from 'path';
import type {IPdfPageSize} from '@electron/pdf/pdfPageSizes';
import type {
    IRetainedDocument,
    IRetainedRawRaster,
    IScanCleanupRasterDependencies,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {PREVIEW_MAX_IMAGE_BYTES} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {
    readScanCleanupPngDimensions as readPngDimensions,
    resolveScanCleanupRasterRenderLimits as resolveRasterRenderLimits,
} from '@evb/scan-cleanup/core/rasterValidation';
import {getErrorMessage} from '@electron/utils/error';
import {createLogger} from '@electron/utils/createLogger';

const logger = createLogger('scan-cleanup-raster-retention-io');
export function logScanCleanupMessage(level: 'debug' | 'error' | 'info' | 'warn', message: string) {
    if (level === 'error') {
        logger.error(message, {
            code: 'MAIN_SCAN_CLEANUP_FAILED',
            context: {},
        });
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
    document.rasterPageSourceStore = null;
    document.rasterPageSource = null;
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
            if (operations.get(path) === tracked) operations.delete(path);
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

export function stableScanCleanupRasterPath(dir: string, pageNumber: number, dpi: number) {
    return join(dir, `page-${pageNumber}-${dpi}.png`);
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
) {
    return JSON.stringify([
        document.sourcePdfPath,
        document.documentRevision,
        document.sourceStatIdentity,
        pageNumber,
        dpi,
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
            if (canRestore) input.rasters.set(input.key, input.raster);
            else input.adjustBytes(-input.raster.sizeBytes);
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
    if (file.size < 1 || file.size > PREVIEW_MAX_IMAGE_BYTES) {
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
    const file = await dependencies.stat(path);
    if (file.size < 1 || file.size > PREVIEW_MAX_IMAGE_BYTES) {
        throw new Error(`Scan cleanup preview image exceeds ${PREVIEW_MAX_IMAGE_BYTES} bytes`);
    }
    const handle = await dependencies.open(path, 'r');
    try {
        const header = Buffer.alloc(24);
        const {bytesRead} = await handle.read(header, 0, header.byteLength, 0);
        if (bytesRead !== header.byteLength) throw new Error('Scan cleanup raster produced a truncated PNG');
        return {
            ...readPngDimensions(header, undefined, 'preview'),
            sizeBytes: file.size,
        };
    } finally {
        await handle.close();
    }
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
    );
    return {
        scratchPath,
        totalPages,
    };
}
