import type {
    ComputedRef,
    Ref,
} from 'vue';
import { range } from 'es-toolkit/math';
import type { IPdfPageMetric } from '@app/types/pdfUi';
import type {
    TPdfViewMode,
    TPdfViewRotation,
} from '@contracts/shared';
import { buildPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/buildPageLayoutMetrics';
import { getLeadingSpacerHeightForPage } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getLeadingSpacerHeightForPage';
import { getInterSegmentSpacerHeight } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getInterSegmentSpacerHeight';
import { getPageRowBounds } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBounds';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import { getTrailingSpacerHeightForPage } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getTrailingSpacerHeightForPage';
import { getPageHeight } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageHeight';
import { getPageTop } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageTop';
import {
    getIndexedValue,
    getPageMetricMaximum,
    normalizePageMetrics,
} from '@app/modules/pdf-viewer/engine/pdf-page-layout/normalizePageMetrics';
import {
    getLayoutContentHeight,
    getLayoutPhysicalScrollSegment,
    PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT,
} from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import {
    buildPdfPageScaleStyle,
    createPdfPageScale,
} from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';
import type { IPdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';
import {
    createAnchorPageWindow,
    expandVirtualWindowForAnchor,
} from '@app/utils/document-viewer/virtualization/pageVirtualization';

export interface IZoomVirtualizationFreeze {
    sessionId: number | null;
    capturedAtMs: number;
    windowStart: number;
    windowEnd: number;
}

export interface IPdfVirtualPageSegment {
    end: number;
    key: string;
    pages: number[];
    spacerBeforeStyle: Record<string, string> | null;
    start: number;
}

interface IUsePdfViewerVirtualizationOptions {
    performancePolicy: IPdfRenderPerformancePolicy;
    // The document session stays mounted while another workspace surface owns
    // the document. Do not turn a stale hidden viewport range into page VNodes.
    isActive?: Ref<boolean>;
    bufferPages: ComputedRef<number>;
    viewMode: ComputedRef<TPdfViewMode>;
    viewRotation?: ComputedRef<TPdfViewRotation>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    continuousScroll: ComputedRef<boolean>;
    basePageWidth: Ref<number | null>;
    basePageHeight: Ref<number | null>;
    pageMetrics: Ref<IPdfPageMetric[]>;
    pageMetricsVersion: Ref<number>;
    effectiveScale: Ref<number>;
    scaledMargin: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    navigationAnchorPage: Ref<number | null>;
    navigationVisualHandoffTargetPage?: Readonly<Ref<number | null>> | undefined;
    getCommittedPageScale?: ((pageNumber: number) => number | null) | undefined;
    resizeTransitionAnchorPage: Ref<number | null>;
    zoomVirtualizationFreeze: Ref<IZoomVirtualizationFreeze | null>;
}

const VIRTUAL_MOUNT_BUFFER_MIN = 6;
const PAGED_MOUNT_ROW_BUFFER_BEFORE_MIN = 1;
const PAGED_MOUNT_ROW_BUFFER_AFTER_MIN = 2;
export {PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT};

interface IPageWindow {
    start: number;
    end: number;
}

function mergePdfRowWindows(
    layout: NonNullable<ReturnType<typeof buildPageLayoutMetrics>>,
    windows: readonly IPageWindow[],
) {
    const rowWindows = windows.map((window) => ({
        start: getPageRowBounds(layout, window.start)?.start ?? window.start,
        end: getPageRowBounds(layout, window.end)?.end ?? window.end,
    })).sort((left, right) => left.start - right.start);
    const mergedWindows: IPageWindow[] = [];
    for (const window of rowWindows) {
        const previous = mergedWindows.at(-1);
        if (previous && window.start <= previous.end + 1) {
            previous.end = Math.max(previous.end, window.end);
        } else {
            mergedWindows.push({...window});
        }
    }
    return mergedWindows;
}

function createVirtualSpacerStyle(height: number) {
    const value = `${height}px`;
    return {
        height: value,
        minHeight: value,
        flexBasis: value,
    };
}

export const usePdfViewerVirtualization = (options: IUsePdfViewerVirtualizationOptions) => {
    const {
        performancePolicy,
        bufferPages,
        viewMode,
        viewRotation: providedViewRotation,
        numPages,
        currentPage,
        continuousScroll,
        basePageWidth,
        basePageHeight,
        pageMetrics,
        pageMetricsVersion,
        effectiveScale,
        scaledMargin,
        visibleRange,
        navigationAnchorPage,
        navigationVisualHandoffTargetPage,
        getCommittedPageScale,
        resizeTransitionAnchorPage,
        zoomVirtualizationFreeze,
    } = options;
    const viewRotation = providedViewRotation ?? computed<TPdfViewRotation>(() => 0);

    const pageMetricsSnapshot = computed(() => ({
        metrics: pageMetrics.value,
        version: pageMetricsVersion.value,
    }));

    const normalizedPageMetrics = computed(() =>
        normalizePageMetrics({
            pageMetrics: pageMetricsSnapshot.value.metrics,
            totalPages: numPages.value,
            fallbackWidth: basePageWidth.value,
            fallbackHeight: basePageHeight.value,
            viewRotation: viewRotation.value,
        }),
    );

    const maxBasePageHeight = computed(() => getPageMetricMaximum(
        normalizedPageMetrics.value,
        'height',
    ));
    const pageHeightEstimate = computed(() => maxBasePageHeight.value * effectiveScale.value);

    const pageLayout = computed(() => {
        if (numPages.value <= 0 || pageHeightEstimate.value <= 0) {
            return null;
        }

        return buildPageLayoutMetrics({
            pageMetrics: normalizedPageMetrics.value,
            pageMetricsVersion: pageMetricsSnapshot.value.version,
            totalPages: numPages.value,
            viewMode: viewMode.value,
            scale: effectiveScale.value,
            gap: scaledMargin.value,
            paddingTop: scaledMargin.value,
            paddingBottom: scaledMargin.value,
        });
    });

    const physicalScrollSegment = computed(() => {
        const layout = pageLayout.value;
        if (!layout) {
            return null;
        }
        const anchorPage = Math.min(
            numPages.value,
            Math.max(1, navigationAnchorPage.value ?? currentPage.value),
        );
        const anchorTop = getPageTop(layout, anchorPage) ?? 0;
        return getLayoutPhysicalScrollSegment(layout, anchorTop);
    });

    function shouldPreserveCommittedPageGeometry(pageNumber: number) {
        if (numPages.value <= 0) {
            return false;
        }

        const targetPage = navigationVisualHandoffTargetPage?.value ?? navigationAnchorPage.value;
        if (targetPage === null) {
            return false;
        }

        if (pageNumber === targetPage) {
            return false;
        }

        // Continuous scroll can show both the outgoing and destination pages.
        // Keep every already-committed page at its painted size until the
        // viewport authority releases the handoff and applies the target
        // scroll position in the same transaction. A newly mounted target has
        // no committed scale, so it can still prepare at the destination scale.
        if (continuousScroll.value) {
            return true;
        }

        const targetRow = getPageRowBoundsForViewMode({
            pageNumber: targetPage,
            viewMode: viewMode.value,
            totalPages: numPages.value,
        });
        return pageNumber < targetRow.start || pageNumber > targetRow.end;
    }

    function getCommittedLayoutScale(pageNumber: number) {
        const committedScale = getCommittedPageScale?.(pageNumber);
        return committedScale !== null && committedScale !== undefined
            && Number.isFinite(committedScale) && committedScale > 0
            ? committedScale
            : null;
    }

    function getPageLayoutScale(pageNumber: number) {
        if (shouldPreserveCommittedPageGeometry(pageNumber)) {
            const committedScale = getCommittedLayoutScale(pageNumber);
            if (committedScale !== null) {
                return committedScale;
            }
        }

        return effectiveScale.value;
    }

    function getPageScale(pageNumber: number) {
        const metric = getIndexedValue(normalizedPageMetrics.value, pageNumber - 1);
        if (!metric) {
            return null;
        }

        return createPdfPageScale(getPageLayoutScale(pageNumber), metric.userUnit);
    }

    function getPagePlaceholderStyle(pageNumber: number): Record<string, string> | null {
        const metric = getIndexedValue(normalizedPageMetrics.value, pageNumber - 1);
        if (!metric) {
            return null;
        }
        const pageScale = createPdfPageScale(
            getPageLayoutScale(pageNumber),
            metric.userUnit,
        );

        return {
            width: `${metric.width * pageScale.scaleFactor}px`,
            height: `${metric.height * pageScale.scaleFactor}px`,
            ...buildPdfPageScaleStyle(pageScale),
        };
    }

    const virtualizedContinuousMode = computed(() =>
        continuousScroll.value
        && numPages.value > 0
        && pageHeightEstimate.value > 0,
    );

    const isNavigationAnchorActive = computed(() =>
        navigationAnchorPage.value !== null,
    );

    const virtualMountBuffer = computed(() =>
        isNavigationAnchorActive.value
            ? Math.max(
                performancePolicy.navigationAnchorRadius,
                VIRTUAL_MOUNT_BUFFER_MIN,
                bufferPages.value + 2,
            )
            : Math.max(VIRTUAL_MOUNT_BUFFER_MIN, bufferPages.value + 2),
    );

    const pagedWindowBounds = computed(() => {
        if (numPages.value <= 0) {
            return {
                start: 1,
                end: 0,
            };
        }

        const anchorPage = navigationAnchorPage.value ?? currentPage.value;
        return getPageRowBoundsForViewMode({
            pageNumber: anchorPage,
            viewMode: viewMode.value,
            totalPages: numPages.value,
        });
    });

    const pagedPresentationWindowBounds = computed(() => {
        if (navigationVisualHandoffTargetPage?.value === null
            || navigationVisualHandoffTargetPage?.value === undefined) {
            return pagedWindowBounds.value;
        }
        return getPageRowBoundsForViewMode({
            pageNumber: currentPage.value,
            viewMode: viewMode.value,
            totalPages: numPages.value,
        });
    });

    const pagedMountRowsBefore = computed(() =>
        Math.max(PAGED_MOUNT_ROW_BUFFER_BEFORE_MIN, Math.trunc(bufferPages.value) - 1),
    );

    const pagedMountRowsAfter = computed(() =>
        Math.max(PAGED_MOUNT_ROW_BUFFER_AFTER_MIN, Math.trunc(bufferPages.value)),
    );

    const pagedMountedWindowBounds = computed(() => {
        const activeBounds = pagedWindowBounds.value;
        if (activeBounds.end < activeBounds.start) {
            return activeBounds;
        }

        let startBounds = activeBounds;
        for (let rowOffset = 0; rowOffset < pagedMountRowsBefore.value; rowOffset += 1) {
            if (startBounds.start <= 1) {
                break;
            }
            startBounds = getPageRowBoundsForViewMode({
                pageNumber: startBounds.start - 1,
                viewMode: viewMode.value,
                totalPages: numPages.value,
            });
        }

        let endBounds = activeBounds;
        for (let rowOffset = 0; rowOffset < pagedMountRowsAfter.value; rowOffset += 1) {
            if (endBounds.end >= numPages.value) {
                break;
            }
            endBounds = getPageRowBoundsForViewMode({
                pageNumber: endBounds.end + 1,
                viewMode: viewMode.value,
                totalPages: numPages.value,
            });
        }

        return {
            start: startBounds.start,
            end: endBounds.end,
        };
    });

    function getPagedPagesToRender() {
        const demandBounds = pagedMountedWindowBounds.value;
        const demandPages = demandBounds.end >= demandBounds.start
            ? range(demandBounds.start, demandBounds.end + 1)
            : [];
        if (navigationVisualHandoffTargetPage?.value === null
            || navigationVisualHandoffTargetPage?.value === undefined) {
            return demandPages;
        }
        const presentationBounds = pagedPresentationWindowBounds.value;
        return Array.from(new Set([
            ...demandPages,
            ...range(presentationBounds.start, presentationBounds.end + 1),
        ])).sort((left, right) => left - right);
    }

    function isPageBuffered(pageNumber: number) {
        if (continuousScroll.value) {
            return false;
        }

        const activeBounds = pagedPresentationWindowBounds.value;
        return pageNumber < activeBounds.start || pageNumber > activeBounds.end;
    }

    const baseVirtualWindowStart = computed(() => {
        if (!virtualizedContinuousMode.value) {
            return pagedWindowBounds.value.start;
        }
        return Math.max(1, visibleRange.value.start - virtualMountBuffer.value);
    });

    const baseVirtualWindowEnd = computed(() => {
        if (!virtualizedContinuousMode.value) {
            return pagedWindowBounds.value.end;
        }
        return Math.min(numPages.value, visibleRange.value.end + virtualMountBuffer.value);
    });

    const navigationAnchorWindow = computed<{
        start: number;
        end: number;
    } | null>(() => {
        const anchorPage = navigationAnchorPage.value;
        if (!virtualizedContinuousMode.value || numPages.value <= 0 || anchorPage === null) {
            return null;
        }

        return createAnchorPageWindow({
            anchorPage,
            totalPages: numPages.value,
            radiusPages: virtualMountBuffer.value,
        });
    });

    const resizeTransitionWindow = computed<{
        start: number;
        end: number;
    } | null>(() => {
        if (!virtualizedContinuousMode.value || numPages.value <= 0) {
            return null;
        }

        const anchorPage = resizeTransitionAnchorPage.value;
        if (anchorPage === null) {
            return null;
        }

        return expandVirtualWindowForAnchor({
            baseStart: baseVirtualWindowStart.value,
            baseEnd: baseVirtualWindowEnd.value,
            anchorPage,
            totalPages: numPages.value,
            buffer: virtualMountBuffer.value,
        });
    });

    /**
     * Keeps the zoom freeze only while it still contains the active navigation
     * anchor. Otherwise a stale frozen window can hide a bookmark target row.
     */
    const activeZoomVirtualizationFreeze = computed(() => {
        const freeze = zoomVirtualizationFreeze.value;
        if (!virtualizedContinuousMode.value || !freeze) {
            return null;
        }

        const anchorPage = navigationAnchorPage.value;
        if (
            anchorPage !== null
            && (anchorPage < freeze.windowStart || anchorPage > freeze.windowEnd)
        ) {
            return null;
        }

        return freeze;
    });

    const virtualWindowStart = computed(() => {
        if (!virtualizedContinuousMode.value) {
            return pagedWindowBounds.value.start;
        }
        if (navigationAnchorWindow.value) {
            return Math.min(baseVirtualWindowStart.value, navigationAnchorWindow.value.start);
        }
        if (activeZoomVirtualizationFreeze.value) {
            return activeZoomVirtualizationFreeze.value.windowStart;
        }

        let nextStart = baseVirtualWindowStart.value;
        if (resizeTransitionWindow.value) {
            nextStart = Math.min(nextStart, resizeTransitionWindow.value.start);
        }
        return nextStart;
    });

    const virtualWindowEnd = computed(() => {
        if (!virtualizedContinuousMode.value) {
            return pagedWindowBounds.value.end;
        }
        if (navigationAnchorWindow.value) {
            return Math.max(baseVirtualWindowEnd.value, navigationAnchorWindow.value.end);
        }
        if (activeZoomVirtualizationFreeze.value) {
            return activeZoomVirtualizationFreeze.value.windowEnd;
        }

        let nextEnd = baseVirtualWindowEnd.value;
        if (resizeTransitionWindow.value) {
            nextEnd = Math.max(nextEnd, resizeTransitionWindow.value.end);
        }
        return nextEnd;
    });

    const topVirtualSpacerStyle = computed<Record<string, string> | null>(() => {
        if (!virtualizedContinuousMode.value) {
            return null;
        }
        const layout = pageLayout.value;
        if (!layout) {
            return null;
        }
        const spacerHeight = Math.max(
            0,
            getLeadingSpacerHeightForPage(layout, virtualWindowStartPage.value)
                - (physicalScrollSegment.value?.origin ?? 0),
        );
        if (spacerHeight <= 0) {
            return null;
        }

        return createVirtualSpacerStyle(spacerHeight);
    });

    const bottomVirtualSpacerStyle = computed<Record<string, string> | null>(() => {
        if (!virtualizedContinuousMode.value) {
            return null;
        }
        const layout = pageLayout.value;
        if (!layout) {
            return null;
        }
        let spacerHeight = getTrailingSpacerHeightForPage(layout, virtualWindowEndPage.value);
        const segment = physicalScrollSegment.value;
        if (segment) {
            const pageTop = getPageTop(layout, virtualWindowEndPage.value) ?? segment.origin;
            const pageHeight = getPageHeight(layout, virtualWindowEndPage.value) ?? 0;
            spacerHeight = Math.min(
                spacerHeight,
                Math.max(0, segment.height - (pageTop - segment.origin + pageHeight)),
            );
        }
        if (spacerHeight <= 0) {
            return null;
        }

        return createVirtualSpacerStyle(spacerHeight);
    });

    const pagesToRender = computed(() => {
        if (options.isActive?.value === false || numPages.value <= 0) {
            return [];
        }

        const layout = pageLayout.value;
        if (!layout) {
            if (!continuousScroll.value) {
                return getPagedPagesToRender();
            }
            const anchorPage = navigationAnchorPage.value
                ?? resizeTransitionAnchorPage.value
                ?? currentPage.value;
            const window = createAnchorPageWindow({
                anchorPage,
                totalPages: numPages.value,
                radiusPages: performancePolicy.layoutPendingRadius,
            });
            if (!window) {
                return [];
            }
            const startBounds = getPageRowBoundsForViewMode({
                pageNumber: window.start,
                viewMode: viewMode.value,
                totalPages: numPages.value,
            });
            const endBounds = getPageRowBoundsForViewMode({
                pageNumber: window.end,
                viewMode: viewMode.value,
                totalPages: numPages.value,
            });
            return range(startBounds.start, endBounds.end + 1);
        }

        if (!continuousScroll.value) {
            return getPagedPagesToRender();
        }

        if (navigationAnchorWindow.value) {
            // This list is intentionally non-contiguous. Consumers that need
            // DOM spacing use virtualPageSegments below; raster demand may
            // safely iterate the flattened page identities.
            return mergePdfRowWindows(layout, [
                {
                    start: baseVirtualWindowStart.value,
                    end: baseVirtualWindowEnd.value,
                },
                navigationAnchorWindow.value,
            ]).flatMap(window => range(window.start, window.end + 1));
        }

        const startBounds = getPageRowBounds(layout, virtualWindowStart.value);
        const endBounds = getPageRowBounds(layout, virtualWindowEnd.value);
        const renderStartPage = startBounds?.start ?? virtualWindowStart.value;
        const renderEndPage = endBounds?.end ?? virtualWindowEnd.value;

        return range(renderStartPage, renderEndPage + 1);
    });

    const virtualPageSegments = computed<IPdfVirtualPageSegment[]>(() => {
        const pages = pagesToRender.value;
        if (!virtualizedContinuousMode.value || pages.length === 0) {
            const start = pages[0];
            const end = pages.at(-1);
            return start === undefined || end === undefined
                ? []
                : [{
                    end,
                    key: `${start}:${end}`,
                    pages,
                    spacerBeforeStyle: null,
                    start,
                }];
        }

        const layout = pageLayout.value;
        if (!layout) {
            return [{
                end: pages.at(-1) ?? 0,
                key: `${pages[0] ?? 0}:${pages.at(-1) ?? 0}`,
                pages,
                spacerBeforeStyle: null,
                start: pages[0] ?? 0,
            }];
        }

        let requestedWindows: Array<{
            start: number;
            end: number;
        }>;
        if (navigationAnchorWindow.value) {
            // Keep the physically visible committed row mounted while the
            // requested row paints in a disjoint offscreen segment. Once the
            // viewport write lands, visibleRange moves to the target and the
            // two windows collapse into one without mounting the pages between.
            requestedWindows = physicalScrollSegment.value
                ? [navigationAnchorWindow.value]
                : [
                    {
                        start: baseVirtualWindowStart.value,
                        end: baseVirtualWindowEnd.value,
                    },
                    navigationAnchorWindow.value,
                ];
        } else if (activeZoomVirtualizationFreeze.value) {
            requestedWindows = [{
                start: activeZoomVirtualizationFreeze.value.windowStart,
                end: activeZoomVirtualizationFreeze.value.windowEnd,
            }];
        } else {
            requestedWindows = [
                {
                    start: baseVirtualWindowStart.value,
                    end: baseVirtualWindowEnd.value,
                },
                resizeTransitionWindow.value,
            ].filter((window): window is {
                start: number;
                end: number;
            } => window !== null);
        }

        const mergedWindows = mergePdfRowWindows(layout, requestedWindows);

        return mergedWindows.map((window, index) => {
            const previous = mergedWindows[index - 1];
            let spacerHeight = getLeadingSpacerHeightForPage(layout, window.start);
            if (index === 0) {
                spacerHeight = Math.max(
                    0,
                    spacerHeight - (physicalScrollSegment.value?.origin ?? 0),
                );
            }
            if (previous) {
                spacerHeight = getInterSegmentSpacerHeight(
                    layout,
                    previous.end,
                    window.start,
                );
            }
            return {
                ...window,
                key: `${window.start}:${window.end}`,
                pages: range(window.start, window.end + 1),
                spacerBeforeStyle: spacerHeight > 0
                    ? createVirtualSpacerStyle(spacerHeight)
                    : null,
            };
        });
    });

    // The scheduler consumes page identities, not a continuous numeric range.
    const disjointPagesToRender = computed(() =>
        virtualPageSegments.value.flatMap(segment => segment.pages),
    );

    const virtualWindowStartPage = computed(() => {
        if (!virtualizedContinuousMode.value) {
            return pagedWindowBounds.value.start;
        }
        const layout = pageLayout.value;
        if (!layout) {
            return virtualWindowStart.value;
        }
        return getPageRowBounds(layout, virtualWindowStart.value)?.start ?? virtualWindowStart.value;
    });

    const virtualWindowEndPage = computed(() => {
        if (!virtualizedContinuousMode.value) {
            return pagedWindowBounds.value.end;
        }

        const layout = pageLayout.value;
        if (!layout) {
            return virtualWindowEnd.value;
        }
        return getPageRowBounds(layout, virtualWindowEnd.value)?.end ?? virtualWindowEnd.value;
    });

    const virtualScrollHeight = computed(() => {
        const layout = pageLayout.value;
        return virtualizedContinuousMode.value && layout
            ? physicalScrollSegment.value?.height ?? getLayoutContentHeight(layout)
            : 0;
    });

    return {
        pageHeightEstimate,
        virtualScrollHeight,
        pageLayout,
        getPageLayoutScale,
        getPageScale,
        getPagePlaceholderStyle,
        virtualizedContinuousMode,
        navigationAnchorWindow,
        resizeTransitionWindow,
        virtualWindowStart,
        virtualWindowEnd,
        virtualWindowStartPage,
        virtualWindowEndPage,
        topVirtualSpacerStyle,
        bottomVirtualSpacerStyle,
        pagesToRender: disjointPagesToRender,
        virtualPageSegments,
        isPageBuffered,
    };
};
