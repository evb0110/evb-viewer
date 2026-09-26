import {
    clampPageNumber,
    requirePageNumber,
} from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';
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
import type { TPdfZoomState } from '@contracts/shared';
import {useResizeObserver} from '@vueuse/core';
import type { IPageRange } from '@app/types/pdfUi';
import type { ILinkAnnotation } from '@app/types/annotations';
import {
    consumeDocumentViewportPaneRelocationScrollFence,
    hasCommittedDocumentOpeningLayout,
    type IDocumentViewerRuntime,
} from '@app/modules/document-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { createPageNavigationRequest } from '@app/modules/document-viewer/public';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import { normalizePageMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/normalizePageMetrics';
import { setupPagePlaceholderSizes } from '@app/modules/pdf-viewer/engine/pdf-page-buffer-manager/setupPagePlaceholderSizes';
import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import {
    getLayoutPhysicalScrollOrigin,
    getLayoutPhysicalScrollSegmentTransition,
} from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
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
import { summarizeViewerMetrics } from '@app/modules/pdf-viewer/engine/pdf-viewer-metrics/summarizeViewerMetrics';
import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import { usePdfViewportViewModel } from '@app/modules/pdf-viewer/runtime/viewport/usePdfViewportViewModel';
import { usePdfOpenVirtualSurfaceGeometry } from '@app/modules/pdf-viewer/runtime/viewport/usePdfOpenVirtualSurfaceGeometry';
import { usePdfSinglePageNavigationController } from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageNavigationController';
import type { IPdfViewportWritePort } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';
import { createPdfOpenSurfaceViewportCallbacks } from '@app/modules/pdf-viewer/runtime/viewport/createPdfOpenSurfaceViewportCallbacks';
import { reconcilePdfOpeningViewportCommit } from '@app/modules/pdf-viewer/runtime/viewport/reconcilePdfOpeningViewportCommit';
import { createPdfOpeningViewportStallDiagnostic } from '@app/modules/pdf-viewer/runtime/viewport/createPdfOpeningViewportStallDiagnostic';
import { createPdfViewportUserNavigationEpochs } from '@app/modules/pdf-viewer/runtime/viewport/createPdfViewportUserNavigationEpochs';
import { getRequestAnchor } from '@app/modules/pdf-viewer/runtime/navigation/pdfNavigationRequestAnchors';
import { resolvePdfPreparedOpeningFitScale } from '@app/modules/pdf-viewer/runtime/lifecycle/resolvePdfPreparedOpeningFitScale';
import { resolveCustomReloadZoomMultiplier } from '@app/modules/pdf-viewer/runtime/reload-zoom/resolveCustomReloadZoomMultiplier';
import type { IPdfViewportReloadPlacement } from '@app/modules/pdf-viewer/runtime/sessions/pdfViewportReloadPlacement';
import { resolvePdfFlingBackdrop } from '@app/modules/pdf-viewer/engine/pdf-page-layout/resolvePdfFlingBackdrop';
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
interface IPdfViewportPageSignal {
    revision: number;
    pageNumber: TPageNumber | null;
}

