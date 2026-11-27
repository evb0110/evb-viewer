import {
    clampPageNumber,
    clampPageRange,
    requirePageIndex,
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
    createPageNavigationRequest,
    getPageRowBoundsForViewMode,
    normalizePageMetrics,
    type IPdfPageLayoutMetrics,
    getLayoutPageTop,
    resolveLayoutPhysicalScrollOrigin,
    createLayoutPhysicalScrollSession,
    type IPdfSemanticAnchor,
    type IDocumentNavigationTicket,
} from '@app/modules/document-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { setupPagePlaceholderSizes } from '@app/modules/pdf-viewer/engine/pdf-page-buffer-manager/setupPagePlaceholderSizes';
import { getViewportVisibility } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getViewportVisibilityFromDom';
import {resolvePdfProtectedVisibleRange} from '@app/modules/pdf-viewer/engine/pdf-visible-render-range-policy/isPdfVisibleRenderRangeCurrent';
import type { IPdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';
import { createPdfPageSlotRegistry } from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';
import { resolvePdfRasterResidencyPlan } from '@app/modules/pdf-viewer/runtime/rendering/resolvePdfRasterResidencyPlan';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';
import { usePdfScale } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScale';
import { usePdfScroll } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import { usePdfSkeletonInsets } from '@app/modules/pdf-viewer/runtime/skeleton/usePdfSkeletonInsets';
import { usePdfViewerReloadTransition } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerReloadTransition';
import { summarizeViewerMetrics } from '@app/modules/pdf-viewer/engine/pdf-viewer-metrics/summarizeViewerMetrics';
import { usePdfViewportViewModel } from '@app/modules/pdf-viewer/runtime/viewport/usePdfViewportViewModel';
import { usePdfOpenVirtualSurfaceGeometry } from '@app/modules/pdf-viewer/runtime/viewport/usePdfOpenVirtualSurfaceGeometry';
import { usePdfSinglePageNavigationController } from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageNavigationController';
import type { IPdfViewportWritePort } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';
import { createPdfOpenSurfaceViewportCallbacks } from '@app/modules/pdf-viewer/runtime/viewport/createPdfOpenSurfaceViewportCallbacks';
import { getRequestAnchor } from '@app/modules/pdf-viewer/runtime/navigation/pdfNavigationRequestAnchors';
import { rotateAnnotationPoint } from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';
import { resolvePdfPreparedOpeningFitScale } from '@app/modules/pdf-viewer/runtime/lifecycle/resolvePdfPreparedOpeningFitScale';
import { resolveCustomReloadZoomMultiplier } from '@app/modules/pdf-viewer/runtime/reload-zoom/resolveCustomReloadZoomMultiplier';
import { resolvePdfFlingBackdrop } from '@app/modules/pdf-viewer/engine/pdf-page-layout/resolvePdfFlingBackdrop';
import type {
    IPdfDocumentTransition,
    TPdfDocumentView,
} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type {
    IPdfReloadAdmission,
    TPdfReloadOutcome,
} from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/pdfReloadWaiterViewer';
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
interface IPdfReloadAdmissionRecord {
    mapPage: (page: number) => number;
    settle: (outcome: TPdfReloadOutcome) => void;
}
export interface ICreatePdfViewportSessionOptions {
    document: TPdfDocumentView;
    isPageFreshlyRenderedForNavigation: (pageNumber: TPageNumber) => boolean;
    waitForPageTextLayerReady?: ((pageNumber: TPageNumber, signal: AbortSignal) => Promise<boolean>) | undefined;
    getCommittedPageScale?: ((pageNumber: TPageNumber) => number | null) | undefined;
    /** Hands the in-flight rasters of superseded viewport work to the renderer to cancel. */
    cancelSupersededRasters?: (() => void) | undefined;
    /** A navigation found its page already painted; the renderer adopts that canvas. */
    adoptResidentCanvas?: ((pageNumber: TPageNumber) => void) | undefined;
    /** The surface accepted a placement; the renderer settles the visual it waits on. */
    reconcileCommittedVisual?: (() => void) | undefined;
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
    /** Writes the view's zoom owner, which the layout reads at once. */
    emitZoomState: (state: TPdfZoomState) => void;
    summarizeViewerStateForLog: () => unknown;
}
// Scroll offsets are fractional under device-pixel scaling, so an exact
// comparison would read a rounding difference as user input.
const SCROLL_CLAMP_TOLERANCE_PX = 1;
/**
 * The viewport disables browser scroll anchoring, so clamping to new bounds
 * is the only offset change layout can produce on its own. Committed pages
 * kept at their painted scale during a navigation handoff shrink when the
 * handoff releases; that clamp must not read as the user taking the viewport
 * from the navigation. Any other offset came from the user.
 */
function isStrictScrollClamp(previousTop: number | null, top: number, maxTop: number) {
    const clampedMaxTop = Math.max(0, maxTop);
    return previousTop !== null
        && previousTop > clampedMaxTop + SCROLL_CLAMP_TOLERANCE_PX
        && Math.abs(top - clampedMaxTop) <= SCROLL_CLAMP_TOLERANCE_PX;
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
    const pageSlots = createPdfPageSlotRegistry();
    // The last offset a scroll event or an authored write left, against
    // which the next scroll is classified as a clamp.
    let lastObservedScrollTop: number | null = null;
    // Every write of this view records the offset it left at once. Layout can
    // clamp that offset before the browser delivers the write's scroll event,
    // and the one coalesced event must still read as a clamp.
    const viewportWritePort: IPdfViewportWritePort = {
        ...options.viewportWritePort,
        apply(container, write) {
            const applied = options.viewportWritePort.apply(container, write);
            if (applied) {
                lastObservedScrollTop = container.scrollTop;
            }
            return applied;
        },
    };
    // Another document or viewport element has its own offsets.
    watch(options.viewerContainer, () => {
        lastObservedScrollTop = null;
    }, {flush: 'sync'});
    // Document offset of the page track's top. Its only writers are the
    // placements below; every physical position derives from it.
    const physicalScroll = createLayoutPhysicalScrollSession();
    const physicalScrollOrigin = physicalScroll.origin;
    let physicalScrollTransitionSequence = 0;
    const getActivePhysicalScrollOrigin = () => physicalScrollOrigin.value;
    const scroll = usePdfScroll();
    // The view model below owns the page layout; the navigation controller
    // is built before it, so it reads the layout through this binding. A
    // reflow anchors its reading point on the layout the DOM still shows.
    const pageLayoutOwner = shallowRef<ComputedRef<IPdfPageLayoutMetrics | null> | null>(null);
    let anchoringLayout: IPdfPageLayoutMetrics | null = null;
    const getPageLayout = () => anchoringLayout ?? pageLayoutOwner.value?.value ?? null;
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
    const reloadTransition = usePdfViewerReloadTransition({summarizeViewerStateForLog: options.summarizeViewerStateForLog});
    const skeletonInsets = usePdfSkeletonInsets(basePageWidth, basePageHeight, scale.effectiveScale);
    const currentPage = scroll.currentPage;
    // A measurement describes the document it was taken in; a deleted page or
    // shorter replacement publishes its page count before the next measurement.
    const measuredVisibleRange = ref<IPageRange>({
        start: 1,
        end: 1,
    });
    const visibleRange = computed<IPageRange>({
        get: () => clampPageRange(measuredVisibleRange.value, Math.max(1, numPages.value)),
        set: range => (measuredVisibleRange.value = range),
    });
    const pageLayoutScaleResolver = shallowRef<((pageNumber: TPageNumber) => number) | null>(null);
    const horizontalScrollLockOwner = shallowRef<ComputedRef<boolean> | null>(null);
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
    function getProtectedVisibleRange(): IPageRange {
        return resolvePdfProtectedVisibleRange({
            visibleRange: visibleRange.value,
            navigationTargetPage: singlePageScroll.renderTargetPage.value,
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
    // A reload keeps the reading point the view shows when its document is
    // invalidated, moved through the page map the shell admitted the reload
    // with or else through the staged page mutation. Reader input after that
    // capture withdraws the placement, not the reload (R2).
    let nextReloadAnchor: IPdfSemanticAnchor | null = null;
    let reloadInteractionEpoch = 0;
    let activeReloadAnchor: IPdfSemanticAnchor | null = null;
    let activeReloadOwnedWork = false;
    // The shell's admission of the next reload, and the one the reload in flight settles.
    let admittedReload: IPdfReloadAdmissionRecord | null = null;
    let activeReloadAdmission: IPdfReloadAdmissionRecord | null = null;
    // A reload that opens a new surface generation is placed by its opening
    // ticket, retargeted to the reading point; the ticket's outcome is the receipt.
    let activeReloadNavigation: IDocumentNavigationTicket | null = null;
    let resolvedPageToRestore = requirePageNumber(1);
    let displayZoomToRestore: number | null = null;
    let activeReloadTransactionId: number | null = null;
    let visualReloadTransitionToken: number | null = null;
    function projectViewportVisibleRange(container: HTMLElement | null, totalPages: number) {
        if (!container || totalPages <= 0) {
            return visibleRange.value;
        }
        const visibility = getViewportVisibility(container, totalPages, getPageLayout(), getActivePhysicalScrollOrigin());
        visibleRange.value = visibility.range ?? visibleRange.value;
        return visibleRange.value;
    }
    /**
     * Moves the segment origin under a viewport the reader scrolled near a
     * segment end. The same document offset stays under the viewport: once
     * Vue has placed the track at the new origin, the scroll offset follows.
     */
    function rebasePhysicalScroll(
        container: HTMLElement,
        layout: IPdfPageLayoutMetrics,
        origin: number,
        documentTop: number,
        sequence: number,
    ) {
        const documentFence = documentSession.captureFence();
        physicalScroll.apply({
            container,
            layout,
            port: viewportWritePort,
            write: {
                intent: viewportWritePort.beginIntent(`pdf-scroll-segment-transition-${sequence}`),
                reason: 'pdf-scroll-segment-transition',
                left: container.scrollLeft,
                top: documentTop,
            },
            isCurrent: () => sequence === physicalScrollTransitionSequence
                && documentSession.isCurrent(documentFence)
                && getPageLayout() === layout
                && physicalScrollOrigin.value === origin,
            onApplied: () => projectViewportVisibleRange(container, numPages.value),
        });
    }
    /** Places the origin so `page` can be shown; `currentOrigin` is kept when it already can. */
    function placePhysicalScrollOrigin(
        layout: IPdfPageLayoutMetrics,
        page: number,
        currentOrigin: number,
    ) {
        if (!options.continuousScroll.value) {
            physicalScroll.place(null, 0, 0);
            return;
        }
        const pageTop = getLayoutPageTop(layout, requirePageIndex(clampPageNumber(page, layout.base.totalPages) - 1)) ?? 0;
        physicalScroll.place(
            layout,
            pageTop,
            options.viewerContainer.value?.clientHeight ?? 0,
            currentOrigin,
        );
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
        () => options.reconcileCommittedVisual?.(),
    );
    const singlePageScroll = usePdfSinglePageNavigationController({
        viewerContainer: options.viewerContainer,
        isHorizontalScrollLocked: () => horizontalScrollLockOwner.value?.value ?? false,
        chassisAuthority,
        numPages,
        currentPage,
        scaledMargin: scale.scaledMargin,
        viewMode: options.viewMode,
        continuousScroll: options.continuousScroll,
        isLoading,
        pdfDocument,
        updateVisibleRange: projectViewportVisibleRange,
        renderVisiblePages: (range, renderOptions) => requestMandatoryRaster(range, renderOptions),
        prepareNavigationLayout,
        isPageFreshlyRenderedForNavigation: options.isPageFreshlyRenderedForNavigation,
        waitForPageTextLayerReady: options.waitForPageTextLayerReady,
        visibleRange,
        viewportWritePort,
        getPageLayoutMetrics: getPageLayout,
        getPhysicalScrollOrigin: () => getActivePhysicalScrollOrigin(),
        bindCurrentPageProjection: scroll.bindCurrentPageProjection,
        getDocumentRevision: () => documentSession.captureFence().loadToken,
        getGeometryRevision: () => pageMetricsVersion.value + 1,
        onViewportWorkCancelled: ({cancelRasters}) => {
            if (cancelRasters) {
                options.cancelSupersededRasters?.();
            }
        },
        onPageVisualReady: page => options.adoptResidentCanvas?.(page),
        ...openSurfaceViewportCallbacks,
    });
    const viewportAuthority = singlePageScroll.viewportAuthority;
    const viewportWork = {
        activeWorkKind: viewportAuthority.activeWorkKind,
        commitVisibleRange,
    };
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
        physicalScrollOrigin,
        navigationVisualHandoffTargetPage: singlePageScroll.navigationAnchorPage,
        getCommittedPageScale: options.getCommittedPageScale,
        scaleContainerStyle: scale.containerStyle,
        selectionMarkupStyle: options.selectionMarkupStyle,
        viewportWritePort,
        classState: options.classState,
    });
    pageLayoutScaleResolver.value = viewModel.getPageLayoutScale;
    pageLayoutOwner.value = viewModel.pageLayout;
    horizontalScrollLockOwner.value = viewModel.isHorizontalScrollLocked;
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
    // Resolves true once the range painted or a page in it failed to render; false when its
    // pass ended without those pixels, a newer request superseded it or the demand was cancelled.
    let resolvePendingMandatoryRaster = (_settled: boolean) => {};
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
        const range = getProtectedVisibleRange();
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
                destinationPage: singlePageScroll.renderTargetPage.value,
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
        const committedViewportPages = singlePageScroll.renderTargetPage.value === null
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
            destinationPage: singlePageScroll.renderTargetPage.value,
            operational: true,
            mandatoryRaster: pendingMandatoryRaster,
        };
    }
    function publishDemand() {
        demand.value = resolveDemand();
    }
    // A newly mounted row can settle after its mount, moving the rows below
    // it without a scroll. Its own resize is the notification; a page
    // container's first observation is its mount.
    const mountedPageGeometryObserver = typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (options.continuousScroll.value) {
                projectViewportVisibleRange(options.viewerContainer.value, numPages.value);
                publishDemand();
            }
        });
    const observedPageContainers = new Map<TPageNumber, HTMLElement>();
    function unobservePageContainer(pageNumber: TPageNumber) {
        const element = observedPageContainers.get(pageNumber);
        if (element) {
            mountedPageGeometryObserver?.unobserve(element);
            observedPageContainers.delete(pageNumber);
        }
    }
    function observePageContainer(pageNumber: TPageNumber) {
        const element = options.viewerContainer.value?.querySelector<HTMLElement>(
            `.page_container[data-page="${String(pageNumber)}"]`,
        ) ?? null;
        if (observedPageContainers.get(pageNumber) === element) {
            return;
        }
        unobservePageContainer(pageNumber);
        if (element && mountedPageGeometryObserver) {
            observedPageContainers.set(pageNumber, element);
            mountedPageGeometryObserver.observe(element);
        }
    }
    function requestMandatoryRaster(
        range: IPageRange,
        renderOptions: IRenderVisiblePagesOptions = {},
    ) {
        resolvePendingMandatoryRaster(false);
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
                    preserveRenderedPages: renderOptions.preserveRenderedPages ?? true,
                },
            };
            resolvePendingMandatoryRaster = resolve;
            publishDemand();
        });
    }
    function settleMandatoryRaster(id: number, settled: boolean) {
        if (pendingMandatoryRaster?.id !== id) {
            return;
        }
        resolvePendingMandatoryRaster(settled);
        pendingMandatoryRaster = null;
        publishDemand();
    }
    function cancelMandatoryRaster() {
        resolvePendingMandatoryRaster(false);
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
            viewportWritePort.interactionEpochSignal.value,
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
    // Document operations run one at a time, so a newer admission supersedes an older one.
    function admitReload(mapPage: (page: number) => number): IPdfReloadAdmission {
        admittedReload?.settle('superseded');
        const {
            promise, resolve,
        } = Promise.withResolvers<TPdfReloadOutcome>();
        const record = admittedReload = {
            mapPage,
            settle: resolve,
        };
        return {
            finished: promise,
            withdraw: () => {
                admittedReload = admittedReload === record ? null : admittedReload;
                resolve('withdrawn');
            },
        };
    }
    function captureReloadAnchor() {
        const anchor = singlePageScroll.captureCurrentSemanticAnchor();
        // The shell's map moves the page through the operation that reloads;
        // a page edit without one moves it through the staged mutation.
        const admission = admittedReload;
        nextReloadAnchor = admission && anchor
            ? {
                ...anchor,
                page: admission.mapPage(anchor.page),
            }
            : documentSession.carryAnchorThroughPageMutation(anchor);
        reloadInteractionEpoch = viewportWritePort.getInteractionEpoch();
    }
    /**
     * Whether the reload still owns its placement: the reader has not moved
     * the view since its point was captured, and no navigation took the view
     * from the reload's work.
     */
    function ownsReloadPlacement() {
        return viewportWritePort.getInteractionEpoch() === reloadInteractionEpoch
            && !(activeReloadOwnedWork && activeReloadTransactionId !== null
                && !viewportAuthority.isWorkCurrent(activeReloadTransactionId));
    }
    /**
     * Places the reading point a reload carried, or an open's first page top,
     * and settles the reload's admission: placed, or taken by the reader or
     * a navigation first. A retargeted opening ticket places it instead.
     */
    function placeReloadAnchor(isReload: boolean) {
        if (isReload && activeReloadNavigation) {
            return;
        }
        const committed = (!isReload || (activeReloadAnchor !== null && ownsReloadPlacement()))
            && singlePageScroll.place(activeReloadAnchor ?? getRequestAnchor(undefined, resolvedPageToRestore), 'document-restore');
        logPdfRenderTrace('pdf-reload-viewport-reanchor', {
            pageNumber: resolvedPageToRestore,
            afterScrollTop: options.viewerContainer.value?.scrollTop ?? null,
            committed,
        });
        activeReloadAdmission?.settle(committed === false ? 'superseded' : 'placed');
        activeReloadAdmission = null;
    }
    function settleVisualReloadTransition(reason: string) {
        if (visualReloadTransitionToken === null) {
            return;
        }
        reloadTransition.endVisualReloadTransition(visualReloadTransitionToken, reason);
        visualReloadTransitionToken = null;
    }
    function beginReloadPlacement(transition: IPdfDocumentTransition) {
        const plan = transition.plan;
        activeReloadAnchor = plan.isReload ? nextReloadAnchor : null;
        nextReloadAnchor = null;
        activeReloadAdmission?.settle('superseded');
        activeReloadAdmission = admittedReload;
        admittedReload = null;
        if (!plan.isReload) {
            activeReloadAdmission?.settle('superseded');
            activeReloadAdmission = null;
        }
        activeReloadNavigation = null;
        const surface = chassisAuthority?.openSurface;
        const openingTicket = surface?.navigationTicket.value;
        if (
            surface && activeReloadAnchor && !plan.preserveVisibleContent
            && openingTicket?.request.source === 'restore'
            && openingTicket.generation === surface.snapshot.value.generation
            && ownsReloadPlacement()
        ) {
            // The reloaded generation opened with a page-top ticket; the
            // reload's point replaces it (latest wins) and resolves on arrival.
            activeReloadNavigation = surface.navigate(createPageNavigationRequest(activeReloadAnchor.page, 'restore', activeReloadAnchor));
        }
        const pageToRestore = plan.isReload
            ? activeReloadAnchor?.page ?? currentPage.value
            : 1;
        resolvedPageToRestore = clampPageNumber(pageToRestore, numPages.value);
        displayZoomToRestore = plan.isReload && !plan.isSelectiveReload && options.zoomMode.value === 'custom'
            ? scale.effectiveScale.value
            : null;
        activeReloadTransactionId = viewportAuthority.beginWork('reload', resolvedPageToRestore);
        activeReloadOwnedWork = viewportAuthority.isWorkCurrent(activeReloadTransactionId);
        visualReloadTransitionToken = plan.isReload && resolvedPageToRestore > 1
            ? reloadTransition.beginVisualReloadTransition('reload-recovery')
            : null;
        const preserveOpeningLayout = !plan.isReload
            && !plan.preserveVisibleContent
            && shouldPreserveOpeningLayout();
        if (plan.preserveVisibleContent) {
            if (plan.isReload) {
                scale.invalidateScaleCache();
            }
        } else if (!plan.isSelectiveReload) {
            if (plan.isReload || preserveOpeningLayout) {
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
    }
    /**
     * A reload keeps its custom display scale. The zoom state is written to
     * the view's owner, so the layout below already uses it.
     */
    function restoreReloadZoom() {
        const nextZoom = displayZoomToRestore === null ? null : resolveCustomReloadZoomMultiplier(displayZoomToRestore);
        displayZoomToRestore = null;
        if (nextZoom !== null && Math.abs(nextZoom - options.zoom.value) > 0.001) {
            options.emitZoomState({
                kind: 'custom',
                scale: nextZoom,
            });
        }
    }
    function handleTrustedScroll(_event: Event) {
        const container = options.viewerContainer.value;
        if (!container) {
            return;
        }
        const scrollEventSequence = ++physicalScrollTransitionSequence;
        viewModel.syncHorizontalScrollForZoomMode();
        const wasAuthorityScroll = viewportWritePort.consumeAuthorityScroll(container);
        if (consumeDocumentViewportPaneRelocationScrollFence(container)) {
            // Teleport can reset the native scroll offset while moving a pane.
            // The workspace marks that move explicitly, so only this lifecycle
            // event is excluded from viewport authority.
            lastObservedScrollTop = container.scrollTop;
            return;
        }
        // The compositor can apply one more inertial delta before scroll
        // suppression reaches it. That offset belongs to the superseded
        // gesture, not to the user taking the viewport.
        const previousTop = lastObservedScrollTop;
        lastObservedScrollTop = container.scrollTop;
        if (
            wasAuthorityScroll
            || viewportWritePort.isCommandResidueLive()
            || isStrictScrollClamp(previousTop, container.scrollTop, container.scrollHeight - container.clientHeight)
        ) {
            projectViewportVisibleRange(container, numPages.value);
            return;
        }
        cancelSupersededRaster();
        // A direct scroll can arrive without a preceding wheel/pointer event
        // (scrollbar drags, accessibility input, or automation). Clear the
        // retained navigation row at the scroll boundary so virtualization
        // follows the live offset instead of remaining pinned to an already
        // settled destination. Cancelling it is what advances the write
        // port's interaction epoch for a scroll no wheel packet announced.
        singlePageScroll.cancelProgrammaticNavigation('viewer-scroll-interaction');
        const layout = getPageLayout();
        const origin = physicalScrollOrigin.value;
        const documentTop = origin + container.scrollTop;
        const nextOrigin = layout
            ? resolveLayoutPhysicalScrollOrigin(layout, documentTop, container.clientHeight, origin)
            : origin;
        if (layout && nextOrigin !== origin) {
            rebasePhysicalScroll(container, layout, nextOrigin, documentTop, scrollEventSequence);
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
        },
        { immediate: true },
    );
    // Apart from a rebase under the reader's scroll, the origin moves only
    // with the layout or a navigation target, before Vue lays the track out.
    // A zoom, fit or view-mode change goes through relayout, which restores
    // the reading point at the new origin. Page metrics that reflow rows at
    // the same scale keep the reading offset under a row-start origin, and
    // the reading point through rows that change above it.
    watch([
        viewModel.pageLayout,
        options.continuousScroll,
    ], ([
        layout,
        continuous,
    ], [
        previous,
        wasContinuous,
    ]) => {
        if (!layout) {
            return;
        }
        const container = options.viewerContainer.value;
        const reflow = continuous && continuous === wasContinuous && container
            && previous?.scale === layout.scale
            && previous.gap === layout.gap
            && previous.base.totalPages === layout.base.totalPages
            && previous.base.rowHeights.length === layout.base.rowHeights.length;
        if (!reflow) {
            placePhysicalScrollOrigin(layout, singlePageScroll.navigationAnchorPage.value ?? currentPage.value, 0);
            return;
        }
        // Rows above the reading page that grow or shrink, as late metrics of
        // a sparse PDF do, move it: keep its point, which the DOM still shows.
        const readingPageIndex = requirePageIndex(clampPageNumber(currentPage.value, layout.base.totalPages) - 1);
        if (getLayoutPageTop(previous, readingPageIndex) !== getLayoutPageTop(layout, readingPageIndex)) {
            anchoringLayout = previous;
            let anchor: IPdfSemanticAnchor | null;
            try {
                anchor = singlePageScroll.captureRelayoutAnchor();
            } finally {
                anchoringLayout = null;
            }
            void singlePageScroll.relayout(undefined, anchor);
        }
        const origin = physicalScrollOrigin.value;
        const documentTop = origin + container.scrollTop;
        const nextOrigin = resolveLayoutPhysicalScrollOrigin(layout, documentTop, container.clientHeight, origin);
        if (nextOrigin !== origin) {
            rebasePhysicalScroll(container, layout, nextOrigin, documentTop, ++physicalScrollTransitionSequence);
        }
    }, {flush: 'sync'});
    watch(singlePageScroll.navigationAnchorPage, (page) => {
        const layout = viewModel.pageLayout.value;
        if (page !== null && layout) {
            placePhysicalScrollOrigin(layout, page, physicalScrollOrigin.value);
        }
    }, {flush: 'sync'});
    watchEffect(() => {
        const layout = viewModel.pageLayout.value;
        if (layout && options.continuousScroll.value) {
            projectViewportVisibleRange(options.viewerContainer.value, numPages.value);
        }
    });
    onBeforeUnmount(() => {
        physicalScrollTransitionSequence += 1;
        mountedPageGeometryObserver?.disconnect();
        observedPageContainers.clear();
    });
    // The reader taking the viewport supersedes a programmatic navigation's raster.
    function cancelSupersededRaster() {
        if (singlePageScroll.viewportAuthority.activeIntent.value !== null || singlePageScroll.navigationAnchorPage.value !== null) {
            options.cancelSupersededRasters?.();
        }
    }
    // Wheel packets and mousedown reach here after the chassis reported
    // them to the write port, which counts the interaction.
    function markUserViewportInteraction() {
        cancelSupersededRaster();
        singlePageScroll.cancelProgrammaticNavigation('user-viewport-interaction', undefined, {observeWritePort: false});
    }
    function handleLinkDestination(dest: NonNullable<ILinkAnnotation['dest']>) {
        const request = createPageNavigationRequest(currentPage.value, 'bookmark');
        request.target = {
            kind: 'named-dest',
            destination: dest,
        };
        singlePageScroll.submitNavigationRequest(request);
    }
    /**
     * An opening is placed by its ticket: the placement receipt reports the
     * opening viewport, and with it the page, to the surface. Should an
     * opening end up without a ticket and without a matching placement for its
     * current intent and requested page — whether withdrawn before Vue's post
     * flush, withdrawn before this view mounted, or after a prior ticket's
     * placement stayed on an earlier page — restore the requested page with a
     * new ticket, which hydrates its metrics and raster as the first one would
     * have. A ticket that fails ends the opening as failed instead.
     */
    watch(
        () => {
            const surface = chassisAuthority?.openSurface;
            const viewport = surface?.viewportSession.value;
            const snapshot = surface?.snapshot.value;
            const committed = snapshot?.committedViewport;
            const hasMatchingPlacement = committed !== null
                && committed !== undefined
                && committed.generation === snapshot?.generation
                && committed.pageNumber === viewport?.requestedPage
                && (viewport.viewportIntent === null || committed.viewportIntentId === viewport.viewportIntent.id);
            return surface
                && viewport?.lifecycle === 'opening'
                && !surface.navigationTicket.value
                && !hasMatchingPlacement
                ? `${String(snapshot?.generation ?? 0)}:${viewport.viewportIntent?.id ?? ''}:${String(viewport.requestedPage)}`
                : null;
        },
        (unplaced) => {
            const surface = chassisAuthority?.openSurface;
            const viewport = surface?.viewportSession.value;
            if (unplaced && surface && viewport?.lifecycle === 'opening' && !surface.navigationTicket.value) {
                surface.navigate(createPageNavigationRequest(viewport.requestedPage, 'restore'));
            }
        },
        {
            flush: 'post',
            immediate: true,
        },
    );
    watch(() => singlePageScroll.viewportAuthority.activeIntent.value, (activeIntent, previous) => {
        if (activeIntent !== null) {
            return;
        }
        // A settled page-top navigation's place is from now on the centre
        // point it shows (R3), so a later relayout, such as a tab's return
        // while its sidebar slides in, keeps that point, not the page top.
        const anchor = previous?.navigation && viewportAuthority.committedAnchor.value?.affinity === 'start'
            && viewportAuthority.getTerminalOutcome(previous.id) === 'settled'
            ? singlePageScroll.captureRelayoutAnchor()
            : null;
        if (anchor) {viewportAuthority.observeSettledAnchor(anchor);}
    }, { flush: 'sync' });
    function fitToViewport() {
        scale.computeFitWidthScale(options.viewerContainer.value, {page: currentPage.value});
    }
    function pageTopAnchor() {
        return getRequestAnchor(undefined, clampPageNumber(currentPage.value, numPages.value));
    }
    // R3 keeps the centre point through a layout change and maps it through
    // its page's turn: every page's, or only that of the `pages` an edit turns.
    function relayoutRotation(change: () => void, rotation: number, pages?: readonly number[]) {
        return singlePageScroll.relayout(change, rotation % 360 === 0 ? undefined : (anchor) => {
            if (pages && !pages.includes(anchor.page)) {
                return anchor;
            }
            const point = rotateAnnotationPoint({
                x: anchor.pageXFraction,
                y: anchor.pageYFraction,
            }, rotation);
            return {
                ...anchor,
                pageXFraction: point.x,
                pageYFraction: point.y,
            };
        });
    }
    watch([
        options.zoom,
        options.zoomMode,
        viewRotation,
    ], ([
        , , rotation,
    ], [
        , , previousRotation,
    ]) => relayoutRotation(fitToViewport, rotation - previousRotation), {flush: 'sync'});
    // No reading-point rule changes view/scroll mode's page-top placement.
    watch([
        options.viewMode,
        options.continuousScroll,
    ], () => {
        singlePageScroll.relayout(fitToViewport, pageTopAnchor());
    }, {flush: 'sync'});
    // A resize keeps the point that was under the old viewport centre at the
    // new centre (contract R3). A pane drag or split keeps the point it
    // started with: moving a pane can reset the native scroll offset before
    // any size change is observed. A position committed after the gesture began,
    // such as a navigation that lands while the sidebar slides, is newer than
    // that point and ends it.
    watch([
        options.isActive,
        options.isResizing,
    ], ([
        active,
        resizing,
    ], [wasActive]) => {
        if (!active) {
            viewportAuthority.suspend();
            return;
        }
        singlePageScroll.relayout(fitToViewport, wasActive && resizing
            ? singlePageScroll.captureRelayoutAnchor()
            : toRaw(viewportAuthority.committedAnchor.value));
        // A navigation the inactive view suspended runs again now.
        singlePageScroll.resumeNavigation();
    }, {flush: 'sync'});
    let observedViewportSize: {
        width: number;
        height: number;
    } | null = null;
    function observeViewportSize() {
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
        // A scrollbar changes the space available to fit, but does not own
        // the zoom gesture's anchor. Recompute fit without placing it again;
        // the rows it covers or uncovers change what is visible and demanded.
        if (previous.width === container.clientWidth
            && Math.abs(previous.height - container.clientHeight) === container.offsetWidth - container.clientWidth) {
            fitToViewport();
            if (options.continuousScroll.value) {
                projectViewportVisibleRange(container, numPages.value);
                publishDemand();
            }
            return;
        }
        singlePageScroll.relayout(fitToViewport, options.isResizing.value
            || previous.width === 0 || previous.height === 0
            ? toRaw(viewportAuthority.committedAnchor.value)
            : singlePageScroll.captureRelayoutAnchor({
                x: previous.width / 2,
                y: previous.height / 2,
            }, previous));
    }
    useResizeObserver(options.viewerContainer, observeViewportSize);
    /**
     * Settles once this view shows its reading point in its current box. The
     * box is read now: a size the ResizeObserver has not delivered yet is laid
     * out here, as it would be there, and the delivery then finds it
     * unchanged. An unchanged box has nothing to place unless a layout change
     * is waiting for its flush; a hidden or closed view has nothing to place.
     */
    async function whenLayoutPlaced() {
        if (options.isActive.value) {
            observeViewportSize();
        }
        await singlePageScroll.pendingRelayoutReceipt();
    }
    /**
     * A reload that ends before its placement was superseded. A retargeted
     * opening ticket settles on its outcome: the reader's input meanwhile
     * supersedes it, although the hidden overflow of an opening generation
     * kept that input from moving the view, so arrival is no jump back.
     */
    async function applyReadyDocumentTransition(transition: IPdfDocumentTransition) {
        const admission = activeReloadAdmission;
        const navigation = activeReloadNavigation;
        try {
            await placeReadyDocument(transition);
        } finally {
            if (navigation) {
                void navigation.finished.then(outcome => admission?.settle(outcome.kind === 'arrived' && ownsReloadPlacement() ? 'placed' : 'superseded'));
            } else {
                admission?.settle('superseded');
            }
        }
    }
    async function placeReadyDocument(transition: IPdfDocumentTransition) {
        if (!transition.isCurrent()) {
            return;
        }
        const plan = transition.plan;
        const isPreservedSelectiveReload = plan.preserveVisibleContent && plan.isSelectiveReload;
        if (!plan.preserveVisibleContent || isPreservedSelectiveReload) {
            // Geometry is complete at ready except on a sparse source, which
            // measures the page it restores.
            await documentSession.ensurePageMetricsInRange(currentPage.value, currentPage.value);
            if (!transition.isCurrent()) {
                return;
            }
            if (!plan.isSelectiveReload || options.zoomMode.value === 'fit-width') {
                scale.computeFitWidthScale(options.viewerContainer.value, {page: currentPage.value});
            }
            // The scale reads the restored zoom at once. The relayout it asks
            // for settles in the flush awaited below, superseded while this
            // reload still owes its own placement.
            restoreReloadZoom();
            setupPagePlaceholders();
            // Placeholder projection is a render boundary. Let Vue install
            // the authoritative page containers before handing raster demand
            // downstream, otherwise that projection can replace a canvas
            // committed against the preceding DOM.
            await nextTick();
            if (!transition.isCurrent()) {
                return;
            }
            placeReloadAnchor(plan.isReload);
            if (isPreservedSelectiveReload) {
                // In paged mode, mapping the reading page to another page at
                // the same scroll offset swaps the mounted `.page_container`;
                // wait for Vue to mount it before measuring DOM visibility.
                await nextTick();
                if (!transition.isCurrent()) {
                    return;
                }
            }
            commitVisibleRange(
                projectViewportVisibleRange(options.viewerContainer.value, numPages.value),
                activeReloadTransactionId,
            );
        }
        const initialPage = clampPageNumber(currentPage.value, numPages.value);
        await requestMandatoryRaster({
            start: initialPage,
            end: initialPage,
        }, plan.preserveVisibleContent
            ? {
                preserveRenderedPages: true,
                bufferOverride: 0,
                forceRerender: !plan.isSelectiveReload || (plan.pagesToInvalidate?.includes(currentPage.value) ?? false),
            }
            : {bufferOverride: 0});
        if (!transition.isCurrent()) {
            return;
        }
        if (plan.preserveVisibleContent && !isPreservedSelectiveReload) {
            placeReloadAnchor(plan.isReload);
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
    const unsubscribeDocumentTransitions = documentSession.subscribe(async (transition) => {
        if (!transition.isCurrent()) {
            return;
        }
        if (transition.phase === 'loading') {
            singlePageScroll.retireStaleViewportIntent(transition.fence.loadToken);
            beginReloadPlacement(transition);
            return;
        }
        if (transition.phase === 'invalidated') {
            lastObservedScrollTop = null;
            singlePageScroll.viewportAuthority.suspend();
            cancelMandatoryRaster();
            // A page operation rewrites the file the viewer already has open.
            // Tearing the presentation down here is what leaves the empty
            // shell on screen until the replacement paints, so hold the last
            // picture instead and let the reload plan consume it.
            activeReloadAdmission?.settle('superseded');
            captureReloadAnchor();
            if (transition.isSameDocumentRewrite) {
                documentSession.preserveNextReloadVisibleContent(true);
            }
            settleVisualReloadTransition(transition.reason);
            const transactionId = activeReloadTransactionId;
            activeReloadTransactionId = null;
            if (transactionId !== null && viewportAuthority.isWorkCurrent(transactionId)) {
                viewportAuthority.cancelWork({cancelRasters: true}, transactionId);
            }
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
        mountedPageGeometryObserver?.disconnect();
        observedPageContainers.clear();
        unsubscribeDocumentTransitions();
        admittedReload?.settle('superseded');
        activeReloadAdmission?.settle('superseded');
        cancelMandatoryRaster();
        pageSlots.dispose();
    });
    return {
        currentPage,
        visibleRange,
        demand: shallowReadonly(demand),
        pageSlots,
        scroll,
        scale,
        relayoutRotation,
        whenLayoutPlaced,
        skeletonInsets,
        reloadTransition,
        viewModel,
        openVirtualSurfaceGeometry,
        flingBackdrop,
        singlePageScroll,
        viewportWork,
        viewportWritePort,
        summarizeViewerMetricsForLog: summarizeViewerMetrics,
        getProtectedVisibleRange,
        setupPagePlaceholders,
        markUserViewportInteraction,
        admitReload,
        handleLinkDestination,
        handleTrustedScroll,
        handleViewerContainerRef: (element: HTMLElement | null) => {
            options.viewerContainer.value = element;
        },
        markPageMounted(pageNumber: TPageNumber) {
            pageSlots.markMounted(pageNumber);
            observePageContainer(pageNumber);
            if (options.continuousScroll.value) {
                projectViewportVisibleRange(options.viewerContainer.value, numPages.value);
            }
            publishDemand();
        },
        markPageUnmounted(pageNumber: TPageNumber) {
            pageSlots.markUnmounted(pageNumber);
            unobservePageContainer(pageNumber);
            publishDemand();
        },
        settleMandatoryRaster,
        commitVisibleRange,
    };
};
export type TPdfViewportSession = ReturnType<typeof createPdfViewportSession>;
