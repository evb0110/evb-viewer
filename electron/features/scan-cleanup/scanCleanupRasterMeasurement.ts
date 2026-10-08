import type {
    IPdfPageSize,
    IPdfPageSizeStore,
} from '@electron/pdf/pdfPageSizes';
import {resolveScanCleanupRasterPageSizeStore} from '@electron/features/scan-cleanup/resolveScanCleanupRasterPageSizeStore';
import {detectPageRasterFromPageSize} from '@evb/scan-cleanup/core/types';
import type {IScanCleanupPreviewRequest} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {PREVIEW_DPI} from '@evb/scan-cleanup/core/detection';
import {
    addScanCleanupDocumentCanvasPage,
    createScanCleanupDocumentCanvasAccumulator,
    type IScanCleanupDocumentCanvasAccumulator,
} from '@evb/scan-cleanup/core/policy/documentCanvas';
import type {
    IBoundedPreviewGeometry,
    IPreviewDocumentFacts,
    IRetainedDocument,
    IScanCleanupRasterDependencies,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {PAGE_MEASUREMENT_CACHE_MAX_ENTRIES} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
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

/** Matched-canvas summaries kept per retained document. */
const PREVIEW_CANVAS_SIGNATURES_RETAINED = 4;

async function forEachDocumentPage(
    store: IPdfPageSizeStore,
    totalPages: number,
    visit: (page: IPdfPageSize) => void,
) {
    let expectedPageNumber = 1;
    await store.forEachChunk(chunk => {
        if (chunk.pageCount !== totalPages) {
            throw new Error(
                `Scan cleanup page-size store reported ${String(chunk.pageCount)} pages for ${String(totalPages)} document pages`,
            );
        }
        for (const page of chunk.pages) {
            if (page.pageNumber !== expectedPageNumber) {
                throw new Error(
                    `Scan cleanup page-size store returned page ${String(page.pageNumber)} where page ${String(expectedPageNumber)} was expected`,
                );
            }
            visit(page);
            expectedPageNumber += 1;
        }
    });
    if (expectedPageNumber - 1 !== totalPages) {
        throw new Error(
            `Scan cleanup page-size store returned ${String(expectedPageNumber - 1)} pages for ${String(totalPages)} document pages`,
        );
    }
}

/**
 * The geometry one preview needs: the requested page and its source DPI, the
 * document's preview DPI and, for a matched preview, the canvas summary.
 * Document-wide values come from the retained document, which measures each
 * of them in one bounded pass and keeps them for later previews.
 */
export async function readBoundedPreviewGeometry(
    document: IRetainedDocument,
    store: IPdfPageSizeStore,
    totalPages: number,
    request: Pick<IScanCleanupPreviewRequest, 'pageNumber' | 'layoutByPage' | 'options'>,
    signal: AbortSignal,
): Promise<IBoundedPreviewGeometry> {
    const facts = await resolveScanCleanupDocumentMeasurement<IPreviewDocumentFacts>(
        {
            read: () => document.previewDocumentFacts,
            write: value => {
                document.previewDocumentFacts = value;
            },
        },
        signal,
        async () => {
            let allPagesHaveRasterMetadata = true as boolean;
            let documentDpi = 0;
            await forEachDocumentPage(store, totalPages, page => {
                const raster = detectPageRasterFromPageSize(page);
                if (raster === undefined) {
                    allPagesHaveRasterMetadata = false;
                } else {
                    documentDpi = Math.max(documentDpi, raster.dpi);
                }
            });
            return {
                allPagesHaveRasterMetadata,
                previewDpi: allPagesHaveRasterMetadata && documentDpi > 0
                    ? Math.min(PREVIEW_DPI, documentDpi)
                    : PREVIEW_DPI,
            };
        },
    );
    const accumulator = request.options.matchPageSize
        ? await resolvePreviewCanvas(document, store, totalPages, request, signal)
        : createScanCleanupDocumentCanvasAccumulator();
    const pageSize = request.pageNumber >= 1 && request.pageNumber <= totalPages
        ? await store.getPage(request.pageNumber)
        : undefined;
    const pageRaster = pageSize === undefined ? undefined : detectPageRasterFromPageSize(pageSize);
    return {
        accumulator,
        pageSize,
        previewDpi: facts.previewDpi,
        pageSourceDpi: facts.allPagesHaveRasterMetadata ? pageRaster?.dpi : undefined,
    };
}

function resolvePreviewCanvas(
    document: IRetainedDocument,
    store: IPdfPageSizeStore,
    totalPages: number,
    request: Pick<IScanCleanupPreviewRequest, 'layoutByPage' | 'options'>,
    signal: AbortSignal,
) {
    const signature = JSON.stringify([
        request.options,
        request.layoutByPage ?? null,
    ]);
    const canvases = document.previewCanvasBySignature;
    const retained = canvases.get(signature);
    if (retained !== undefined) {
        // Map order is the recency order.
        canvases.delete(signature);
        canvases.set(signature, retained);
    }
    return resolveScanCleanupDocumentMeasurement<IScanCleanupDocumentCanvasAccumulator>(
        {
            read: () => canvases.get(signature) ?? null,
            write: value => {
                if (value === null) {
                    canvases.delete(signature);
                    return;
                }
                canvases.set(signature, value);
                while (canvases.size > PREVIEW_CANVAS_SIGNATURES_RETAINED) {
                    canvases.delete(canvases.keys().next().value!);
                }
            },
        },
        signal,
        async () => {
            const accumulator = createScanCleanupDocumentCanvasAccumulator();
            await forEachDocumentPage(store, totalPages, page => addScanCleanupDocumentCanvasPage(
                accumulator,
                page,
                request.options,
                request.layoutByPage?.[String(page.pageNumber)],
            ));
            return accumulator;
        },
    );
}
