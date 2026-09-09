import {PAGE_MEASUREMENT_CACHE_MAX_ENTRIES} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import type {
    IPdfPageSize,
    IPdfPageSizeStore,
} from '@electron/pdf/pdfPageSizes';
import {getErrorMessage} from '@electron/utils/error';
import {createLogger} from '@electron/utils/createLogger';
import {resolveScanCleanupRasterPageSizeStore} from '@electron/features/scan-cleanup/resolveScanCleanupRasterPageSizeStore';
import {logScanCleanupMessage} from '@electron/features/scan-cleanup/scanCleanupRasterRetentionIo';
import {detectPageRasterFromPageSize} from '@evb/scan-cleanup/core/types';
import type {
    IRetainedDocument,
    IScanCleanupRasterDependencies,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';

const logger = createLogger('scan-cleanup-raster-measurement');

export function resolveScanCleanupDocumentMeasurement<TValue>(
    slot: {
        read: () => Promise<TValue> | null;
        write: (value: Promise<TValue> | null) => void;
    },
    signal: AbortSignal,
    measure: () => Promise<TValue>,
) {
    signal.throwIfAborted();
    let pending = slot.read();
    if (!pending) {
        pending = measure();
        slot.write(pending);
        const started = pending;
        void started.catch(() => {
            if (slot.read() === started) slot.write(null);
        });
    }
    const shared = pending;
    return new Promise<TValue>((resolve, reject) => {
        const onAbort = () => {
            reject(signal.reason instanceof Error
                ? signal.reason
                : new DOMException('Scan cleanup document measurement was abandoned', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, {once: true});
        shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}

export function resolveScanCleanupDocumentPageMeasurement<TValue>(
    slots: Map<number, Promise<TValue>>,
    pageNumber: number,
    signal: AbortSignal,
    measure: () => Promise<TValue>,
) {
    return resolveScanCleanupDocumentMeasurement(
        {
            read: () => {
                const pending = slots.get(pageNumber);
                if (pending !== undefined) {
                    slots.delete(pageNumber);
                    slots.set(pageNumber, pending);
                }
                return pending ?? null;
            },
            write: value => {
                if (value === null) {
                    slots.delete(pageNumber);
                } else {
                    slots.delete(pageNumber);
                    slots.set(pageNumber, value);
                    while (slots.size > PAGE_MEASUREMENT_CACHE_MAX_ENTRIES) {
                        const oldest = slots.keys().next().value;
                        if (oldest === undefined) break;
                        slots.delete(oldest);
                    }
                }
            },
        },
        signal,
        measure,
    );
}

export function createScanCleanupRasterMeasurements(input: {
    dependencies: IScanCleanupRasterDependencies;
    documentGenerations: WeakMap<IRetainedDocument, number>;
    disposed: () => boolean;
}) {
    const resolvePageCount = (document: IRetainedDocument, signal: AbortSignal) => resolveScanCleanupDocumentMeasurement(
        {
            read: () => document.pageCount,
            write: value => {
                document.pageCount = value;
            },
        },
        signal,
        () => input.dependencies.getPageCount(document.sourcePdfPath, {signal: document.lifetime.signal}),
    );
    const resolvePreviewPageSizes = (document: IRetainedDocument, signal: AbortSignal) => resolveScanCleanupDocumentMeasurement(
        {
            read: () => document.previewPageSizes,
            write: value => {
                document.previewPageSizes = value;
            },
        },
        signal,
        async () => {
            try {
                const pdfPageOpsBinary = input.dependencies.resolvePageOpsBinary();
                const pdfinfoBinary = input.dependencies.resolvePdfInfoBinary?.();
                if (!pdfPageOpsBinary && !pdfinfoBinary) {
                    throw new Error('no PDF tool is available to read page geometry');
                }
                return await input.dependencies.getPageSizes(document.sourcePdfPath, {
                    ...(pdfPageOpsBinary ? {pdfPageOpsBinary} : {}),
                    ...(pdfinfoBinary ? {pdfinfoBinary} : {}),
                    tempDir: await document.dir,
                    signal: document.lifetime.signal,
                    log: logScanCleanupMessage,
                });
            } catch (error) {
                logger.warn(`Scan cleanup could not measure the document canvas: ${getErrorMessage(error)}`);
                throw new Error(
                    `Scan cleanup could not measure this document's page sizes, which matched page size needs: ${getErrorMessage(error)}`,
                );
            }
        },
    );
    const observePageSize = (document: IRetainedDocument, page: IPdfPageSize) => {
        const raster = detectPageRasterFromPageSize(page);
        if (raster !== undefined) {
            document.pageGeometryDpi = Math.max(document.pageGeometryDpi ?? 0, raster.dpi);
        }
    };
    const observePageSizeStore = (
        document: IRetainedDocument,
        store: IPdfPageSizeStore,
    ): IPdfPageSizeStore => {
        const fork = store.fork === undefined
            ? undefined
            : () => observePageSizeStore(document, store.fork!());
        return {
            get pageCount() {
                return store.pageCount;
            },
            getPage: async pageNumber => {
                const page = await store.getPage(pageNumber);
                observePageSize(document, page);
                return page;
            },
            readRange: async (firstPageNumber, lastPageNumberExclusive) => {
                const pages = await store.readRange(firstPageNumber, lastPageNumberExclusive);
                for (const page of pages) observePageSize(document, page);
                return pages;
            },
            forEachChunk: async onChunk => {
                await store.forEachChunk(async chunk => {
                    for (const page of chunk.pages) observePageSize(document, page);
                    await onChunk(chunk);
                });
            },
            close: () => store.close(),
            ...(fork === undefined ? {} : {fork}),
        };
    };
    const resolvePageSizeStore = (document: IRetainedDocument, signal: AbortSignal) => resolveScanCleanupRasterPageSizeStore({
        dependencies: input.dependencies,
        document,
        signal,
        disposed: input.disposed,
        generation: input.documentGenerations.get(document) ?? 0,
        currentGeneration: () => input.documentGenerations.get(document) ?? 0,
        resolvePageCount,
        resolvePreviewPageSizes,
        observePageSizeStore,
    });
    return {
        resolvePageCount,
        resolvePreviewPageSizes,
        resolvePageSizeStore,
    };
}
