import {watchOnce} from '@vueuse/core';
import {useFailureToast} from '@app/composables/useFailureToast';
import {getErrorMessage} from '@app/utils/error';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';
import type {Ref} from 'vue';
import { resolvePdfPageViewportRotation } from '@app/utils/pdfViewRotation';
import type {
    IPageRange,
    IPdfPageMatches,
} from '@app/types/pdfUi';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { usePdfTextLayerRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer';
import {
    usePdfAnnotationLayerRenderer,
    getParsedPageAnnotations,
    isLinkAnnotation,
} from '@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer';
import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {TPdfPageOperationSettlementCapture} from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';
import { usePdfRendererSearchController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererSearchController';
import { createPdfRendererPageDom } from '@app/modules/pdf-viewer/runtime/rendering/pdf-renderer-page-dom/createPdfRendererPageDom';
import {
    isRenderCancellation,
    usePdfRendererAnnotationLayerController,
} from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererAnnotationLayerController';
import { usePdfRendererTextLayerController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererTextLayerController';
import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import { createPdfRenderSupervisor } from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import type {
    IPdfLayerRenderResult,
    IRenderVisiblePagesOptions,
    IUsePdfPageRendererOptions,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
export type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';

const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

interface IPdfAnnotationProjection {
    readonly hiddenAnnotationIds: Readonly<Ref<Set<string>>>;
    readonly annotationProjectionReady: Readonly<Ref<boolean>>;
    readonly canvasHiddenAnnotationIds: Readonly<Ref<Set<string>>>;
    readonly thumbnailHiddenAnnotationIds: Readonly<Ref<Set<string>>>;
    ensureAnnotationProjectionReady?: () => Promise<void>;
    pageCommitted(pageNumber: TPageNumber): void;
}

interface ICommittedPdfPageRaster {
    pageNumber: TPageNumber;
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
    const {presentFailureToast} = useFailureToast();
    const {t} = useTypedI18n();
    const viewport = options.viewport;
    const projection = shallowRef<IPdfAnnotationProjection | null>(null);
    const hiddenAnnotationIds = computed(() => projection.value?.hiddenAnnotationIds.value ?? EMPTY_ID_SET as Set<string>);
    const annotationProjectionReady = computed(() => projection.value?.annotationProjectionReady.value ?? true);
    const canvasHiddenAnnotationIds = computed(() => projection.value?.canvasHiddenAnnotationIds.value ?? EMPTY_ID_SET as Set<string>);
    const thumbnailHiddenAnnotationIds = computed(() => projection.value?.thumbnailHiddenAnnotationIds.value ?? EMPTY_ID_SET as Set<string>);
    const {
        pdfDocument,
        numPages,
        isLoading,
    } = options.document;
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
    const textLayerRenderer = usePdfTextLayerRenderer({
        searchPageMatches,
        currentSearchMatch,
        workingCopyPath,
        documentRevisionToken,
        effectiveScale: viewport.scale.effectiveScale,
        viewportWritePort: viewport.viewportWritePort,
    });
    const annotationLayerRenderer = usePdfAnnotationLayerRenderer({
        numPages,
        currentPage: viewport.currentPage,
        pdfDocument,
        hiddenAnnotationIds,
        annotationProjectionReady,
        linkAnnotations: options.linkAnnotations,
        renderSupervisor,
        scrollToPage: pageNumber => {
            viewport.singlePageScroll.scrollToPage(requirePageNumber(pageNumber));
        },
    });
    const pageRenderState = options.pageRenderState;
    const textLayerCleanupFns = new Map<TPageNumber, () => void>();
    const activeTextLayerAbortControllers = new Map<TPageNumber, {
        version: number;
        requestId: number;
        controller: AbortController;
    }>();
    const activeLayerHydrationTasks = new Map<TPageNumber, Promise<void>>();
    const queuedPrioritizedTextLayerPromotions = new Map<TPageNumber, IRenderVisiblePagesOptions>();
    async function flushQueuedPrioritizedTextLayerPromotion(pageNumber: TPageNumber) {
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
        pageNumber: TPageNumber,
        task: Promise<void>,
    ) {
        const pending = task.finally(() => {
            if (activeLayerHydrationTasks.get(pageNumber) === pending) activeLayerHydrationTasks.delete(pageNumber);
            void runGuardedTask(
                () => flushQueuedPrioritizedTextLayerPromotion(pageNumber),
                {
                    category: 'user-visible-operation',
                    scope: 'pdf-renderer',
                    message: `Failed to promote the queued text layer for page ${String(pageNumber)}`,
                },
            );
        });
        activeLayerHydrationTasks.set(pageNumber, pending);
        return pending;
    }
    function cancelActiveTextLayerRender(pageNumber: TPageNumber) {
        const active = activeTextLayerAbortControllers.get(pageNumber);
        if (!active) {
            return;
        }
        activeTextLayerAbortControllers.delete(pageNumber);
        active.controller.abort();
    }
    function cancelActiveTextLayerRenderIfCurrent(
        pageNumber: TPageNumber,
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
        beginSearchTransaction: pageNumber => viewport.viewportWork.beginWork('search', pageNumber),
        isSearchTransactionCurrent: viewport.viewportWork.isWorkCurrent,
        settleSearchTransaction: viewport.viewportWork.settleWork,
        cancelSearchTransaction: transactionId => viewport.viewportWork.cancelWork({cancelRasters: false}, transactionId),
        isPageRenderPending: pageNumber => pageRenderState.getSlot(pageNumber).job === 'rendering',
    });
    watch(viewport.cancelPendingSearchRevision, (revision, previous) => {
        if (revision !== previous) searchController.invalidatePendingRequests();
    }, {flush: 'sync'});
    function cleanupTextLayer(pageNumber: TPageNumber) {
        textLayerCleanupFns.get(pageNumber)?.();
        textLayerCleanupFns.delete(pageNumber);
    }
    function releasePageLayers(pageNumber: TPageNumber) {
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
        const pending = Promise.all(activeLayerHydrationTasks.values()).then(() => undefined);
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
        pageNumber: TPageNumber,
        stage: string,
        error: unknown,
    ) {
        if (isRenderCancellation(error)) {
            return;
        }
        return BrowserLogger.error('pdf-renderer', `Failed to render ${stage} for page ${String(pageNumber)}`, error, {code: 'RENDERER_PDF_PAGE_RENDER_FAILED'});
    }
    /**
     * Tells the user once that a page could not finish rendering, with a
     * Retry that redraws what failed: its layers when the canvas is on
     * screen, its raster when it is not. A Retry after the document changed
     * does nothing.
     */
    function presentPageFailure(pageNumber: TPageNumber, report: {
        receipt: FailureReceipt;
        error: unknown;
        description: string;
        retry: () => Promise<unknown>;
    }) {
        const documentFence = options.document.captureFence();
        presentFailureToast({
            failure: report.receipt,
            title: t('common.pdfPage', {page: pageNumber}),
            description: report.description,
            technicalDetails: getErrorMessage(report.error),
            persistent: true,
            actions: [{
                label: t('common.retry'),
                onClick: () => {
                    if (!options.document.isCurrent(documentFence)) return;
                    runGuardedTask(report.retry, {
                        category: 'user-visible-operation',
                        scope: 'pdf-renderer',
                        message: `Failed to retry page ${String(pageNumber)}`,
                    });
                },
            }],
        });
    }
    function cleanupPageIfCurrentRender(pageNumber: TPageNumber, version: number, requestId?: number) {
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
        cancelActiveTextLayerRender,
        cancelActiveTextLayerRenderIfCurrent,
        clearSelectionBeforePageLayerTeardown,
        logNonCriticalStageError,
    });

    async function hydrateCommittedLayers(
        commit: ICommittedPdfPageRaster,
        publishRaster?: () => boolean,
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
            if (publishRaster && !publishRaster()) return;
            const retainedLayers = renderOptions.contentIntent === 'canvas-only-refine'
                && pageRenderState.getSlot(pageNumber).layerReadiness === 'ready';
            if (!retainedLayers) {
                pageRenderState.markCanvasOnly(pageNumber, version, requestId);
            }
            container.dataset.pageLayerReadiness = retainedLayers ? 'ready' : 'canvas-only';
            pageRenderState.completeRender(pageNumber, version, requestId);
            options.onRenderedPageStateChanged?.();
            return;
        }
        const documentFence = options.document.captureFence();
        const shouldContinue = () => {
            const slot = pageRenderState.getSlot(pageNumber);
            return options.document.isCurrent(documentFence)
                && options.getRenderVersion() === version
                && slot.container === container
                && container.isConnected !== false
                && container.dataset.page === String(pageNumber)
                && (slot.job !== 'rendering' || slot.requestId === requestId)
                && (slot.contentVersion === version && container.contains(renderResult.canvas)
                    || slot.version === version && slot.requestId === requestId && slot.pendingContainer === container);
        };
        const outgoingText = container.querySelector<HTMLDivElement>('.text-layer');
        const slot = pageRenderState.getSlot(pageNumber);
        const textHost = publishRaster && outgoingText && slot.canvasReadiness === 'ready'
            ? container.cloneNode(false) as HTMLElement : null;
        const incomingText = textHost && outgoingText ? outgoingText.cloneNode(false) as HTMLDivElement : outgoingText;
        if (textHost && incomingText) {
            const structureHost = document.createElement('div');
            structureHost.className = 'page_canvas__render-layer';
            textHost.append(structureHost, incomingText);
        }
        if (publishRaster && slot.canvasReadiness !== 'ready') {
            if (!publishRaster()) return;
            publishRaster = undefined;
        }
        let lease: Awaited<ReturnType<typeof options.document.leasePage>> | null = null;
        try {
            lease = await options.document.leasePage(pageNumber).catch((error: unknown) => {
                if (isRenderCancellation(error)) {
                    return null;
                }
                throw error;
            });
            if (!lease || !shouldContinue()) {
                return;
            }
            const context = {
                container,
                pdfPage: lease.page,
                renderResult,
                textLayerDiv: incomingText,
                preserveCanvasOnStale: true,
            };
            const textReady = await renderTextLayerForPage(
                pageNumber,
                version,
                requestId,
                context,
                scale,
                shouldContinue,
                () => {
                    if (!shouldContinue() || publishRaster && !publishRaster()) return false;
                    if (textHost && outgoingText && incomingText) {
                        outgoingText.replaceWith(incomingText);
                        textLayerRenderer.cleanupTextLayerDom(outgoingText);
                        container.querySelector('.page_canvas__render-layer, .page_canvas')
                            ?.append(...textHost.querySelectorAll('.structTree'));
                    }
                    if (!pageRenderState.markLayersHydrating(pageNumber, version, requestId)) return false;
                    container.dataset.pageLayerReadiness = 'hydrating';
                    options.onRenderedPageStateChanged?.();
                    return true;
                },
            );
            if (!textReady || !pageRenderState.markTextLayerReady(pageNumber, version, requestId, container)) return;
            options.onRenderedPageStateChanged?.();
            const annotation = await renderAnnotationLayersForPage(
                pageNumber,
                version,
                requestId,
                context,
                shouldContinue,
            );
            if ('error' in annotation && shouldContinue()) {
                if (pageRenderState.failLayerHydration(pageNumber, version, requestId, 'failed')) {
                    container.dataset.pageLayerReadiness = 'failed';
                    options.onRenderedPageStateChanged?.();
                    if (annotation.failure) {
                        presentPageFailure(pageNumber, {
                            receipt: annotation.failure,
                            error: annotation.error,
                            description: t('common.pageInteractionFailed', {page: pageNumber}),
                            retry: () => renderLayerPromotions({
                                start: pageNumber,
                                end: pageNumber,
                            }, {
                                contentIntent: 'layers-only-promotion',
                                rasterDemandPages: [pageNumber],
                                prioritizeTextLayer: true,
                            }),
                        });
                    }
                }
                return;
            }
            if (!annotation.shouldContinue || !shouldContinue()) return;
            textLayerRenderer.scheduleOcrDebugForPage?.(pageNumber, context);
            if (!shouldContinue() || !pageRenderState.markLayersReady(pageNumber, version, requestId, container)) return;
            options.onPageLayersCommitted?.({
                kind: 'page-layer-committed',
                pageNumber,
            }, documentFence);
            container.dataset.pageLayerReadiness = 'ready';
            options.onRenderedPageStateChanged?.();
        } finally {
            if (pageRenderState.markLayersCanvasOnly(pageNumber, version, requestId, container)) {
                container.dataset.pageLayerReadiness = 'canvas-only';
                options.onRenderedPageStateChanged?.();
            }
            pageRenderState.completeRender(pageNumber, version, requestId);
            if (incomingText && textHost && !incomingText.isConnected) textLayerRenderer.cleanupTextLayerDom(incomingText);
            lease?.release();
        }
    }

    function renderCommittedPageLayers(commit: ICommittedPdfPageRaster, publishRaster?: () => boolean) {
        projection.value?.pageCommitted(commit.pageNumber);
        return trackLayerHydrationSettlement(
            commit.pageNumber,
            hydrateCommittedLayers(
                commit, publishRaster,
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
            .filter(pageNumber => pageNumber >= 1 && pageNumber <= numPages.value)
            .map(pageNumber => requirePageNumber(pageNumber, numPages.value));
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
            let lease: Awaited<ReturnType<typeof options.document.leasePage>> | null = null;
            try {
                lease = await options.document.leasePage(pageNumber);
                const pageViewport = lease.page.getViewport({
                    scale: toValue(viewport.scale.effectiveScale),
                    rotation: resolvePdfPageViewportRotation(
                        lease.page.rotate,
                        toValue(options.viewRotation ?? (() => 0)),
                    ),
                });
                const userUnit = pageViewport.userUnit ?? 1;
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
                    }),
                );
            } catch (error) {
                // The slot is already 'hydrating' and nothing else moves it on:
                // markLayersReady and isLayerPromotionEligible both refuse it, so
                // the page would keep its canvas and never get its text or
                // annotation layer for as long as the viewer stays open.
                cleanupPageIfCurrentRender(pageNumber, version, requestId);
                throw error;
            } finally {
                lease?.release();
            }
        }
    }

    function resolveLayerPromotionDemand(pages: readonly number[]) {
        const promotionPages = pages
            .map(page => requirePageNumber(page, numPages.value))
            .filter(page => pageRenderState.isLayerPromotionEligible(page));
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
        for (const rawPageNumber of pages) {
            const pageNumber = requirePageNumber(rawPageNumber, numPages.value);
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
        adoptCommittedCanvasVersions(
            contentVersion: number,
            documentToken: string,
            excludedPages: readonly TPageNumber[] = [],
        ) {
            const excluded = new Set(excludedPages);
            for (const pageNumber of pageRenderState.renderedPages) {
                if (excluded.has(pageNumber)) {
                    continue;
                }
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
        presentPageRenderFailure(pageNumber: TPageNumber, error: unknown, retry: () => Promise<unknown>, isVisible: () => boolean = () => true) {
            const receipt = logNonCriticalStageError(pageNumber, 'canvas', error);
            if (!receipt) return;
            const present = () => presentPageFailure(pageNumber, {
                receipt,
                error,
                description: t('common.pageRenderFailed'),
                retry,
            });
            if (isVisible()) return present();
            const failure = pageRenderState.getSlot(pageNumber);
            options.document.registerDisposable(watchOnce(isVisible, () => {
                if (pageRenderState.getSlot(pageNumber) !== failure || failure.version !== options.getRenderVersion()) return;
                present();
            }));
        },
        resolveLayerPromotionDemand,
        queuePrioritizedTextLayerPromotions,
        cleanupAllLayers,
        dispose,
        releasePageLayers,
        applySearchHighlights: searchController.applySearchHighlights,
        requestScrollToCurrentResult: searchController.requestScrollToCurrentResult,
        annotationProjectionReady,
        async prepareCanvasAnnotations(page: IPdfPage, captureSettlement?: TPdfPageOperationSettlementCapture) {
            const parsed = getParsedPageAnnotations(page);
            captureSettlement?.(parsed.then(() => undefined, () => undefined));
            if ((await parsed).some(annotation => !isLinkAnnotation(annotation))) await projection.value?.ensureAnnotationProjectionReady?.();
        },
        cancelPendingSearchScroll: searchController.invalidatePendingRequests,
        // The raster bakes pixels that survive until the page is re-rendered, so it
        // must follow the store alone. Deferring suppression until a managed shape's
        // overlay is mounted — as the annotation layer does, where the decision is
        // revisited on every DOM sync — would bake native ink under the overlay.
        canvasHiddenAnnotationIds,
        thumbnailHiddenAnnotationIds,
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
