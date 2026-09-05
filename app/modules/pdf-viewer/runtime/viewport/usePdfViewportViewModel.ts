import type {
    ComputedRef,
    Ref,
} from 'vue';
import { getCurrentSpreadRenderedBoundsFromMetrics } from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/getCurrentSpreadRenderedBoundsFromMetrics';
import { resolveHorizontalScrollClampForActiveSpread as resolveActiveSpreadHorizontalScrollClamp } from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/resolveHorizontalScrollClampForActiveSpread';
import { HORIZONTAL_SCROLL_CLAMP_EPSILON_PX } from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/resolvePageBoundedHorizontalScroll';
import { usePdfViewerVirtualization } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerVirtualization';
import type { IZoomVirtualizationFreeze } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerVirtualization';
import type {
    TFitMode,
    TPdfViewRotation,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import type { IPdfPageMetric } from '@app/types/pdfUi';
import type { IPdfViewportWritePort } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';
import type { IPdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';

interface IUsePdfViewportViewModelOptions {
    performancePolicy: IPdfRenderPerformancePolicy;
    isActive: ComputedRef<boolean>;
    viewerContainer: Ref<HTMLElement | null>;
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
    navigationAnchorPage: ComputedRef<number | null>;
    navigationVisualHandoffTargetPage?: ComputedRef<number | null> | undefined;
    getCommittedPageScale?: ((pageNumber: number) => number | null) | undefined;
    resizeTransitionAnchorPage: Ref<number | null>;
    zoomVirtualizationFreeze: Ref<IZoomVirtualizationFreeze | null>;
    scaleContainerStyle: ComputedRef<Record<string, string>>;
    selectionMarkupStyle: ComputedRef<Record<string, string> | null>;
    viewportWritePort: IPdfViewportWritePort;
    classState: {
        isAnySaving: ComputedRef<boolean>;
        isDragging: Ref<boolean>;
        isViewerPanDragModeActive: ComputedRef<boolean>;
        isSelectionMarkupToolActive: ComputedRef<boolean>;
        isTextSelectionModeActive: ComputedRef<boolean>;
        fitMode: ComputedRef<TFitMode>;
        zoomMode: ComputedRef<TZoomMode>;
        resizeTransitionVisible: Ref<boolean>;
        zoomSnapSuppressed: Ref<boolean>;
    };
}

export const usePdfViewportViewModel = (options: IUsePdfViewportViewModelOptions) => {
    const viewRotation = options.viewRotation ?? computed<TPdfViewRotation>(() => 0);
    const fitWidthHorizontalScrollLocked = ref(false);
    const viewportDimensionVersion = ref(0);
    let writeSequence = 0;
    const writeLeft = (container: HTMLElement, left: number, reason: string) => {
        writeSequence += 1;
        const intentId = `viewport-clamp-${writeSequence}`;
        options.viewportWritePort.apply(container, {
            intent: options.viewportWritePort.beginIntent(intentId),
            reason,
            left,
        });
    };

    watch(
        () => options.viewerContainer.value,
        (container, _previousContainer, onCleanup) => {
            viewportDimensionVersion.value += 1;
            if (typeof ResizeObserver === 'undefined' || !container) {
                return;
            }

            const resizeObserver = new ResizeObserver(() => {
                viewportDimensionVersion.value += 1;
            });
            resizeObserver.observe(container);
            onCleanup(() => resizeObserver.disconnect());
        },
        {
            immediate: true,
            flush: 'post',
        },
    );

    const virtualization = usePdfViewerVirtualization({
        performancePolicy: options.performancePolicy,
        isActive: options.isActive,
        bufferPages: options.bufferPages,
        viewMode: options.viewMode,
        viewRotation,
        numPages: options.numPages,
        currentPage: options.currentPage,
        continuousScroll: options.continuousScroll,
        basePageWidth: options.basePageWidth,
        basePageHeight: options.basePageHeight,
        pageMetrics: options.pageMetrics,
        pageMetricsVersion: options.pageMetricsVersion,
        effectiveScale: options.effectiveScale,
        scaledMargin: options.scaledMargin,
        visibleRange: options.visibleRange,
        navigationAnchorPage: options.navigationAnchorPage,
        navigationVisualHandoffTargetPage: options.navigationVisualHandoffTargetPage,
        getCommittedPageScale: options.getCommittedPageScale,
        resizeTransitionAnchorPage: options.resizeTransitionAnchorPage,
        zoomVirtualizationFreeze: options.zoomVirtualizationFreeze,
    });

    const containerStyle = computed(() => ({
        ...options.scaleContainerStyle.value,
        ...(options.selectionMarkupStyle.value ?? {}),
        '--pdf-virtual-scroll-height': `${virtualization.virtualScrollHeight.value}px`,
    }));

    const isActiveSpreadHorizontalScrollLocked = computed(() => {
        void viewportDimensionVersion.value;
        const container = options.viewerContainer.value;
        if (!container) {
            return false;
        }

        const renderedSpreadBounds = getCurrentSpreadRenderedBoundsFromMetrics({
            container,
            basePageWidth: options.basePageWidth.value,
            basePageHeight: options.basePageHeight.value,
            numPages: options.numPages.value,
            pageMetrics: options.pageMetrics.value,
            currentPage: options.currentPage.value,
            viewMode: options.viewMode.value,
            viewRotation: viewRotation.value,
            effectiveScale: options.effectiveScale.value,
            getScaleForPage: virtualization.getPageLayoutScale,
            scaledMargin: options.scaledMargin.value,
        });

        return renderedSpreadBounds
            ? renderedSpreadBounds.width <= container.clientWidth + HORIZONTAL_SCROLL_CLAMP_EPSILON_PX
            : container.scrollWidth <= container.clientWidth + HORIZONTAL_SCROLL_CLAMP_EPSILON_PX;
    });

    const viewerClass = computed(() => ({
        'pdfViewer--saving': options.classState.isAnySaving.value,
        'is-dragging': options.classState.isDragging.value,
        'drag-mode': options.classState.isViewerPanDragModeActive.value,
        'is-selection-markup-tool': options.classState.isSelectionMarkupToolActive.value,
        'is-text-selection-mode': options.classState.isTextSelectionModeActive.value,
        'pdfViewer--single-page': !options.continuousScroll.value,
        'pdfViewer--mode-single': options.viewMode.value === 'single',
        'pdfViewer--mode-facing': options.viewMode.value === 'facing',
        'pdfViewer--mode-facing-first-single': options.viewMode.value === 'facing-first-single',
        'pdfViewer--fit-width': options.classState.zoomMode.value === 'fit-width',
        'pdfViewer--fit-width-page-fits': fitWidthHorizontalScrollLocked.value,
        'pdfViewer--fit-height': options.classState.fitMode.value === 'height',
        'pdfViewer--active-spread-fits-width': isActiveSpreadHorizontalScrollLocked.value,
        'pdfViewer--resize-transition': options.classState.resizeTransitionVisible.value,
        'pdfViewer--zoom-snap-suppressed': options.classState.zoomSnapSuppressed.value,
    }));

    function resolveActiveSpreadHorizontalScrollLock() {
        const container = options.viewerContainer.value;
        if (!container) {
            return false;
        }

        const shouldLock = isActiveSpreadHorizontalScrollLocked.value;
        if (shouldLock && container.scrollLeft !== 0) {
            writeLeft(container, 0, 'active-spread-fit-clamp');
        }

        return shouldLock;
    }

    function resolveHorizontalScrollClampForActiveSpread() {
        const container = options.viewerContainer.value;
        if (
            !container
            || options.classState.fitMode.value !== 'width'
        ) {
            fitWidthHorizontalScrollLocked.value = false;
            return null;
        }

        const scrollClamp = resolveActiveSpreadHorizontalScrollClamp({
            container,
            fitMode: options.classState.fitMode.value,
            pageNumber: options.currentPage.value,
            viewMode: options.viewMode.value,
            viewRotation: viewRotation.value,
            numPages: options.numPages.value,
            basePageWidth: options.basePageWidth.value,
            basePageHeight: options.basePageHeight.value,
            pageMetrics: options.pageMetrics.value,
            effectiveScale: options.effectiveScale.value,
            getScaleForPage: virtualization.getPageLayoutScale,
            scaledMargin: options.scaledMargin.value,
            epsilon: HORIZONTAL_SCROLL_CLAMP_EPSILON_PX,
        });
        fitWidthHorizontalScrollLocked.value = scrollClamp?.shouldLock ?? false;
        return scrollClamp;
    }

    function syncHorizontalScrollForZoomMode() {
        const container = options.viewerContainer.value;
        if (!container) {
            fitWidthHorizontalScrollLocked.value = false;
            return false;
        }

        const scrollClamp = resolveHorizontalScrollClampForActiveSpread();
        if (scrollClamp) {
            const scrollDelta = Math.abs(container.scrollLeft - scrollClamp.scrollLeft);
            if (scrollDelta > HORIZONTAL_SCROLL_CLAMP_EPSILON_PX) {
                writeLeft(container, scrollClamp.scrollLeft, 'fit-width-clamp');
            }
            return scrollClamp.shouldLock;
        }

        if (resolveActiveSpreadHorizontalScrollLock()) {
            return true;
        }

        if (
            (options.classState.zoomMode.value === 'fit-width' || options.classState.zoomMode.value === 'fit-height')
            && container.scrollWidth <= container.clientWidth
            && container.scrollLeft !== 0
        ) {
            writeLeft(container, 0, 'fit-mode-center');
        }
        return false;
    }

    return {
        ...virtualization,
        containerStyle,
        viewerClass,
        isActiveSpreadHorizontalScrollLocked,
        resolveHorizontalScrollClampForActiveSpread,
        syncHorizontalScrollForZoomMode,
    };
};
