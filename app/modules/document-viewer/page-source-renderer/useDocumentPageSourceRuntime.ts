import {
    buildDocumentPageSourceScrollLayout,
    createLayoutPhysicalScrollSession,
    getLayoutContentHeight,
    getLayoutPhysicalScrollSegment,
    resolveLayoutPhysicalScrollOrigin,
} from '@app/modules/document-viewer/layout/pdfPageLayoutMetrics';
import {useWindowDevicePixelRatio} from '@app/composables/useWindowDevicePixelRatio';
import {useTypedI18n} from '@app/composables/useTypedI18n';
import {useResizeObserver, useTimeoutFn} from '@vueuse/core';
import {DOCUMENT_SOURCE_INACTIVE_LEASE_GRACE_MS} from '@app/constants/timeouts';
import {clamp} from 'es-toolkit/math';
import {isAbortError} from '@contracts/isAbortError';
import type {IPdfSemanticAnchor} from '@contracts/recentReadingView';
import type {IZoomStateAccess} from '@contracts/shared';
import type {IDocumentViewerExpose} from '@app/modules/pdf-viewer/public';
import {createDocumentWheelZoomHandler, type IDocumentWheelInteraction} from '@app/modules/document-viewer/input/documentWheelInteraction';
import {
    createLazyIndexedCollection,
    isLazyIndexedCollection,
    type ILazyIndexedCollection,
} from '@app/modules/document-viewer/virtualization/pageVirtualization';
import {
    resolveDocumentPageLeft,
    resolveDocumentZoomAnchorScroll,
    type IDocumentZoomPageLayout,
} from '@app/modules/document-viewer/zoomAnchor';
import {createDocumentViewportWritePort} from '@app/modules/document-viewer/runtime/documentViewportWritePort';
import {
    resolveDocumentContinuousScrollWindow,
    resolveDocumentVisiblePageForIndicator,
} from '@app/modules/document-viewer/viewport/resolveDocumentContinuousScrollWindow';
import {
    resolveDocumentPageDisplayLayouts,
    resolveDocumentPageDisplayScale,
    type IDocumentPageDisplayLayout,
} from '@app/modules/document-viewer/layout/resolveDocumentPageDisplayLayout';
import {shouldProjectDocumentViewportScroll} from '@app/modules/document-viewer/runtime/shouldProjectDocumentViewportScroll';
import {useDocumentViewportLayoutLifecycle} from '@app/modules/document-viewer/lifecycle/useDocumentViewportLayoutLifecycle';
import {useDocumentWheelZoomSessionBoundaries} from '@app/modules/document-viewer/input/useDocumentWheelZoomSessionBoundaries';
import {DOCUMENT_PAGE_GUTTER_PX} from '@app/modules/document-viewer/layout/documentPageGutterPx';
import {readArrivedViewportClientSize} from '@app/modules/document-viewer/layout/resolveDocumentPageSourceOpeningFrame';
import {injectDocumentViewerRuntime} from '@app/modules/document-viewer/runtime/documentViewerRuntime';
import {clampDocumentManualZoom} from '@app/modules/document-viewer/zoomPolicy';
import type {IDocumentPageMetrics, IDocumentPageSource} from '@app/modules/document-viewer/source/documentPageSource';
import {
    createPageNavigationRequest,
    type IDocumentNavigationRequest,
    type IDocumentNavigationTicket,
} from '@app/modules/document-viewer/navigation/documentNavigationRequest';
import type {IDocumentViewportSessionState} from '@app/modules/document-viewer/runtime/documentOpenSurfaceReducer';
import {workspaceSurfaceBudgetController} from '@app/modules/document-viewer/runtime/workspaceSurfaceBudgetController';
import type {TMemoryPressureLevel} from '@app/utils/viewerResidencyPolicy';
import {createRafCoalescedCallback} from '@app/utils/createRafCoalescedCallback';
import {
    createColdOpenProvisionalDocumentPageMetrics,
    createProvisionalDocumentPageMetrics,
    isSparseDocumentPageMetrics,
    loadInitialDocumentPageMetric,
    type TDocumentPageMetricsCollection,
} from '@app/modules/document-viewer/page-source-renderer/loadPrioritizedDocumentPageMetrics';
import {resolveDocumentPageSourceRenderDemand} from '@app/modules/document-viewer/page-source-renderer/resolveDocumentPageSourceRenderDemand';
import {resolveDocumentPageSourceRenderQueue} from '@app/modules/document-viewer/page-source-renderer/resolveDocumentPageSourceRenderQueue';
import {
    createDocumentPageSourcePresentation,
    resolveDocumentPageSourceRenderWidthPx,
} from '@app/modules/document-viewer/page-source-renderer/documentPageSourcePresentation';
import {createPageSourcePagedWheelNavigation} from '@app/modules/document-viewer/page-source-renderer/createPageSourcePagedWheelNavigation';
import {createDocumentPageMetricPublication} from '@app/modules/document-viewer/page-source-renderer/createDocumentPageMetricPublication';
import {getRawElectronPlatformApi} from '@app/utils/electronPlatformBridge';
import {getPerformanceProfile, type IPerformanceProfile} from '@app/utils/performanceProfile';
import {resolveOpenPathSecondaryPerformancePolicy} from '@app/utils/resolveOpenPathSecondaryPerformancePolicy';
import {
    createDocumentPageSourceLifecycle,
    createDocumentPageSourceOpenJob,
    type TDocumentPageSourceOpenJob,
    type IDocumentPageSourceTransition,
    openDocumentPageSource,
    type IDocumentPageSourceFeaturePackEmit,
    type TDocumentPageElement,
    type TDocumentPageSourceRuntimeProps,
} from '@app/modules/document-viewer/page-source-renderer/documentPageSourceFeaturePackState';
const DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS = 12;
const DOCUMENT_SOURCE_MAX_MOUNTED_PAGES = 40;
const DOCUMENT_SOURCE_MAX_RESIDENT_PAGES = 5;
const DOCUMENT_SOURCE_CONTINUOUS_MAX_RESIDENT_PAGES = DOCUMENT_SOURCE_MAX_MOUNTED_PAGES;
const DOCUMENT_SOURCE_RENDER_CONCURRENCY_LOW = 1;
const DOCUMENT_SOURCE_RENDER_CONCURRENCY = 2;
const DOCUMENT_SOURCE_LOW_CPU_MAX = 2;
const DOCUMENT_SOURCE_LOW_RAM_MAX_BYTES = 8 * 1024 ** 3;
const DOCUMENT_SOURCE_LAYOUT_CHUNK_SIZE = 256;
const DOCUMENT_SOURCE_LAYOUT_MAX_CACHED_CHUNKS = 32;
export {DOCUMENT_SOURCE_INACTIVE_LEASE_GRACE_MS};

export function resolveDocumentPageSourceRenderConcurrency(
    profile: Pick<IPerformanceProfile, 'lowCpu' | 'lowMemory' | 'tier'>,
    hostHardware?: {logicalCpus?: number; totalRamBytes?: number} | null,
) {
    const logicalCpus = hostHardware?.logicalCpus;
    const totalRamBytes = hostHardware?.totalRamBytes;
    return profile.tier === 'low' ||
        profile.lowCpu ||
        profile.lowMemory ||
        (typeof logicalCpus === 'number' && logicalCpus > 0 && logicalCpus <= DOCUMENT_SOURCE_LOW_CPU_MAX) ||
        (typeof totalRamBytes === 'number' && totalRamBytes > 0 && totalRamBytes <= DOCUMENT_SOURCE_LOW_RAM_MAX_BYTES)
        ? DOCUMENT_SOURCE_RENDER_CONCURRENCY_LOW
        : DOCUMENT_SOURCE_RENDER_CONCURRENCY;
}

