import {useFailureToast} from '@app/composables/useFailureToast';
import {getErrorMessage} from '@app/utils/error';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';
import type {Ref} from 'vue';
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
} from '@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer';
import type {
    IPdfPage, IPdfAnnotation,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {IAcceptedNativeTextBox} from '@app/modules/pdf-viewer/runtime/save/nativeTextBoxMutations';
import type {TPdfPageOperationSettlementCapture} from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';
import { usePdfRendererSearchController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererSearchController';
import { findPdfPageContainer } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/findPdfPageContainer';
import { pdfViewerDomSelectors } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomSelectors';
import {
    isRenderCancellation,
    usePdfRendererTextLayerController,
    type IPdfLayerStageFailure,
} from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererTextLayerController';
import {
    isPdfPageBusy,
    type IPdfLayerHydration,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfPageResources';
import { withPageStageTimeout } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/withPageStageTimeout';
import { PDF_PAGE_RENDER_TIMEOUT_MS } from '@app/constants/timeouts';
import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import { createPdfRenderSupervisor } from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import type {
    IPdfLayerRenderResult,
    IPdfAnnotationRenderInput,
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
    /** Each page's paint identity; a page that has none is absent. */
    readonly paintIdentities: Readonly<Ref<ReadonlyMap<number, string>>>;
    preparePagePaint(page: IPdfPage, annotations: readonly IPdfAnnotation[], signal?: AbortSignal, reserveAppearanceBytes?: (bytes: number) => void, accepted?: IAcceptedNativeTextBox): IPdfAnnotationRenderInput | undefined | Promise<IPdfAnnotationRenderInput | undefined>;
}

interface ICommittedPdfPageRaster {
    pageNumber: TPageNumber;
    container: HTMLElement;
    renderResult: IPdfLayerRenderResult;
    renderOptions: IRenderVisiblePagesOptions;
    signal?: AbortSignal;
}

/** Publishes the prepared raster with the given layer state; false when it is no longer wanted. */
export type TPdfRasterPublication = (layers: 'hydrating' | 'canvas-only' | 'retain') => boolean;

/**
 * Owns only the disposable DOM projections attached after a canvas commit:
 * text, annotation/editor layers, search highlights, and their cleanup.
 * What a page wants and shows, and who owns its layer work, is the page
 * resource of PdfRenderingSession.
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
    const renderSupervisor = options.renderSupervisor ?? createPdfRenderSupervisor();
    const textLayerRenderer = usePdfTextLayerRenderer({
        searchPageMatches,
        currentSearchMatch,
        workingCopyPath: options.workingCopyPath ?? null,
        documentRevisionToken: options.documentRevisionToken ?? null,
        viewportWritePort: viewport.viewportWritePort,
    });
    const annotationLayerRenderer = usePdfAnnotationLayerRenderer({
        numPages,
        currentPage: viewport.currentPage,
        pdfDocument,
        hiddenAnnotationIds,
        annotationProjectionReady,
        linkAnnotations: options.linkAnnotations,
        scrollToPage: pageNumber => {
            viewport.singlePageScroll.scrollToPage(requirePageNumber(pageNumber));
        },
    });
    const resources = options.pageResources;
    const annotationPaintIdentities = computed(() => projection.value?.paintIdentities.value ?? new Map<number, string>());
    const pendingHydrations = new Set<Promise<void>>();
    let disposed = false;
    async function promoteQueuedTextLayer(pageNumber: TPageNumber) {
        const resource = resources.get(pageNumber);
        if (!resource.textFirst || isPdfPageBusy(resource)) {
            return;
        }
        resources.requestTextFirst(pageNumber, false);
        const promotion = resource.text || resource.layers === 'ready' ? null : resolveLayerPromotionDemand([pageNumber]);
        if (promotion) {
            await renderLayerPromotions(promotion.range, {
                ...promotion.options,
                prioritizeTextLayer: true,
            });
        }
    }
    function renderCommittedPageLayers(commit: ICommittedPdfPageRaster, publishRaster?: TPdfRasterPublication) {
        const pageNumber = commit.pageNumber;
        if (disposed || commit.signal?.aborted) return Promise.resolve();
        const hydration = resources.beginHydration(pageNumber);
        const abort = () => hydration.controller.abort();
        commit.signal?.addEventListener('abort', abort, {once: true});
        const pending: Promise<void> = hydrateCommittedLayers(commit, hydration, publishRaster).finally(() => {
            commit.signal?.removeEventListener('abort', abort);
            if (resources.settleHydration(pageNumber, hydration, 'canvas-only')) options.onRenderedPageStateChanged?.();
            pendingHydrations.delete(pending);
            void runGuardedTask(
                () => promoteQueuedTextLayer(pageNumber),
                {
                    category: 'user-visible-operation',
                    scope: 'pdf-renderer',
                    message: `Failed to promote the queued text layer for page ${String(pageNumber)}`,
                },
            );
        });
        pendingHydrations.add(pending);
        return pending;
    }
    const getMountedPageContainer = (pageNumber: TPageNumber, root = options.container.value) => findPdfPageContainer(root, pageNumber);
    const clearSelectionBeforePageLayerTeardown = (pageNumber: TPageNumber) => clearPdfSelectionForLayerTeardown({
        target: getMountedPageContainer(pageNumber)?.querySelector<HTMLElement>(pdfViewerDomSelectors.textLayerAny) ?? null,
        root: options.container.value,
        includeDetached: true,
        includeAnyPdfTextSelection: pageNumber === viewport.currentPage.value,
    });
    const searchController = usePdfRendererSearchController({
        container: options.container,
        isActive: options.isActive ?? true,
        isLoading,
        numPages,
        textLayerRenderer,
        searchPageMatches,
        currentSearchMatch,
        currentSearchMatchNavigationId: options.currentSearchMatchNavigationId ?? 0,
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
                searchNavigationId: toValue(options.currentSearchMatchNavigationId ?? 0),
            }),
        endSearchNavigation: () => viewport.singlePageScroll.endSearchNavigation(),
        beginSearchTransaction: pageNumber => viewport.viewportWork.beginWork('search', pageNumber),
        isSearchTransactionCurrent: viewport.viewportWork.isWorkCurrent,
        settleSearchTransaction: viewport.viewportWork.settleWork,
        cancelSearchTransaction: transactionId => viewport.viewportWork.cancelWork({cancelRasters: false}, transactionId),
    });
    watch(viewport.cancelPendingSearchRevision, (revision, previous) => {
        if (revision !== previous) searchController.invalidatePendingRequests();
    }, {flush: 'sync'});
    function releasePageLayers(pageNumber: TPageNumber) {
        const root = options.container.value;
        const container = getMountedPageContainer(pageNumber, root);
        clearPdfSelectionForLayerTeardown({
            target: container,
            root,
            includeDetached: true,
            includeAnyPdfTextSelection: pageNumber === viewport.currentPage.value,
        });
        const textLayer = container?.querySelector<HTMLDivElement>('.text-layer');
        const annotationLayer = container?.querySelector<HTMLElement>('.annotation-layer');
        if (textLayer) textLayerRenderer.cleanupTextLayerDom(textLayer);
        if (annotationLayer) {
            for (const canvas of annotationLayer.querySelectorAll<HTMLCanvasElement>('canvas')) {
                canvas.width = 0;
                canvas.height = 0;
            }
            annotationLayer.replaceChildren();
        }
        if (container) {
            delete container.dataset.pageLayerReadiness;
            textLayerRenderer.clearOcrDebug(container);
        }
    }
    function cleanupAllLayers() {
        const pending = Promise.all(pendingHydrations).then(() => undefined);
        for (const pageNumber of [...resources.resources.keys()]) {
            releasePageLayers(pageNumber);
        }
        annotationLayerRenderer.clearAllLayers();
        searchController.invalidatePendingRequests();
        return pending;
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
        retry?: (() => Promise<unknown>) | undefined;
    }) {
        const documentFence = options.document.captureFence();
        presentFailureToast({
            failure: report.receipt,
            title: t('common.pdfPage', {page: pageNumber}),
            description: report.description,
            technicalDetails: getErrorMessage(report.error),
            persistent: true,
            actions: report.retry ? [{
                label: t('common.retry'),
                onClick: () => {
                    if (!options.document.isCurrent(documentFence) || !report.retry) return;
                    runGuardedTask(report.retry, {
                        category: 'user-visible-operation',
                        scope: 'pdf-renderer',
                        message: `Failed to retry page ${String(pageNumber)}`,
                    });
                },
            }] : [],
        });
    }
    const renderTextLayerForPage = usePdfRendererTextLayerController({
        textLayerRenderer,
        logNonCriticalStageError,
    });

    async function renderAnnotationLayerForPage(
        pageNumber: TPageNumber,
        context: {
            container: HTMLElement;
            pdfPage: IPdfPage;
            renderResult: IPdfLayerRenderResult;
        },
        hydration: IPdfLayerHydration,
        shouldContinue: () => boolean,
    ): Promise<boolean | IPdfLayerStageFailure> {
        const annotationLayerDiv = context.container.querySelector<HTMLElement>('.annotation-layer');
        if (!annotationLayerDiv || !shouldContinue()) {
            return shouldContinue();
        }
        const controller = new AbortController();
        const signal = AbortSignal.any([
            controller.signal,
            hydration.controller.signal,
        ]);
        try {
            await withPageStageTimeout(
                annotationLayerRenderer.renderAnnotationLayer(
                    context.pdfPage,
                    annotationLayerDiv,
                    context.renderResult.viewport,
                    pageNumber,
                    context.renderResult.annotationCanvasMap,
                    {
                        signal,
                        shouldContinue,
                    },
                ),
                {
                    pageNumber,
                    stage: 'annotation-layer',
                    timeoutMs: PDF_PAGE_RENDER_TIMEOUT_MS,
                },
                shouldContinue,
                () => controller.abort(),
                undefined,
                renderSupervisor,
                signal,
            );
        } catch (error) {
            if (shouldContinue() && !isRenderCancellation(error)) {
                return {
                    error,
                    failure: logNonCriticalStageError(pageNumber, 'annotation layer', error),
                };
            }
        }
        return shouldContinue();
    }

    // A layer that failed keeps the readable canvas and waits for the
    // user's Retry instead of being promoted again on every frame.
    function settleFailedLayers(pageNumber: TPageNumber, hydration: IPdfLayerHydration, layer: IPdfLayerStageFailure) {
        if (!resources.settleHydration(pageNumber, hydration, 'failed')) return;
        options.onRenderedPageStateChanged?.();
        if (!layer.failure) return;
        presentPageFailure(pageNumber, {
            receipt: layer.failure,
            error: layer.error,
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

    async function hydrateCommittedLayers(
        commit: ICommittedPdfPageRaster,
        hydration: IPdfLayerHydration,
        publishRaster?: TPdfRasterPublication,
    ) {
        const {
            pageNumber,
            container,
            renderResult,
            renderOptions,
        } = commit;
        if (
            renderOptions.contentIntent === 'canvas-only-buffer'
            || renderOptions.contentIntent === 'canvas-only-refine'
        ) {
            if (!publishRaster?.(renderOptions.contentIntent === 'canvas-only-refine' ? 'retain' : 'canvas-only')) return;
            container.querySelectorAll('.annotation-layer canvas').forEach(canvas => canvas.remove());
            options.onRenderedPageStateChanged?.();
            return;
        }
        const documentFence = options.document.captureFence();
        // The owner identity implies the rest: a newer raster, a new render
        // version and a released page each end this hydration's ownership.
        const shouldContinue = () => !hydration.controller.signal.aborted
            && resources.get(pageNumber).hydration === hydration
            && options.document.isCurrent(documentFence)
            && container.isConnected !== false
            && container.dataset.page === String(pageNumber);
        const outgoingText = container.querySelector<HTMLDivElement>('.text-layer');
        const textHost = publishRaster ? container.cloneNode(false) as HTMLElement : null;
        let incomingText = outgoingText;
        const outgoingAnnotations = container.querySelector<HTMLElement>('.annotation-layer');
        const incomingAnnotations = textHost && outgoingAnnotations ? outgoingAnnotations.cloneNode(false) as HTMLElement : null;
        if (textHost && incomingAnnotations) textHost.append(incomingAnnotations);
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
            // Keep the mounted spans on scale-only renders. Replacing them
            // collapses every in-flight selection Range, even if the browser's
            // visible selection is restored onto the replacement afterwards.
            if (textHost && outgoingText && !textLayerRenderer.canReuseTextLayer(lease.page, outgoingText)) {
                incomingText = outgoingText.cloneNode(false) as HTMLDivElement;
                const structureHost = document.createElement('div');
                structureHost.className = 'page_canvas__render-layer';
                textHost.append(structureHost, incomingText);
            }
            const context = {
                container,
                pdfPage: lease.page,
                renderResult,
                textLayerDiv: incomingText,
            };
            const stagedAnnotations = publishRaster && renderResult.annotationOutput?.ownCanvases.length !== 0
                ? await renderAnnotationLayerForPage(pageNumber, {
                    ...context,
                    container: textHost ?? container,
                }, hydration, shouldContinue)
                : null;
            if (typeof stagedAnnotations === 'object' && stagedAnnotations !== null) throw stagedAnnotations.error;
            if (stagedAnnotations === false) return;
            if (stagedAnnotations && renderResult.annotationOutput?.ownCanvases.some(entry => !incomingAnnotations?.contains(entry[1]))) return;
            const textReady = await renderTextLayerForPage(
                pageNumber,
                context,
                hydration.controller.signal,
                shouldContinue,
                () => {
                    if (!shouldContinue()) return false;
                    if (publishRaster ? !publishRaster('hydrating') : !resources.beginLayers(pageNumber, hydration)) return false;
                    if (incomingAnnotations && outgoingAnnotations) outgoingAnnotations.replaceWith(incomingAnnotations);
                    if (textHost && outgoingText && incomingText && incomingText !== outgoingText) {
                        // Rebuilt spans replace the mounted ones; a selection on those ends here.
                        clearSelectionBeforePageLayerTeardown(pageNumber);
                        outgoingText.replaceWith(incomingText);
                        textLayerRenderer.cleanupTextLayerDom(outgoingText);
                        container.querySelector('.page_canvas__render-layer, .page_canvas')
                            ?.append(...textHost.querySelectorAll('.structTree'));
                    }
                    options.onRenderedPageStateChanged?.();
                    return true;
                },
            );
            if (!textReady) return;
            if (typeof textReady !== 'object' && incomingText) {
                if (!resources.markText(pageNumber, hydration, incomingText)) return;
                try {
                    textLayerRenderer.applyPageSearchHighlights(container, incomingText, pageNumber, renderResult.viewport);
                } catch (error) {
                    logNonCriticalStageError(pageNumber, 'search highlights', error);
                }
                options.onRenderedPageStateChanged?.();
            }
            const annotation = stagedAnnotations ?? await renderAnnotationLayerForPage(pageNumber, context, hydration, shouldContinue);
            const failure = typeof textReady === 'object' ? textReady : typeof annotation === 'object' ? annotation : null;
            if (failure) {
                if (shouldContinue()) settleFailedLayers(pageNumber, hydration, failure);
                return;
            }
            if (!annotation || !shouldContinue()) return;
            textLayerRenderer.scheduleOcrDebugForPage?.(pageNumber, context);
            if (!shouldContinue() || !resources.settleHydration(pageNumber, hydration, 'ready')) return;
            options.onPageLayersCommitted?.({
                kind: 'page-layer-committed',
                pageNumber,
            }, documentFence);
            options.onRenderedPageStateChanged?.();
        } finally {
            if (incomingText && textHost && !incomingText.isConnected) textLayerRenderer.cleanupTextLayerDom(incomingText);
            lease?.release();
        }
    }

    async function renderLayerPromotions(
        range: IPageRange,
        renderOptions: IRenderVisiblePagesOptions,
    ) {
        const pages = (renderOptions.rasterDemandPages
            ?? Array.from(
                {length: range.end - range.start + 1},
                (_, index) => range.start + index,
            ))
            .filter(pageNumber => pageNumber >= 1 && pageNumber <= numPages.value)
            .map(pageNumber => requirePageNumber(pageNumber, numPages.value));
        for (const pageNumber of pages) {
            const resource = resources.get(pageNumber);
            const container = getMountedPageContainer(pageNumber, options.container.value);
            const renderResult = options.getCommittedRender(pageNumber);
            // A failed layer is promoted only by the user's Retry.
            if (!container || !renderResult || isPdfPageBusy(resource) || (resource.layers !== 'canvas-only' && resource.layers !== 'failed')) {
                continue;
            }
            if (renderResult.annotationOutput?.ownCanvases.length) {
                await options.requestSearchPageRaster(pageNumber, true);
                continue;
            }
            await renderCommittedPageLayers({
                pageNumber,
                container,
                renderResult,
                renderOptions,
            });
        }
    }

    function resolveLayerPromotionDemand(pages: readonly number[]) {
        const promotionPages = pages
            .map(page => requirePageNumber(page, numPages.value))
            .filter((page) => {
                const resource = resources.get(page);
                return resource.shown !== null && resource.layers === 'canvas-only' && !isPdfPageBusy(resource);
            });
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
                preserveRenderedPages: true,
                rasterDemandPages: promotionPages,
                renderWindowOverride: range,
            },
        };
    }

    /** Promotes the pages' layers text-first now, or as soon as each page is idle. */
    async function promoteTextLayers(pages: readonly number[]) {
        const promotion = resolveLayerPromotionDemand(pages);
        if (promotion) {
            await renderLayerPromotions(promotion.range, {
                ...promotion.options,
                prioritizeTextLayer: true,
            });
            return;
        }
        for (const rawPageNumber of pages) {
            const pageNumber = requirePageNumber(rawPageNumber, numPages.value);
            const resource = resources.get(pageNumber);
            resources.requestTextFirst(pageNumber, !resource.text && resource.layers !== 'ready');
            void promoteQueuedTextLayer(pageNumber);
        }
    }

    return {
        renderCommittedPageLayers,
        renderLayerPromotions,
        presentPageRenderFailure(pageNumber: TPageNumber, error: unknown, retry?: () => Promise<unknown>, isVisible: () => boolean = () => true) {
            const receipt = logNonCriticalStageError(pageNumber, 'canvas', error);
            if (!receipt) return;
            const present = () => presentPageFailure(pageNumber, {
                receipt,
                error,
                description: t('common.pageRenderFailed'),
                retry,
            });
            if (isVisible()) return present();
            // Told once the page is seen, while its failure lasts: scrolling it into
            // view keeps the failure; a new attempt or render version ends it.
            const version = resources.get(pageNumber).job?.demand.consumerGeneration;
            const stop = watch(() => {
                const {job} = resources.get(pageNumber);
                return job?.rasterState === 'failed' && job.demand.consumerGeneration === version ? isVisible() : null;
            }, (visible) => {
                if (visible !== false) stop();
                if (visible) present();
            }, {flush: 'sync'});
            options.document.registerDisposable(stop);
        },
        resolveLayerPromotionDemand,
        promoteTextLayers,
        cleanupAllLayers,
        dispose() {
            disposed = true;
        },
        releasePageLayers,
        applySearchHighlights: searchController.applySearchHighlights,
        annotationProjectionReady,
        annotationPaintIdentities,
        isAnnotationInputCurrent: (pageNumber: TPageNumber, input: IPdfAnnotationRenderInput | undefined) => !input
            || input.document === pdfDocument.value && input.signature === (annotationPaintIdentities.value.get(pageNumber) ?? ''),
        async prepareCanvasAnnotations(page: IPdfPage, captureSettlement?: TPdfPageOperationSettlementCapture, signal?: AbortSignal, reserveAppearanceBytes?: (bytes: number) => void, accepted?: IAcceptedNativeTextBox) {
            const parsed = getParsedPageAnnotations(page);
            captureSettlement?.(parsed.then(() => undefined, () => undefined));
            return projection.value?.preparePagePaint(page, await parsed, signal, reserveAppearanceBytes, accepted);
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
