import type {Ref} from 'vue';
import { resolvePdfPageViewportRotation } from '@app/utils/pdfViewRotation';
import type {
    IPageRange,
    IPdfPageMatches,
} from '@app/types/pdfUi';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { usePdfTextLayerRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer';
import { usePdfAnnotationLayerRenderer } from '@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer';
import { usePdfRendererSearchController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererSearchController';
import { usePdfSearchHighlightHandoff } from '@app/modules/pdf-viewer/runtime/rendering/usePdfSearchHighlightHandoff';
import { createPdfRendererPageDom } from '@app/modules/pdf-viewer/runtime/rendering/pdf-renderer-page-dom/createPdfRendererPageDom';
import { usePdfRendererAnnotationLayerController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererAnnotationLayerController';
import { usePdfRendererTextLayerController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererTextLayerController';
import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import { createPdfRenderSupervisor } from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import type {
    IPdfLayerRenderResult,
    IPdfPageLayerRenderContext,
    IRenderVisiblePagesOptions,
    IUsePdfPageRendererOptions,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
export type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';

const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

interface IPdfAnnotationProjection {
    readonly hiddenAnnotationIds: Readonly<Ref<Set<string>>>;
    readonly annotationProjectionReady: Readonly<Ref<boolean>>;
    readonly canvasHiddenAnnotationIds: Readonly<Ref<Set<string>>>;
    pageCommitted(pageNumber: number): void;
}

interface ICommittedPdfPageRaster {
    pageNumber: number;
    version: number;
    requestId: number;
    scale: number;
    container: HTMLElement;
    renderResult: IPdfLayerRenderResult;
    renderOptions: IRenderVisiblePagesOptions;
}

/**
 * Owns only the disposable DOM projections attached after a canvas commit:
 * text, annotation/editor layers, search highlights, and their cleanup.
 * Raster demand, PDF.js RenderTasks, canvas identity, and page state remain
 * authoritative in PdfRenderingSession.
 */
export const usePdfPageRenderer = (options: IUsePdfPageRendererOptions) => {
    const viewport = options.viewport;
    const projection = shallowRef<IPdfAnnotationProjection | null>(null);
    const hiddenAnnotationIds = computed(() => projection.value?.hiddenAnnotationIds.value ?? EMPTY_ID_SET as Set<string>);
    const annotationProjectionReady = computed(() => projection.value?.annotationProjectionReady.value ?? true);
    const canvasHiddenAnnotationIds = computed(() => projection.value?.canvasHiddenAnnotationIds.value ?? EMPTY_ID_SET as Set<string>);
    const {
        pdfDocument,
        numPages,
        isLoading,
    } = options.document;
    const showAnnotations = options.showAnnotations ?? true;
    const searchPageMatches =
        options.searchPageMatches ?? new Map<number, IPdfPageMatches>();
    const currentSearchMatch = options.currentSearchMatch ?? null;
    const currentSearchMatchNavigationId = options.currentSearchMatchNavigationId ?? 0;
    const workingCopyPath = options.workingCopyPath ?? null;
    const documentRevisionToken = options.documentRevisionToken ?? null;
    const isActive = options.isActive ?? true;
    const outputScale = options.outputScale
        ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    const renderSupervisor = options.renderSupervisor ?? createPdfRenderSupervisor();
    const highlightHandoff = usePdfSearchHighlightHandoff({
        currentSearchMatch,
        navigationId: currentSearchMatchNavigationId,
        authority: viewport.singlePageScroll.viewportAuthority,
        applyHighlights: pages => {
            const root = options.container.value;
            if (root) textLayerRenderer.applySearchHighlightHandoff(root, pages);
        },
    });
    const textLayerRenderer = usePdfTextLayerRenderer({
        searchPageMatches,
        currentSearchMatch: highlightHandoff.currentHighlightMatch,
        workingCopyPath,
        documentRevisionToken,
        effectiveScale: viewport.scale.effectiveScale,
        viewportWritePort: viewport.viewportWritePort,
    });
    const annotationLayerRenderer = usePdfAnnotationLayerRenderer({
        numPages,
        currentPage: viewport.currentPage,
        pdfDocument,
        showAnnotations,
        hiddenAnnotationIds,
        annotationProjectionReady,
        renderSupervisor,
        scrollToPage: pageNumber => {
            viewport.singlePageScroll.scrollToPage(pageNumber);
        },
    });
    const pageRenderState = options.pageRenderState;
    const textLayerCleanupFns = new Map<number, () => void>();
    const activeTextLayerAbortControllers = new Map<number, {
        version: number;
        requestId: number;
        controller: AbortController;
    }>();
    const activeOptionalTextLayerTasks = new Map<number, {
        version: number;
        requestId: number;
        promise: Promise<void>;
    }>();
    const queuedPrioritizedTextLayerPromotions = new Map<number, IRenderVisiblePagesOptions>();
    function trackOptionalTextLayerTask(
        pageNumber: number,
        version: number,
        requestId: number,
        task: Promise<unknown>,
    ) {
        const promise = task.catch(() => undefined).then(() => undefined).finally(() => {
            const current = activeOptionalTextLayerTasks.get(pageNumber);
            if (current?.version === version && current.requestId === requestId) {
                activeOptionalTextLayerTasks.delete(pageNumber);
            }
        });
        activeOptionalTextLayerTasks.set(pageNumber, {
            version,
            requestId,
            promise,
        });
        return promise;
    }
    function waitForOptionalTextLayerTasksToSettle() {
        return Promise.all(
            Array.from(activeOptionalTextLayerTasks.values(), task => task.promise),
        ).then(() => undefined);
    }
    async function flushQueuedPrioritizedTextLayerPromotion(pageNumber: number) {
        const renderOptions = queuedPrioritizedTextLayerPromotions.get(pageNumber);
        if (!renderOptions) {
            return;
        }
        const slot = pageRenderState.getSlot(pageNumber);
        if (slot.textLayerReadiness === 'ready' || slot.layerReadiness === 'ready') {
            queuedPrioritizedTextLayerPromotions.delete(pageNumber);
            return;
        }
        if (slot.job !== 'idle' || slot.layerReadiness === 'hydrating') {
            return;
        }
        queuedPrioritizedTextLayerPromotions.delete(pageNumber);
        const promotion = resolveLayerPromotionDemand([pageNumber]);
        if (!promotion) {
            return;
        }
        await renderLayerPromotions(promotion.range, {
            ...renderOptions,
            ...promotion.options,
            prioritizeTextLayer: true,
        });
    }
    function trackLayerHydrationSettlement(
        pageNumber: number,
        task: Promise<void>,
    ) {
        return task.finally(() => {
            void runGuardedTask(
                () => flushQueuedPrioritizedTextLayerPromotion(pageNumber),
                {
                    category: 'user-visible-operation',
                    scope: 'pdf-renderer',
                    message: `Failed to promote the queued text layer for page ${String(pageNumber)}`,
                },
            );
        });
    }
    function cancelActiveTextLayerRender(pageNumber: number) {
        const active = activeTextLayerAbortControllers.get(pageNumber);
        if (!active) {
            return;
        }
        activeTextLayerAbortControllers.delete(pageNumber);
        active.controller.abort();
    }
    function cancelActiveTextLayerRenderIfCurrent(
        pageNumber: number,
        version: number,
        requestId: number,
    ) {
        const active = activeTextLayerAbortControllers.get(pageNumber);
        if (active?.version === version && active.requestId === requestId) {
            cancelActiveTextLayerRender(pageNumber);
        }
    }
    const {
        getMountedPageContainer,
        clearSelectionBeforePageLayerTeardown,
    } = createPdfRendererPageDom({
        container: options.container,
        currentPage: viewport.currentPage,
    });
    const searchController = usePdfRendererSearchController({
        container: options.container,
        isActive,
        isLoading,
        numPages,
        textLayerRenderer,
        searchPageMatches,
        currentSearchMatch,
        currentSearchMatchNavigationId,
        scheduleRenderForSinglePage: pageNumber => runGuardedTask(
            () => options.requestSearchPageRaster(pageNumber),
            {
                category: 'user-visible-operation',
                scope: 'pdf-renderer',
                message: `Failed to schedule search render for page ${String(pageNumber)}`,
            },
        ),
        scrollToPage: (pageNumber, scrollOptions) =>
            viewport.singlePageScroll.scrollToPage(pageNumber, scrollOptions),
        beginSearchNavigation: (pageNumber) => {
            viewport.markUserViewportInteraction();
            viewport.singlePageScroll.beginSearchNavigation(pageNumber);
        },
        revealSearchNavigationTarget: (pageNumber, revealOptions) =>
            viewport.singlePageScroll.revealSearchNavigationTarget(pageNumber, {
                ...revealOptions,
                searchNavigationId: toValue(currentSearchMatchNavigationId),
            }),
        endSearchNavigation: () => viewport.singlePageScroll.endSearchNavigation(),
        beginSearchTransaction: (pageNumber, searchOptions) => (
            viewport.transactionController.beginTransaction({
                kind: 'search',
                source: 'search-navigation',
                page: pageNumber,
                anchor: searchOptions?.markerRect ? 'marker' : 'top',
                markerRect: searchOptions?.markerRect ?? null,
            })?.id ?? null
        ),
        isSearchTransactionCurrent: transactionId =>
            viewport.transactionController.isTransactionCurrent(transactionId),
        settleSearchTransaction: transactionId => {
            viewport.transactionController.advanceTransaction(transactionId, 'settled');
        },
        cancelSearchTransaction: transactionId => {
            viewport.transactionController.cancelActiveTransaction({
                reason: 'superseded',
                cancelInFlightRenders: false,
                bumpRenderVersion: false,
                preserveVisualContent: true,
            }, transactionId);
        },
        isPageRenderPending: pageNumber => pageRenderState.getSlot(pageNumber).job === 'rendering',
    });
    watch(viewport.cancelPendingSearchRevision, (revision, previous) => {
        if (revision !== previous) searchController.invalidatePendingRequests();
    }, {flush: 'sync'});
    function cleanupTextLayer(pageNumber: number) {
        textLayerCleanupFns.get(pageNumber)?.();
        textLayerCleanupFns.delete(pageNumber);
    }
    function releasePageLayers(pageNumber: number) {
        const root = options.container.value;
        const container = getMountedPageContainer(pageNumber, root);
        clearPdfSelectionForLayerTeardown({
            target: container,
            root,
            includeDetached: true,
            includeAnyPdfTextSelection: pageNumber === viewport.currentPage.value,
        });
        cancelActiveTextLayerRender(pageNumber);
        annotationLayerController.cancel(pageNumber);
        cleanupTextLayer(pageNumber);
        const textLayer = container?.querySelector<HTMLDivElement>('.text-layer');
        const annotationLayer = container?.querySelector<HTMLElement>('.annotation-layer');
        if (textLayer) textLayerRenderer.cleanupTextLayerDom(textLayer);
        if (annotationLayer) {
            zeroCanvasDescendants(annotationLayer);
            annotationLayer.replaceChildren();
        }
        if (container) {
            delete container.dataset.pageLayerReadiness;
            textLayerRenderer.clearOcrDebug(container);
        }
    }
    function cleanupAllLayers() {
        const pending = waitForOptionalTextLayerTasksToSettle();
        queuedPrioritizedTextLayerPromotions.clear();
        annotationLayerController.cancelAll();
        for (const pageNumber of new Set([
            ...textLayerCleanupFns.keys(),
            ...activeTextLayerAbortControllers.keys(),
        ])) {
            releasePageLayers(pageNumber);
        }
        annotationLayerRenderer.clearAllLayers();
        searchController.invalidatePendingRequests();
        return pending;
    }
    function dispose() {
        queuedPrioritizedTextLayerPromotions.clear();
        annotationLayerController.dispose();
        for (const pageNumber of activeTextLayerAbortControllers.keys()) {
            cancelActiveTextLayerRender(pageNumber);
        }
    }
    function logNonCriticalStageError(
        pageNumber: number,
        stage: string,
        error: unknown,
    ) {
        if (
            error
            && typeof error === 'object'
            && (
                (error as {name?: unknown}).name === 'AbortError'
                || (error as {name?: unknown}).name === 'RenderingCancelledException'
            )
        ) {
            return;
        }
        BrowserLogger.error('pdf-renderer', `Failed to render ${stage} for page ${String(pageNumber)}`, error, {
            code: 'RENDERER_PDF_PAGE_RENDER_FAILED',
            context: {},
        });
    }
    function cleanupPageIfCurrentRender(pageNumber: number, version: number, requestId?: number) {
        const slot = pageRenderState.getSlot(pageNumber);
        if (
            slot.contentVersion !== version
            || (requestId !== undefined && slot.requestId !== null && slot.requestId !== requestId)
        ) {
            return;
        }
        pageRenderState.failLayerHydration(pageNumber, version, requestId ?? slot.requestId ?? 0);
    }
    const annotationLayerController = usePdfRendererAnnotationLayerController({
        annotationLayerRenderer,
        showAnnotations,
        getRenderVersion: options.getRenderVersion,
        cleanupPageIfCurrentRender,
        logNonCriticalStageError,
        renderSupervisor,
    });
    const renderAnnotationLayersForPage = annotationLayerController;
    const renderTextLayerForPage = usePdfRendererTextLayerController({
        textLayerRenderer,
        activeTextLayerAbortControllers,
        textLayerCleanupFns,
        getRenderVersion: options.getRenderVersion,
        cleanupTextLayer,
        cleanupPageIfCurrentRender,
        cancelActiveTextLayerRender,
        cancelActiveTextLayerRenderIfCurrent,
        clearSelectionBeforePageLayerTeardown,
        logNonCriticalStageError,
    });

    async function hydrateCommittedLayers(
        commit: ICommittedPdfPageRaster,
        priority: 'text-first' | 'annotations-first' = 'annotations-first',
    ) {
        const {
            pageNumber,
            version,
            requestId,
            scale,
            container,
            renderResult,
            renderOptions,
        } = commit;
        if (
            renderOptions.contentIntent === 'canvas-only-buffer'
            || renderOptions.contentIntent === 'canvas-only-refine'
        ) {
            const retainedLayers = renderOptions.contentIntent === 'canvas-only-refine'
                && pageRenderState.getSlot(pageNumber).layerReadiness === 'ready';
            if (!retainedLayers) {
                pageRenderState.markCanvasOnly(pageNumber, version, requestId);
            }
            container.dataset.pageLayerReadiness = retainedLayers ? 'ready' : 'canvas-only';
            pageRenderState.completeRender(pageNumber, version, requestId);
            options.onPageRendered?.(pageNumber);
            options.onRenderedPageStateChanged?.();
            return;
        }
        const documentFence = options.document.captureFence();
        const lease = await options.document.leasePage(pageNumber);
        const shouldContinue = () => {
            const slot = pageRenderState.getSlot(pageNumber);
            return options.document.isCurrent(documentFence)
                && options.getRenderVersion() === version
                && slot.contentVersion === version
                && slot.container === container
                && container.isConnected !== false
                && container.dataset.page === String(pageNumber)
                && container.contains(renderResult.canvas);
        };
        try {
            if (!shouldContinue()) {
                return;
            }
            if (!pageRenderState.markLayersHydrating(pageNumber, version, requestId)) {
                return;
            }
            container.dataset.pageLayerReadiness = 'hydrating';
            const context: IPdfPageLayerRenderContext = {
                container,
                pdfPage: lease.page,
                renderResult,
                textLayerDiv: container.querySelector<HTMLDivElement>('.text-layer'),
                annotationLayerInstance: null,
                preserveCanvasOnStale: true,
            };
            const renderText = () => renderTextLayerForPage(
                pageNumber,
                version,
                requestId,
                context,
                scale,
                shouldContinue,
            );
            if (priority === 'text-first') {
                if (!(await renderText())) {
                    if (pageRenderState.markLayersCanvasOnly(pageNumber, version, requestId, container)) {
                        container.dataset.pageLayerReadiness = 'canvas-only';
                        options.onRenderedPageStateChanged?.();
                    }
                    pageRenderState.completeRender(pageNumber, version, requestId);
                    return;
                }
                if (!pageRenderState.markTextLayerReady(pageNumber, version, requestId, container)) {
                    pageRenderState.completeRender(pageNumber, version, requestId);
                    return;
                }
                options.onRenderedPageStateChanged?.();
            }
            const annotation = await renderAnnotationLayersForPage(
                pageNumber,
                version,
                requestId,
                context,
                shouldContinue,
            );
            if (!annotation.shouldContinue || !shouldContinue()) {
                if (pageRenderState.markLayersCanvasOnly(pageNumber, version, requestId, container)) {
                    container.dataset.pageLayerReadiness = 'canvas-only';
                    options.onRenderedPageStateChanged?.();
                }
                pageRenderState.completeRender(pageNumber, version, requestId);
                return;
            }
            context.annotationLayerInstance = annotation.annotationLayerInstance;
            textLayerRenderer.scheduleOcrDebugForPage?.(pageNumber, context);
            if (!pageRenderState.completeRender(pageNumber, version, requestId)) {
                return;
            }
            if (!shouldContinue()) {
                return;
            }
            options.onPageLayersCommitted?.({
                kind: 'page-layer-committed',
                pageNumber,
            }, documentFence);
            options.onPageRendered?.(pageNumber);
            if (priority === 'text-first') {
                if (pageRenderState.markLayersReady(pageNumber, version, requestId, container)) {
                    container.dataset.pageLayerReadiness = 'ready';
                }
                options.onRenderedPageStateChanged?.();
                return;
            }
            options.onRenderedPageStateChanged?.();
            const task = renderText().then((didRender) => {
                if (
                    didRender
                    && pageRenderState.markTextLayerReady(pageNumber, version, requestId, container)
                ) {
                    options.onRenderedPageStateChanged?.();
                    if (pageRenderState.markLayersReady(pageNumber, version, requestId, container)) {
                        container.dataset.pageLayerReadiness = 'ready';
                        options.onRenderedPageStateChanged?.();
                    }
                    return;
                }
                if (
                    !didRender
                    && pageRenderState.markLayersCanvasOnly(pageNumber, version, requestId, container)
                ) {
                    container.dataset.pageLayerReadiness = 'canvas-only';
                    options.onRenderedPageStateChanged?.();
                }
            });
            await trackOptionalTextLayerTask(pageNumber, version, requestId, task);
        } finally {
            if (pageRenderState.markLayersCanvasOnly(pageNumber, version, requestId, container)) {
                container.dataset.pageLayerReadiness = 'canvas-only';
                options.onRenderedPageStateChanged?.();
            }
            pageRenderState.completeRender(pageNumber, version, requestId);
            lease.release();
        }
    }

    function renderCommittedPageLayers(commit: ICommittedPdfPageRaster) {
        projection.value?.pageCommitted(commit.pageNumber);
        return trackLayerHydrationSettlement(
            commit.pageNumber,
            hydrateCommittedLayers(
                commit,
                commit.renderOptions.prioritizeTextLayer === true ? 'text-first' : 'annotations-first',
            ),
        );
    }

    let layerPromotionGeneration = 0;
    let layerRequestId = 0;
    async function renderLayerPromotions(
        range: IPageRange,
        renderOptions: IRenderVisiblePagesOptions,
    ) {
        const generation = ++layerPromotionGeneration;
        const version = options.getRenderVersion();
        const pages = (renderOptions.rasterDemandPages
            ?? Array.from(
                {length: range.end - range.start + 1},
                (_, index) => range.start + index,
            ))
            .filter(pageNumber => pageNumber >= 1 && pageNumber <= numPages.value);
        for (const pageNumber of pages) {
            if (generation !== layerPromotionGeneration || version !== options.getRenderVersion()) {
                return;
            }
            const slot = pageRenderState.getSlot(pageNumber);
            const container = getMountedPageContainer(pageNumber, options.container.value);
            const canvas = options.getCommittedCanvas(pageNumber);
            if (
                !container
                || !canvas
                || slot.canvasReadiness !== 'ready'
                || slot.contentVersion !== version
            ) {
                continue;
            }
            const requestId = ++layerRequestId;
            if (!pageRenderState.beginLayerHydration(
                pageNumber,
                version,
                requestId,
                options.getRenderDocumentToken(),
                toValue(viewport.scale.effectiveScale),
                toValue(outputScale),
                container,
            )) {
                continue;
            }
            const lease = await options.document.leasePage(pageNumber);
            const pageViewport = lease.page.getViewport({
                scale: toValue(viewport.scale.effectiveScale),
                rotation: resolvePdfPageViewportRotation(
                    lease.page.rotate,
                    toValue(options.viewRotation ?? (() => 0)),
                ),
            });
            const userUnit = pageViewport.userUnit ?? 1;
            try {
                await trackLayerHydrationSettlement(
                    pageNumber,
                    hydrateCommittedLayers({
                        pageNumber,
                        version,
                        requestId,
                        scale: toValue(viewport.scale.effectiveScale),
                        container,
                        renderResult: {
                            canvas,
                            viewport: pageViewport,
                            annotationCanvasMap: null,
                            scaleX: canvas.width / pageViewport.width,
                            scaleY: canvas.height / pageViewport.height,
                            rawDims: pageViewport.rawDims as {
                                pageWidth: number;
                                pageHeight: number
                            },
                            userUnit,
                            totalScaleFactor: toValue(viewport.scale.effectiveScale) * userUnit,
                        },
                        renderOptions,
                    }, renderOptions.prioritizeTextLayer === true ? 'text-first' : 'annotations-first'),
                );
            } finally {
                lease.release();
            }
        }
    }

    function resolveLayerPromotionDemand(pages: readonly number[]) {
        const promotionPages = pages.filter(
            page => pageRenderState.isLayerPromotionEligible(page),
        );
        if (promotionPages.length === 0) {
            return null;
        }
        const range = {
            start: Math.min(...promotionPages),
            end: Math.max(...promotionPages),
        };
        return {
            range,
            options: {
                bufferOverride: 0,
                contentIntent: 'layers-only-promotion' as const,
                preserveInFlightRequiredPages: true,
                preserveRenderedPages: true,
                rasterDemandPages: promotionPages,
                renderWindowOverride: range,
            },
        };
    }

    function queuePrioritizedTextLayerPromotions(
        pages: readonly number[],
        renderOptions: IRenderVisiblePagesOptions,
    ) {
        for (const pageNumber of pages) {
            const slot = pageRenderState.getSlot(pageNumber);
            if (
                slot.textLayerReadiness === 'ready'
                || slot.layerReadiness === 'ready'
                || slot.canvasReadiness !== 'ready'
            ) {
                queuedPrioritizedTextLayerPromotions.delete(pageNumber);
                continue;
            }
            queuedPrioritizedTextLayerPromotions.set(pageNumber, renderOptions);
            void flushQueuedPrioritizedTextLayerPromotion(pageNumber);
        }
    }

    return {
        adoptCommittedCanvasVersions(contentVersion: number, documentToken: string) {
            for (const pageNumber of pageRenderState.renderedPages) {
                const wasHydrating = pageRenderState.getSlot(pageNumber).layerReadiness === 'hydrating';
                if (
                    pageRenderState.adoptCommittedCanvasVersion(pageNumber, contentVersion, documentToken)
                    && wasHydrating
                ) {
                    const container = getMountedPageContainer(pageNumber, options.container.value);
                    if (container) {
                        container.dataset.pageLayerReadiness = 'canvas-only';
                    }
                }
            }
        },
        renderCommittedPageLayers,
        renderLayerPromotions,
        resolveLayerPromotionDemand,
        queuePrioritizedTextLayerPromotions,
        cleanupAllLayers,
        dispose,
        releasePageLayers,
        applySearchHighlights: searchController.applySearchHighlights,
        requestScrollToCurrentResult: searchController.requestScrollToCurrentResult,
        annotationProjectionReady,
        cancelPendingSearchScroll: searchController.invalidatePendingRequests,
        // The raster bakes pixels that survive until the page is re-rendered, so it
        // must follow the store alone. Deferring suppression until a managed shape's
        // overlay is mounted — as the annotation layer does, where the decision is
        // revisited on every DOM sync — would bake native ink under the overlay.
        canvasHiddenAnnotationIds,
        attachAnnotationProjection(attached: IPdfAnnotationProjection) {
            projection.value = attached;
            return () => {
                if (projection.value !== attached) {
                    return;
                }
                projection.value = null;
            };
        },
    };
};

function zeroCanvasDescendants(root: HTMLElement) {
    for (const canvas of root.querySelectorAll<HTMLCanvasElement>('canvas')) {
        canvas.width = 0;
        canvas.height = 0;
    }
}