type TDocumentPageSourceCollection<T> = T[] | ILazyIndexedCollection<T>;

interface IDocumentPageDisplayLayoutCollection extends ILazyIndexedCollection<IDocumentPageDisplayLayout> {
    readonly sumHeightRange?: (start: number, end: number) => number;
}

interface IDocumentPageHeightCollection extends ILazyIndexedCollection<number> {
    readonly sumRange?: (start: number, end: number) => number;
}

function resolveDocumentPageDisplayLayout(
    metric: IDocumentPageMetrics,
    availableHeight: number,
    availableWidth: number,
    manualZoom: number,
    zoomMode: TDocumentPageSourceRuntimeProps['zoomMode'],
    fitWidthPageWidth: number | undefined,
) {
    const scale = resolveDocumentPageDisplayScale({
        availableHeight,
        availableWidth,
        manualZoom,
        pageSize: {
            height: metric.heightPoints,
            width: metric.widthPoints,
        },
        zoomMode,
        fitWidthPageWidth,
    });
    return {
        height: Math.max(1, Math.round(metric.heightPoints * scale)),
        scale,
        width: Math.max(1, Math.round(metric.widthPoints * scale)),
    };
}

export function resolveDocumentPageDisplayLayoutsBounded(
    metrics: TDocumentPageMetricsCollection,
    availableHeight: number,
    availableWidth: number,
    manualZoom: number,
    zoomMode: TDocumentPageSourceRuntimeProps['zoomMode'],
    continuousScroll = false,
) {
    if (!isLazyIndexedCollection(metrics)) {
        return resolveDocumentPageDisplayLayouts({
            availableHeight,
            availableWidth,
            manualZoom,
            pageSizes: metrics.map((metric) => ({
                height: metric.heightPoints,
                width: metric.widthPoints,
            })),
            zoomMode,
            continuousScroll,
        });
    }
    const sparseMetrics = isSparseDocumentPageMetrics(metrics) ? metrics : null;
    // Continuous fit-width fits the widest page, one scale for the document.
    // Measured once per layout, not per scroll; sparse metrics hold their
    // measured pages apart, and every other page is the fallback.
    let fitWidthPageWidth: number | undefined;
    if (continuousScroll && zoomMode === 'fit-width') {
        let widest = 0;
        if (sparseMetrics) {
            let exactCount = 0;
            sparseMetrics.forEachExact((_pageNumber, metric) => {
                exactCount += 1;
                widest = Math.max(widest, metric.widthPoints);
            });
            if (exactCount < metrics.length) {
                widest = Math.max(widest, metrics.fallbackMetric.widthPoints);
            }
        } else {
            for (let index = 0; index < metrics.length; index += 1) {
                widest = Math.max(widest, (metrics.get(index) ?? metrics.fallbackMetric).widthPoints);
            }
        }
        fitWidthPageWidth = widest;
    }
    const displayLayouts = createLazyIndexedCollection({
        cacheValues: false,
        chunkSize: DOCUMENT_SOURCE_LAYOUT_CHUNK_SIZE,
        getValue: (index) =>
            resolveDocumentPageDisplayLayout(
                metrics.get(index) ?? metrics.fallbackMetric,
                availableHeight,
                availableWidth,
                manualZoom,
                zoomMode,
                fitWidthPageWidth,
            ),
        length: metrics.length,
        maxCachedChunks: DOCUMENT_SOURCE_LAYOUT_MAX_CACHED_CHUNKS,
    });
    if (!sparseMetrics) {
        return displayLayouts as ILazyIndexedCollection<IDocumentPageDisplayLayout>;
    }
    const fallbackLayout = resolveDocumentPageDisplayLayout(
        metrics.fallbackMetric,
        availableHeight,
        availableWidth,
        manualZoom,
        zoomMode,
        fitWidthPageWidth,
    );
    let correctionRevision = -1;
    let correctionIndices: number[] = [];
    let correctionPrefixes: number[] = [];
    const ensureHeightCorrections = () => {
        if (correctionRevision === sparseMetrics.exactRevision) {
            return;
        }
        correctionIndices = [];
        correctionPrefixes = [0];
        for (const pageNumber of sparseMetrics.getExactPageNumbers()) {
            const index = pageNumber - 1;
            const metric = sparseMetrics[index];
            if (!metric) {
                continue;
            }
            const exactLayout = resolveDocumentPageDisplayLayout(
                metric,
                availableHeight,
                availableWidth,
                manualZoom,
                zoomMode,
                fitWidthPageWidth,
            );
            correctionIndices.push(index);
            correctionPrefixes.push((correctionPrefixes.at(-1) ?? 0) + exactLayout.height - fallbackLayout.height);
        }
        correctionRevision = sparseMetrics.exactRevision;
    };
    const sumCorrectionsBefore = (end: number) => {
        let low = 0;
        let high = correctionIndices.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            const correctionIndex = correctionIndices[middle];
            if (correctionIndex !== undefined && correctionIndex < end) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        return correctionPrefixes[low] ?? 0;
    };
    Object.defineProperty(displayLayouts, 'sumHeightRange', {
        configurable: false,
        enumerable: false,
        value: (start: number, end: number) => {
            const rangeStart = Math.max(0, Math.min(metrics.length, Math.trunc(start)));
            const rangeEnd = Math.max(rangeStart, Math.min(metrics.length, Math.trunc(end)));
            if (rangeStart >= rangeEnd) {
                return 0;
            }
            ensureHeightCorrections();
            return (rangeEnd - rangeStart) * fallbackLayout.height + sumCorrectionsBefore(rangeEnd) - sumCorrectionsBefore(rangeStart);
        },
    });
    return displayLayouts as IDocumentPageDisplayLayoutCollection;
}
function mapDocumentPageSourceCollectionBounded<T, U>(
    collection: TDocumentPageSourceCollection<T>,
    mapValue: (value: T, index: number) => U,
): TDocumentPageSourceCollection<U> {
    if (isLazyIndexedCollection(collection)) {
        return createLazyIndexedCollection({
            cacheValues: true,
            chunkSize: DOCUMENT_SOURCE_LAYOUT_CHUNK_SIZE,
            getValue: (index) => mapValue(collection.get(index) as T, index),
            length: collection.length,
            maxCachedChunks: DOCUMENT_SOURCE_LAYOUT_MAX_CACHED_CHUNKS,
        });
    }
    return collection.map((value, index) => mapValue(value, index));
}
export function resolveDocumentPageHeightsBounded(displayLayouts: TDocumentPageSourceCollection<IDocumentPageDisplayLayout>) {
    const heights = mapDocumentPageSourceCollectionBounded(displayLayouts, (layout) => layout.height);
    const sumHeightRange = (displayLayouts as IDocumentPageDisplayLayoutCollection).sumHeightRange;
    if (sumHeightRange && isLazyIndexedCollection(heights)) {
        Object.defineProperty(heights, 'sumRange', {
            configurable: false,
            enumerable: false,
            value: sumHeightRange,
        });
    }
    return heights as TDocumentPageSourceCollection<number> & IDocumentPageHeightCollection;
}
export function resolveDocumentPageLayoutsBounded(
    displayLayouts: TDocumentPageSourceCollection<IDocumentPageDisplayLayout>,
    pageTops: TDocumentPageSourceCollection<number>,
    continuousScroll: boolean,
) {
    return mapDocumentPageSourceCollectionBounded(displayLayouts, (layout, index) => ({
        top: continuousScroll ? (pageTops[index] ?? DOCUMENT_PAGE_GUTTER_PX) : DOCUMENT_PAGE_GUTTER_PX,
        width: layout.width,
        height: layout.height,
    }));
}
export function resolveDocumentPageZoomAnchorLayoutsBounded(
    pageLayouts: TDocumentPageSourceCollection<IDocumentZoomPageLayout>,
    resolvePageLeft: (pageWidth: number) => number,
) {
    return mapDocumentPageSourceCollectionBounded(pageLayouts, (layout) => ({
        ...layout,
        left: resolvePageLeft(layout.width),
    }));
}
export function shouldRetainInactiveDocumentPageSourceLease(retainWarmLease: boolean, pressureLevel: TMemoryPressureLevel) {
    return retainWarmLease && pressureLevel === 'none';
}
export function resolveDocumentPageSourceReadyEdgeSemanticPage(
    viewportSession: Pick<IDocumentViewportSessionState, 'lifecycle' | 'requestedPage' | 'committedPage' | 'observedPage'>,
) {
    if (viewportSession.lifecycle !== 'ready' || viewportSession.observedPage !== null) {
        return null;
    }
    return viewportSession.committedPage ?? viewportSession.requestedPage;
}
export const useDocumentPageSourceRuntime = (options: {
    emit: IDocumentPageSourceFeaturePackEmit;
    readProps: () => TDocumentPageSourceRuntimeProps;
    readZoom: () => IZoomStateAccess;
}) => {
    let nextSourcePageSlotOwnerId = 0;
    const emit = options.emit;
    const props = computed(options.readProps);
    const viewerContainer = shallowRef<HTMLElement | null>(null);
    const pixelRatio = useWindowDevicePixelRatio();
    const containerWidth = ref(0);
    const containerHeight = ref(0);
    const physicalScroll = createLayoutPhysicalScrollSession();
    const viewportScrollTop = ref(0);
    const viewportScrollDirection = ref<-1 | 0 | 1>(0);
    const pagedWheelNavigation = createPageSourcePagedWheelNavigation(DOCUMENT_PAGE_GUTTER_PX);
    const chassisAuthority = injectDocumentViewerRuntime();
    // The view's page is the page its surface reports, for every renderer.
    const currentPage = computed(() => chassisAuthority?.currentPage.value ?? 1);
    const openSurfaceRenderOwner = chassisAuthority?.openSurface.claimRenderOwner();
    const viewportWritePort = chassisAuthority?.viewportWritePort ?? createDocumentViewportWritePort();
    const renderSession = chassisAuthority?.renderCoordinator.createSession(`page-source-feature:${String(++nextSourcePageSlotOwnerId)}`);
    const openingPageFrameOwnerId = `page-source:${String(nextSourcePageSlotOwnerId)}`;
    const pageSlots = renderSession?.pageSlots;
    const surfaceBudget = chassisAuthority?.surfaceBudget ?? workspaceSurfaceBudgetController;
    const rasterBufferProfile = getPerformanceProfile();
    const hostResourceProfile = getRawElectronPlatformApi()?.host.getResourceProfile() ?? null;
    const renderConcurrency = resolveDocumentPageSourceRenderConcurrency(
        rasterBufferProfile,
        hostResourceProfile
            ? {
                  logicalCpus: hostResourceProfile.logicalCpus,
                  totalRamBytes: hostResourceProfile.totalRamBytes,
              }
            : typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
              ? {logicalCpus: navigator.hardwareConcurrency}
              : null,
    );
    const source = shallowRef<IDocumentPageSource | null>(null);
    const isLoading = ref(false);
    const pageMetrics = shallowRef<TDocumentPageMetricsCollection>([]);
    const exactPageMetricNumbers = new Set<number>();
    const exactPageMetricLoads = new Map<number, Promise<IDocumentPageMetrics>>();
    const navigationTargetPage = computed(() => {
        const target = chassisAuthority?.openSurface.navigationTicket.value?.request.target;
        return target && 'page' in target ? target.page : null;
    });
    let openJob: TDocumentPageSourceOpenJob | null = null;
    let releaseViewportFeature: (() => void) | null = null;
    let lastProjectedNavigationSignal: AbortSignal | null = null;
    function measureViewport() {
        const container = viewerContainer.value;
        if (!container || container.clientWidth <= 0 || container.clientHeight <= 0) {
            return;
        }
        // A hidden tab has no measurable viewport. Retain its last layout so
        // fit mode cannot collapse the document and clamp its scroll offset.
        containerWidth.value = container.clientWidth;
        containerHeight.value = container.clientHeight;
        viewportScrollTop.value = physicalScroll.origin.value + container.scrollTop;
    }
    useResizeObserver(viewerContainer, measureViewport);
    const pageDisplayLayouts = computed(() =>
        resolveDocumentPageDisplayLayoutsBounded(
            pageMetrics.value,
            Math.max(1, containerHeight.value - DOCUMENT_PAGE_GUTTER_PX * 2),
            Math.max(1, containerWidth.value - DOCUMENT_PAGE_GUTTER_PX * 2),
            clampDocumentManualZoom(props.value.zoom),
            props.value.zoomMode,
            props.value.continuousScroll,
        ),
    );
    const effectiveZoom = computed(
        () => pageDisplayLayouts.value[currentPage.value - 1]?.scale ?? clampDocumentManualZoom(props.value.zoom),
    );
    const handleWheelZoom = createDocumentWheelZoomHandler(effectiveZoom, options.readZoom, {
        beforeZoom: (interaction, packetAt, startsNewSession) =>
            layoutLifecycle.capturePointerAnchor(interaction.event, packetAt, startsNewSession),
        onNonZoom: () => layoutLifecycle.cancelPendingRestore(),
        readSessionKey: () => transitions.loadGeneration.value,
    });
    const cancelWheelInteraction = useDocumentWheelZoomSessionBoundaries({
        isInteractionActive: computed(() => props.value.isInteractionActive),
        reset: () => {
            handleWheelZoom.reset();
            layoutLifecycle.cancelPendingRestore();
        },
    });
    const pageHeights = computed(() => resolveDocumentPageHeightsBounded(pageDisplayLayouts.value));
    const scrollLayout = computed(() => buildDocumentPageSourceScrollLayout(pageHeights.value));
    const pageTops = computed(() => scrollLayout.value.pageTops);
    const totalHeight = computed(() => Math.max(containerHeight.value, getLayoutContentHeight(scrollLayout.value.layout)));
    const physicalSegment = computed(() =>
        props.value.continuousScroll ? getLayoutPhysicalScrollSegment(scrollLayout.value.layout, physicalScroll.origin.value) : null,
    );
    function readLogicalViewport(container: HTMLElement) {
        return {
            clientWidth: container.clientWidth,
            clientHeight: container.clientHeight,
            offsetWidth: container.offsetWidth,
            offsetHeight: container.offsetHeight,
            scrollLeft: container.scrollLeft,
            scrollTop: physicalScroll.origin.value + container.scrollTop,
            scrollWidth: container.scrollWidth,
            scrollHeight: props.value.continuousScroll ? totalHeight.value : container.scrollHeight,
        };
    }
    function applyLogicalScroll(container: HTMLElement, write: Parameters<typeof viewportWritePort.apply>[1], onApplied?: () => void) {
        const fence = transitions.readFence();
        return physicalScroll.apply({
            container,
            port: viewportWritePort,
            write,
            layout: props.value.continuousScroll ? scrollLayout.value.layout : null,
            isCurrent: () => transitions.isCurrent(fence) && viewerContainer.value === container,
            onApplied: () => {
                measureViewport();
                scheduleRender.schedule();
                onApplied?.();
            },
        });
    }
    const pageLayouts = computed(() =>
        resolveDocumentPageLayoutsBounded(pageDisplayLayouts.value, pageTops.value, props.value.continuousScroll),
    );
    const mountedPages = computed(() => {
        const pageCount =
            source.value?.pageCount ??
            chassisAuthority?.openSurface.snapshot.value.openingPageGeometry?.pageCount ??
            pageMetrics.value.length;
        const viewportPages = props.value.continuousScroll
            ? (resolveDocumentContinuousScrollWindow({
                  currentPage: currentPage.value,
                  geometry: {
                      pageHeights: pageHeights.value,
                      pageTops: pageTops.value,
                      totalHeight: totalHeight.value,
                  },
                  pageGapPx: DOCUMENT_PAGE_GUTTER_PX,
                  pageHeights: pageHeights.value,
                  renderMarginPages: DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS,
                  scrollTop: viewportScrollTop.value,
                  totalPages: pageCount,
                  viewportHeight: containerHeight.value,
                  overscanViewports: 1,
              })?.pageNumbers ?? [])
            : [];
        const pages =
            renderSession?.resolveMountedPages({
                currentPage: navigationTargetPage.value ?? currentPage.value,
                destinationPage:
                    navigationTargetPage.value ??
                    (['opening', 'transitioning'].includes(chassisAuthority?.openSurface.viewportSession.value.lifecycle ?? '')
                        ? chassisAuthority?.openSurface.snapshot.value.openingPageFrame?.pageNumber
                        : undefined),
                maxPages: DOCUMENT_SOURCE_MAX_MOUNTED_PAGES,
                pageCount,
                radius: props.value.continuousScroll ? DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS : 3,
                viewportPages,
            }) ?? [];
        const segment = physicalSegment.value;
        return segment ? pages.filter((page) => page >= segment.firstPage && page <= segment.lastPage) : pages;
    });
    const renderDemand = computed(() =>
        resolveDocumentPageSourceRenderDemand({
            bufferRadius:
                props.value.continuousScroll && effectiveZoom.value < 1
                    ? DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS
                    : rasterBufferProfile.pdfBufferPages,
            continuousScroll: props.value.continuousScroll,
            currentPage: navigationTargetPage.value ?? currentPage.value,
            estimatePagePixels: (pageNumber) => {
                const layout = pageLayouts.value[pageNumber - 1];
                return layout ? layout.width * layout.height * pixelRatio.value ** 2 : 1;
            },
            maxBufferPixels: rasterBufferProfile.maxBufferCanvasPixels,
            maximumResidentPages:
                props.value.continuousScroll && effectiveZoom.value < 1
                    ? DOCUMENT_SOURCE_CONTINUOUS_MAX_RESIDENT_PAGES
                    : DOCUMENT_SOURCE_MAX_RESIDENT_PAGES,
            minimumBufferPages: props.value.continuousScroll && effectiveZoom.value < 1 ? DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS : 2,
            preferredDirection: viewportScrollDirection.value,
            mountedPages: mountedPages.value,
            pageCount: source.value?.pageCount ?? pageMetrics.value.length,
            pageHeights: pageHeights.value,
            pageTops: pageTops.value,
            scrollTop: viewportScrollTop.value,
            viewportHeight: containerHeight.value,
        }),
    );
    const surfaceStyle = computed(() => ({
        height: props.value.continuousScroll ? `${Math.max(1, physicalSegment.value?.height ?? totalHeight.value)}px` : '100%',
    }));
    function resolvePageLeft(pageWidth: number) {
        return resolveDocumentPageLeft(containerWidth.value, pageWidth);
    }
    const zoomAnchorPageLayouts = computed(() => resolveDocumentPageZoomAnchorLayoutsBounded(pageLayouts.value, resolvePageLeft));
    let modeTransitionPreferredPageIndex: number | null = null;
    watch(
        () => [props.value.continuousScroll, currentPage.value, props.value.documentRevisionToken ?? props.value.src] as const,
        ([continuousScroll, _currentPage, sourceIdentity], previous) => {
            if (!previous) {
                return;
            }
            if (sourceIdentity !== previous[2]) {
                modeTransitionPreferredPageIndex = null;
                return;
            }
            if (continuousScroll !== previous[0]) {
                modeTransitionPreferredPageIndex = continuousScroll ? Math.max(0, previous[1] - 1) : null;
            }
        },
        {flush: 'sync'},
    );
    function getPageStyle(pageNumber: number) {
        const layout = pageLayouts.value[pageNumber - 1];
        if (!layout) {
            return {};
        }
        return {
            width: `${String(layout.width)}px`,
            height: `${String(layout.height)}px`,
            top: `${String(
                props.value.continuousScroll
                    ? (pageTops.value[pageNumber - 1] ?? DOCUMENT_PAGE_GUTTER_PX) - physicalScroll.origin.value
                    : DOCUMENT_PAGE_GUTTER_PX,
            )}px`,
            left: `${String(resolvePageLeft(layout.width))}px`,
            display: !props.value.continuousScroll && pageNumber !== currentPage.value ? 'none' : undefined,
        };
    }
    function getChassisOpeningShellTarget(pageNumber: number) {
        const authority = chassisAuthority;
        if (!authority) {
            return null;
        }
        const snapshot = authority.openSurface.snapshot.value;
        const frame = snapshot?.openingPageFrame;
        if (!frame) {
            return null;
        }
        const target = authority.openingPageElement.value;
        return frame.generation === snapshot.generation &&
            frame.pageNumber === pageNumber &&
            frame.pageNumber === authority.openSurface.viewportSession.value.requestedPage &&
            target?.isConnected &&
            target.dataset.pageNumber === String(pageNumber) &&
            target.dataset.openSurfaceGeneration === String(snapshot.generation) &&
            target.dataset.openSurfaceFrameOwner === frame.ownerId
            ? target
            : null;
    }
    function setPageElement(pageNumber: number, element: TDocumentPageElement) {
        if (element instanceof HTMLElement) {
            pageSlots?.markMounted(pageNumber);
        } else {
            pageSlots?.markUnmounted(pageNumber);
        }
    }
    let chassisOpeningSlotPage: number | null = null;
    watch(
        () =>
            [
                chassisAuthority?.openingPageElement.value ?? null,
                chassisAuthority?.openSurface.snapshot.value.openingPageFrame?.pageNumber ?? null,
                chassisAuthority?.openSurface.snapshot.value.generation ?? null,
            ] as const,
        ([_target, pageNumber, _generation]) => {
            const ownedTarget = pageNumber === null ? null : getChassisOpeningShellTarget(pageNumber);
            if (chassisOpeningSlotPage !== null && (!ownedTarget || chassisOpeningSlotPage !== pageNumber)) {
                pageSlots?.markUnmounted(chassisOpeningSlotPage);
                chassisOpeningSlotPage = null;
            }
            if (!ownedTarget || pageNumber === null || chassisOpeningSlotPage === pageNumber) {
                return;
            }
            pageSlots?.markMounted(pageNumber);
            chassisOpeningSlotPage = pageNumber;
        },
        {
            flush: 'post',
            immediate: true,
        },
    );
    const metricPublication = createDocumentPageMetricPublication({
        readMetrics: () => pageMetrics.value,
        commitMetrics: (metrics) =>
            layoutLifecycle.preserveLayoutMutation(() => {
                pageMetrics.value = metrics;
                triggerRef(pageMetrics);
            }),
        onPublished: () => scheduleRender.schedule(),
    });
    function ensureExactPageMetric(
        activeSource: IDocumentPageSource,
        generation: number,
        pageNumber: number,
        signal: AbortSignal,
        isCurrent: () => boolean,
    ) {
        const exactMetric = pageMetrics.value[pageNumber - 1];
        if (exactPageMetricNumbers.has(pageNumber) && exactMetric) {
            return Promise.resolve(exactMetric);
        }
        const pendingMetric = exactPageMetricLoads.get(pageNumber);
        if (pendingMetric) {
            return pendingMetric;
        }
        const metricLoad = loadInitialDocumentPageMetric(activeSource, pageNumber, signal)
            .then((metric) => {
                if (isCurrent() && source.value === activeSource && pageNumber >= 1 && pageNumber <= activeSource.pageCount) {
                    metricPublication.enqueue(pageNumber, metric);
                    exactPageMetricNumbers.add(pageNumber);
                }
                return metric;
            })
            .finally(() => {
                if (exactPageMetricLoads.get(pageNumber) === metricLoad) {
                    exactPageMetricLoads.delete(pageNumber);
                }
            });
        exactPageMetricLoads.set(pageNumber, metricLoad);
        return metricLoad;
    }
    const transitions = createDocumentPageSourceLifecycle({
        chassisAuthority,
        readIsActive: () => props.value.isActive,
        readRevisionToken: () => props.value.documentRevisionToken ?? null,
        readSrc: () => props.value.src,
    });
    const {t} = useTypedI18n();
    const presentation = createDocumentPageSourcePresentation({
        t,
        chassisAuthority,
        emit,
        ensureExactPageMetric,
        flushMetricPublication: metricPublication.flush,
        getOpeningTarget: getChassisOpeningShellTarget,
        isFenceCurrent: transitions.isCurrent,
        openSurfaceRenderOwner,
        readContinuousScroll: () => props.value.continuousScroll,
        readCurrentPage: () => currentPage.value,
        readFence: transitions.readFence,
        readIsActive: () => props.value.isActive,
        readOpenJob: () => openJob,
        readMetric: (pageNumber) => pageMetrics.value[pageNumber - 1],
        readPageScale: (pageNumber) => pageDisplayLayouts.value[pageNumber - 1]?.scale ?? effectiveZoom.value,
        readPixelRatio: () => pixelRatio.value,
        readRenderDemand: () => renderDemand.value,
        readSource: () => source.value,
        readViewport: () => viewerContainer.value,
        readViewportScrollDirection: () => viewportScrollDirection.value,
        renderSession,
        scheduleRender: () => scheduleRender.schedule(),
    });
    const activeRenderCounts = new Map<number, number>();
    const activeRenderPromises = new Set<Promise<void>>();
    function needsPageRender(pageNumber: number) {
        const state = presentation.pageStates.get(pageNumber);
        if (state?.error || (state?.lease && state.retryCount > 2)) {
            return false;
        }
        const metric = pageMetrics.value[pageNumber - 1];
        return (
            !state?.lease ||
            !state.ready ||
            !metric ||
            state.widthPx !==
                resolveDocumentPageSourceRenderWidthPx(
                    metric,
                    pageDisplayLayouts.value[pageNumber - 1]?.scale ?? effectiveZoom.value,
                    pixelRatio.value,
                )
        );
    }
    function trackRenderSlot(pageNumber: number, run: () => Promise<void>) {
        activeRenderCounts.set(pageNumber, (activeRenderCounts.get(pageNumber) ?? 0) + 1);
        const task = run().finally(() => {
            activeRenderPromises.delete(task);
            const remaining = (activeRenderCounts.get(pageNumber) ?? 1) - 1;
            if (remaining <= 0) {
                activeRenderCounts.delete(pageNumber);
            } else {
                activeRenderCounts.set(pageNumber, remaining);
            }
            if (
                !presentation.renderControllers.has(pageNumber) &&
                props.value.isActive &&
                source.value &&
                renderDemand.value.residentPages.some(
                    (candidate) =>
                        mountedPages.value.includes(candidate) &&
                        !presentation.renderControllers.has(candidate) &&
                        !activeRenderCounts.has(candidate) &&
                        needsPageRender(candidate),
                )
            ) {
                scheduleRender.schedule();
            }
        });
        activeRenderPromises.add(task);
        return task;
    }
    function renderPage(pageNumber: number) {
        return trackRenderSlot(pageNumber, () => presentation.renderPage(pageNumber));
    }
    async function waitForRenderSlot(isCurrent: () => boolean) {
        while (isCurrent() && activeRenderCounts.size >= renderConcurrency && activeRenderPromises.size > 0) {
            await Promise.race(activeRenderPromises);
        }
    }
    async function renderMountedPages() {
        if (props.value.isResizing || layoutLifecycle.isResizeTransitionActive.value) {
            return;
        }
        await nextTick();
        const inFlightPages = [...new Set([...presentation.renderControllers.keys(), ...activeRenderCounts.keys()])];
        const renderQueue = resolveDocumentPageSourceRenderQueue({
            bufferPages: renderDemand.value.bufferPages,
            concurrency: renderConcurrency,
            currentPage: navigationTargetPage.value ?? currentPage.value,
            guardRadius: DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS,
            inFlightPages,
            mountedPages: mountedPages.value,
            needsRender: needsPageRender,
            preferredDirection: viewportScrollDirection.value,
            residentPages: renderDemand.value.residentPages,
            visiblePages: renderDemand.value.visiblePages,
        });
        renderQueue.pagesToAbort.forEach((pageNumber) => presentation.renderControllers.get(pageNumber)?.abort());
        await Promise.all(renderQueue.pagesToRender.map(renderPage));
    }
    const scheduleRender = createRafCoalescedCallback(() => void renderMountedPages());
    const captureLayoutRestoreEpoch = () =>
        `${String(chassisAuthority?.openSurface.snapshot.value.generation ?? null)}:${String(viewportWritePort.getInteractionEpoch())}`;
    const layoutLifecycle = useDocumentViewportLayoutLifecycle({
        viewerContainer,
        pageLayouts: zoomAnchorPageLayouts,
        readViewport: readLogicalViewport,
        capturePageIndex: () => {
            const preferredPageIndex = modeTransitionPreferredPageIndex;
            modeTransitionPreferredPageIndex = null;
            // A single-page view shows one page: a navigation's target before its ready edge names it.
            return (
                preferredPageIndex ??
                (props.value.continuousScroll ? null : Math.max(0, (navigationTargetPage.value ?? currentPage.value) - 1))
            );
        },
        isResizing: computed(() => props.value.isResizing),
        captureRestoreEpoch: captureLayoutRestoreEpoch,
        // A tab being shown is active one flush before it has a box. That box
        // reads offset 0, so it can neither tell nor take the reader's point.
        canRestore: (epoch) =>
            epoch === captureLayoutRestoreEpoch() &&
            (viewerContainer.value?.clientHeight ?? 0) > 0 &&
            (!chassisAuthority ||
                (props.value.isActive &&
                    shouldProjectDocumentViewportScroll(
                        chassisAuthority.openSurface.snapshot.value,
                        chassisAuthority.openSurface.viewportSession.value,
                    ))),
        applyRestoredScroll: (restored, onApplied) => {
            const container = viewerContainer.value;
            return (
                container !== null &&
                applyLogicalScroll(
                    container,
                    {
                        intent: viewportWritePort.beginIntent(`page-source-zoom-anchor:${String(transitions.loadGeneration.value)}`),
                        reason: 'zoom-anchor-restoration',
                        ...restored,
                        left: props.value.continuousScroll && props.value.zoomMode === 'fit-width' ? container.scrollLeft : restored.left,
                    },
                    onApplied,
                )
            );
        },
        onResizeSettled: () => scheduleRender.schedule(),
    });
    function handleScroll(event?: Event) {
        if (
            !viewerContainer.value ||
            viewerContainer.value.clientWidth <= 0 ||
            viewerContainer.value.clientHeight <= 0 ||
            props.value.isResizing ||
            layoutLifecycle.isResizeTransitionActive.value
        ) {
            return;
        }
        // Widening the window clamps the offset and reports that scroll before
        // ResizeObserver reports the resize. Measure the resize first, so the
        // layout lifecycle keeps the reader's point rather than the clamped one.
        if (viewerContainer.value.clientWidth !== containerWidth.value || viewerContainer.value.clientHeight !== containerHeight.value) {
            measureViewport();
            return;
        }
        const nextScrollTop = physicalScroll.origin.value + viewerContainer.value.scrollTop;
        const scrollDelta = nextScrollTop - viewportScrollTop.value;
        if (Math.abs(scrollDelta) > 1) {
            viewportScrollDirection.value = scrollDelta > 0 ? 1 : -1;
        }
        viewportScrollTop.value = nextScrollTop;
        scheduleRender.schedule();
        const consumedAuthorityScroll = viewportWritePort.consumeAuthorityScroll(viewerContainer.value);
        if (consumedAuthorityScroll) {
            // The echo of an authored write: its placement already committed the point.
            const viewportSession = chassisAuthority?.openSurface.viewportSession.value;
            if (viewportSession && viewportSession.requestedPage !== currentPage.value) {
                // The scroll event can be delivered after the authored offset
                // lands but before the shared navigation ready edge publishes
                // its semantic page. Do not derive a center page from that
                // provisional offset: it can overwrite the command target
                // while the viewport is still settling.
                return;
            }
            const hasStableCommittedPage =
                viewportSession?.lifecycle === 'ready' &&
                viewportSession.requestedPage === viewportSession.committedPage &&
                viewportSession.requestedPage === currentPage.value;
            if (!hasStableCommittedPage) {
                syncCurrentPageFromViewport();
            }
            return;
        }
        if (layoutLifecycle.hasPendingPointerRestore()) {
            return;
        }
        if (chassisAuthority && event?.isTrusted !== true) {
            return;
        }
        if (viewportWritePort.isCommandResidueLive()) {
            // The compositor can apply one more inertial delta before scroll
            // suppression reaches it. That offset belongs to the superseded
            // gesture, so it must not invalidate the command's pending write
            // or move the reading point the write port is about to repair.
            return;
        }
        layoutLifecycle.cancelPendingRestore();
        viewportWritePort.observeUserScroll(viewerContainer.value);
        const navigationTicket = chassisAuthority?.navigationTicket.value;
        if (navigationTicket) {
            chassisAuthority.openSurface.reportNavigation(navigationTicket, {
                kind: 'abandoned',
                by: 'user-input',
            });
        }
        layoutLifecycle.commitReadingPoint();
        if (
            resolveLayoutPhysicalScrollOrigin(
                scrollLayout.value.layout,
                nextScrollTop,
                viewerContainer.value.clientHeight,
                physicalScroll.origin.value,
            ) !== physicalScroll.origin.value
        ) {
            applyLogicalScroll(
                viewerContainer.value,
                {
                    intent: viewportWritePort.beginIntent('page-source-scroll-segment'),
                    reason: 'page-source-scroll-segment',
                    top: nextScrollTop,
                },
                syncCurrentPageFromViewport,
            );
            return;
        }
        syncCurrentPageFromViewport();
    }
    function syncCurrentPageFromViewport(forceProjection = false) {
        const container = viewerContainer.value;
        if (!container || container.clientWidth <= 0 || container.clientHeight <= 0 || !props.value.continuousScroll) {
            return;
        }
        const viewportSession = chassisAuthority?.openSurface.viewportSession.value;
        if (
            viewportSession?.lifecycle === 'ready' &&
            viewportSession.requestedPage === viewportSession.committedPage &&
            (viewportSession.observedPage === null || viewportSession.observedPage === viewportSession.requestedPage) &&
            viewportSession.requestedPage !== currentPage.value
        ) {
            // A command may have committed its authored offset before the
            // surface names its page here. Preserve that shared semantic
            // target instead of interpreting the command offset as a
            // user-centered page.
            return;
        }
        const totalPages =
            source.value?.pageCount ??
            chassisAuthority?.openSurface.snapshot.value.openingPageGeometry?.pageCount ??
            pageMetrics.value.length;
        const visiblePage = resolveDocumentVisiblePageForIndicator({
            currentPage: currentPage.value,
            pageLayouts: zoomAnchorPageLayouts.value,
            scrollLeft: container.scrollLeft,
            scrollTop: physicalScroll.origin.value + container.scrollTop,
            totalPages,
            viewportHeight: container.clientHeight,
            viewportWidth: container.clientWidth,
        });
        if (visiblePage && (forceProjection || visiblePage !== currentPage.value)) {
            chassisAuthority?.observePage(visiblePage);
        }
    }
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
            // A navigation scroll can arrive before the target render commits.
            // The navigation fence correctly rejects that early page projection,
            // so reconcile once the viewport session reaches its ready boundary.
            if (viewportSession[0] === 'ready' && previousViewportSession?.[0] !== 'ready') {
                const semanticPage = chassisAuthority
                    ? resolveDocumentPageSourceReadyEdgeSemanticPage(chassisAuthority.openSurface.viewportSession.value)
                    : null;
                // The target render and viewport have just crossed their
                // ready fence. Its physical offset may still reflect
                // provisional geometry, so keep the committed semantic page
                // until trusted input records an observation.
                if (semanticPage === null) {
                    syncCurrentPageFromViewport(true);
                }
            }
        },
        {
            flush: 'sync',
            immediate: true,
        },
    );
    function handleWheel(interaction: IDocumentWheelInteraction) {
        if (handleWheelZoom(interaction) || interaction.intent === 'platform-scroll') {
            return;
        }
        const target = pagedWheelNavigation.handle(
            interaction.event,
            {
                container: viewerContainer.value,
                continuousScroll: props.value.continuousScroll,
                currentPage: currentPage.value,
                pageCount: source.value?.pageCount ?? 0,
                pageHeights: pageHeights.value,
                viewMode: props.value.viewMode,
            },
            interaction.deltaPx,
        );
        if (target !== null) {
            scrollToPage(target, {
                navigationSource: 'wheel',
                alignPageBottom: interaction.deltaPx < 0,
            });
        }
    }
    function scrollToPage(
        pageNumber: number,
        options: Parameters<IDocumentViewerExpose['scrollToPage']>[1] = {},
        existingTicket?: IDocumentNavigationTicket,
    ) {
        if (options.navigationSource !== 'wheel') {
            pagedWheelNavigation.reset();
        }
        const normalized = Math.max(1, Math.min(source.value?.pageCount ?? 1, Math.trunc(pageNumber)));
        // A page-source view lands on a page's top or, turning back by wheel, its bottom.
        const request: IDocumentNavigationRequest = {
            ...createPageNavigationRequest(normalized, options.navigationSource ?? 'toolbar'),
            alignment: options.alignPageBottom ? 'page-bottom' : 'page-top',
        };
        const ticket = existingTicket ?? chassisAuthority?.navigate(request) ?? null;
        if (ticket) {
            lastProjectedNavigationSignal = ticket.signal;
        }
        const requestedTargetPage = ticket?.request.target && 'page' in ticket.request.target ? ticket.request.target.page : normalized;
        const targetPage = Math.max(1, Math.min(source.value?.pageCount ?? normalized, Math.trunc(requestedTargetPage)));
        physicalScroll.place(
            props.value.continuousScroll ? scrollLayout.value.layout : null,
            Math.max(0, (pageTops.value[targetPage - 1] ?? DOCUMENT_PAGE_GUTTER_PX) - DOCUMENT_PAGE_GUTTER_PX),
            containerHeight.value,
        );
        const readyState = presentation.pageStates.get(normalized);
        const intent = chassisAuthority?.viewportWritePort.beginIntent(
            `page-source-navigation:${String(targetPage)}:${String(transitions.loadGeneration.value)}`,
        );
        const activeSource = source.value;
        const signal = openJob?.abort.signal;
        const metricFence = transitions.readFence();
        if (activeSource && signal && !exactPageMetricNumbers.has(targetPage)) {
            void ensureExactPageMetric(activeSource, metricFence.loadGeneration, targetPage, signal, () =>
                transitions.isCurrent(metricFence),
            )
                .then(() => scheduleRender.schedule())
                .catch((error: unknown) => {
                    if (
                        transitions.isCurrent(metricFence) &&
                        props.value.isActive &&
                        source.value === activeSource &&
                        !signal.aborted &&
                        !isAbortError(error)
                    ) {
                        const message = presentation.commitTerminalError(targetPage, error);
                        if (targetPage === currentPage.value) {
                            emit('loadError', error instanceof Error ? error : presentation.createFailureError(targetPage, message));
                        }
                    }
                });
        }
        void nextTick(() => {
            if (viewerContainer.value) {
                if (!intent) {
                    return;
                }
                if (ticket && !chassisAuthority?.openSurface.isNavigationCurrent(ticket)) {
                    return;
                }
                const anchor = ticket?.request.target.kind === 'page' ? ticket.request.target.anchor : null;
                const container = viewerContainer.value;
                const arrived = readArrivedViewportClientSize(container);
                const restored = anchor
                    ? resolveDocumentZoomAnchorScroll(
                          {
                              clientWidth: arrived.width,
                              clientHeight: arrived.height,
                              scrollLeft: container.scrollLeft,
                              scrollTop: physicalScroll.origin.value + container.scrollTop,
                          },
                          zoomAnchorPageLayouts.value,
                          {
                              pageIndex: targetPage - 1,
                              xRatio: anchor.pageXFraction,
                              yRatio: anchor.pageYFraction,
                              viewportXRatio: anchor.viewportXFraction,
                              viewportYRatio: anchor.viewportYFraction,
                          },
                      )
                    : null;
                // Navigation wins over a queued restore: it commits the point the restore places.
                applyLogicalScroll(
                    viewerContainer.value,
                    {
                        intent,
                        reason: 'source-neutral-page-navigation',
                        ...(restored ? {left: restored.left} : {}),
                        top:
                            restored?.top ??
                            (props.value.continuousScroll
                                ? Math.max(0, (pageTops.value[targetPage - 1] ?? DOCUMENT_PAGE_GUTTER_PX) - DOCUMENT_PAGE_GUTTER_PX)
                                : options.alignPageBottom
                                  ? Math.max(
                                        0,
                                        (pageHeights.value[targetPage - 1] ?? 0) +
                                            DOCUMENT_PAGE_GUTTER_PX * 2 -
                                            viewerContainer.value.clientHeight,
                                    )
                                  : 0),
                    },
                    layoutLifecycle.commitReadingPoint,
                );
            }
            // Place the physical viewport before publishing an already-painted
            // target. Otherwise the ready callback can report arrival first,
            // retire the ticket, and cause this write to be discarded as stale.
            if (readyState?.ready && (!ticket || chassisAuthority?.openSurface.isNavigationCurrent(ticket))) {
                presentation.commitReady(normalized, readyState);
            }
            scheduleRender.schedule();
        });
    }
    watch(
        () =>
            [chassisAuthority?.openSurface.navigationTicket.value ?? null, source.value, pageMetrics.value, viewerContainer.value] as const,
        ([ticket, activeSource, metrics, container]) => {
            if (
                !ticket ||
                !activeSource ||
                metrics.length !== activeSource.pageCount ||
                !container ||
                lastProjectedNavigationSignal === ticket.signal ||
                !('page' in ticket.request.target)
            ) {
                return;
            }
            scrollToPage(ticket.request.target.page, undefined, ticket);
        },
        {
            flush: 'post',
            immediate: true,
        },
    );
    const {start: scheduleInactiveLeaseRelease, stop: cancelInactiveLeaseRelease} = useTimeoutFn(
        (retainedPageNumber: number, retainedLease: unknown) => {
            if (!props.value.isActive && presentation.pageStates.get(retainedPageNumber)?.lease === retainedLease) {
                presentation.releasePage(retainedPageNumber);
            }
        },
        DOCUMENT_SOURCE_INACTIVE_LEASE_GRACE_MS,
        {immediate: false},
    );
    function releaseInactivePageStates() {
        cancelInactiveLeaseRelease();
        const retainCurrentPage = shouldRetainInactiveDocumentPageSourceLease(
            resolveOpenPathSecondaryPerformancePolicy(rasterBufferProfile).inactiveDjvuLeasePolicy === 'warm-grace',
            surfaceBudget.getSnapshot().pressureLevel,
        );
        const retainedPageNumber = retainCurrentPage ? currentPage.value : null;
        for (const pageNumber of [...presentation.pageStates.keys()]) {
            if (pageNumber === retainedPageNumber) {
                continue;
            }
            presentation.releasePage(pageNumber);
        }
        const retainedState = retainedPageNumber === null ? null : presentation.pageStates.get(retainedPageNumber);
        const retainedLease = retainedState?.lease;
        if (retainedPageNumber === null || !retainedState || !retainedLease) {
            return;
        }
        retainedLease.setPriority?.('prefetch');
        retainedState.priority = 'prefetch';
        scheduleInactiveLeaseRelease(retainedPageNumber, retainedLease);
    }
    function seedOpeningPageMetrics() {
        const geometry = chassisAuthority?.openSurface.snapshot.value.openingPageGeometry;
        if (!geometry) {
            return false;
        }
        pageMetrics.value = createProvisionalDocumentPageMetrics(geometry.pageCount, {
            widthPoints: geometry.width,
            heightPoints: geometry.height,
            rotation: geometry.rotation as IDocumentPageMetrics['rotation'],
        });
        emit('update:totalPages', geometry.pageCount);
        return true;
    }
    async function applyOpenTransition(transition: IDocumentPageSourceTransition) {
        const documentRef = transition.fence.src;
        const openingTicket = chassisAuthority?.openSurface.navigationTicket.value;
        layoutLifecycle.resetReadingPoint();
        pagedWheelNavigation.reset();
        openJob?.abort.abort();
        const job = createDocumentPageSourceOpenJob();
        openJob = job;
        exactPageMetricNumbers.clear();
        exactPageMetricLoads.clear();
        metricPublication.clear();
        presentation.beginSourceGeneration();
        const previousSource = source.value;
        previousSource?.dispose();
        if (chassisAuthority?.source.value === previousSource) {
            chassisAuthority.bindSource(null);
        }
        source.value = null;
        physicalScroll.place(null, 0, 0);
        if (!seedOpeningPageMetrics()) {
            pageMetrics.value = documentRef ? createColdOpenProvisionalDocumentPageMetrics(Math.max(1, Math.trunc(currentPage.value))) : [];
        }
        isLoading.value = Boolean(documentRef);
        if (!documentRef) {
            emit('update:totalPages', 0);
            job.settleVisual(false);
            return;
        }
        const opened = await openDocumentPageSource(transition, {
            chassisAuthority,
            commitPageTerminalError: presentation.commitTerminalError,
            createPageFailureError: presentation.createFailureError,
            emit,
            isLoading,
            ensureExactPageMetric,
            layoutLifecycle,
            loadController: job.abort,
            markExactPageMetric: (pageNumber) => exactPageMetricNumbers.add(pageNumber),
            measureViewport,
            openingPageFrameOwnerId,
            publishPageMetrics: (metrics) => {
                pageMetrics.value = metrics;
            },
            readCurrentPage: () => currentPage.value,
            getPriorityPages: () => {
                const demand = renderDemand.value;
                return [...new Set([...demand.visiblePages, ...demand.bufferPages, ...demand.residentPages, currentPage.value])];
            },
            readPageMetric: (pageNumber) => pageMetrics.value[pageNumber - 1],
            readPolicy: () => ({
                continuousScroll: props.value.continuousScroll,
                zoom: props.value.zoom,
                zoomMode: props.value.zoomMode,
            }),
            readViewport: () => viewerContainer.value,
            renderPage,
            scheduleRender: scheduleRender.schedule,
            positionPage: (page) => {
                if (!chassisAuthority?.openSurface.navigationTicket.value) {
                    scrollToPage(page, {navigationSource: 'restore'});
                }
            },
            setSource: (nextSource) => {
                source.value = nextSource;
            },
            surfaceBudget,
        });
        if (opened && transition.isCurrent()) {
            scheduleRender.schedule();
            presentation.settleUncommittedVisual(job, openingTicket);
            await job.visual;
        } else {
            job.settleVisual(false);
        }
    }
    function applySuspendTransition() {
        layoutLifecycle.suspend();
        scheduleRender.cancel();
        presentation.renderControllers.forEach((controller) => controller.abort());
        presentation.renderControllers.clear();
        releaseInactivePageStates();
    }
    function applyRestoreTransition(transition: IDocumentPageSourceTransition) {
        cancelInactiveLeaseRelease();
        const retainedState = presentation.pageStates.get(currentPage.value);
        retainedState?.lease?.setPriority?.('navigation');
        if (retainedState?.lease) {
            retainedState.priority = 'navigation';
        }
        void (async () => {
            await waitForRenderSlot(transition.isCurrent);
            if (!transition.isCurrent()) {
                return;
            }
            await trackRenderSlot(currentPage.value, () =>
                presentation.restore(transition, {
                    measureViewport,
                    renderMountedPages: () => Promise.resolve(),
                    restoreViewport: layoutLifecycle.resume,
                }),
            );
            if (transition.isCurrent()) {
                await renderMountedPages();
            }
        })();
    }
    // Opening geometry the host commits before this source is acquired seeds the cold page metrics.
    watch(
        () => chassisAuthority?.openSurface.snapshot.value.openingPageGeometry ?? null,
        (geometry) => {
            if (geometry && !source.value) {
                seedOpeningPageMetrics();
            }
        },
        {immediate: true},
    );
    transitions.channel.subscribe((transition) => {
        switch (transition.kind) {
            case 'open':
                return applyOpenTransition(transition);
            case 'invalidate':
                return applySuspendTransition();
            case 'restore':
                return applyRestoreTransition(transition);
            case 'settle':
                scheduleRender.schedule();
        }
    });
    transitions.start();
    function retainOnlyPageStates(pages: readonly number[]) {
        if (props.value.isResizing || layoutLifecycle.isResizeTransitionActive.value) {
            return;
        }
        const retainedPages = new Set(pages);
        for (const pageNumber of presentation.pageStates.keys()) {
            if (!retainedPages.has(pageNumber)) {
                presentation.releasePage(pageNumber);
            }
        }
        scheduleRender.schedule();
    }
    watch([() => renderDemand.value.residentPages, pixelRatio], ([pages]) => retainOnlyPageStates(pages));
    onMounted(() => {
        viewerContainer.value = chassisAuthority?.viewportElement.value ?? null;
        measureViewport();
        releaseViewportFeature =
            chassisAuthority?.bindViewportFeature({
                getClass: () => 'document-viewer-viewport document-source-viewer app-scrollbar',
                getStyle: () => ({}),
                events: {
                    mousedown: cancelWheelInteraction,
                    scroll: (event) => handleScroll(event),
                },
                wheel: handleWheel,
            }) ?? null;
    });
    onBeforeUnmount(() => {
        transitions.dispose();
        cancelInactiveLeaseRelease();
        releaseViewportFeature?.();
        scheduleRender.cancel();
        metricPublication.clear();
        renderSession?.dispose();
        if (chassisOpeningSlotPage !== null) {
            pageSlots?.markUnmounted(chassisOpeningSlotPage);
            chassisOpeningSlotPage = null;
        }
        openJob?.abort.abort();
        const activeSource = source.value;
        activeSource?.dispose();
        if (chassisAuthority?.source.value === activeSource) {
            chassisAuthority.bindSource(null);
        }
        presentation.dispose();
        if (!chassisAuthority) {
            viewportWritePort.retire();
        }
    });
    return {
        activeOpenSurfaceGeneration: transitions.openSurfaceGeneration,
        getChassisOpeningShellTarget,
        getPageStyle,
        presentation,
        loadGeneration: transitions.loadGeneration,
        mountedPages,
        pageLayouts,
        setPageElement,
        surfaceStyle,
        viewerExpose: {
            getViewerContainer: () => viewerContainer.value,
            getEffectiveZoom: () => effectiveZoom.value,
            getCurrentPage: () => currentPage.value,
            isDocumentLoading: () => isLoading.value,
            scrollToPage,
            // A box the ResizeObserver has not delivered yet is measured now;
            // the layout watcher then queues its restore in the next flush. An
            // unchanged, hidden or closed view has no restore to wait for.
            whenLayoutPlaced: async () => {
                if (!props.value.isActive) {
                    return;
                }
                measureViewport();
                await nextTick();
                await layoutLifecycle.whenRestored();
            },
            captureReadingAnchor: (): IPdfSemanticAnchor | null => {
                const anchor = layoutLifecycle.readReadingPoint();
                return anchor
                    ? {
                          page: anchor.pageIndex + 1,
                          pageXFraction: clamp(anchor.xRatio, 0, 1),
                          pageYFraction: clamp(anchor.yRatio, 0, 1),
                          viewportXFraction: anchor.viewportXRatio ?? 0.5,
                          viewportYFraction: anchor.viewportYRatio ?? 0.5,
                          affinity: 'center',
                      }
                    : null;
            },
        } satisfies IDocumentViewerExpose & {isDocumentLoading: () => boolean},
    };
};