export interface ICreatePdfViewportSessionOptions {
    document: TPdfDocumentSession;
    isPageFreshlyRenderedForNavigation: (pageNumber: TPageNumber) => boolean;
    waitForPageTextLayerReady?: ((pageNumber: TPageNumber, signal: AbortSignal) => Promise<boolean>) | undefined;
    getCommittedPageScale?: ((pageNumber: TPageNumber) => number | null) | undefined;
    chassisAuthority: IDocumentViewerRuntime | null;
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
    outputScale: Ref<number>;
    selectionMarkupStyle: Parameters<typeof usePdfViewportViewModel>[0]['selectionMarkupStyle'];
    classState: Parameters<typeof usePdfViewportViewModel>[0]['classState'];
    emitCurrentPage: (page: number) => void;
    emitNavigationFeedbackPage: (page: number | null) => void;
    emitZoomState: (state: TPdfZoomState) => void;
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
    const cancelPendingSearchRevision = ref(0);
    const cancelRasterRevision = ref(0);
    const visualReadySignal = shallowRef<IPdfViewportPageSignal>({
        revision: 0,
        pageNumber: null,
    });
    const navigationCommittedSignal = shallowRef<IPdfViewportPageSignal>({
        revision: 0,
        pageNumber: null,
    });
    const viewportPin = useViewportPagePin({summarizeViewerStateForLog: options.summarizeViewerStateForLog});
    let getActivePhysicalScrollOrigin = () => 0;
    let lastPhysicalScrollTop = 0;
    let physicalScrollTransitionSequence = 0;
    const scroll = usePdfScroll({
        getPinnedMostVisiblePage: () => viewportPin.getPinnedViewportPage(),
        getPhysicalScrollOrigin: () => getActivePhysicalScrollOrigin(),
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
        options.continuousScroll,
    );
    const reloadTransition = usePdfViewerReloadTransition({
        emitEffectiveZoom: options.emitEffectiveZoom,
        summarizeViewerStateForLog: options.summarizeViewerStateForLog,
    });
    watch(
        () => scale.effectiveScale.value,
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
    const pageLayoutScaleResolver = shallowRef<((pageNumber: TPageNumber) => number) | null>(null);
    function seedPreparedOpeningFitScale() {
        // The host frame only seeds the shell. Once document metrics exist,
        // fitting belongs to the viewport and includes every known spread.
        if (!chassisAuthority || (pdfDocument.value && pageMetrics.value.length > 0)) {
            return false;
        }
        const preparedScale = resolvePdfPreparedOpeningFitScale(chassisAuthority.openSurface.snapshot.value, options.zoomMode.value === 'custom');
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
        return singlePageScroll.viewportAuthority.targetPage.value
            ?? singlePageScroll.navigationAnchorPage.value;
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
    async function prepareNavigationLayout(pageNumber: TPageNumber, signal: AbortSignal) {
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
    // The reading point a same-document rewrite restores once it reloads.
    let nextReloadAnchor: IPdfSemanticAnchor | null = null;
    let activeReloadAnchor: IPdfSemanticAnchor | null = null;
    let resolvedPageToRestore = requirePageNumber(1);
    let activeReloadTransactionId: number | null = null;
    let visualReloadTransitionToken: number | null = null;
    function projectViewportVisibleRange(container: HTMLElement | null, totalPages: number) {
        if (!container || totalPages <= 0) {
            return visibleRange.value;
        }
        const domVisibility = getViewportVisibilityFromDom(container, totalPages);
        const visibility = domVisibility.range || domVisibility.mostVisiblePage !== null
            ? domVisibility
            : getViewportVisibilityFromLayout(
                container,
                totalPages,
                viewportLayoutMetrics.value,
                viewportLayoutMetrics.value ? getActivePhysicalScrollOrigin() : 0,
            ) ?? domVisibility;
        visibleRange.value = visibility.range ?? visibleRange.value;
        return visibleRange.value;
    }
    function schedulePhysicalScrollSegmentTransition(
        container: HTMLElement,
        layout: IPdfPageLayoutMetrics,
        transition: {
            origin: number;
            page: TPageNumber;
            scrollTop: number;
        },
        sequence: number,
    ) {
        const documentFence = documentSession.captureFence();
        void nextTick(() => {
            if (
                sequence !== physicalScrollTransitionSequence
                || !documentSession.isCurrent(documentFence)
                || viewportLayoutMetrics.value !== layout
                || getActivePhysicalScrollOrigin() !== transition.origin
            ) {
                return;
            }
            const applied = viewportWritePort.apply(container, {
                intent: viewportWritePort.beginIntent(`pdf-scroll-segment-transition-${sequence}`),
                reason: 'pdf-scroll-segment-transition',
                left: container.scrollLeft,
                top: transition.scrollTop,
            });
            if (!applied) {
                return;
            }
            navigationEpochs.observeAuthoredScrollOffset(container.scrollTop);
            lastPhysicalScrollTop = container.scrollTop;
            projectViewportVisibleRange(container, numPages.value);
            options.emitCurrentPage(singlePageScroll.viewportAuthority.currentPage.value);
        });
    }
    function getVisibleRange(): IPageRange {
        if (!options.continuousScroll.value && numPages.value > 0) {
            const rowBounds = getPageRowBoundsForViewMode({
                pageNumber: clampPageNumber(currentPage.value, numPages.value),
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
                pageNumber: clampPageNumber(page, numPages.value),
            };
        },
    );
    const singlePageScroll = usePdfSinglePageNavigationController({
        viewerContainer: options.viewerContainer,
        chassisAuthority,
        numPages,
        currentPage,
        scaledMargin: scale.scaledMargin,
        viewMode: options.viewMode,
        continuousScroll: options.continuousScroll,
        isLoading,
        pdfDocument,
        getMostVisiblePage: scroll.getMostVisiblePage,
        scrollToPageInternal: (container, pageNumber, totalPages, margin, scrollOptions) => (
            scroll.scrollToPage(container, clampPageNumber(pageNumber, totalPages), totalPages, margin, scrollOptions)
        ),
        updateVisibleRange: projectViewportVisibleRange,
        updateCurrentPage: scroll.updateCurrentPage,
        commitVisibleRange: (range, commitOptions) => commitVisibleRange(range, commitOptions?.transactionId ?? null),
        renderVisiblePages: (range, renderOptions) => requestMandatoryRaster(range, renderOptions),
        prepareNavigationLayout,
        isPageFreshlyRenderedForNavigation: options.isPageFreshlyRenderedForNavigation,
        waitForPageTextLayerReady: options.waitForPageTextLayerReady,
        visibleRange,
        emitCurrentPage: options.emitCurrentPage,
        emitNavigationFeedbackPage: options.emitNavigationFeedbackPage,
        viewportWritePort,
        getPageLayoutMetrics: () => viewportLayoutMetrics.value,
        getPhysicalScrollOrigin: () => getActivePhysicalScrollOrigin(),
        bindCurrentPageProjection: scroll.bindCurrentPageProjection,
        getDocumentRevision: () => documentSession.captureFence().loadToken,
        getGeometryRevision: () => pageMetricsVersion.value + 1,
        cancelPendingSearchScroll: () => {
            cancelPendingSearchRevision.value += 1;
        },
        onViewportWorkCancelled: ({cancelRasters}) => {
            if (cancelRasters) {
                cancelRasterRevision.value += 1;
            }
        },
        onPageVisualReady: page => {
            visualReadySignal.value = {
                revision: visualReadySignal.value.revision + 1,
                pageNumber: page,
            };
        },
        ...openSurfaceViewportCallbacks,
    });
    getActivePhysicalScrollOrigin = () => {
        const layout = viewportLayoutMetrics.value;
        if (!layout) {
            return 0;
        }
        return getLayoutPhysicalScrollOrigin(
            layout,
            singlePageScroll.navigationAnchorPage.value ?? currentPage.value,
        );
    };
    const viewportAuthority = singlePageScroll.viewportAuthority;
    const viewportWork = {
        activeWorkKind: viewportAuthority.activeWorkKind,
        beginWork: viewportAuthority.beginWork,
        isWorkCurrent: viewportAuthority.isWorkCurrent,
        settleWork: viewportAuthority.settleWork,
        cancelWork: viewportAuthority.cancelWork,
        commitVisibleRange,
    };
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
                reloadTransition.emitEffectiveZoom(scale.effectiveScale.value);
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
        effectiveScale: scale.effectiveScale,
        doesFitHeightSpreadFitWidth: scale.doesFitHeightSpreadFitWidth,
        scaledMargin: scale.scaledMargin,
        visibleRange,
        navigationAnchorPage: singlePageScroll.navigationAnchorPage,
        navigationVisualHandoffTargetPage: singlePageScroll.navigationVisualHandoffTargetPage,
        getCommittedPageScale: options.getCommittedPageScale,
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
    const flingBackdrop = computed(() => {
        const layout = viewModel.pageLayout.value;
        if (!layout || !viewModel.virtualizedContinuousMode.value || numPages.value <= 0) {
            return null;
        }
        return resolvePdfFlingBackdrop(
            layout,
            clampPageNumber(currentPage.value, numPages.value),
            getActivePhysicalScrollOrigin(),
        );
    });
    let mandatoryRasterId = 0;
    let pendingMandatoryRaster: IPdfViewportMandatoryRaster | null = null;
    // Resolves true when the request's own raster pass settled, false when a
    // newer mandatory request superseded it or the demand was cancelled.
    const mandatoryRasterResolvers = new Map<number, (settled: boolean) => void>();
    let demandRevision = 0;
    function estimatePageRasterPixels(pageNumber: TPageNumber) {
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
    let mountedVisibilityProjectionGeneration = 0;
    function cancelMountedVisibilityProjection() {
        mountedVisibilityProjectionGeneration += 1;
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
        const generation = mountedVisibilityProjectionGeneration;
        void nextTick(() => {
            if (
                mountedVisibilityProjectionDisposed
                || generation !== mountedVisibilityProjectionGeneration
            ) {
                return;
            }
            mountedVisibilityFrameId = window.requestAnimationFrame(() => {
                if (mountedVisibilityProjectionDisposed || generation !== mountedVisibilityProjectionGeneration) {
                    return;
                }
                mountedVisibilityFrameId = window.requestAnimationFrame(() => {
                    mountedVisibilityFrameId = null;
                    if (mountedVisibilityProjectionDisposed || generation !== mountedVisibilityProjectionGeneration) {
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
            mandatoryRasterResolvers.get(pendingMandatoryRaster.id)?.(false);
            mandatoryRasterResolvers.delete(pendingMandatoryRaster.id);
        }
        return new Promise<boolean>((resolve) => {
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
        mandatoryRasterResolvers.get(id)?.(true);
        mandatoryRasterResolvers.delete(id);
        if (pendingMandatoryRaster?.id !== id) {
            return;
        }
        pendingMandatoryRaster = null;
        publishDemand();
    }
    function cancelMandatoryRaster() {
        for (const resolve of mandatoryRasterResolvers.values()) {
            resolve(false);
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
            options.isResizing.value,
            options.isActive.value,
            isLoading.value,
            Boolean(pdfDocument.value),
            numPages.value,
            userViewportInteractionEpoch.value,
            viewportAuthority.activeWorkKind.value !== null,
        ] as const,
        publishDemand,
        {
            flush: 'sync',
            immediate: true,
        },
    );
    function commitVisibleRange(range: IPageRange, workId: number | null) {
        if (workId !== null && !viewportAuthority.isWorkCurrent(workId)) {
            return false;
        }
        visibleRange.value = range;
        return true;
    }
    function applyReloadViewport(pageNumber: TPageNumber, scrollOptions?: IScrollToPageOptions) {
        scroll.scrollToPage(options.viewerContainer.value, pageNumber, numPages.value, scale.scaledMargin.value, scrollOptions);
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
        activeReloadAnchor = plan.preserveVisibleContent ? nextReloadAnchor : null;
        nextReloadAnchor = null;
        const pageToRestore = plan.isReload
            ? activeReloadAnchor?.page ?? currentPage.value
            : 1;
        resolvedPageToRestore = clampPageNumber(pageToRestore, numPages.value);
        const displayZoomToRestore = plan.isReload && options.zoomMode.value === 'custom'
            ? scale.effectiveScale.value
            : null;
        const shouldPinReloadPage = plan.isReload && resolvedPageToRestore > 1;
        activeReloadTransactionId = viewportAuthority.beginWork('reload', resolvedPageToRestore);
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
        const preserveOpeningLayout = !plan.isReload
            && !plan.preserveVisibleContent
            && shouldPreserveOpeningLayout();
        const preserveReloadDisplayZoom = plan.isReload
            && !plan.isSelectiveReload
            && displayZoomToRestore !== null;
        if (plan.preserveVisibleContent) {
            if (plan.isReload || preserveReloadDisplayZoom) {
                scale.invalidateScaleCache();
            }
        } else if (!plan.isSelectiveReload) {
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
        options.emitZoomState({
            kind: 'custom',
            scale: nextZoom,
        });
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
            && !viewportAuthority.isWorkCurrent(activeReloadTransactionId)
        ) {
            return false;
        }
        options.emitCurrentPage(currentPage.value);
        return true;
    }
    function handleTrustedScroll(_event: Event) {
        const container = options.viewerContainer.value;
        if (!container) {
            return;
        }
        const scrollEventSequence = ++physicalScrollTransitionSequence;
        const previousScrollTop = lastPhysicalScrollTop;
        lastPhysicalScrollTop = container.scrollTop;
        viewModel.syncHorizontalScrollForZoomMode();
        const authority = singlePageScroll.viewportAuthority;
        const wasAuthorityScroll = viewportWritePort.consumeAuthorityScroll(container);
        if (consumeDocumentViewportPaneRelocationScrollFence(container)) {
            // Teleport can reset the native scroll offset while moving a pane.
            // The workspace marks that move explicitly, so only this lifecycle
            // event is excluded from viewport authority.
            navigationEpochs.observeAuthoredScrollOffset(container.scrollTop);
            return;
        }
        if (
            wasAuthorityScroll
            // The compositor can apply one more inertial delta before scroll
            // suppression reaches it. That offset belongs to the superseded
            // gesture, not to the user taking the viewport.
            || viewportWritePort.isCommandResidueLive()
        ) {
            navigationEpochs.observeAuthoredScrollOffset(container.scrollTop);
            projectViewportVisibleRange(container, numPages.value);
            options.emitCurrentPage(authority.currentPage.value);
            return;
        }
        const isPhysicalNavigation = navigationEpochs.markScrollInteraction({
            top: container.scrollTop,
            maxTop: container.scrollHeight - container.clientHeight,
        });
        if (!isPhysicalNavigation) {
            projectViewportVisibleRange(container, numPages.value);
            options.emitCurrentPage(authority.currentPage.value);
            return;
        }
        const supersedesProgrammaticNavigation = authority.activeIntent.value !== null
            || singlePageScroll.navigationAnchorPage.value !== null;
        if (supersedesProgrammaticNavigation) {
            cancelRasterRevision.value += 1;
        }
        // A direct scroll can arrive without a preceding wheel/pointer event
        // (scrollbar drags, accessibility input, or automation). Clear the
        // retained navigation row at the scroll boundary so virtualization
        // follows the live offset instead of remaining pinned to an already
        // settled destination.
        const layout = viewportLayoutMetrics.value;
        const physicalScrollOrigin = getActivePhysicalScrollOrigin();
        const transition = layout
            ? getLayoutPhysicalScrollSegmentTransition(
                layout,
                container.scrollTop,
                previousScrollTop,
                container.clientHeight,
                physicalScrollOrigin,
            )
            : null;
        singlePageScroll.cancelProgrammaticNavigation(
            'viewer-scroll-interaction',
            transition ? getRequestAnchor(undefined, transition.page) : undefined,
        );
        if (transition && layout) {
            schedulePhysicalScrollSegmentTransition(
                container,
                layout,
                transition,
                scrollEventSequence,
            );
            return;
        }
        projectViewportVisibleRange(container, numPages.value);
    }
    // A custom zoom that lands on the continuous fit-width scale is Fit Width.
    function snapCustomZoomToFitWidth() {
        if (
            options.zoomMode.value === 'custom'
            && options.continuousScroll.value
            && pdfDocument.value
            && !isLoading.value
            && Math.abs(scale.effectiveScale.value - scale.fitWidthScale.value) < 0.001
            && scale.isFitWidthScaleCurrent(options.viewerContainer.value)
        ) {
            options.emitZoomState({
                kind: 'fit',
                axis: 'width',
            });
        }
    }
    watch(
        () => [
            options.zoomMode.value,
            options.fitMode.value,
            options.continuousScroll.value,
            currentPage.value,
            scale.effectiveScale.value,
            options.viewMode.value,
            viewRotation.value,
            numPages.value,
            pageMetricsVersion.value,
        ] as const,
        () => {
            snapCustomZoomToFitWidth();
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
        physicalScrollTransitionSequence += 1;
        mountedVisibilityProjectionDisposed = true;
        cancelMountedVisibilityProjection();
        viewportPin.clearPinnedViewportPage('before-unmount');
        options.clearPendingImagePlacement();
        scroll.setPageLayoutMetrics(null);
    });
    function markUserViewportInteraction() {
        navigationEpochs.markPhysicalNavigation();
        const supersedesProgrammaticNavigation = singlePageScroll.viewportAuthority.activeIntent.value !== null
            || singlePageScroll.navigationAnchorPage.value !== null;
        if (supersedesProgrammaticNavigation) {
            cancelRasterRevision.value += 1;
        }
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
            pageNumber: requirePageNumber(committedRender.pageNumber),
        };
        return true;
    }
    watch(() => singlePageScroll.viewportAuthority.activeIntent.value, (activeIntent, previousIntent) => {
        if (activeIntent === null && previousIntent !== null) {
            const terminalOutcome = singlePageScroll.viewportAuthority.getTerminalOutcome(previousIntent.id);
            if (terminalOutcome === 'settled') {
                singlePageScroll.commitCurrentViewportIfSettled(
                    clampPageNumber(singlePageScroll.viewportAuthority.currentPage.value),
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
    function fitToViewport() {
        scale.computeFitWidthScale(options.viewerContainer.value, {page: currentPage.value});
    }
    function pageTopAnchor() {
        return getRequestAnchor(undefined, clampPageNumber(currentPage.value, numPages.value));
    }
    // Zoom keeps the point under the viewport centre; a fit, view mode,
    // rotation or scroll mode change keeps the top of the committed page,
    // because every row's height is rewritten under it.
    watch([
        options.zoom,
        options.zoomMode,
    ], ([
        , zoomMode,
    ]) => {
        singlePageScroll.relayout(fitToViewport, zoomMode === 'custom' ? undefined : pageTopAnchor());
    }, {flush: 'sync'});
    watch([
        options.viewMode,
        viewRotation,
        options.continuousScroll,
    ], () => {
        singlePageScroll.relayout(fitToViewport, pageTopAnchor());
    }, {flush: 'sync'});
    // A resize keeps the point that was under the old viewport centre at the
    // new centre (contract R3). A pane drag or split keeps the point it
    // started with: moving a pane can reset the native scroll offset before
    // any size change is observed.
    let resizeGestureAnchor: ReturnType<typeof singlePageScroll.captureRelayoutAnchor> = null;
    watch(options.isResizing, (resizing) => {
        if (resizing) {
            resizeGestureAnchor = singlePageScroll.captureRelayoutAnchor();
            return;
        }
        const anchor = resizeGestureAnchor;
        resizeGestureAnchor = null;
        if (anchor) {
            singlePageScroll.relayout(fitToViewport, anchor);
        }
    }, {flush: 'sync'});
    let observedViewportSize: {
        width: number;
        height: number;
    } | null = null;
    useResizeObserver(options.viewerContainer, () => {
        const container = options.viewerContainer.value;
        if (!container) {
            return;
        }
        const previous = observedViewportSize;
        observedViewportSize = {
            width: container.clientWidth,
            height: container.clientHeight,
        };
        if (
            !previous
            || !options.isActive.value
            || (previous.width === container.clientWidth && previous.height === container.clientHeight)
        ) {
            return;
        }
        singlePageScroll.relayout(fitToViewport, resizeGestureAnchor ?? singlePageScroll.captureRelayoutAnchor({
            x: previous.width / 2,
            y: previous.height / 2,
        }, previous));
    });
    watch(options.isActive, (active) => {
        if (!active) {
            singlePageScroll.viewportAuthority.suspend();
            return;
        }
        singlePageScroll.relayout(fitToViewport, singlePageScroll.viewportAuthority.committedAnchor.value);
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
        const isPreservedSelectiveReload = transition.plan.preserveVisibleContent
            && transition.plan.isSelectiveReload;
        if (!transition.plan.preserveVisibleContent || isPreservedSelectiveReload) {
            // Geometry is complete at ready except on a sparse source, which
            // measures the page it restores.
            await documentSession.ensurePageMetricsInRange(currentPage.value, currentPage.value);
            if (!transition.isCurrent()) {
                return;
            }
            if (!transition.plan.isSelectiveReload || options.zoomMode.value === 'fit-width') {
                scale.computeFitWidthScale(options.viewerContainer.value, {page: currentPage.value});
            }
            if (isPreservedSelectiveReload && options.zoomMode.value === 'fit-width') {
                // This Fit Width value defines the first raster for the new
                // revision. Publish it now instead of letting the visual
                // reload transition defer the toolbar/readout until the
                // replacement raster has warmed and the transition settles.
                reloadTransition.commitEffectiveZoom(scale.effectiveScale.value);
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
            if (isPreservedSelectiveReload) {
                applyReloadAnchor();
                await nextTick();
            } else if (transition.plan.isReload && currentPage.value > 1) {
                applyReloadViewport(clampPageNumber(currentPage.value, numPages.value));
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
            start: clampPageNumber(currentPage.value, numPages.value),
            end: clampPageNumber(currentPage.value, numPages.value),
        };
        const isCurrentPageInvalidated = transition.plan.pagesToInvalidate?.includes(currentPage.value) ?? false;
        await requestMandatoryRaster(initialRange, transition.plan.preserveVisibleContent
            ? {
                preserveRenderedPages: true,
                bufferOverride: 0,
                forceRerender: !transition.plan.isSelectiveReload || isCurrentPageInvalidated,
            }
            : {bufferOverride: 0});
        if (!transition.isCurrent()) {
            return;
        }
        if (transition.plan.preserveVisibleContent && !isPreservedSelectiveReload) {
            applyReloadAnchor();
        }
        if (placement.shouldPinReloadPage) {
            pinCurrentPageToRestoreTarget();
        } else {
            const page = scroll.getMostVisiblePage(options.viewerContainer.value, numPages.value);
            if (page !== currentPage.value) {
                singlePageScroll.currentPageAuthority.commitViewportPage(page);
            }
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
            viewportAuthority.settleWork(transactionId);
        }
    }
    function applyReloadAnchor() {
        const anchor = activeReloadAnchor;
        applyReloadViewport(resolvedPageToRestore, {
            navigationSource: 'restore',
            preferExactDom: true,
            ...(anchor
                ? {
                    pageYRatio: anchor.pageYFraction,
                    markerRect: {
                        left: anchor.pageXFraction,
                        top: anchor.pageYFraction,
                        width: 0,
                        height: 0,
                    },
                }
                : {}),
        });
    }
    function preserveNextSourceReloadVisibleContent() {
        nextReloadAnchor = singlePageScroll.captureCurrentSemanticAnchor();
        documentSession.preserveNextReloadVisibleContent(true);
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
            // A page operation rewrites the file the viewer already has open.
            // Tearing the presentation down here is what leaves the empty
            // shell on screen until the replacement paints, so hold the last
            // picture instead and let the reload plan consume it.
            const holdsVisibleContent = transition.isSameDocumentRewrite;
            if (holdsVisibleContent) {
                preserveNextSourceReloadVisibleContent();
            }
            settleVisualReloadTransition(transition.reason);
            const transactionId = activeReloadTransactionId;
            activeReloadTransactionId = null;
            if (transactionId !== null && viewportAuthority.isWorkCurrent(transactionId)) {
                viewportAuthority.cancelWork({cancelRasters: true}, transactionId);
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
        scroll,
        scale,
        viewportPin,
        skeletonInsets,
        reloadTransition,
        viewModel,
        openVirtualSurfaceGeometry,
        flingBackdrop,
        singlePageScroll,
        viewportWork,
        viewportWritePort,
        summarizeViewerMetricsForLog: summarizeViewerMetrics,
        getVisibleRange,
        getProtectedVisibleRange,
        isVisibleRenderRangeCurrent,
        setupPagePlaceholders,
        markUserViewportInteraction,
        handleLinkDestination,
        handleTrustedScroll,
        handleViewerContainerRef: (element: HTMLElement | null) => {
            options.viewerContainer.value = element;
        },
        markPageMounted(pageNumber: TPageNumber) {
            pageSlots.markMounted(pageNumber);
            if (options.continuousScroll.value) {
                projectViewportVisibleRange(options.viewerContainer.value, numPages.value);
                scheduleMountedVisibilityProjection();
            }
            publishDemand();
        },
        markPageUnmounted(pageNumber: TPageNumber) {
            pageSlots.markUnmounted(pageNumber);
            publishDemand();
        },
        requestMandatoryRaster,
        settleMandatoryRaster,
        commitVisibleRange,
    };
};
export type TPdfViewportSession = ReturnType<typeof createPdfViewportSession>;
