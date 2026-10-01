import type {
    IPdfDocument,
    IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { requirePageNumber } from '@contracts/pageNumbers';
import { AnnotationMode } from '@app/services/pdfjs/runtimeLib';
import type { IPdfPageRasterScheduler } from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import { createRenderTaskHiddenAnnotationOperationsFilter } from '@app/modules/pdf-viewer/engine/pdf-hidden-annotation-operations/createRenderTaskHiddenAnnotationOperationsFilter';
import type {
    IWorkspaceSurfaceBudgetController,
    IDocumentPageRenderRequest,
    IDocumentRenderLease,
} from '@app/modules/document-viewer/public';
import { resolveBoundedRasterDimensions } from '@app/modules/document-viewer/public';

const PDF_PAGE_SOURCE_MAX_PIXELS = 16 * 1024 * 1024;
const PDF_PAGE_SOURCE_MAX_DIMENSION = 32_767;

export async function renderPdfDocumentPageSource(options: {
    document: IPdfDocument;
    request: IDocumentPageRenderRequest;
    scopeId: string;
    surfaceBudget: IWorkspaceSurfaceBudgetController;
}): Promise<IDocumentRenderLease> {
    const {
        document,
        request,
        scopeId,
        surfaceBudget,
    } = options;
    request.signal.throwIfAborted();
    const page = await document.getPage(request.pageNumber);
    const baseViewport = page.getViewport({scale: 1});
    const requestedScale = request.widthPx / Math.max(1, baseViewport.width);
    const requestedViewport = page.getViewport({scale: requestedScale});
    const dimensions = resolveBoundedRasterDimensions({
        width: requestedViewport.width,
        height: requestedViewport.height,
        maxPixels: PDF_PAGE_SOURCE_MAX_PIXELS,
        maxDimension: PDF_PAGE_SOURCE_MAX_DIMENSION,
    });
    const viewport = page.getViewport({scale: requestedScale * dimensions.scale});
    const bytes = dimensions.width * dimensions.height * 4;
    const budgetLease = surfaceBudget.tryReserve({
        scopeId,
        category: 'pdf-page-canvas',
        bytes,
        priority: request.priority === 'navigation' ? 100 : 50,
        canEvict: () => false,
    });
    if (!budgetLease) {
        throw new RangeError('PDF page source exceeds the available workspace surface budget');
    }
    const canvas = window.document.createElement('canvas');
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const canvasContext = canvas.getContext('2d');
    if (!canvasContext) {
        budgetLease.release();
        throw new Error('PDF page-source canvas context is unavailable');
    }
    const renderTask = page.render({
        canvas,
        canvasContext,
        viewport,
    });
    const cancelRender = () => renderTask.cancel();
    request.signal.addEventListener('abort', cancelRender, {once: true});
    if (request.signal.aborted) {
        cancelRender();
    }
    try {
        await renderTask.promise;
        request.signal.throwIfAborted();
    } catch (error) {
        budgetLease.release();
        canvas.width = 0;
        canvas.height = 0;
        throw error;
    } finally {
        request.signal.removeEventListener('abort', cancelRender);
    }
    let released = false;
    return {
        widthPx: canvas.width,
        heightPx: canvas.height,
        bytes,
        surface: canvas,
        release() {
            if (released) {
                return;
            }
            released = true;
            budgetLease.release();
            canvas.width = 0;
            canvas.height = 0;
        },
    };
}

const PDF_THUMBNAIL_MAX_PIXELS = 4 * 1024 * 1024;
const PDF_THUMBNAIL_MAX_DIMENSION = 16_384;

interface IPreparedPdfThumbnail {
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
    viewport: ReturnType<IPdfPage['getViewport']>;
}

/**
 * A thumbnail is one raster request on the viewer's scheduler, so it queues
 * behind the pages on screen. It draws the annotation storage the page shows,
 * leaves out deleted annotations and follows the rotation the page geometry
 * presents, which a rotation preview changes before the rewritten file exists.
 */
export async function renderPdfDocumentThumbnail(options: {
    scheduler: IPdfPageRasterScheduler;
    /** The view's own thumbnail source on the scheduler its linked views share. */
    sourceId: string;
    request: IDocumentPageRenderRequest;
    surfaceBudget: IWorkspaceSurfaceBudgetController;
    rotation: number | undefined;
    hiddenAnnotationIds: ReadonlySet<string>;
}): Promise<IDocumentRenderLease> {
    const {
        scheduler,
        sourceId,
        request,
    } = options;
    const pageNumber = requirePageNumber(request.pageNumber);
    let lease: IDocumentRenderLease | null = null;
    let priority = request.priority;
    let invalidate: (() => void) | undefined;
    let budgetLease: ReturnType<IWorkspaceSurfaceBudgetController['reserve']> | null = null;
    const cancel = () => scheduler.invalidate({
        pages: [pageNumber],
        reason: 'thumbnail-demand-cancelled',
        sourceId,
    });
    request.signal.addEventListener('abort', cancel, {once: true});
    try {
        const outcome = await scheduler.request<IPreparedPdfThumbnail>({
            sourceId,
            demand: {
                pageNumber,
                renderKey: `${String(pageNumber)}:${String(request.widthPx)}`,
                lane: 'thumbnail-visible',
                ordinal: 0,
                estimatedPixels: request.widthPx * request.widthPx * 2,
                retention: 'render-cache',
                documentFence: scheduler.documentFence,
                consumerGeneration: 0,
            },
            target: {
                id: sourceId,
                prepare(_demand, page) {
                    const rotation = options.rotation === undefined ? {} : {rotation: options.rotation};
                    const baseViewport = page.getViewport({
                        scale: 1,
                        ...rotation,
                    });
                    const requestedScale = request.widthPx / Math.max(1, baseViewport.width);
                    const dimensions = resolveBoundedRasterDimensions({
                        width: baseViewport.width * requestedScale,
                        height: baseViewport.height * requestedScale,
                        maxPixels: PDF_THUMBNAIL_MAX_PIXELS,
                        maxDimension: PDF_THUMBNAIL_MAX_DIMENSION,
                    });
                    const canvas = window.document.createElement('canvas');
                    canvas.width = dimensions.width;
                    canvas.height = dimensions.height;
                    const context = canvas.getContext('2d');
                    return Promise.resolve(context
                        ? {
                            canvas,
                            context,
                            viewport: page.getViewport({
                                scale: requestedScale * dimensions.scale,
                                ...rotation,
                            }),
                        }
                        : null);
                },
                start(prepared, page) {
                    const renderOptions = {
                        annotationMode: AnnotationMode?.ENABLE_STORAGE ?? AnnotationMode?.ENABLE_FORMS ?? 1,
                        canvas: prepared.canvas,
                        canvasContext: prepared.context,
                        viewport: prepared.viewport,
                    };
                    if (options.hiddenAnnotationIds.size === 0) {
                        return page.render(renderOptions);
                    }
                    const filter = createRenderTaskHiddenAnnotationOperationsFilter(options.hiddenAnnotationIds);
                    const task = page.render({
                        ...renderOptions,
                        operationsFilter: filter.filter,
                    });
                    if (filter.bindTask(task)) {
                        return task;
                    }
                    // Without the operator list nothing can be left out
                    // selectively, so drop every annotation rather than show a
                    // deleted one.
                    task.cancel();
                    return page.render({
                        ...renderOptions,
                        annotationMode: AnnotationMode?.DISABLE ?? 0,
                    });
                },
                commit(prepared) {
                    const {canvas} = prepared;
                    lease = {
                        widthPx: canvas.width,
                        heightPx: canvas.height,
                        bytes: canvas.width * canvas.height * 4,
                        surface: canvas,
                        onInvalidated(listener) {
                            invalidate = listener;
                            return () => { invalidate = undefined; };
                        },
                        setPriority(nextPriority) {
                            priority = nextPriority;
                            budgetLease?.setPriority?.(nextPriority === 'visible' ? 100 : nextPriority === 'thumbnail' ? 20 : 0);
                        },
                        release() {
                            invalidate = undefined;
                            budgetLease?.release();
                            canvas.width = 0;
                            canvas.height = 0;
                        },
                    };
                    return true;
                },
                discard(prepared) {
                    prepared.canvas.width = 0;
                    prepared.canvas.height = 0;
                },
                release() {},
            },
        });
        if (outcome.status === 'failed') {
            throw outcome.error;
        }
        if (outcome.status !== 'committed' || !lease) {
            throw new DOMException('Thumbnail render was cancelled', 'AbortError');
        }
        // Transfer the temporary raster reservation to the rail's retained
        // lease before publication. Keeping a scheduler resident as well would
        // duplicate ownership; releasing an old canvas must not invalidate a
        // newer request for the same page.
        cancel();
        const reservation = {
            scopeId: 'pdf-thumbnails',
            category: 'pdf-thumbnail-canvas',
            bytes: (lease as IDocumentRenderLease).bytes,
            priority: priority === 'visible' ? 100 : 20,
            canEvict: () => priority !== 'visible',
            evict: () => {
                invalidate?.();
                lease?.release();
            },
        } as const;
        budgetLease = priority === 'visible'
            ? options.surfaceBudget.reserve(reservation)
            : options.surfaceBudget.tryReserve(reservation);
        if (!budgetLease) {
            (lease as IDocumentRenderLease).release();
            throw new RangeError('PDF thumbnail exceeds the available workspace surface budget');
        }
        return lease;
    } finally {
        request.signal.removeEventListener('abort', cancel);
        cancel();
    }
}
