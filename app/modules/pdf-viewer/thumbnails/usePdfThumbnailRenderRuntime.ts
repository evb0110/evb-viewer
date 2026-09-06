import type {
    IPdfDocument,
    IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { groupBy } from 'es-toolkit/array';
import { clamp } from 'es-toolkit/math';
import { createRenderTaskHiddenAnnotationOperationsFilter } from '@app/modules/pdf-viewer/engine/pdf-hidden-annotation-operations/createRenderTaskHiddenAnnotationOperationsFilter';
import { AnnotationMode } from '@app/services/pdfjs/runtimeLib';
import { leasePdfDocumentPage } from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    IPdfRasterDemand,
    IPdfRasterDemandPolicy,
    IPdfRasterRenderTarget,
    IPdfPageRasterScheduler,
    TPdfRasterLane,
} from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import { BrowserLogger } from '@app/utils/browserLogger';
import { isPdfDocumentUsable } from '@app/utils/isPdfDocumentUsable';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import {
    buildThumbnailRenderTransform,
    isThumbnailRasterWidthReady,
    resolveThumbnailRasterWidth,
    roundMetric,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailRenderMetrics';
import {
    resolvePdfThumbnailItemChromeHeight,
    resolvePdfThumbnailRenderWidth,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailDomMetrics';
import {
    createEditedTextMarkupThumbnailVisualSignature,
    createHiddenAnnotationIdsSignature,
    getEditedTextMarkupThumbnailComments,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailTextMarkupVisuals';
import { resolveThumbnailItemHeightFromAspect } from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailLayout';
import type { IUsePdfThumbnailRenderRuntimeOptions } from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailRenderRuntimeOptions';
import { createThumbnailRenderFrameScheduler } from '@app/modules/pdf-viewer/thumbnails/createThumbnailRenderFrameScheduler';
import { shouldPreserveThumbnailBitmap } from '@app/modules/pdf-viewer/thumbnails/shouldPreserveThumbnailBitmap';
import { resolveBoundedRasterDimensions } from '@app/utils/document-viewer/resolveBoundedRasterDimensions';

export const PDF_THUMBNAIL_LOG_SECTION = 'pdf-thumbnails';
const IMMEDIATE_RENDER_RADIUS = 2;
const PREFETCH_RENDER_RADIUS = 4;
const MAX_THUMBNAIL_OUTPUT_SCALE = 2;
const THUMBNAIL_RASTER_SOURCE_ID = 'pdf-thumbnails';

interface IPdfThumbnailDemandInput {
    active: boolean;
    currentPage: number;
    documentFence: IPdfPageRasterScheduler['documentFence'];
    estimatedPixels: (pageNumber: number) => number;
    generation: number;
    mountedPages: readonly number[];
    totalPages: number;
    visiblePages: readonly number[];
}

interface IPreparedThumbnailRaster {
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
    hiddenAnnotationFilter: ReturnType<typeof createRenderTaskHiddenAnnotationOperationsFilter> | null;
    metrics: {
        pixelHeight: number;
        pixelWidth: number;
        scaleX: number;
        scaleY: number;
        scaledViewport: ReturnType<IPdfPage['getViewport']>;
    };
    page: IPdfPage;
    pageNumber: number;
    renderCanvas: HTMLCanvasElement;
    renderKey: string;
}

function normalizeThumbnailPage(page: number, totalPages: number) {
    return totalPages <= 0 ? 0 : clamp(Math.trunc(page), 1, totalPages);
}

function resolveThumbnailDemandLane(
    pageNumber: number,
    currentPage: number,
    visiblePages: ReadonlySet<number>,
) {
    if (pageNumber === currentPage) {
        return 'thumbnail-current' satisfies TPdfRasterLane;
    }
    if (
        visiblePages.has(pageNumber)
        || Math.abs(pageNumber - currentPage) <= IMMEDIATE_RENDER_RADIUS
    ) {
        return 'thumbnail-visible' satisfies TPdfRasterLane;
    }
    return 'prefetch' satisfies TPdfRasterLane;
}

export function expandPdfThumbnailRasterDemand(
    input: IPdfThumbnailDemandInput,
): readonly IPdfRasterDemand[] {
    if (!input.active || input.totalPages <= 0) {
        return [];
    }
    const currentPage = normalizeThumbnailPage(input.currentPage, input.totalPages);
    const visiblePages = new Set(
        input.visiblePages.map(page => normalizeThumbnailPage(page, input.totalPages)),
    );
    const mountedPages = new Set(
        input.mountedPages.map(page => normalizeThumbnailPage(page, input.totalPages)),
    );
    const candidates = new Set<number>([currentPage]);
    for (const page of visiblePages) {
        candidates.add(page);
    }
    for (let distance = 1; distance <= PREFETCH_RENDER_RADIUS; distance += 1) {
        candidates.add(normalizeThumbnailPage(currentPage - distance, input.totalPages));
        candidates.add(normalizeThumbnailPage(currentPage + distance, input.totalPages));
    }
    for (const page of mountedPages) {
        candidates.add(page);
    }
    return [...candidates]
        .filter(pageNumber => pageNumber > 0 && mountedPages.has(pageNumber))
        .map((pageNumber) => ({
            consumerGeneration: input.generation,
            documentFence: input.documentFence,
            estimatedPixels: input.estimatedPixels(pageNumber),
            lane: resolveThumbnailDemandLane(pageNumber, currentPage, visiblePages),
            ordinal: Math.abs(pageNumber - currentPage) * 2 + (pageNumber < currentPage ? 0 : 1),
            pageNumber,
            renderKey: `${String(input.generation)}:${String(pageNumber)}`,
            retention: 'render-cache',
        }));
}

const thumbnailDemandPolicy: IPdfRasterDemandPolicy<IPdfThumbnailDemandInput> = {
    expand: expandPdfThumbnailRasterDemand,
    compareWithinLane: (left, right) => left.ordinal - right.ordinal,
};

function startThumbnailRenderTask(
    prepared: IPreparedThumbnailRaster,
    annotationMode: number,
) {
    const renderOptions = {
        annotationMode,
        canvas: prepared.renderCanvas,
        canvasContext: prepared.context,
        transform: buildThumbnailRenderTransform(
            prepared.metrics.scaleX,
            prepared.metrics.scaleY,
        ),
        viewport: prepared.metrics.scaledViewport,
    };
    if (!prepared.hiddenAnnotationFilter) {
        return prepared.page.render(renderOptions);
    }
    const guardedTask = prepared.page.render({
        ...renderOptions,
        operationsFilter: prepared.hiddenAnnotationFilter.filter,
    });
    if (prepared.hiddenAnnotationFilter.bindTask(guardedTask)) {
        return guardedTask;
    }
    // The private render-task shape pdf.js exposes the operator list through is
    // unreachable, so nothing can be suppressed selectively. Fail closed and drop
    // every annotation rather than showing the stale source of an edited one.
    guardedTask.cancel();
    return prepared.page.render({
        ...renderOptions,
        annotationMode: AnnotationMode?.DISABLE ?? 0,
    });
}

export const usePdfThumbnailRenderRuntime = (
    options: IUsePdfThumbnailRenderRuntimeOptions,
) => {
    const {
        dom,
        effects,
        layout,
        source,
        visuals,
    } = options;
    const documentRenderEpoch = ref(0);
    const thumbnailKeySignal = ref(0);
    const pageRenderEpochs = new Map<number, number>();
    const renderedCanvases = new Map<number, HTMLCanvasElement>();
    let activeScheduler: IPdfPageRasterScheduler | null = null;
    let activeDocument: IPdfDocument | null = null;
    let reloadTransition = false;
    let pendingInvalidation: number[] | null = null;

    const editedTextMarkupCommentsByPage = computed(() => groupBy(
        getEditedTextMarkupThumbnailComments(visuals.annotationComments.value),
        comment => Math.floor(comment.pageNumber),
    ));
    // Deleted-source tombstones arrive without a page, so they stay document-wide;
    // only the edited text-markup half can be attributed to a page today.
    const documentHiddenAnnotationIds = computed(() => new Set(visuals.hiddenAnnotationIds.value));
    const documentVisualSignature = computed(() => [
        createHiddenAnnotationIdsSignature(documentHiddenAnnotationIds.value),
        createEditedTextMarkupThumbnailVisualSignature(
            Object.values(editedTextMarkupCommentsByPage.value).flat(),
            visuals.annotationSettings.value,
        ),
    ].join('\u0002'));

    function resolvePageVisualSignature(pageNumber: number) {
        return [
            createHiddenAnnotationIdsSignature(documentHiddenAnnotationIds.value),
            createEditedTextMarkupThumbnailVisualSignature(
                editedTextMarkupCommentsByPage.value[pageNumber] ?? [],
                visuals.annotationSettings.value,
            ),
        ].join('\u0002');
    }

    function resolveHiddenAnnotationIdsForPage(_pageNumber: number) {
        return documentHiddenAnnotationIds.value;
    }

    function isThumbnailPaneActive() {
        return source.isActive.value !== false;
    }

    function resolveThumbnailOutputScale() {
        if (typeof window === 'undefined' || window.devicePixelRatio <= 0) {
            return 1;
        }
        return Math.min(MAX_THUMBNAIL_OUTPUT_SCALE, window.devicePixelRatio);
    }

    function getThumbnailRenderKey(pageNumber: number) {
        void thumbnailKeySignal.value;
        return [
            documentRenderEpoch.value,
            pageNumber,
            Math.round(layout.thumbnailRenderWidth.value),
            resolveThumbnailOutputScale().toFixed(3),
            pageRenderEpochs.get(pageNumber) ?? 0,
            resolvePageVisualSignature(pageNumber),
        ].join(':');
    }

    function resetThumbnailCanvasBitmap(
        canvas: HTMLCanvasElement,
        renderKey: string | null = null,
    ) {
        canvas.width = 0;
        canvas.height = 0;
        delete canvas.dataset.thumbnailRendered;
        delete canvas.dataset.thumbnailPreservedBitmap;
        if (renderKey) {
            canvas.dataset.thumbnailRenderKey = renderKey;
        } else {
            delete canvas.dataset.thumbnailRenderKey;
        }
    }

    function clearThumbnailCanvas(
        pageNumber: number,
        canvas: HTMLCanvasElement,
        renderKey: string | null = null,
    ) {
        renderedCanvases.delete(pageNumber);
        resetThumbnailCanvasBitmap(canvas, renderKey);
    }

    function isCurrentThumbnailCanvasRendered(pageNumber: number) {
        const canvas = dom.getCanvas(pageNumber);
        return Boolean(
            canvas
            && renderedCanvases.get(pageNumber) === canvas
            && canvas.dataset.thumbnailRendered === 'true'
            && canvas.dataset.thumbnailRenderKey === getThumbnailRenderKey(pageNumber),
        );
    }

    function updateThumbnailAspectRatioForPage(
        pageNumber: number,
        viewportWidth: number,
        viewportHeightValue: number,
        reason: string,
    ) {
        if (
            pageNumber < 1
            || pageNumber > source.totalPages.value
            || viewportWidth <= 0
            || viewportHeightValue <= 0
        ) {
            return false;
        }
        const nextAspectRatio = viewportHeightValue / viewportWidth;
        const previousAspectRatio = layout.thumbnailAspectRatios.value.get(pageNumber) ?? null;
        if (
            !Number.isFinite(nextAspectRatio)
            || nextAspectRatio <= 0
            || (
                previousAspectRatio !== null
                && Math.abs(previousAspectRatio - nextAspectRatio) < 0.001
            )
        ) {
            return false;
        }
        layout.updateThumbnailAspectRatio(pageNumber, nextAspectRatio);
        BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Thumbnail aspect ratio changed', {
            currentPage: source.currentPage.value,
            itemHeight: roundMetric(resolveThumbnailItemHeightFromAspect(
                nextAspectRatio,
                layout.thumbnailRenderWidth.value,
            )),
            nextAspectRatio: roundMetric(nextAspectRatio),
            page: pageNumber,
            previousAspectRatio: previousAspectRatio === null
                ? null
                : roundMetric(previousAspectRatio),
            reason,
            totalPages: source.totalPages.value,
        });
        return true;
    }

    function resolveThumbnailRenderMetrics(page: IPdfPage, pageNumber: number) {
        const viewport = page.getViewport({scale: 1});
        updateThumbnailAspectRatioForPage(
            pageNumber,
            viewport.width,
            viewport.height,
            'render-viewport',
        );
        const scale = layout.thumbnailRenderWidth.value / viewport.width;
        const scaledViewport = page.getViewport({scale});
        const outputScale = resolveThumbnailOutputScale();
        const dimensions = resolveBoundedRasterDimensions({
            width: scaledViewport.width * outputScale,
            height: scaledViewport.height * outputScale,
            maxPixels: 4 * 1024 * 1024,
            maxDimension: 16_384,
        });
        return {
            scaledViewport,
            pixelWidth: dimensions.width,
            pixelHeight: dimensions.height,
            scaleX: dimensions.width / scaledViewport.width,
            scaleY: dimensions.height / scaledViewport.height,
        };
    }

    function applyThumbnailCanvasSize(
        canvas: HTMLCanvasElement,
        metrics: IPreparedThumbnailRaster['metrics'],
    ) {
        canvas.width = metrics.pixelWidth;
        canvas.height = metrics.pixelHeight;
        canvas.style.removeProperty('width');
        canvas.style.removeProperty('height');
    }

    const thumbnailRenderTarget: IPdfRasterRenderTarget<IPreparedThumbnailRaster> = {
        id: 'pdf-thumbnail',
        prepare(demand, page, signal) {
            if (signal.aborted) {
                return Promise.resolve(null);
            }
            const canvas = dom.getCanvas(demand.pageNumber);
            const renderKey = getThumbnailRenderKey(demand.pageNumber);
            if (
                !canvas
                || isCurrentThumbnailCanvasRendered(demand.pageNumber)
            ) {
                return Promise.resolve(null);
            }
            const minimumPixelWidth = Math.ceil(
                layout.thumbnailRenderWidth.value * resolveThumbnailOutputScale(),
            );
            const preserveBitmap = shouldPreserveThumbnailBitmap(
                canvas,
                minimumPixelWidth,
            );
            if (preserveBitmap) {
                canvas.dataset.thumbnailRenderKey = renderKey;
                canvas.dataset.thumbnailPreservedBitmap = 'true';
                delete canvas.dataset.thumbnailRendered;
            } else {
                clearThumbnailCanvas(demand.pageNumber, canvas, renderKey);
            }
            const metrics = resolveThumbnailRenderMetrics(page, demand.pageNumber);
            const renderCanvas = preserveBitmap
                ? document.createElement('canvas')
                : canvas;
            applyThumbnailCanvasSize(renderCanvas, metrics);
            const context = renderCanvas.getContext('2d');
            if (!context) {
                if (renderCanvas !== canvas) {
                    renderCanvas.remove();
                }
                return Promise.resolve(null);
            }
            const pageHiddenAnnotationIds = resolveHiddenAnnotationIdsForPage(demand.pageNumber);
            return Promise.resolve({
                canvas,
                context,
                hiddenAnnotationFilter: pageHiddenAnnotationIds.size > 0
                    ? createRenderTaskHiddenAnnotationOperationsFilter(pageHiddenAnnotationIds)
                    : null,
                metrics,
                page,
                pageNumber: demand.pageNumber,
                renderCanvas,
                renderKey,
            });
        },
        start(prepared) {
            const annotationMode = AnnotationMode?.ENABLE_STORAGE
                ?? AnnotationMode?.ENABLE_FORMS
                ?? AnnotationMode?.ENABLE
                ?? 1;
            return startThumbnailRenderTask(prepared, annotationMode);
        },
        commit(prepared) {
            if (
                !isThumbnailPaneActive()
                || activeDocument !== source.pdfDocument.value
                || activeDocument === null
                || !isPdfDocumentUsable(activeDocument)
                || dom.getCanvas(prepared.pageNumber) !== prepared.canvas
                || getThumbnailRenderKey(prepared.pageNumber) !== prepared.renderKey
                || prepared.canvas.dataset.thumbnailRenderKey !== prepared.renderKey
            ) {
                return false;
            }
            if (prepared.renderCanvas !== prepared.canvas) {
                const visibleContext = prepared.canvas.getContext('2d');
                if (!visibleContext) {
                    return false;
                }
                applyThumbnailCanvasSize(prepared.canvas, prepared.metrics);
                visibleContext.drawImage(prepared.renderCanvas, 0, 0);
                prepared.renderCanvas.width = 0;
                prepared.renderCanvas.height = 0;
                prepared.renderCanvas.remove();
                delete prepared.canvas.dataset.thumbnailPreservedBitmap;
            }
            prepared.canvas.dataset.thumbnailRendered = 'true';
            renderedCanvases.set(prepared.pageNumber, prepared.canvas);
            logPdfRenderTrace('thumbnail-finalize-rendered', {
                demand: prepared.pageNumber === source.currentPage.value
                    ? 'current'
                    : layout.viewportPages.value.includes(prepared.pageNumber)
                        ? 'viewport'
                        : 'nearby',
                pageNumber: prepared.pageNumber,
                renderKey: prepared.renderKey,
                renderedCount: renderedCanvases.size,
            });
            void effects.measureThumbnailHeight();
            return true;
        },
        discard(prepared) {
            if (prepared.renderCanvas !== prepared.canvas) {
                prepared.renderCanvas.width = 0;
                prepared.renderCanvas.height = 0;
                prepared.renderCanvas.remove();
            } else if (prepared.canvas.dataset.thumbnailPreservedBitmap !== 'true') {
                clearThumbnailCanvas(
                    prepared.pageNumber,
                    prepared.canvas,
                    prepared.renderKey,
                );
            }
        },
        release(pageNumber, reason) {
            const canvas = dom.getCanvas(pageNumber);
            renderedCanvases.delete(pageNumber);
            // Page invalidation transfers the resident pixels to the replacement
            // render. Its explicit marker must outlive the scheduler resident.
            if (
                canvas
                && canvas.dataset.thumbnailPreservedBitmap !== 'true'
                && reason !== 'demand-replaced'
                && reason !== 'raster-replaced'
            ) {
                resetThumbnailCanvasBitmap(canvas);
            }
        },
    };

    function estimateThumbnailPixels(pageNumber: number) {
        const width = Math.max(1, layout.thumbnailRenderWidth.value);
        const aspectRatio = layout.thumbnailAspectRatios.value.get(pageNumber) ?? 1.3;
        const outputScale = resolveThumbnailOutputScale();
        return Math.max(1, Math.ceil(width * outputScale))
            * Math.max(1, Math.ceil(width * aspectRatio * outputScale));
    }

    function pruneDetachedThumbnailState() {
        const mountedPages = new Set(layout.virtualPages.value);
        for (const [
            pageNumber,
            canvas,
        ] of renderedCanvases) {
            if (!mountedPages.has(pageNumber) || dom.getCanvas(pageNumber) !== canvas) {
                renderedCanvases.delete(pageNumber);
            }
        }
    }

    function clearUnderResolutionCanvases() {
        const container = dom.resolveVisibleContainer('clear-under-resolution-thumbnails');
        if (!container) {
            return;
        }
        const minimumPixelWidth = Math.ceil(
            resolveThumbnailRasterWidth(layout.thumbnailLayoutWidth.value)
            * resolveThumbnailOutputScale(),
        );
        for (const thumbnail of container.querySelectorAll<HTMLElement>('.pdf-thumbnail')) {
            const pageNumber = Number(thumbnail.dataset.page);
            const canvas = thumbnail.querySelector<HTMLCanvasElement>('canvas');
            const presented = canvas?.dataset.thumbnailRendered === 'true'
                || canvas?.dataset.thumbnailPreservedBitmap === 'true';
            if (canvas && presented && canvas.width < minimumPixelWidth) {
                clearThumbnailCanvas(pageNumber, canvas);
            }
        }
    }

    function runVisibleThumbnailRender() {
        const document = source.pdfDocument.value;
        if (
            !document
            || document !== activeDocument
            || !activeScheduler
            || source.totalPages.value <= 0
            || !isThumbnailPaneActive()
            || !dom.resolveVisibleContainer('schedule-visible-render')
        ) {
            return;
        }
        if (!isThumbnailRasterWidthReady(
            layout.thumbnailLayoutWidth.value,
            layout.thumbnailRenderWidth.value,
        )) {
            clearUnderResolutionCanvases();
            void activeScheduler.cancelSource(THUMBNAIL_RASTER_SOURCE_ID);
            return;
        }
        pruneDetachedThumbnailState();
        const queueCurrentPage = layout.shouldPreferVisibleAnchorOverCurrentPage()
            ? layout.resolveViewportAnchorPage() ?? source.currentPage.value
            : source.currentPage.value;
        const generation = documentRenderEpoch.value;
        activeScheduler.setDemand({
            sourceId: THUMBNAIL_RASTER_SOURCE_ID,
            input: {
                active: true,
                currentPage: queueCurrentPage,
                documentFence: activeScheduler.documentFence,
                estimatedPixels: estimateThumbnailPixels,
                generation,
                mountedPages: layout.virtualPages.value,
                totalPages: source.totalPages.value,
                visiblePages: layout.viewportPages.value,
            },
            policy: {
                ...thumbnailDemandPolicy,
                expand: input => thumbnailDemandPolicy.expand(input).map(demand => ({
                    ...demand,
                    renderKey: getThumbnailRenderKey(demand.pageNumber),
                })),
            },
            target: thumbnailRenderTarget,
        });
    }

    const visibleThumbnailRenderScheduler = createThumbnailRenderFrameScheduler(
        runVisibleThumbnailRender,
    );
    const scheduleVisibleThumbnailRender = visibleThumbnailRenderScheduler.schedule;

    async function preloadThumbnailAspectRatio(
        pdfDocument: IPdfDocument,
        generation: number,
    ) {
        const pageNumber = clamp(
            source.currentPage.value || 1,
            1,
            Math.max(1, source.totalPages.value),
        );
        try {
            const pageLease = await leasePdfDocumentPage(
                pdfDocument,
                pageNumber,
                'transient-background',
            );
            try {
                if (
                    generation !== documentRenderEpoch.value
                    || pdfDocument !== activeDocument
                ) {
                    return;
                }
                const viewport = pageLease.page.getViewport({scale: 1});
                updateThumbnailAspectRatioForPage(
                    pageNumber,
                    viewport.width,
                    viewport.height,
                    'preload-viewport',
                );
                void effects.refreshVisibleThumbnailPane('preload-viewport');
            } finally {
                pageLease.release();
            }
        } catch (error) {
            if (pdfDocument !== activeDocument) {
                return;
            }
            BrowserLogger.diagnostic(
                PDF_THUMBNAIL_LOG_SECTION,
                'Failed to preload thumbnail aspect ratio',
                {
                    error,
                    page: pageNumber,
                },
            );
        }
    }

    function clearRenderedState(clearLayout = true) {
        renderedCanvases.clear();
        pageRenderEpochs.clear();
        const container = dom.resolveVisibleContainer('clear-visible-thumbnails');
        if (container) {
            for (const thumbnail of container.querySelectorAll<HTMLElement>('.pdf-thumbnail')) {
                const canvas = thumbnail.querySelector<HTMLCanvasElement>('canvas');
                if (canvas) {
                    resetThumbnailCanvasBitmap(canvas);
                }
            }
        }
        if (clearLayout) {
            // A source replacement does not resize the rail, so ResizeObserver
            // may not run again. Keep the raster width ready for the existing
            // measured layout instead of falling back to the under-resolved
            // 150px seed and waiting for user interaction to wake rendering.
            layout.thumbnailRenderWidth.value = resolveThumbnailRasterWidth(
                layout.thumbnailLayoutWidth.value,
            );
            layout.clearThumbnailAspectRatios();
        }
        effects.resetMeasurementState();
    }

    function invalidatePages(pages: readonly number[]) {
        pendingInvalidation = [...pages];
        for (const pageNumber of pages) {
            pageRenderEpochs.set(
                pageNumber,
                (pageRenderEpochs.get(pageNumber) ?? 0) + 1,
            );
            if (layout.thumbnailAspectRatios.value.has(pageNumber)) {
                layout.updateThumbnailAspectRatio(pageNumber, null);
            }
            const canvas = dom.getCanvas(pageNumber);
            if (canvas) {
                canvas.dataset.thumbnailPreservedBitmap = 'true';
                delete canvas.dataset.thumbnailRendered;
            }
            renderedCanvases.delete(pageNumber);
        }
        thumbnailKeySignal.value += 1;
        activeScheduler?.invalidate({
            pages,
            reason: 'thumbnail-pages-invalidated',
            sourceId: THUMBNAIL_RASTER_SOURCE_ID,
        });
        void scheduleVisibleThumbnailRender();
    }

    watch(
        [
            () => source.pdfDocument.value,
            () => source.totalPages.value,
            () => source.rasterScheduler.value,
        ],
        ([
            document,
            totalPages,
            rasterScheduler,
        ], [previousDocument]) => {
            visibleThumbnailRenderScheduler.cancel();
            if (activeScheduler) {
                void activeScheduler.cancelSource(THUMBNAIL_RASTER_SOURCE_ID);
            }
            documentRenderEpoch.value += 1;
            thumbnailKeySignal.value += 1;
            effects.onSourceCycleStarted();
            activeDocument = document;
            activeScheduler = document ? rasterScheduler : null;

            if (!document || totalPages <= 0) {
                if (totalPages <= 0) {
                    clearRenderedState();
                    reloadTransition = false;
                } else {
                    reloadTransition = true;
                }
                return;
            }
            if (document !== previousDocument) {
                if (reloadTransition && pendingInvalidation) {
                    reloadTransition = false;
                    pendingInvalidation = null;
                } else {
                    reloadTransition = false;
                    pendingInvalidation = null;
                    clearRenderedState();
                }
            }
            void nextTick(() => {
                const pageNumber = clamp(
                    source.currentPage.value || 1,
                    1,
                    Math.max(1, source.totalPages.value),
                );
                const aspectRatio = layout.thumbnailAspectRatios.value.get(pageNumber) ?? null;
                if (!aspectRatio || aspectRatio <= 0) {
                    void preloadThumbnailAspectRatio(
                        document,
                        documentRenderEpoch.value,
                    );
                    return;
                }
                void effects.refreshVisibleThumbnailPane('document-ready');
            });
        },
        {immediate: true},
    );

    watch(
        () => [
            source.currentPage.value,
            layout.virtualPages.value[0] ?? 0,
            layout.virtualPages.value.at(-1) ?? 0,
            layout.virtualPages.value.length,
            layout.viewportPages.value.join(','),
        ] as const,
        () => void scheduleVisibleThumbnailRender(),
    );

    watch(
        () => source.currentPage.value,
        () => effects.scheduleActivePaneRefresh('current-page'),
        {
            flush: 'post',
            immediate: true,
        },
    );

    watch(
        () => source.isActive.value,
        (isActive) => {
            if (!isActive) {
                effects.cancelActivePaneRefresh();
                visibleThumbnailRenderScheduler.cancel();
                void activeScheduler?.cancelSource(THUMBNAIL_RASTER_SOURCE_ID);
                return;
            }
            effects.scheduleActivePaneRefresh('pane-active');
        },
        {
            flush: 'post',
            immediate: true,
        },
    );

    watch(
        () => documentVisualSignature.value,
        (nextSignature, previousSignature) => {
            if (nextSignature === previousSignature) {
                return;
            }
            // Every mounted page re-derives its own render key, so only the pages
            // whose annotation visuals actually changed fall out of the scheduler's
            // resident set and re-render.
            thumbnailKeySignal.value += 1;
            void scheduleVisibleThumbnailRender();
        },
    );

    watch(
        () => source.invalidationRequest.value?.id,
        () => {
            const pages = source.invalidationRequest.value?.pages;
            if (pages?.length) {
                invalidatePages(pages);
            }
        },
    );

    watch(
        () => [
            layout.thumbnailLayoutWidth.value,
            layout.thumbnailRenderWidth.value,
        ] as const,
        () => {
            if (isThumbnailRasterWidthReady(
                layout.thumbnailLayoutWidth.value,
                layout.thumbnailRenderWidth.value,
            )) {
                void scheduleVisibleThumbnailRender();
                return;
            }
            visibleThumbnailRenderScheduler.cancel();
            void activeScheduler?.cancelSource(THUMBNAIL_RASTER_SOURCE_ID);
            documentRenderEpoch.value += 1;
            clearUnderResolutionCanvases();
        },
        {
            flush: 'sync',
            immediate: true,
        },
    );

    watch(layout.virtualPages, async () => {
        pruneDetachedThumbnailState();
        await nextTick();
        void effects.measureThumbnailHeight();
        void scheduleVisibleThumbnailRender();
    });

    onMounted(() => effects.scheduleActivePaneRefresh('mounted'));
    onBeforeUnmount(() => {
        effects.cancelActivePaneRefresh();
        visibleThumbnailRenderScheduler.cancel();
        void activeScheduler?.cancelSource(THUMBNAIL_RASTER_SOURCE_ID);
        clearRenderedState();
    });

    return {
        cancelAllRenders: () => activeScheduler?.cancelSource(THUMBNAIL_RASTER_SOURCE_ID),
        getRenderSummary: () => {
            const snapshot = activeScheduler?.snapshot();
            const renderingPages = snapshot?.inFlightPages
                .filter(item => item.sourceId === THUMBNAIL_RASTER_SOURCE_ID)
                .map(item => item.pageNumber) ?? [];
            return {
                activeTasks: renderingPages,
                renderedCount: renderedCanvases.size,
                renderedPages: [...renderedCanvases.keys()],
                renderingCount: renderingPages.length,
                renderingPages,
            };
        },
        getThumbnailRenderKey,
        hasRenderedThumbnails: () => renderedCanvases.size > 0,
        reconcileSurfaceResidency: () => void scheduleVisibleThumbnailRender(),
        resolveThumbnailItemChromeHeight: resolvePdfThumbnailItemChromeHeight,
        resolveThumbnailRenderWidth: resolvePdfThumbnailRenderWidth,
        scheduleVisibleThumbnailRender,
    };
};
