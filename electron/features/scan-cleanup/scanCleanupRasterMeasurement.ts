import {PAGE_MEASUREMENT_CACHE_MAX_ENTRIES} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import type {
    IPdfPageSize,
    IPdfPageSizeStore,
} from '@electron/pdf/pdfPageSizes';
import {resolveScanCleanupRasterPageSizeStore} from '@electron/features/scan-cleanup/resolveScanCleanupRasterPageSizeStore';
import {detectPageRasterFromPageSize} from '@evb/scan-cleanup/core/types';
import type {
    IRetainedDocument,
    IScanCleanupRasterDependencies,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';

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
    const resolvePageSizeStore = (document: IRetainedDocument, signal: AbortSignal) => resolveScanCleanupDocumentMeasurement(
        {
            read: () => document.pageSizeStore,
            write: value => {
                document.pageSizeStore = value;
            },
        },
        signal,
        () => resolveScanCleanupRasterPageSizeStore({
            dependencies: input.dependencies,
            document,
            signal,
            disposed: input.disposed,
            generation: input.documentGenerations.get(document) ?? 0,
            currentGeneration: () => input.documentGenerations.get(document) ?? 0,
            observePageSizeStore,
        }),
    );
    return {
        resolvePageCount,
        resolvePageSizeStore,
    };
}
