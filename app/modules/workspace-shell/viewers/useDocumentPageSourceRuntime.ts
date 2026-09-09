import { useResizeObserver } from '@vueuse/core';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';
import type {
    IDocumentPageMetrics,
    IDocumentPageSource,
} from '@app/utils/document-viewer/source/documentPageSource';
import { createRafCoalescedCallback } from '@app/utils/createRafCoalescedCallback';
import { workspaceSurfaceBudgetController } from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';
import type { TWorkspaceResourcePressureLevel } from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';
import { injectDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { shouldProjectDocumentViewportScroll } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type { IDocumentViewportSessionState } from '@app/utils/document-viewer/chassis/documentOpenSurfaceReducer';
import { createDocumentViewportWritePort } from '@app/utils/document-viewer/chassis/documentViewportWritePort';
import {
    createColdOpenProvisionalDocumentPageMetrics,
    createProvisionalDocumentPageMetrics,
    isSparseDocumentPageMetrics,
    loadInitialDocumentPageMetric,
    type TDocumentPageMetricsCollection,
} from '@app/modules/workspace-shell/viewers/loadPrioritizedDocumentPageMetrics';
import { clampDocumentManualZoom } from '@app/utils/document-viewer/zoomPolicy';
import {
    resolveDocumentPageDisplayLayouts,
    resolveDocumentPageDisplayScale,
    type IDocumentPageDisplayLayout,
} from '@app/utils/document-viewer/layout/resolveDocumentPageDisplayLayout';
import {
    createLazyIndexedCollection,
    isLazyIndexedCollection,
    type ILazyIndexedCollection,
} from '@app/utils/document-viewer/virtualization/pageVirtualization';
import {
    resolveNearestDocumentPageToViewportCenter,
    resolveDocumentContinuousScrollWindow,
} from '@app/utils/document-viewer/viewport/resolveDocumentContinuousScrollWindow';
import { DOCUMENT_PAGE_GUTTER_PX } from '@app/utils/document-viewer/layout/documentPageGutterPx';
import type { IDocumentZoomPageLayout } from '@app/utils/document-viewer/zoomAnchor';
import { resolveDocumentPageSourceRenderDemand } from '@app/modules/workspace-shell/viewers/resolveDocumentPageSourceRenderDemand';
import { resolveDocumentPageSourceRenderQueue } from '@app/modules/workspace-shell/viewers/resolveDocumentPageSourceRenderQueue';
import {
    createDocumentPageSourcePresentation,
    resolveDocumentPageSourceRenderWidthPx,
} from '@app/modules/workspace-shell/viewers/documentPageSourcePresentation';
import { useDocumentViewportLayoutLifecycle } from '@app/utils/document-viewer/lifecycle/useDocumentViewportLayoutLifecycle';
import { createPageSourcePagedWheelNavigation } from '@app/modules/workspace-shell/viewers/createPageSourcePagedWheelNavigation';
import { createDocumentPageMetricPublication } from '@app/modules/workspace-shell/viewers/createDocumentPageMetricPublication';
import {
    createDocumentWheelZoomHandler,
    type IDocumentWheelInteraction,
} from '@app/utils/document-viewer/input/documentWheelInteraction';
import { useDocumentWheelZoomSessionBoundaries } from '@app/utils/document-viewer/input/useDocumentWheelZoomSessionBoundaries';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import { resolveOpenPathSecondaryPerformancePolicy } from '@app/utils/openPathSecondaryPerformancePolicy';
import {
    createDocumentPageSourceLifecycle,
    type IDocumentPageSourceTransition,
    openDocumentPageSource,
    type IDocumentPageSourceFeaturePackEmit,
    type TDocumentPageElement,
    type TDocumentPageSourceRuntimeProps,
} from '@app/modules/workspace-shell/viewers/documentPageSourceFeaturePackState';
const DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS = 12;
const DOCUMENT_SOURCE_MAX_MOUNTED_PAGES = 40;
const DOCUMENT_SOURCE_MAX_RESIDENT_PAGES = 5;
const DOCUMENT_SOURCE_RENDER_CONCURRENCY = 2;
const DOCUMENT_SOURCE_LAYOUT_CHUNK_SIZE = 256;
const DOCUMENT_SOURCE_LAYOUT_MAX_CACHED_CHUNKS = 32;
export const DOCUMENT_SOURCE_INACTIVE_LEASE_GRACE_MS = 1_500;

interface IDocumentPageSourceCollectionMetadata<T> {
    readonly estimateValue?: (index: number) => T | undefined;
    readonly getKnownIndices?: () => readonly number[];
}
type TDocumentPageSourceLazyCollection<T> = ILazyIndexedCollection<T> & IDocumentPageSourceCollectionMetadata<T>;
type TDocumentPageSourceCollection<T> = T[] | TDocumentPageSourceLazyCollection<T>;

function readDocumentPageSourceCollectionMetadata<T>(
    collection: TDocumentPageSourceCollection<T>,
) {
    if (!isLazyIndexedCollection(collection)) {
        return {} as IDocumentPageSourceCollectionMetadata<T>;
    }
    const lazyCollection = collection;
    return {
        ...(lazyCollection.estimateValue ? {estimateValue: lazyCollection.estimateValue} : {}),
        ...(lazyCollection.getKnownIndices ? {getKnownIndices: lazyCollection.getKnownIndices} : {}),
    } satisfies IDocumentPageSourceCollectionMetadata<T>;
}

function attachDocumentPageSourceCollectionMetadata<T>(
    collection: ILazyIndexedCollection<T>,
    metadata: IDocumentPageSourceCollectionMetadata<T>,
) {
    if (metadata.estimateValue) {
        Object.defineProperty(collection, 'estimateValue', {
            configurable: false,
            enumerable: false,
            value: metadata.estimateValue,
        });
    }
    if (metadata.getKnownIndices) {
        Object.defineProperty(collection, 'getKnownIndices', {
            configurable: false,
            enumerable: false,
            value: metadata.getKnownIndices,
        });
    }
    return collection as TDocumentPageSourceLazyCollection<T>;
}

interface IDocumentPageDisplayLayoutCollection extends ILazyIndexedCollection<IDocumentPageDisplayLayout> {readonly sumHeightRange?: (start: number, end: number) => number;}

interface IDocumentPageHeightCollection extends ILazyIndexedCollection<number> {readonly sumRange?: (start: number, end: number) => number;}

function resolveDocumentPageDisplayLayout(
    metric: IDocumentPageMetrics,
    availableHeight: number,
    availableWidth: number,
    manualZoom: number,
    zoomMode: TDocumentPageSourceRuntimeProps['zoomMode'],
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
) {
    if (!isLazyIndexedCollection(metrics)) {
        return resolveDocumentPageDisplayLayouts({
            availableHeight,
            availableWidth,
            manualZoom,
            pageSizes: metrics.map(metric => ({
                height: metric.heightPoints,
                width: metric.widthPoints,
            })),
            zoomMode,
        });
    }
    const sparseMetrics = isSparseDocumentPageMetrics(metrics) ? metrics : null;
    const displayLayouts = createLazyIndexedCollection({
        cacheValues: false,
        chunkSize: DOCUMENT_SOURCE_LAYOUT_CHUNK_SIZE,
        getValue: index => resolveDocumentPageDisplayLayout(
            metrics.get(index) ?? metrics.fallbackMetric,
            availableHeight,
            availableWidth,
            manualZoom,
            zoomMode,
        ),
        length: metrics.length,
        maxCachedChunks: DOCUMENT_SOURCE_LAYOUT_MAX_CACHED_CHUNKS,
    });
    if (!sparseMetrics) {
        return displayLayouts as TDocumentPageSourceLazyCollection<IDocumentPageDisplayLayout>;
    }
    const sparseLayouts = attachDocumentPageSourceCollectionMetadata(displayLayouts, {
        estimateValue: index => resolveDocumentPageDisplayLayout(
            sparseMetrics.getEstimated(index + 1),
            availableHeight,
            availableWidth,
            manualZoom,
            zoomMode,
        ),
        getKnownIndices: () => sparseMetrics.getExactPageNumbers().map(pageNumber => pageNumber - 1),
    });
    const fallbackLayout = resolveDocumentPageDisplayLayout(metrics.fallbackMetric, availableHeight, availableWidth, manualZoom, zoomMode);
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
            const exactLayout = resolveDocumentPageDisplayLayout(metric, availableHeight, availableWidth, manualZoom, zoomMode);
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
    Object.defineProperty(sparseLayouts, 'sumHeightRange', {
        configurable: false,
        enumerable: false,
        value: (start: number, end: number) => {
            const rangeStart = Math.max(0, Math.min(metrics.length, Math.trunc(start)));
            const rangeEnd = Math.max(rangeStart, Math.min(metrics.length, Math.trunc(end)));
            if (rangeStart >= rangeEnd) {
                return 0;
            }
            ensureHeightCorrections();
            return (rangeEnd - rangeStart) * fallbackLayout.height
                + sumCorrectionsBefore(rangeEnd)
                - sumCorrectionsBefore(rangeStart);
        },
    });
    return sparseLayouts as TDocumentPageSourceLazyCollection<IDocumentPageDisplayLayout> & IDocumentPageDisplayLayoutCollection;
}
function mapDocumentPageSourceCollectionBounded<T, U>(
    collection: TDocumentPageSourceCollection<T>,
    mapValue: (value: T, index: number) => U,
): TDocumentPageSourceCollection<U> {
    if (isLazyIndexedCollection(collection)) {
        const metadata = readDocumentPageSourceCollectionMetadata(collection);
        const estimateValue = metadata.estimateValue;
        const mapped = createLazyIndexedCollection({
            cacheValues: true,
            chunkSize: DOCUMENT_SOURCE_LAYOUT_CHUNK_SIZE,
            getValue: index => mapValue(collection.get(index) as T, index),
            length: collection.length,
            maxCachedChunks: DOCUMENT_SOURCE_LAYOUT_MAX_CACHED_CHUNKS,
        });
        return attachDocumentPageSourceCollectionMetadata(mapped, {
            ...(estimateValue
                ? {estimateValue: index => mapValue(estimateValue(index) as T, index)}
                : {}),
            ...(metadata.getKnownIndices ? {getKnownIndices: metadata.getKnownIndices} : {}),
        });
    }
    return collection.map((value, index) => mapValue(value, index));
}
export function resolveDocumentPageHeightsBounded(
    displayLayouts: TDocumentPageSourceCollection<IDocumentPageDisplayLayout>,
) {
    const heights = mapDocumentPageSourceCollectionBounded(displayLayouts, layout => layout.height);
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
export function resolveDocumentPageTopsBounded(
    heights: TDocumentPageSourceCollection<number>,
) {
    if (!isLazyIndexedCollection(heights)) {
        let top = DOCUMENT_PAGE_GUTTER_PX;
        return heights.map((height) => {
            const value = top;
            top += height + DOCUMENT_PAGE_GUTTER_PX;
            return value;
        });
    }
    const sumRange = (heights as IDocumentPageHeightCollection).sumRange;
    if (sumRange) {
        return createLazyIndexedCollection({
            cacheValues: false,
            chunkSize: DOCUMENT_SOURCE_LAYOUT_CHUNK_SIZE,
            getValue: index => DOCUMENT_PAGE_GUTTER_PX
                + index * DOCUMENT_PAGE_GUTTER_PX
                + sumRange(0, index),
            length: heights.length,
            maxCachedChunks: DOCUMENT_SOURCE_LAYOUT_MAX_CACHED_CHUNKS,
        });
    }
    const metadata = readDocumentPageSourceCollectionMetadata(heights);
    const estimateValue = metadata.estimateValue;
    if (estimateValue) {
        const estimatedHeight = Math.max(0, estimateValue(0) ?? 0);
        let knownIndices: number[] = [];
        let knownIndexCount = -1;
        const resolveKnownIndices = () => {
            const nextKnownIndices = metadata.getKnownIndices?.() ?? [];
            if (nextKnownIndices.length !== knownIndexCount) {
                knownIndices = [...nextKnownIndices]
                    .filter(index => Number.isSafeInteger(index) && index >= 0 && index < heights.length)
                    .sort((left, right) => left - right);
                knownIndexCount = nextKnownIndices.length;
            }
            return knownIndices;
        };
        const resolvePageTop = (index: number) => {
            let top = DOCUMENT_PAGE_GUTTER_PX + index * (estimatedHeight + DOCUMENT_PAGE_GUTTER_PX);
            for (const knownIndex of resolveKnownIndices()) {
                if (knownIndex >= index) {
                    break;
                }
                const exactHeight = Math.max(0, heights[knownIndex] ?? estimatedHeight);
                const knownEstimatedHeight = Math.max(0, estimateValue(knownIndex) ?? estimatedHeight);
                top += exactHeight - knownEstimatedHeight;
            }
            return top;
        };
        return createLazyIndexedCollection({
            cacheValues: false,
            chunkSize: DOCUMENT_SOURCE_LAYOUT_CHUNK_SIZE,
            getValue: resolvePageTop,
            length: heights.length,
            maxCachedChunks: DOCUMENT_SOURCE_LAYOUT_MAX_CACHED_CHUNKS,
        });
    }
    const prefixTops = new Map<number, number>([[
        0,
        DOCUMENT_PAGE_GUTTER_PX,
    ]]);
    const resolvePageTop = (index: number) => {
        const cached = prefixTops.get(index);
        if (cached !== undefined) {
            return cached;
        }
        let nearestIndex = 0;
        let top = DOCUMENT_PAGE_GUTTER_PX;
        for (const [
            cachedIndex,
            cachedTop,
        ] of prefixTops) {
            if (cachedIndex <= index && cachedIndex >= nearestIndex) {
                nearestIndex = cachedIndex;
                top = cachedTop;
            }
        }
        for (let pageIndex = nearestIndex; pageIndex < index; pageIndex += 1) {
            top += (heights[pageIndex] ?? 0) + DOCUMENT_PAGE_GUTTER_PX;
        }
        prefixTops.set(index, top);
        while (prefixTops.size > DOCUMENT_SOURCE_LAYOUT_MAX_CACHED_CHUNKS) {
            const oldest = [...prefixTops.keys()].find(key => key !== 0 && key !== index);
            if (oldest === undefined) {
                break;
            }
            prefixTops.delete(oldest);
        }
        return top;
    };
    return createLazyIndexedCollection({
        cacheValues: false,
        chunkSize: DOCUMENT_SOURCE_LAYOUT_CHUNK_SIZE,
        getValue: resolvePageTop,
        length: heights.length,
        maxCachedChunks: DOCUMENT_SOURCE_LAYOUT_MAX_CACHED_CHUNKS,
    });
}
export function resolveDocumentPageLayoutsBounded(
    displayLayouts: TDocumentPageSourceCollection<IDocumentPageDisplayLayout>,
    pageTops: TDocumentPageSourceCollection<number>,
    continuousScroll: boolean,
) {
    return mapDocumentPageSourceCollectionBounded(displayLayouts, (layout, index) => ({
        top: continuousScroll
            ? pageTops[index] ?? DOCUMENT_PAGE_GUTTER_PX
            : DOCUMENT_PAGE_GUTTER_PX,
        width: layout.width,
        height: layout.height,
    }));
}
export function resolveDocumentPageZoomAnchorLayoutsBounded(
    pageLayouts: TDocumentPageSourceCollection<IDocumentZoomPageLayout>,
    resolvePageLeft: (pageWidth: number) => number,
) {
    return mapDocumentPageSourceCollectionBounded(pageLayouts, layout => ({
        ...layout,
        left: resolvePageLeft(layout.width),
    }));
}
export function shouldRetainInactiveDocumentPageSourceLease(
    retainWarmLease: boolean,
    pressureLevel: TWorkspaceResourcePressureLevel,
) {
    return retainWarmLease && [
        'healthy',
        'guarded',
    ].includes(pressureLevel);
}
export function resolveDocumentPageSourceReadyEdgeSemanticPage(
    viewportSession: Pick<
        IDocumentViewportSessionState,
        'lifecycle' | 'requestedPage' | 'committedPage' | 'observedPage'
    >,
) {
    if (viewportSession.lifecycle !== 'ready' || viewportSession.observedPage !== null) {
        return null;
    }
    return viewportSession.committedPage ?? viewportSession.requestedPage;
}
export const useDocumentPageSourceRuntime = (options: {
    emit: IDocumentPageSourceFeaturePackEmit;
    readProps: () => TDocumentPageSourceRuntimeProps;
}) => {
    let nextSourcePageSlotOwnerId = 0;
    const emit = options.emit;
    const props = computed(options.readProps);
    const viewerContainer = shallowRef<HTMLElement | null>(null);
    const containerWidth = ref(0);
    const containerHeight = ref(0);
    const viewportScrollTop = ref(0);
    const viewportScrollDirection = ref<-1 | 0 | 1>(0);
    const pagedWheelNavigation = createPageSourcePagedWheelNavigation(DOCUMENT_PAGE_GUTTER_PX);
    const chassisAuthority = injectDocumentViewerChassisAuthority();
    const openSurfaceRenderOwner = chassisAuthority?.openSurface.claimRenderOwner();
    const viewportWritePort = chassisAuthority?.viewportWritePort ?? createDocumentViewportWritePort();
    const renderSession = chassisAuthority?.renderCoordinator.createSession(
        `page-source-feature:${String(++nextSourcePageSlotOwnerId)}`,
    );
    const openingPageFrameOwnerId = `page-source:${String(nextSourcePageSlotOwnerId)}`;
    const pageSlots = renderSession?.pageSlots;
    const surfaceBudget = chassisAuthority?.surfaceBudget ?? workspaceSurfaceBudgetController;
    const rasterBufferProfile = getPerformanceProfile();
    const source = shallowRef<IDocumentPageSource | null>(null);
    const pageMetrics = shallowRef<TDocumentPageMetricsCollection>([]);
    const exactPageMetricNumbers = new Set<number>();
    const exactPageMetricLoads = new Map<number, Promise<IDocumentPageMetrics>>();
    let loadSettled = Promise.resolve();
    let loadController: AbortController | null = null;
    let releaseViewportFeature: (() => void) | null = null;
    let inactiveLeaseReleaseTimer: ReturnType<typeof setTimeout> | null = null;
    function measureViewport() {
        containerWidth.value = viewerContainer.value?.clientWidth ?? 0;
        containerHeight.value = viewerContainer.value?.clientHeight ?? 0;
        viewportScrollTop.value = viewerContainer.value?.scrollTop ?? 0;
    }
    useResizeObserver(viewerContainer, measureViewport);
    const pageDisplayLayouts = computed(() => resolveDocumentPageDisplayLayoutsBounded(
        pageMetrics.value,
        Math.max(1, containerHeight.value - DOCUMENT_PAGE_GUTTER_PX * 2),
        Math.max(1, containerWidth.value - DOCUMENT_PAGE_GUTTER_PX * 2),
        clampDocumentManualZoom(props.value.zoom),
        props.value.zoomMode,
    ));
    const effectiveZoom = computed(() => (
        pageDisplayLayouts.value[props.value.currentPage - 1]?.scale
        ?? clampDocumentManualZoom(props.value.zoom)
    ));
    const handleWheelZoom = createDocumentWheelZoomHandler(
        effectiveZoom,
        computed(() => props.value.zoomMode),
        emit,
        {
            beforeZoom: (interaction, packetAt, startsNewSession) => layoutLifecycle.capturePointerAnchor(
                interaction.event,
                packetAt,
                startsNewSession,
            ),
            onNonZoom: () => layoutLifecycle.cancelPendingRestore(),
            readSessionKey: () => transitions.loadGeneration.value,
        },
    );
    const cancelWheelInteraction = useDocumentWheelZoomSessionBoundaries({
        isInteractionActive: computed(() => props.value.isInteractionActive),
        reset: () => { handleWheelZoom.reset(); layoutLifecycle.cancelPendingRestore(); },
    });
    const pageHeights = computed(() => resolveDocumentPageHeightsBounded(pageDisplayLayouts.value));
    const pageTops = computed(() => resolveDocumentPageTopsBounded(
        pageHeights.value,
    ));
    const totalHeight = computed(() => Math.max(
        containerHeight.value,
        (pageTops.value.at(-1) ?? DOCUMENT_PAGE_GUTTER_PX)
            + (pageHeights.value.at(-1) ?? 0)
            + DOCUMENT_PAGE_GUTTER_PX,
        (pageTops.value[props.value.currentPage - 1] ?? DOCUMENT_PAGE_GUTTER_PX)
            + (pageHeights.value[props.value.currentPage - 1] ?? 0)
            + DOCUMENT_PAGE_GUTTER_PX,
    ));
    const pageLayouts = computed(() => resolveDocumentPageLayoutsBounded(
        pageDisplayLayouts.value,
        pageTops.value,
        props.value.continuousScroll,
    ));
    const mountedPages = computed(() => {
        const pageCount = source.value?.pageCount
            ?? chassisAuthority?.openSurface.snapshot.value.openingPageGeometry?.pageCount
            ?? pageMetrics.value.length;
        const viewportPages = props.value.continuousScroll
            ? resolveDocumentContinuousScrollWindow({
                currentPage: props.value.currentPage,
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
            })?.pageNumbers ?? []
            : [];
        return renderSession?.resolveMountedPages({
            currentPage: props.value.currentPage,
            destinationPage: [
                'opening',
                'transitioning',
            ].includes(chassisAuthority?.openSurface.viewportSession.value.lifecycle ?? '')
                ? chassisAuthority?.openSurface.snapshot.value.openingPageFrame?.pageNumber
                : undefined,
            maxPages: DOCUMENT_SOURCE_MAX_MOUNTED_PAGES,
            pageCount,
            radius: props.value.continuousScroll ? DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS : 3,
            viewportPages,
        }) ?? [];
    });
    const renderDemand = computed(() => resolveDocumentPageSourceRenderDemand({
        bufferRadius: props.value.continuousScroll && effectiveZoom.value < 1
            ? DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS
            : rasterBufferProfile.pdfBufferPages,
        continuousScroll: props.value.continuousScroll,
        currentPage: props.value.currentPage,
        estimatePagePixels: (pageNumber) => {
            const layout = pageLayouts.value[pageNumber - 1];
            const pixelRatio = window.devicePixelRatio || 1;
            return layout ? layout.width * layout.height * pixelRatio * pixelRatio : 1;
        },
        maxBufferPixels: rasterBufferProfile.maxBufferCanvasPixels,
        maximumResidentPages: DOCUMENT_SOURCE_MAX_RESIDENT_PAGES,
        minimumBufferPages: props.value.continuousScroll && effectiveZoom.value < 1
            ? DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS
            : 2,
        preferredDirection: viewportScrollDirection.value,
        mountedPages: mountedPages.value,
        pageCount: source.value?.pageCount ?? pageMetrics.value.length,
        pageHeights: pageHeights.value,
        pageTops: pageTops.value,
        scrollTop: viewportScrollTop.value,
        viewportHeight: containerHeight.value,
    }));
    const surfaceStyle = computed(() => ({height: props.value.continuousScroll ? `${Math.max(1, totalHeight.value)}px` : '100%'}));
    function resolvePageLeft(pageWidth: number) {
        return Math.max(DOCUMENT_PAGE_GUTTER_PX, (containerWidth.value - pageWidth) / 2);
    }
    const zoomAnchorPageLayouts = computed(() => resolveDocumentPageZoomAnchorLayoutsBounded(
        pageLayouts.value,
        resolvePageLeft,
    ));
    let modeTransitionPreferredPageIndex: number | null = null;
    watch(
        () => [
            props.value.continuousScroll,
            props.value.currentPage,
        ] as const,
        ([continuousScroll], previous) => {
            if (previous && continuousScroll !== previous[0]) {
                modeTransitionPreferredPageIndex = previous[0]
                    ? null
                    : Math.max(0, previous[1] - 1);
            }
        },
        {flush: 'sync'},
    );
    watch(
        () => props.value.documentRevisionToken ?? props.value.src,
        () => {
            modeTransitionPreferredPageIndex = null;
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
            top: `${String(props.value.continuousScroll
                ? pageTops.value[pageNumber - 1] ?? DOCUMENT_PAGE_GUTTER_PX
                : DOCUMENT_PAGE_GUTTER_PX)}px`,
            left: `${String(resolvePageLeft(layout.width))}px`,
            display: !props.value.continuousScroll && pageNumber !== props.value.currentPage
                ? 'none'
                : undefined,
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
        return frame.generation === snapshot.generation
            && frame.pageNumber === pageNumber
            && frame.pageNumber === authority.currentPage.value
            && target?.isConnected
            && target.dataset.pageNumber === String(pageNumber)
            && target.dataset.openSurfaceGeneration === String(snapshot.generation)
            && target.dataset.openSurfaceFrameOwner === frame.ownerId
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
        () => [
            chassisAuthority?.openingPageElement.value ?? null,
            chassisAuthority?.openSurface.snapshot.value.openingPageFrame?.pageNumber ?? null,
            chassisAuthority?.openSurface.snapshot.value.generation ?? null,
        ] as const,
        ([
            _target,
            pageNumber,
            _generation,
        ]) => {
            const ownedTarget = pageNumber === null ? null : getChassisOpeningShellTarget(pageNumber);
            if (
                chassisOpeningSlotPage !== null
                && (!ownedTarget || chassisOpeningSlotPage !== pageNumber)
            ) {
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
        commitMetrics: metrics => layoutLifecycle.preserveLayoutMutation(() => {
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
                if (
                    isCurrent()
                    && source.value === activeSource
                    && pageNumber >= 1
                    && pageNumber <= activeSource.pageCount
                ) {
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
    const presentation = createDocumentPageSourcePresentation({
        chassisAuthority,
        emit,
        ensureExactPageMetric,
        flushMetricPublication: metricPublication.flush,
        getOpeningTarget: getChassisOpeningShellTarget,
        isFenceCurrent: transitions.isCurrent,
        openSurfaceRenderOwner,
        readContinuousScroll: () => props.value.continuousScroll,
        readCurrentPage: () => props.value.currentPage,
        readFence: transitions.readFence,
        readIsActive: () => props.value.isActive,
        readLoadSignal: () => loadController?.signal ?? null,
        readMetric: pageNumber => pageMetrics.value[pageNumber - 1],
        readPageScale: pageNumber => (
            pageDisplayLayouts.value[pageNumber - 1]?.scale ?? effectiveZoom.value
        ),
        readPixelRatio: () => window.devicePixelRatio || 1,
        readRenderDemand: () => renderDemand.value,
        readSource: () => source.value,
        readViewport: () => viewerContainer.value,
        readViewportScrollDirection: () => viewportScrollDirection.value,
        renderSession,
        scheduleRender: () => scheduleRender.schedule(),
    });
    const renderPage = presentation.renderPage;
    async function renderMountedPages() {
        if (props.value.isResizing || layoutLifecycle.isResizeTransitionActive.value) {
            return;
        }
        await nextTick();
        const renderQueue = resolveDocumentPageSourceRenderQueue({
            bufferPages: renderDemand.value.bufferPages,
            concurrency: DOCUMENT_SOURCE_RENDER_CONCURRENCY,
            currentPage: props.value.currentPage,
            guardRadius: DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS,
            inFlightPages: [...presentation.renderControllers.keys()],
            mountedPages: mountedPages.value,
            needsRender: (pageNumber) => {
                const state = presentation.pageStates.get(pageNumber);
                const metric = pageMetrics.value[pageNumber - 1];
                return !state?.lease || !state.ready || !metric || state.widthPx !== resolveDocumentPageSourceRenderWidthPx(
                    metric,
                    pageDisplayLayouts.value[pageNumber - 1]?.scale ?? effectiveZoom.value,
                    window.devicePixelRatio || 1,
                );
            },
            preferredDirection: viewportScrollDirection.value,
            residentPages: renderDemand.value.residentPages,
            visiblePages: renderDemand.value.visiblePages,
        });
        renderQueue.pagesToAbort.forEach(pageNumber => presentation.renderControllers.get(pageNumber)?.abort());
        await Promise.all(renderQueue.pagesToRender.map(renderPage));
    }
    const scheduleRender = createRafCoalescedCallback(() => void renderMountedPages());
    const captureLayoutRestoreEpoch = () => `${String(chassisAuthority?.openSurface.snapshot.value.generation ?? null)}:${String(viewportWritePort.getInteractionEpoch())}`;
    const layoutLifecycle = useDocumentViewportLayoutLifecycle({
        viewerContainer,
        pageLayouts: zoomAnchorPageLayouts,
        capturePageIndex: () => {
            const preferredPageIndex = modeTransitionPreferredPageIndex;
            modeTransitionPreferredPageIndex = null;
            return preferredPageIndex ?? (props.value.continuousScroll
                ? null
                : Math.max(0, props.value.currentPage - 1));
        },
        isResizing: computed(() => props.value.isResizing),
        captureRestoreEpoch: captureLayoutRestoreEpoch,
        canRestore: epoch => epoch === captureLayoutRestoreEpoch()
            && (!chassisAuthority || (
                props.value.isActive
                && shouldProjectDocumentViewportScroll(
                    chassisAuthority.openSurface.snapshot.value,
                    chassisAuthority.openSurface.viewportSession.value,
                )
            )),
        applyRestoredScroll: (restored) => {
            const container = viewerContainer.value;
            return container !== null && viewportWritePort.apply(container, {
                intent: viewportWritePort.beginIntent(
                    `page-source-zoom-anchor:${String(transitions.loadGeneration.value)}`,
                ),
                reason: 'zoom-anchor-restoration',
                ...restored,
                left: props.value.continuousScroll && props.value.zoomMode === 'fit-width'
                    ? container.scrollLeft
                    : restored.left,
            });
        },
        onResizeSettled: () => scheduleRender.schedule(),
    });
    function handleScroll(event?: Event) {
        if (!viewerContainer.value || props.value.isResizing || layoutLifecycle.isResizeTransitionActive.value) {
            return;
        }
        const nextScrollTop = viewerContainer.value.scrollTop;
        const scrollDelta = nextScrollTop - viewportScrollTop.value;
        if (Math.abs(scrollDelta) > 1) {
            viewportScrollDirection.value = scrollDelta > 0 ? 1 : -1;
        }
        viewportScrollTop.value = nextScrollTop;
        scheduleRender.schedule();
        const consumedAuthorityScroll = viewportWritePort.consumeAuthorityScroll(viewerContainer.value);
        if (consumedAuthorityScroll) {
            layoutLifecycle.refreshLayoutTransactionAnchor();
            const viewportSession = chassisAuthority?.openSurface.viewportSession.value;
            const hasStableCommittedPage = viewportSession?.lifecycle === 'ready'
                && viewportSession.requestedPage === viewportSession.committedPage
                && viewportSession.requestedPage === props.value.currentPage;
            if (!hasStableCommittedPage) {
                syncCurrentPageFromViewport(false);
            }
            return;
        }
        if (layoutLifecycle.hasPendingPointerRestore()) {
            return;
        }
        if (chassisAuthority && event?.isTrusted !== true) {
            return;
        }
        layoutLifecycle.cancelPendingRestore();
        viewportWritePort.observeUserScroll(viewerContainer.value);
        layoutLifecycle.refreshLayoutTransactionAnchor();
        syncCurrentPageFromViewport(true);
    }
    function syncCurrentPageFromViewport(
        supersedeNavigation: boolean,
        forceProjection = false,
    ) {
        const container = viewerContainer.value;
        if (!container || !props.value.continuousScroll) {
            return;
        }
        const totalPages = source.value?.pageCount
            ?? chassisAuthority?.openSurface.snapshot.value.openingPageGeometry?.pageCount
            ?? pageMetrics.value.length;
        const nearestPage = resolveNearestDocumentPageToViewportCenter({
            geometry: {
                pageHeights: pageHeights.value,
                pageTops: pageTops.value,
                totalHeight: totalHeight.value,
            },
            scrollTop: container.scrollTop,
            totalPages,
            viewportHeight: container.clientHeight,
        });
        if (nearestPage && (forceProjection || nearestPage !== props.value.currentPage)) {
            const observedPage = chassisAuthority?.observePage(nearestPage, {supersedeNavigation}) ?? nearestPage;
            emit('update:currentPage', observedPage);
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
            if (
                viewportSession[0] === 'ready'
                && previousViewportSession?.[0] !== 'ready'
            ) {
                const semanticPage = chassisAuthority
                    ? resolveDocumentPageSourceReadyEdgeSemanticPage(
                        chassisAuthority.openSurface.viewportSession.value,
                    )
                    : null;
                if (semanticPage !== null) {
                    // The target render and viewport have just crossed their
                    // ready fence. Its physical offset may still reflect
                    // provisional geometry, so keep the committed semantic
                    // page until trusted input records an observation.
                    emit('update:currentPage', semanticPage);
                    return;
                }
                syncCurrentPageFromViewport(false, true);
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
        const target = pagedWheelNavigation.handle(interaction.event, {
            container: viewerContainer.value,
            continuousScroll: props.value.continuousScroll,
            currentPage: props.value.currentPage,
            pageCount: source.value?.pageCount ?? 0,
            pageHeights: pageHeights.value,
            viewMode: props.value.viewMode,
        });
        if (target !== null) scrollToPage(target, 'wheel');
    }
    function scrollToPage(
        pageNumber: number,
        navigationSource: Parameters<IDocumentViewerExpose['scrollToPage']>[1] | 'wheel' = undefined,
    ) {
        if (navigationSource !== 'wheel') {
            pagedWheelNavigation.reset();
        }
        const normalized = chassisAuthority?.navigate(pageNumber)
            ?? Math.max(1, Math.min(source.value?.pageCount ?? 1, Math.trunc(pageNumber)));
        const readyState = presentation.pageStates.get(normalized);
        if (readyState?.ready) {
            void nextTick(() => presentation.commitReady(normalized, readyState));
        }
        emit('update:currentPage', normalized);
        const intent = chassisAuthority?.viewportWritePort.beginIntent(
            `page-source-navigation:${String(normalized)}:${String(transitions.loadGeneration.value)}`,
        );
        const activeSource = source.value;
        const signal = loadController?.signal;
        const metricFence = transitions.readFence();
        if (activeSource && signal && !exactPageMetricNumbers.has(normalized)) {
            void ensureExactPageMetric(
                activeSource,
                metricFence.loadGeneration,
                normalized,
                signal,
                () => transitions.isCurrent(metricFence),
            ).then(() => scheduleRender.schedule()).catch((error: unknown) => {
                if (
                    transitions.isCurrent(metricFence)
                    && props.value.isActive
                    && source.value === activeSource
                    && !signal.aborted
                    && !(error instanceof DOMException && error.name === 'AbortError')
                ) {
                    const message = presentation.commitTerminalError(normalized, error);
                    if (normalized === props.value.currentPage) {
                        emit('loadError', error instanceof Error
                            ? error
                            : presentation.createFailureError(normalized, message));
                    }
                }
            });
        }
        void nextTick(() => {
            if (viewerContainer.value) {
                if (!intent) {
                    return;
                }
                chassisAuthority?.viewportWritePort.apply(viewerContainer.value, {
                    intent,
                    reason: 'source-neutral-page-navigation',
                    top: props.value.continuousScroll
                        ? Math.max(
                            0,
                            (pageTops.value[normalized - 1] ?? DOCUMENT_PAGE_GUTTER_PX)
                                - DOCUMENT_PAGE_GUTTER_PX,
                        )
                        : 0,
                });
                layoutLifecycle.refreshLayoutTransactionAnchor();
            }
            scheduleRender.schedule();
        });
    }
    function releaseInactivePageStates() {
        if (inactiveLeaseReleaseTimer !== null) {
            clearTimeout(inactiveLeaseReleaseTimer);
            inactiveLeaseReleaseTimer = null;
        }
        const retainCurrentPage = shouldRetainInactiveDocumentPageSourceLease(
            resolveOpenPathSecondaryPerformancePolicy(rasterBufferProfile)
                .inactiveDjvuLeasePolicy === 'warm-grace',
            surfaceBudget.getSnapshot().pressureLevel,
        );
        const retainedPageNumber = retainCurrentPage ? props.value.currentPage : null;
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
        inactiveLeaseReleaseTimer = setTimeout(() => {
            inactiveLeaseReleaseTimer = null;
            if (!props.value.isActive && presentation.pageStates.get(retainedPageNumber)?.lease === retainedLease) {
                presentation.releasePage(retainedPageNumber);
            }
        }, DOCUMENT_SOURCE_INACTIVE_LEASE_GRACE_MS);
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
    function applyOpenTransition(transition: IDocumentPageSourceTransition) {
        const documentRef = transition.fence.src;
        pagedWheelNavigation.reset();
        loadController?.abort();
        const activeLoadController = new AbortController();
        loadController = activeLoadController;
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
        emit('update:pageSource', null);
        if (!seedOpeningPageMetrics()) {
            pageMetrics.value = documentRef
                ? createColdOpenProvisionalDocumentPageMetrics(Math.max(1, Math.trunc(
                    chassisAuthority?.currentPage.value ?? props.value.currentPage,
                )))
                : [];
        }
        emit('loading', Boolean(documentRef));
        if (!documentRef) {
            emit('update:totalPages', 0);
            return;
        }
        emit('initial-visual-pending');
        loadSettled = openDocumentPageSource(transition, {
            chassisAuthority,
            commitPageTerminalError: presentation.commitTerminalError,
            createPageFailureError: presentation.createFailureError,
            emit,
            ensureExactPageMetric,
            getOpeningShellTarget: getChassisOpeningShellTarget,
            layoutLifecycle,
            loadController: activeLoadController,
            markExactPageMetric: pageNumber => exactPageMetricNumbers.add(pageNumber),
            measureViewport,
            openingPageFrameOwnerId,
            publishPageMetrics: (metrics) => {
                pageMetrics.value = metrics;
            },
            readCurrentPage: () => chassisAuthority?.currentPage.value ?? props.value.currentPage,
            getPriorityPages: () => {
                const demand = renderDemand.value;
                return [...new Set([
                    ...demand.visiblePages,
                    ...demand.bufferPages,
                    ...demand.residentPages,
                    props.value.currentPage,
                ])];
            },
            readPageMetric: pageNumber => pageMetrics.value[pageNumber - 1],
            readPolicy: () => ({
                continuousScroll: props.value.continuousScroll,
                zoom: props.value.zoom,
                zoomMode: props.value.zoomMode,
            }),
            readViewport: () => viewerContainer.value,
            renderPage,
            resetMetricPublication: metricPublication.clear,
            scheduleRender: scheduleRender.schedule,
            scrollToPage,
            setSource: (nextSource) => {
                source.value = nextSource;
            },
            surfaceBudget,
        }).then((settled) => {
            if (settled && transition.isCurrent()) {
                return transitions.channel.publish({
                    kind: 'settle',
                    fence: transition.fence,
                });
            }
            return false;
        }).then(() => undefined);
    }
    function applySuspendTransition() {
        scheduleRender.cancel();
        presentation.renderControllers.forEach(controller => controller.abort());
        presentation.renderControllers.clear();
        releaseInactivePageStates();
    }
    function applyRestoreTransition(transition: IDocumentPageSourceTransition) {
        if (inactiveLeaseReleaseTimer !== null) {
            clearTimeout(inactiveLeaseReleaseTimer);
            inactiveLeaseReleaseTimer = null;
        }
        const retainedState = presentation.pageStates.get(props.value.currentPage);
        retainedState?.lease?.setPriority?.('navigation');
        if (retainedState?.lease) {
            retainedState.priority = 'navigation';
        }
        void presentation.restore(transition, {
            measureViewport,
            renderMountedPages,
        });
    }
    watch(
        () => chassisAuthority?.openSurface.snapshot.value.openingPageGeometry ?? null,
        (geometry) => {
            if (!geometry) {
                return;
            }
            if (!source.value) {
                seedOpeningPageMetrics();
            }
        },
        {immediate: true},
    );
    transitions.channel.subscribe((transition) => {
        switch (transition.kind) {
            case 'open':
                applyOpenTransition(transition);
                return;
            case 'invalidate':
                applySuspendTransition();
                return;
            case 'restore':
                applyRestoreTransition(transition);
                return;
            case 'settle':
                scheduleRender.schedule();
        }
    });
    transitions.start();
    watch(effectiveZoom, (value) => {
        emit('update:effectiveZoom', value);
        if (!props.value.isResizing) scheduleRender.schedule();
    });
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
    watch(() => renderDemand.value.residentPages, retainOnlyPageStates);
    onMounted(() => {
        viewerContainer.value = chassisAuthority?.viewportElement.value ?? null;
        measureViewport();
        releaseViewportFeature = chassisAuthority?.bindViewportFeature({
            getClass: () => 'document-viewer-viewport document-source-viewer app-scrollbar',
            getStyle: () => ({}),
            events: {
                mousedown: cancelWheelInteraction,
                scroll: event => handleScroll(event),
            },
            wheel: handleWheel,
        }) ?? null;
    });
    onBeforeUnmount(() => {
        transitions.dispose();
        if (inactiveLeaseReleaseTimer !== null) {
            clearTimeout(inactiveLeaseReleaseTimer);
        }
        releaseViewportFeature?.();
        scheduleRender.cancel();
        metricPublication.clear();
        renderSession?.dispose();
        if (chassisOpeningSlotPage !== null) {
            pageSlots?.markUnmounted(chassisOpeningSlotPage);
            chassisOpeningSlotPage = null;
        }
        loadController?.abort();
        const activeSource = source.value;
        emit('update:pageSource', null);
        activeSource?.dispose();
        if (chassisAuthority?.source.value === activeSource) {
            chassisAuthority.bindSource(null);
        }
        presentation.dispose();
    });
    return {
        activeOpenSurfaceGeneration: transitions.openSurfaceGeneration,
        getChassisOpeningShellTarget,
        getPageStyle,
        getRenderGeneration: presentation.getRenderGeneration,
        getSurface: presentation.getSurface,
        getVisual: presentation.getVisual,
        getVisualError: presentation.getVisualError,
        getVisualFailurePresentation: presentation.getVisualFailurePresentation,
        handleSurfaceError: presentation.handleSurfaceError,
        handleSurfaceLoad: presentation.handleSurfaceLoad,
        loadGeneration: transitions.loadGeneration,
        mountedPages,
        pageLayouts,
        setPageElement,
        surfaceStyle,
        viewerExpose: {
            getViewerContainer: () => viewerContainer.value,
            getCurrentPage: () => props.value.currentPage,
            waitForViewerLoadSettled: () => loadSettled,
            scrollToPage,
            invalidatePages: (pages: readonly number[]) => pages.forEach(page => void renderPage(page)),
            requestScrollToCurrentResult: () => scrollToPage(props.value.currentPage),
            captureScrollSnapshot: () => ({page: chassisAuthority?.currentPage.value ?? props.value.currentPage}),
            restoreScrollSnapshot: (snapshot: unknown, exposeOptions: {fallbackPage: number;}) => {
                const page = typeof snapshot === 'object' && snapshot !== null && 'page' in snapshot
                    ? Number(snapshot.page)
                    : exposeOptions.fallbackPage;
                scrollToPage(Number.isFinite(page) ? page : exposeOptions.fallbackPage);
            },
        },
    };
};
