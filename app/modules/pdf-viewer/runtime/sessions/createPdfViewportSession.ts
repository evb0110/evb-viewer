import type {
    ComputedRef,
    Ref,
} from 'vue';
import type {
    TFitMode,
    TPdfViewRotation,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import type { IPageRange } from '@app/types/pdfUi';
import type { ILinkAnnotation } from '@app/types/annotations';
import type { IDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { hasCommittedDocumentOpeningLayout } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { createPageNavigationRequest } from '@app/modules/pdf-viewer/engine/viewport/createPageNavigationRequest';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import { normalizePageMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/normalizePageMetrics';
import { setupPagePlaceholderSizes } from '@app/modules/pdf-viewer/engine/pdf-page-buffer-manager/setupPagePlaceholderSizes';
import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import {
    getViewportVisibilityFromDom,
    getViewportVisibilityFromLayout,
} from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getViewportVisibilityFromDom';
import {
    isPdfVisibleRenderRangeCurrent,
    resolvePdfProtectedVisibleRange,
} from '@app/modules/pdf-viewer/engine/pdf-visible-render-range-policy/isPdfVisibleRenderRangeCurrent';
import type { IPdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';
import { createPdfPageSlotRegistry } from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';
import { resolvePdfRasterResidencyPlan } from '@app/modules/pdf-viewer/runtime/rendering/resolvePdfRasterResidencyPlan';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';
import { usePdfScale } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScale';
import { usePdfScroll } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import { useViewportPagePin } from '@app/modules/pdf-viewer/runtime/composables/pdf/useViewportPagePin';
import { usePdfSkeletonInsets } from '@app/modules/pdf-viewer/runtime/skeleton/usePdfSkeletonInsets';
import { usePdfViewerReloadTransition } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerReloadTransition';
import { usePdfViewerCurrentPageSync } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import { usePdfViewportViewModel } from '@app/modules/pdf-viewer/runtime/viewport/usePdfViewportViewModel';
import { usePdfOpenVirtualSurfaceGeometry } from '@app/modules/pdf-viewer/runtime/viewport/usePdfOpenVirtualSurfaceGeometry';
import { usePdfSinglePageNavigationController } from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageNavigationController';
import { usePdfViewerTransactionController } from '@app/modules/pdf-viewer/runtime/transactions/usePdfViewerTransactionController';
import type { IPdfViewportWritePort } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';
import { createPdfOpenSurfaceViewportCallbacks } from '@app/modules/pdf-viewer/runtime/viewport/createPdfOpenSurfaceViewportCallbacks';
import { reconcilePdfOpeningViewportCommit } from '@app/modules/pdf-viewer/runtime/viewport/reconcilePdfOpeningViewportCommit';
import { createPdfOpeningViewportStallDiagnostic } from '@app/modules/pdf-viewer/runtime/viewport/createPdfOpeningViewportStallDiagnostic';
import { createPdfViewportUserNavigationEpochs } from '@app/modules/pdf-viewer/runtime/viewport/createPdfViewportUserNavigationEpochs';
import type { IZoomVirtualizationFreeze } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerVirtualization';
import type { IResizeTransitionSignal } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewerViewportTypes';
import { resolvePdfPreparedOpeningFitScale } from '@app/modules/pdf-viewer/runtime/lifecycle/resolvePdfPreparedOpeningFitScale';
import { resolveCustomReloadZoomMultiplier } from '@app/modules/pdf-viewer/runtime/reload-zoom/resolveCustomReloadZoomMultiplier';
import {resolvePdfReadyMetricRange} from '@app/modules/pdf-viewer/runtime/sessions/resolvePdfReadyMetricRange';
import type { IPdfViewportReloadPlacement } from '@app/modules/pdf-viewer/runtime/sessions/pdfViewportReloadPlacement';
import type {
    IPdfDocumentTransition,
    TPdfDocumentSession,
} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
const RELOAD_RECOVERY_PAGE_PIN_MS = 900;
export interface IPdfViewportDemand {
    readonly revision: number;
    readonly visibleRange: IPageRange;
    readonly requiredPages: readonly number[];
    readonly nearbyPages: readonly number[];
    readonly residentPages: readonly number[];
    readonly mountedPages: readonly number[];
    readonly currentPage: number;
    readonly destinationPage: number | null;
    readonly operational: boolean;
    readonly mandatoryRaster: IPdfViewportMandatoryRaster | null;
}
export interface IPdfViewportMandatoryRaster {
    readonly id: number;
    readonly range: IPageRange;
    readonly options: IRenderVisiblePagesOptions;
}
export interface ICreatePdfViewportSessionOptions {
    document: TPdfDocumentSession;
    isPageFreshlyRenderedForNavigation: (pageNumber: number) => boolean;
    waitForPageTextLayerReady?: ((pageNumber: number, signal: AbortSignal) => Promise<boolean>) | undefined;
    getCommittedPageScale?: ((pageNumber: number) => number | null) | undefined;
    chassisAuthority: IDocumentViewerChassisAuthority | null;
    performancePolicy: IPdfRenderPerformancePolicy;
    maxBufferCanvasPixels: number;
    settledMaxCanvasPixels: number;
    viewerContainer: Ref<HTMLElement | null>;
    viewportWritePort: IPdfViewportWritePort;
    zoom: ComputedRef<number>;
    zoomMode: ComputedRef<TZoomMode>;
    fitMode: ComputedRef<TFitMode>;
    viewMode: ComputedRef<TPdfViewMode>;
    viewRotation?: ComputedRef<TPdfViewRotation>;
    continuousScroll: ComputedRef<boolean>;
    bufferPages: ComputedRef<number>;
    isActive: ComputedRef<boolean>;
    isResizing: ComputedRef<boolean>;
    requestedCurrentPage: Ref<number | undefined>;
    outputScale: Ref<number>;
    selectionMarkupStyle: Parameters<typeof usePdfViewportViewModel>[0]['selectionMarkupStyle'];
    classState: Parameters<typeof usePdfViewportViewModel>[0]['classState'];
    emitCurrentPage: (page: number) => void;
    emitNavigationFeedbackPage: (page: number | null) => void;
    emitZoom: (value: number) => void;
    emitEffectiveZoom: (value: number) => void;
    summarizeViewerStateForLog: () => unknown;
    clearPendingImagePlacement: () => void;
}
export const createPdfViewportSession = (options: ICreatePdfViewportSessionOptions) => {
    const documentSession = options.document;
    const {
        pdfDocument,
        numPages,
        isLoading,
        basePageWidth,
        basePageHeight,
        pageMetrics,
        pageMetricsVersion,
    } = documentSession;
    const viewRotation = options.viewRotation ?? computed<TPdfViewRotation>(() => 0);
    const chassisAuthority = options.chassisAuthority;
    const viewportWritePort = options.viewportWritePort;
    const pageSlots = createPdfPageSlotRegistry();
    const navigationEpochs = createPdfViewportUserNavigationEpochs();
    const { userViewportInteractionEpoch } = navigationEpochs;
    const zoomVirtualizationFreeze = ref<IZoomVirtualizationFreeze | null>(null);
    const resizeTransitionVisible = ref(false);
    const resizeTransitionAnchorPage = ref<number | null>(null);
    const zoomSnapSuppressedForClass = ref(false);
    const cancelPendingSearchRevision = ref(0);
    const cancelRasterRevision = ref(0);
    const visualReadySignal = shallowRef({
        revision: 0,
        pageNumber: 0,
    });
    const navigationCommittedSignal = shallowRef({
        revision: 0,
        pageNumber: 0,
    });
    const viewportPin = useViewportPagePin({summarizeViewerStateForLog: options.summarizeViewerStateForLog});
    const scroll = usePdfScroll({
        getPinnedMostVisiblePage: () => viewportPin.getPinnedViewportPage(),
        viewportWritePort,
    });
    const scale = usePdfScale(
        options.zoom,
        options.zoomMode,
        options.fitMode,
        options.viewMode,
        viewRotation,
        numPages,
        pageMetrics,
        pageMetricsVersion,
        basePageWidth,
        basePageHeight,
        scroll.currentPage,
    );
    const reloadTransition = usePdfViewerReloadTransition({
        emitEffectiveZoom: options.emitEffectiveZoom,
        summarizeViewerStateForLog: options.summarizeViewerStateForLog,
    });
    watch(
        () => scale.layoutScale.value,
        value => reloadTransition.emitEffectiveZoom(value),
        { immediate: true },
    );
    const skeletonInsets = usePdfSkeletonInsets(basePageWidth, basePageHeight, scale.effectiveScale);
    const currentPage = scroll.currentPage;
    const visibleRange = ref({
        start: 1,
        end: 1,
    });
    const viewportLayoutMetrics = shallowRef<IPdfPageLayoutMetrics | null>(null);
    const pageLayoutScaleResolver = shallowRef<((pageNumber: number) => number) | null>(null);
    function seedPreparedOpeningFitScale() {
        if (!chassisAuthority) {
            return false;
        }
        const preparedScale = resolvePdfPreparedOpeningFitScale(
            chassisAuthority.openSurface.snapshot.value,
            options.zoomMode.value === 'custom',
        );
        return preparedScale === null ? false : scale.seedOpeningFitScale(preparedScale);
    }
    watchEffect(seedPreparedOpeningFitScale);
    function shouldPreserveOpeningLayout() {
        const snapshot = chassisAuthority?.openSurface.snapshot.value;
        return snapshot !== undefined && hasCommittedDocumentOpeningLayout(snapshot);
    }
    function setupPagePlaceholders() {
        const containerRoot = options.viewerContainer.value;
        const baseWidth = basePageWidth.value;
        const baseHeight = basePageHeight.value;
        if (!containerRoot || !baseWidth || !baseHeight) {
            return;
        }
        setupPagePlaceholderSizes(
            containerRoot,
            normalizePageMetrics({
                pageMetrics: pageMetrics.value,
                totalPages: numPages.value,
                fallbackWidth: baseWidth,
                fallbackHeight: baseHeight,
                viewRotation: viewRotation.value,
            }),
            scale.effectiveScale.value,
            pageNumber => pageLayoutScaleResolver.value?.(pageNumber) ?? scale.effectiveScale.value,
        );
    }
    function getNavigationRenderTargetPage() {
        return transactionController.targetPage.value
            ?? singlePageScroll.navigationAnchorPage.value
            ?? null;
    }
    function getProtectedVisibleRange() {
        return resolvePdfProtectedVisibleRange({
            visibleRange: visibleRange.value,
            navigationTargetPage: getNavigationRenderTargetPage(),
            viewMode: options.viewMode.value,
            totalPages: numPages.value,
        });
    }
    function isVisibleRenderRangeCurrent(range: IPageRange) {
        return isPdfVisibleRenderRangeCurrent({
            range,
            visibleRange: visibleRange.value,
            navigationTargetPage: getNavigationRenderTargetPage(),
            viewMode: options.viewMode.value,
            totalPages: numPages.value,
        });
    }
    async function prepareNavigationLayout(pageNumber: number, signal: AbortSignal) {
        const range = getPageRowBoundsForViewMode({
            pageNumber,
            viewMode: options.viewMode.value,
            totalPages: numPages.value,
        });
        await documentSession.ensurePageMetricsInRange(range.start, range.end);
        if (signal.aborted || options.zoomMode.value === 'custom') {
            return;
        }
        scale.invalidateScaleCache(); scale.computeFitWidthScale(options.viewerContainer.value, {page: pageNumber});
        setupPagePlaceholders();
        await nextTick();
    }
    let resolvedPageToRestore = 1;
    let activeReloadTransactionId: number | null = null;
    let visualReloadTransitionToken: number | null = null;
    function projectViewportVisibleRange(container: HTMLElement | null, totalPages: number) {
        if (!container || totalPages <= 0) {
            return visibleRange.value;
        }
        const domVisibility = getViewportVisibilityFromDom(container, totalPages);
        const visibility = domVisibility.range || domVisibility.mostVisiblePage !== null
            ? domVisibility
            : getViewportVisibilityFromLayout(container, totalPages, viewportLayoutMetrics.value) ?? domVisibility;
        visibleRange.value = visibility.range ?? visibleRange.value;
        return visibleRange.value;
    }
    function getVisibleRange(): IPageRange {
        if (!options.continuousScroll.value && numPages.value > 0) {
            const rowBounds = getPageRowBoundsForViewMode({
                pageNumber: currentPage.value,
                viewMode: options.viewMode.value,
                totalPages: numPages.value,
            });
            return {
                start: rowBounds.start,
                end: rowBounds.end,
            };
        }
        projectViewportVisibleRange(options.viewerContainer.value, numPages.value);
        return visibleRange.value;
    }
    const openSurfaceViewportCallbacks = createPdfOpenSurfaceViewportCallbacks(
        chassisAuthority,
        options.emitCurrentPage,
        (page) => {
            navigationCommittedSignal.value = {
                revision: navigationCommittedSignal.value.revision + 1,
                pageNumber: page,
            };
        },
    );
    const singlePageScroll = usePdfSinglePageNavigationController({
        viewerContainer: options.viewerContainer,
        numPages,
        currentPage,
        scaledMargin: scale.scaledMargin,
        viewMode: options.viewMode,
        continuousScroll: options.continuousScroll,
        isResizeTransitionActive: computed(() => options.isResizing.value || resizeTransitionVisible.value),
        isLoading,
        pdfDocument,
        getMostVisiblePage: scroll.getMostVisiblePage,
        scrollToPageInternal: scroll.scrollToPage,
        updateVisibleRange: projectViewportVisibleRange,
        updateCurrentPage: scroll.updateCurrentPage,
        commitVisibleRange: (range, commitOptions) => transactionController.commitVisibleRange(range, commitOptions),
        renderVisiblePages: (range, renderOptions) => requestMandatoryRaster(range, renderOptions),
        ensurePageMetricsInRange: documentSession.ensurePageMetricsInRange,
        prepareNavigationLayout,
        isPageFreshlyRenderedForNavigation: options.isPageFreshlyRenderedForNavigation,
        waitForPageTextLayerReady: options.waitForPageTextLayerReady,
        visibleRange,
        emitCurrentPage: options.emitCurrentPage,
        emitNavigationFeedbackPage: options.emitNavigationFeedbackPage,
        viewportWritePort,
        getPageLayoutMetrics: () => viewportLayoutMetrics.value,
        bindCurrentPageProjection: scroll.bindCurrentPageProjection,
        getDocumentRevision: () => documentSession.captureFence().loadToken,
        getGeometryRevision: () => pageMetricsVersion.value + 1,
        beginLayoutGeometryReplacement: navigationEpochs.beginLayoutGeometryReplacement,
        pageSlots,
        requestedCurrentPage: options.requestedCurrentPage,
        cancelPendingSearchScroll: () => {
            cancelPendingSearchRevision.value += 1;
        },
        requestSurfacePageNavigation: page => chassisAuthority?.navigate(page) ?? page,
        onPageVisualReady: page => {
            visualReadySignal.value = {
                revision: visualReadySignal.value.revision + 1,
                pageNumber: page,
            };
        },
        ...openSurfaceViewportCallbacks,
    });
    const transactionController = usePdfViewerTransactionController({
        currentPage,
        visibleRange,
        numPages,
        viewMode: options.viewMode,
        pdfDocument,
        userViewportInteractionEpoch,
        getDocumentLoadToken: () => documentSession.captureFence().loadToken,
        getDocumentVersion: documentSession.getRenderVersion,
        executeCancellationEffects: (cancellation) => {
            if (cancellation.cancelInFlightRenders || cancellation.bumpRenderVersion) {
                cancelRasterRevision.value += 1;
            }
        },
        navigationState: singlePageScroll.navigationState,
    });
    const {
        summarizeViewerMetricsForLog,
        summarizeVisiblePageSnapshotForLog,
        syncCurrentPageFromViewport,
    } = usePdfViewerCurrentPageSync({
        viewerContainer: options.viewerContainer,
        numPages,
        visibleRange,
        currentPage,
        pdfDocument,
        isLoading,
        getMostVisiblePage: scroll.getMostVisiblePage,
        updateCurrentPage: scroll.updateCurrentPage,
        emitCurrentPage: options.emitCurrentPage,
        canSyncCurrentPageFromViewport: () => singlePageScroll.currentPageAuthority.canSyncFromViewport(),
        commitCurrentPageFromViewport: page => singlePageScroll.currentPageAuthority.commitViewportPage(page),
    });
    watch(
        () => {
            const viewportSession = chassisAuthority?.openSurface.viewportSession.value;
            return [
                viewportSession?.lifecycle ?? null,
                viewportSession?.requestedPage ?? null,
                viewportSession?.committedPage ?? null,
                viewportSession?.viewportIntent?.id ?? null,
            ] as const;
        },
        (viewportSession, previousViewportSession) => {
            // Page and scale projections can arrive before the shared surface is
            // ready. Replay both authorities at that lifecycle edge so the
            // workspace reflects the geometry that already settled physically.
            if (
                viewportSession[0] === 'ready'
                && previousViewportSession?.[0] !== 'ready'
            ) {
                options.emitCurrentPage(currentPage.value);
                reloadTransition.emitEffectiveZoom(scale.layoutScale.value);
            }
        },
        {
            flush: 'sync',
            immediate: true,
        },
    );
    const viewModel = usePdfViewportViewModel({
        performancePolicy: options.performancePolicy,
        isActive: options.isActive,
        viewerContainer: options.viewerContainer,
        bufferPages: options.bufferPages,
        viewMode: options.viewMode,
        viewRotation,
        numPages,
        currentPage,
        continuousScroll: options.continuousScroll,
        basePageWidth,
        basePageHeight,
        pageMetrics,
        pageMetricsVersion,
        effectiveScale: scale.layoutScale,
        scaledMargin: scale.scaledMargin,
        visibleRange,
        navigationAnchorPage: singlePageScroll.navigationAnchorPage,
        navigationVisualHandoffTargetPage: singlePageScroll.navigationVisualHandoffTargetPage,
        getCommittedPageScale: options.getCommittedPageScale,
        resizeTransitionAnchorPage,
        zoomVirtualizationFreeze,
        scaleContainerStyle: scale.containerStyle,
        selectionMarkupStyle: options.selectionMarkupStyle,
        viewportWritePort,
        classState: options.classState,
    });
    pageLayoutScaleResolver.value = viewModel.getPageLayoutScale;
    const openVirtualSurfaceGeometry = usePdfOpenVirtualSurfaceGeometry({
        chassisAuthority,
        continuousScroll: options.continuousScroll,
        viewMode: options.viewMode,
        scaledMargin: scale.scaledMargin,
        virtualizedBottomVirtualSpacerStyle: viewModel.bottomVirtualSpacerStyle,
        getLastMountedPage: () => viewModel.virtualPageSegments.value.at(-1)?.end,
        viewerContainer: options.viewerContainer,
        zoomMode: options.zoomMode,
        hasExactPageGeometry: documentSession.hasExactPageGeometry,
        isFitWidthScaleCurrent: scale.isFitWidthScaleCurrent,
        getPagePlaceholderStyle: viewModel.getPagePlaceholderStyle,
    });
    let mandatoryRasterId = 0;
    let pendingMandatoryRaster: IPdfViewportMandatoryRaster | null = null;
    const mandatoryRasterResolvers = new Map<number, () => void>();
    let demandRevision = 0;
    function estimatePageRasterPixels(pageNumber: number) {
        const metric = pageMetrics.value[pageNumber - 1];
        const width = metric?.width ?? basePageWidth.value ?? 1;
        const height = metric?.height ?? basePageHeight.value ?? 1;
        const scaled = scale.effectiveScale.value * options.outputScale.value;
        const requestedPixels = Math.max(1, Math.round(width * scaled))
            * Math.max(1, Math.round(height * scaled));
        return Math.min(requestedPixels, options.settledMaxCanvasPixels);
    }
    function clampedProtectedVisibleRange(): IPageRange {
        const requested = getProtectedVisibleRange();
        const pageCount = Math.max(1, numPages.value);
        const start = Math.max(1, Math.min(pageCount, Math.trunc(requested.start)));
        return {
            start,
            end: Math.max(start, Math.min(pageCount, Math.trunc(requested.end))),
        };
    }
    const demand = shallowRef<IPdfViewportDemand>({
        revision: 0,
        visibleRange: {
            start: 1,
            end: 1,
        },
        requiredPages: [],
        nearbyPages: [],
        residentPages: [],
        mountedPages: [],
        currentPage: 1,
        destinationPage: null,
        operational: false,
        mandatoryRaster: null,
    });
    function resolveDemand(): IPdfViewportDemand {
        demandRevision += 1;
        const range = clampedProtectedVisibleRange();
        const operational = (options.isActive.value || pendingMandatoryRaster !== null)
            && !isLoading.value
            && pdfDocument.value !== null
            && numPages.value > 0;
        if (!operational) {
            return {
                revision: demandRevision,
                visibleRange: range,
                requiredPages: [],
                nearbyPages: [],
                residentPages: [],
                mountedPages: [],
                currentPage: currentPage.value,
                destinationPage: getNavigationRenderTargetPage(),
                operational: false,
                mandatoryRaster: pendingMandatoryRaster,
            };
        }
        const mountedPages = viewModel.pagesToRender.value.filter(page => pageSlots.isMounted(page));
        const plan = resolvePdfRasterResidencyPlan({
            mountedPages,
            visibleRange: range,
            bufferRadius: options.bufferPages.value,
            maxBufferPixels: options.maxBufferCanvasPixels,
            estimatePagePixels: estimatePageRasterPixels,
        });
        const mounted = new Set(mountedPages);
        const requiredPages = plan.visiblePages.filter(page => mounted.has(page));
        const nearbyPages = plan.bufferPages.filter(page => mounted.has(page));
        const committedViewportPages = getNavigationRenderTargetPage() === null
            ? []
            : mountedPages.filter(page => (
                page >= visibleRange.value.start
                && page <= visibleRange.value.end
            ));
        return {
            revision: demandRevision,
            visibleRange: range,
            requiredPages,
            nearbyPages,
            residentPages: [...new Set([
                ...requiredPages,
                ...nearbyPages,
                // Retain semantic and physical demand until the destination raster commits.
                ...committedViewportPages,
            ])],
            mountedPages,
            currentPage: currentPage.value,
            destinationPage: getNavigationRenderTargetPage(),
            operational: true,
            mandatoryRaster: pendingMandatoryRaster,
        };
    }
    function publishDemand() {
        demand.value = resolveDemand();
    }
    let mountedVisibilityFrameId: number | null = null;
    let mountedVisibilityProjectionDisposed = false;
    function cancelMountedVisibilityProjection() {
        if (mountedVisibilityFrameId !== null) {
            window.cancelAnimationFrame(mountedVisibilityFrameId);
            mountedVisibilityFrameId = null;
        }
    }
    function scheduleMountedVisibilityProjection() {
        if (!options.continuousScroll.value) {
            return;
        }
        cancelMountedVisibilityProjection();
        void nextTick(() => {
            if (mountedVisibilityProjectionDisposed) {
                return;
            }
            mountedVisibilityFrameId = window.requestAnimationFrame(() => {
                if (mountedVisibilityProjectionDisposed) {
                    mountedVisibilityFrameId = null;
                    return;
                }
                mountedVisibilityFrameId = window.requestAnimationFrame(() => {
                    mountedVisibilityFrameId = null;
                    if (mountedVisibilityProjectionDisposed) {
                        return;
                    }
                    projectViewportVisibleRange(options.viewerContainer.value, numPages.value);
                    publishDemand();
                });
            });
        });
    }
    function requestMandatoryRaster(
        range: IPageRange,
        renderOptions: IRenderVisiblePagesOptions = {},
    ) {
        if (pendingMandatoryRaster) {
            mandatoryRasterResolvers.get(pendingMandatoryRaster.id)?.();
            mandatoryRasterResolvers.delete(pendingMandatoryRaster.id);
        }
        return new Promise<void>((resolve) => {
            const id = ++mandatoryRasterId;
            pendingMandatoryRaster = {
                id,
                range,
                options: {
                    ...renderOptions,
                    // Mandatory work normally isolates its exact range. The
                    // semantic navigation path explicitly opts out so the old
                    // visible raster remains resident until the target paints.
                    suppressResidentRasterDemand: renderOptions.suppressResidentRasterDemand ?? true,
                    bufferOverride: renderOptions.bufferOverride ?? 0,
                    preserveInFlightRequiredPages: renderOptions.preserveInFlightRequiredPages ?? true,
                    preserveRenderedPages: renderOptions.preserveRenderedPages ?? true,
                },
            };
            mandatoryRasterResolvers.set(id, resolve);
            publishDemand();
        });
    }
    function settleMandatoryRaster(id: number) {
        mandatoryRasterResolvers.get(id)?.();
        mandatoryRasterResolvers.delete(id);
        if (pendingMandatoryRaster?.id !== id) {
            return;
        }
        pendingMandatoryRaster = null;
        publishDemand();
    }
    function cancelMandatoryRaster() {
        for (const resolve of mandatoryRasterResolvers.values()) {
            resolve();
        }
        mandatoryRasterResolvers.clear();
        pendingMandatoryRaster = null;
        publishDemand();
    }
    // `pagesToRender` can be disjoint, so its watch key needs every page. Cache
    // the join to avoid an O(mounted pages) string build on unrelated changes.
    const renderedPagesKey = computed(() => viewModel.pagesToRender.value.join(','));
    watch(
        () => [
            visibleRange.value.start,
            visibleRange.value.end,
            renderedPagesKey.value,
            options.bufferPages.value,
            scale.effectiveScale.value,
            options.outputScale.value,
            options.isActive.value,
            isLoading.value,
            Boolean(pdfDocument.value),
            numPages.value,
            userViewportInteractionEpoch.value,
            transactionController.activeTransaction.value !== null,
        ] as const,
        publishDemand,
        {
            flush: 'sync',
            immediate: true,
        },
    );
    function commitVisibleRange(range: IPageRange, transactionId: number | null) {
        const didCommit = transactionController.commitVisibleRange(
            range,
            transactionId !== null ? { transactionId } : undefined,
        );
        if (didCommit !== undefined) {
            return didCommit;
        }
        visibleRange.value = range;
        return true;
    }
    function applyReloadViewport(pageNumber: number, scrollOptions?: IScrollToPageOptions) {
        scroll.scrollToPage(
            options.viewerContainer.value,
            pageNumber,
            numPages.value,
            scale.scaledMargin.value,
            scrollOptions,
        );
        const committed = singlePageScroll.commitCurrentViewportIfSettled(pageNumber)
            || singlePageScroll.applyOpeningViewportAnchor(pageNumber) === true
            && singlePageScroll.commitCurrentViewportIfSettled(pageNumber);
        logPdfRenderTrace('pdf-reload-viewport-reanchor', {
            pageNumber,
            afterScrollTop: options.viewerContainer.value?.scrollTop ?? null,
            committed,
        });
        return committed;
    }
    function settleVisualReloadTransition(reason: string) {
        if (visualReloadTransitionToken === null) {
            return;
        }
        reloadTransition.endVisualReloadTransition(visualReloadTransitionToken, reason);
        visualReloadTransitionToken = null;
    }
    function beginReloadPlacement(transition: IPdfDocumentTransition): IPdfViewportReloadPlacement {
        const plan = transition.plan;
        const pageToRestore = plan.isReload
            ? currentPage.value
            : 1;
        resolvedPageToRestore = Math.max(1, Math.floor(pageToRestore));
        const displayZoomToRestore = plan.isReload && options.zoomMode.value === 'custom'
            ? scale.effectiveScale.value
            : null;
        const shouldPinReloadPage = plan.isReload && resolvedPageToRestore > 1;
        activeReloadTransactionId = transactionController.beginTransaction({
            kind: 'reload',
            source: 'reload',
            page: resolvedPageToRestore,
            range: {
                start: resolvedPageToRestore,
                end: resolvedPageToRestore,
            },
            anchor: 'top',
            scrollPlan: {
                preferExactDom: true,
                commitCurrentPageOnScroll: true,
                suppressSnapAfterScroll: true,
                holdProgrammaticNavigationMs: RELOAD_RECOVERY_PAGE_PIN_MS,
            },
        })?.id ?? null;
        visualReloadTransitionToken = shouldPinReloadPage
            ? reloadTransition.beginVisualReloadTransition('reload-recovery')
            : null;
        if (shouldPinReloadPage) {
            viewportPin.pinCurrentPageDuringRecovery(resolvedPageToRestore, {
                durationMs: RELOAD_RECOVERY_PAGE_PIN_MS,
                reason: 'reload-recovery',
            });
        }
        options.emitCurrentPage(pageToRestore);
        const preserveOpeningLayout = !plan.isReload && shouldPreserveOpeningLayout();
        const preserveReloadDisplayZoom = plan.isReload
            && !plan.isSelectiveReload
            && displayZoomToRestore !== null;
        if (!plan.isSelectiveReload) {
            if (plan.isReload || preserveReloadDisplayZoom || preserveOpeningLayout) {
                scale.invalidateScaleCache();
            } else {
                scale.resetScale();
            }
            if (!preserveOpeningLayout) {
                skeletonInsets.resetInsets();
            }
            commitVisibleRange({
                start: pageToRestore,
                end: pageToRestore,
            }, activeReloadTransactionId);
        }
        seedPreparedOpeningFitScale();
        return {
            displayZoomToRestore,
            shouldPinReloadPage,
        };
    }
    async function applyRestoredReloadZoom(displayZoomToRestore: number | null) {
        if (displayZoomToRestore === null) {
            return;
        }
        const nextZoom = resolveCustomReloadZoomMultiplier(displayZoomToRestore);
        if (nextZoom === null || Math.abs(nextZoom - options.zoom.value) <= 0.001) {
            return;
        }
        options.emitZoom(nextZoom);
        for (let attempt = 0; attempt < 6; attempt += 1) {
            await nextTick();
            if (Math.abs(options.zoom.value - nextZoom) <= 0.001) {
                return;
            }
        }
        BrowserLogger.diagnostic('pdf-nav', '[load-from-source] zoom restore did not sync before render', {
            currentZoom: options.zoom.value,
            targetZoom: nextZoom,
        });
    }
    /**
     * The navigation controller projects `currentPage`; the reload path only
     * republishes it once the owning transaction is still current.
     */
    function pinCurrentPageToRestoreTarget() {
        if (
            activeReloadTransactionId !== null
            && !transactionController.isTransactionCurrent(activeReloadTransactionId)
        ) {
            return false;
        }
        options.emitCurrentPage(currentPage.value);
        return true;
    }
    function handleResizeTransitionSignal(payload: IResizeTransitionSignal) {
        const nextAnchorPage = payload.active ? payload.anchorPage : null;
        if (
            resizeTransitionVisible.value === payload.active
            && resizeTransitionAnchorPage.value === nextAnchorPage
        ) {
            return;
        }
        resizeTransitionVisible.value = payload.active;
        resizeTransitionAnchorPage.value = nextAnchorPage;
        BrowserLogger.diagnostic('pdf-nav', `[resize-transition-ui] active=${payload.active}`, {
            ...payload,
            storedAnchorPage: resizeTransitionAnchorPage.value,
            viewer: options.summarizeViewerStateForLog(),
            currentPage: currentPage.value,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
        });
    }
    function handleTrustedScroll(_event: Event) {
        const container = options.viewerContainer.value;
        if (!container) {
            return;
        }
        viewModel.syncHorizontalScrollForZoomMode();
        const authority = singlePageScroll.viewportAuthority;
        if (
            viewportWritePort.consumeAuthorityScroll(container)
            || options.isResizing.value
            || resizeTransitionVisible.value
            || zoomSnapSuppressedForClass.value
        ) {
            projectViewportVisibleRange(container, numPages.value);
            options.emitCurrentPage(authority.currentPage.value);
            return;
        }
        const isPhysicalNavigation = navigationEpochs.markScrollInteraction();
        if (!isPhysicalNavigation) {
            projectViewportVisibleRange(container, numPages.value);
            options.emitCurrentPage(authority.currentPage.value);
            return;
        }
        // A direct scroll can arrive without a preceding wheel/pointer event
        // (scrollbar drags, accessibility input, or automation). Clear the
        // retained navigation row at the scroll boundary so virtualization
        // follows the live offset instead of remaining pinned to an already
        // settled destination.
        singlePageScroll.cancelProgrammaticNavigation('viewer-scroll-interaction');
        projectViewportVisibleRange(container, numPages.value);
    }
    watch(
        () => [
            options.zoomMode.value,
            options.fitMode.value,
            currentPage.value,
            scale.effectiveScale.value,
            options.viewMode.value,
            viewRotation.value,
            numPages.value,
            pageMetricsVersion.value,
        ] as const,
        () => {
            void nextTick(viewModel.syncHorizontalScrollForZoomMode);
            scheduleMountedVisibilityProjection();
        },
        { immediate: true },
    );
    watchEffect(() => {
        const layout = viewModel.pageLayout.value;
        viewportLayoutMetrics.value = layout;
        scroll.setPageLayoutMetrics(layout);
        if (layout && options.continuousScroll.value) {
            projectViewportVisibleRange(options.viewerContainer.value, numPages.value);
        }
    });
    onBeforeUnmount(() => {
        mountedVisibilityProjectionDisposed = true;
        cancelMountedVisibilityProjection();
        viewportPin.clearPinnedViewportPage('before-unmount');
        options.clearPendingImagePlacement();
        scroll.setPageLayoutMetrics(null);
        resizeTransitionVisible.value = false;
        resizeTransitionAnchorPage.value = null;
    });
    function markUserViewportInteraction() {
        navigationEpochs.markPhysicalNavigation();
        singlePageScroll.cancelProgrammaticNavigation('user-viewport-interaction');
    }
    function handleLinkDestination(dest: NonNullable<ILinkAnnotation['dest']>) {
        const request = createPageNavigationRequest(currentPage.value, 'bookmark');
        request.target = {
            kind: 'named-dest',
            destination: dest,
        };
        request.alignment = 'page-top';
        request.readiness = 'page-canvas';
        singlePageScroll.submitNavigationRequest(request);
    }
    let anchoredZoomAlreadySubmitted: number | null = null;
    function submitZoomViewportStateIntent(value: number) {
        if (
            anchoredZoomAlreadySubmitted !== null
            && Math.abs(anchoredZoomAlreadySubmitted - value) < 0.000_001
        ) {
            anchoredZoomAlreadySubmitted = null;
            return;
        }
        anchoredZoomAlreadySubmitted = null;
        submitAmbientViewportStateIntent('zoom', { zoom: value });
    }
    function submitAmbientViewportStateIntent(
        kind: 'zoom' | 'fit' | 'view-mode' | 'dpr' | 'activation',
        state: Parameters<typeof singlePageScroll.submitViewportStateIntent>[1] = {},
    ) {
        if (chassisAuthority?.openSurface.viewportSession.value.lifecycle === 'opening') {
            return;
        }
        void singlePageScroll.submitViewportStateIntent(kind, state);
    }
    const openingViewportStallDiagnostic = createPdfOpeningViewportStallDiagnostic({
        getSurface: () => chassisAuthority?.openSurface ?? null,
        getActiveIntent: () => singlePageScroll.viewportAuthority.activeIntent.value,
        getAuthorityPhase: () => singlePageScroll.viewportAuthority.phase.value,
        getCurrentDocumentRevision: () => documentSession.captureFence().loadToken,
        getLayoutRevision: () => pageMetricsVersion.value,
        captureCommitDiagnostics: singlePageScroll.captureViewportCommitDiagnostics,
    });
    function reconcileIdleOpenSurfaceViewport() {
        const surface = chassisAuthority?.openSurface;
        if (!surface) {
            return false;
        }
        const committedRender = reconcilePdfOpeningViewportCommit({
            surface,
            activeIntent: singlePageScroll.viewportAuthority.activeIntent.value,
            currentDocumentRevision: documentSession.captureFence().loadToken,
            suspendActiveIntent: () => singlePageScroll.retireStaleViewportIntent(
                documentSession.captureFence().loadToken,
            ),
            commitCurrentViewportIfSettled: singlePageScroll.commitCurrentViewportIfSettled,
            applyReloadViewport,
        }, openingViewportStallDiagnostic.observe);
        if (!committedRender) {
            return false;
        }
        navigationCommittedSignal.value = {
            revision: navigationCommittedSignal.value.revision + 1,
            pageNumber: committedRender.pageNumber,
        };
        return true;
    }
    watch(() => singlePageScroll.viewportAuthority.activeIntent.value, (activeIntent, previousIntent) => {
        if (activeIntent === null && previousIntent !== null) {
            const terminalOutcome = singlePageScroll.viewportAuthority.getTerminalOutcome(previousIntent.id);
            if (terminalOutcome === 'settled') {
                singlePageScroll.commitCurrentViewportIfSettled(
                    singlePageScroll.viewportAuthority.currentPage.value,
                );
            }
        }
        if (activeIntent !== null) {
            return;
        }
        reconcileIdleOpenSurfaceViewport();
    }, { flush: 'sync' });
    watch([
        () => chassisAuthority?.openSurface.snapshot.value.committedRender,
        () => chassisAuthority?.openSurface.snapshot.value.committedViewport,
        viewportLayoutMetrics,
    ], reconcileIdleOpenSurfaceViewport, {flush: 'post'});
    watch(options.fitMode, () => submitAmbientViewportStateIntent('fit'));
    watch(options.viewMode, value => {
        submitAmbientViewportStateIntent('view-mode', { viewMode: value });
    });
    watch(options.outputScale, value => {
        submitAmbientViewportStateIntent('dpr', { dpr: value });
    });
    watch(options.isActive, (active) => {
        if (!active) {
            singlePageScroll.viewportAuthority.suspend();
            return;
        }
        submitAmbientViewportStateIntent('activation');
    });
    let activeDocumentPlacement: IPdfViewportReloadPlacement | null = null;
    async function applyReadyDocumentTransition(transition: IPdfDocumentTransition) {
        if (!transition.isCurrent()) {
            return;
        }
        const placement = activeDocumentPlacement ?? {
            shouldPinReloadPage: false,
            displayZoomToRestore: null,
        };
        activeDocumentPlacement = null;
        pinCurrentPageToRestoreTarget();
        {
            const readyMetricRange = resolvePdfReadyMetricRange({
                currentPage: currentPage.value,
                totalPages: numPages.value,
                isReload: transition.plan.isReload,
                isSelectiveReload: transition.plan.isSelectiveReload,
            });
            await documentSession.ensurePageMetricsInRange(readyMetricRange.start, readyMetricRange.end);
            if (!transition.isCurrent()) {
                return;
            }
            if (!transition.plan.isSelectiveReload) {
                scale.computeFitWidthScale(options.viewerContainer.value);
            }
            if (!transition.plan.isSelectiveReload) {
                await applyRestoredReloadZoom(placement.displayZoomToRestore);
            }
            if (!transition.isCurrent()) {
                return;
            }
            await nextTick();
            if (!transition.isCurrent()) {
                return;
            }
            setupPagePlaceholders();
            // Placeholder projection is a render boundary. Let Vue install
            // the authoritative page containers before handing raster demand
            // downstream, otherwise that projection can replace a canvas
            // committed against the preceding DOM.
            await nextTick();
            if (!transition.isCurrent()) {
                return;
            }
            if (transition.plan.isReload && currentPage.value > 1) {
                applyReloadViewport(currentPage.value);
                await nextTick();
            } else if (!transition.plan.isReload) {
                applyReloadViewport(resolvedPageToRestore);
            }
            if (!transition.isCurrent()) {
                return;
            }
            commitVisibleRange(
                projectViewportVisibleRange(options.viewerContainer.value, numPages.value),
                activeReloadTransactionId,
            );
        }
        const initialRange = {
            start: currentPage.value,
            end: currentPage.value,
        };
        await requestMandatoryRaster(initialRange, {bufferOverride: 0});
        if (!transition.isCurrent()) {
            return;
        }
        if (placement.shouldPinReloadPage) {
            pinCurrentPageToRestoreTarget();
        } else {
            await syncCurrentPageFromViewport({source: 'load-from-source'});
        }
        if (!transition.isCurrent()) {
            return;
        }
        await requestMandatoryRaster(getVisibleRange());
        if (!transition.isCurrent()) {
            return;
        }
        settleVisualReloadTransition('warm-render-complete');
        const transactionId = activeReloadTransactionId;
        activeReloadTransactionId = null;
        if (transactionId !== null) {
            transactionController.advanceTransaction(transactionId, 'settled');
        }
    }
    const unsubscribeDocumentTransitions = documentSession.subscribe(async (transition) => {
        if (!transition.isCurrent()) {
            return;
        }
        if (transition.phase === 'loading') {
            singlePageScroll.retireStaleViewportIntent(transition.fence.loadToken);
            activeDocumentPlacement = beginReloadPlacement(transition);
            return;
        }
        if (transition.phase === 'invalidated') {
            openingViewportStallDiagnostic.cancel();
            singlePageScroll.viewportAuthority.suspend();
            activeDocumentPlacement = null;
            cancelMandatoryRaster();
            settleVisualReloadTransition(transition.reason);
            const transactionId = activeReloadTransactionId;
            activeReloadTransactionId = null;
            if (transactionId !== null && transactionController.isTransactionCurrent(transactionId)) {
                transactionController.cancelActiveTransaction({
                    reason: transition.reason === 'load-aborted' ? 'reload' : 'document-changed',
                    cancelInFlightRenders: true,
                    bumpRenderVersion: true,
                    preserveVisualContent: false,
                }, transactionId);
            }
            cancelPendingSearchRevision.value += 1;
            cancelRasterRevision.value += 1;
            return;
        }
        if (transition.phase === 'ready') {
            try {
                await applyReadyDocumentTransition(transition);
            } catch (error) {
                if (transition.isCurrent()) {
                    BrowserLogger.error('pdf-viewer', 'Failed to place PDF viewport after source load', error, Object.assign({code: 'RENDERER_PDF_VIEWPORT_PLACEMENT_FAILED' as const}, {context: {}}));
                }
            }
        }
    });
    documentSession.registerDisposable(() => {
        openingViewportStallDiagnostic.cancel();
        mountedVisibilityProjectionDisposed = true;
        cancelMountedVisibilityProjection();
        unsubscribeDocumentTransitions();
        cancelMandatoryRaster();
        pageSlots.dispose();
    });
    return {
        currentPage,
        visibleRange,
        demand: shallowReadonly(demand),
        cancelPendingSearchRevision: readonly(cancelPendingSearchRevision),
        cancelRasterRevision: readonly(cancelRasterRevision),
        visualReadySignal: shallowReadonly(visualReadySignal),
        navigationCommittedSignal: shallowReadonly(navigationCommittedSignal),
        pageSlots,
        userViewportInteractionEpoch,
        userPhysicalNavigationEpoch: navigationEpochs.userPhysicalNavigationEpoch,
        beginLayoutGeometryReplacement: navigationEpochs.beginLayoutGeometryReplacement,
        resizeTransitionVisible,
        resizeTransitionAnchorPage,
        zoomVirtualizationFreeze,
        zoomSnapSuppressedForClass,
        scroll,
        scale,
        viewportPin,
        skeletonInsets,
        reloadTransition,
        viewModel,
        openVirtualSurfaceGeometry,
        singlePageScroll,
        transactionController,
        viewportWritePort,
        summarizeViewerMetricsForLog,
        summarizeVisiblePageSnapshotForLog,
        getVisibleRange,
        getProtectedVisibleRange,
        isVisibleRenderRangeCurrent,
        setupPagePlaceholders,
        syncCurrentPageFromViewport,
        markUserViewportInteraction,
        handleLinkDestination,
        handleResizeTransitionSignal,
        handleTrustedScroll,
        handleViewerContainerRef: (element: HTMLElement | null) => {
            options.viewerContainer.value = element;
        },
        markAnchoredZoomSubmitted: (zoom: number) => {
            anchoredZoomAlreadySubmitted = zoom;
        },
        submitZoomViewportStateIntent,
        markPageMounted(pageNumber: number) {
            pageSlots.markMounted(pageNumber);
            if (options.continuousScroll.value) {
                projectViewportVisibleRange(options.viewerContainer.value, numPages.value);
                scheduleMountedVisibilityProjection();
            }
            publishDemand();
        },
        markPageUnmounted(pageNumber: number) {
            pageSlots.markUnmounted(pageNumber);
            publishDemand();
        },
        requestMandatoryRaster,
        settleMandatoryRaster,
        commitVisibleRange,
    };
};
export type TPdfViewportSession = ReturnType<typeof createPdfViewportSession>;
