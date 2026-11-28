import {parsePageNumber, requirePageNumber} from '@contracts/pageNumbers';
import type {TPageNumber} from '@contracts/pageNumbers';

import {onScopeDispose, type ComputedRef, type Ref} from 'vue';
import {useResizeObserver} from '@vueuse/core';
import {getPageRowBoundsForViewMode} from '@app/modules/document-viewer/public';
import {getCurrentSpreadRenderedBoundsFromMetrics} from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/getCurrentSpreadRenderedBoundsFromMetrics';
import {resolveHorizontalScrollClampForActiveSpread as resolveActiveSpreadHorizontalScrollClamp} from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/resolveHorizontalScrollClampForActiveSpread';
import {HORIZONTAL_SCROLL_CLAMP_EPSILON_PX} from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/resolvePageBoundedHorizontalScroll';
import {usePdfViewerVirtualization} from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerVirtualization';
import type {TFitMode, TPdfViewRotation, TPdfViewMode, TZoomMode} from '@app/types/pdfContracts';
import type {IPdfPageMetric} from '@app/types/pdfUi';
import type {IPdfViewportWritePort} from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';
import type {IPdfRenderPerformancePolicy} from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';

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
    doesFitHeightSpreadFitWidth: (container: HTMLElement, page: TPageNumber) => boolean;
    scaledMargin: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    navigationAnchorPage: ComputedRef<number | null>;
    physicalScrollOrigin: Readonly<Ref<number>>;
    navigationVisualHandoffTargetPage?: ComputedRef<number | null> | undefined;
    getCommittedPageScale?: ((pageNumber: TPageNumber) => number | null) | undefined;
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
    };
}

export const usePdfViewportViewModel = (options: IUsePdfViewportViewModelOptions) => {
    const viewRotation = options.viewRotation ?? computed<TPdfViewRotation>(() => 0);
    const fitWidthHorizontalScrollLocked = ref(false);
    const viewportDimensionVersion = ref(0);
    let lastHorizontalClampCache: {
        container: HTMLElement;
        key: string;
        elements: HTMLElement[];
        scrollLeft: number;
        result: {scrollLeft: number; shouldLock: boolean};
    } | null = null;
    const observedActiveRowElements = new Set<HTMLElement>();
    let activeRowGeometryObserver: ResizeObserver | null = null;
    function getActiveRowGeometryObserver() {
        if (activeRowGeometryObserver === null && typeof ResizeObserver !== 'undefined') {
            activeRowGeometryObserver = new ResizeObserver(() => {
                lastHorizontalClampCache = null;
                syncHorizontalScrollForZoomMode();
            });
        }
        return activeRowGeometryObserver;
    }
    function clearObservedActiveRowElements() {
        if (observedActiveRowElements.size === 0) {
            return;
        }
        for (const element of observedActiveRowElements) {
            activeRowGeometryObserver?.unobserve(element);
        }
        observedActiveRowElements.clear();
    }
    function syncObservedActiveRowElements(elements: readonly HTMLElement[]) {
        if (elements.length === observedActiveRowElements.size && elements.every((element) => observedActiveRowElements.has(element))) {
            return;
        }
        clearObservedActiveRowElements();
        const observer = getActiveRowGeometryObserver();
        for (const element of elements) {
            observedActiveRowElements.add(element);
            observer?.observe(element);
        }
    }
    function invalidateHorizontalClampCache() {
        lastHorizontalClampCache = null;
        clearObservedActiveRowElements();
    }
    onScopeDispose(() => {
        activeRowGeometryObserver?.disconnect();
        observedActiveRowElements.clear();
    });
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

    useResizeObserver(options.viewerContainer, () => {
        viewportDimensionVersion.value += 1;
        lastHorizontalClampCache = null;
    });

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
        physicalScrollOrigin: options.physicalScrollOrigin,
        navigationVisualHandoffTargetPage: options.navigationVisualHandoffTargetPage,
        getCommittedPageScale: options.getCommittedPageScale,
    });

    const renderedSpreadBounds = computed(() => {
        void viewportDimensionVersion.value;
        const container = options.viewerContainer.value;
        const currentPage = parsePageNumber(options.currentPage.value, options.numPages.value);
        return container && currentPage !== null
            ? getCurrentSpreadRenderedBoundsFromMetrics({
                  container,
                  basePageWidth: options.basePageWidth.value,
                  basePageHeight: options.basePageHeight.value,
                  numPages: options.numPages.value,
                  pageWidths: virtualization.pageLayout.value?.base.pageWidths ?? [],
                  currentPage,
                  viewMode: options.viewMode.value,
                  effectiveScale: options.effectiveScale.value,
                  getScaleForPage: virtualization.getPageLayoutScale,
                  scaledMargin: options.scaledMargin.value,
              })
            : null;
    });

    const containerStyle = computed(() => ({
        ...options.scaleContainerStyle.value,
        ...(options.selectionMarkupStyle.value ?? {}),
        '--pdf-virtual-scroll-height': `${virtualization.virtualScrollHeight.value}px`,
        '--pdf-virtual-scroll-width': `${(renderedSpreadBounds.value?.width ?? 0) + options.scaledMargin.value * 2}px`,
    }));

    const isActiveSpreadHorizontalScrollLocked = computed(() => {
        void viewportDimensionVersion.value;
        const container = options.viewerContainer.value;
        const currentPage = parsePageNumber(options.currentPage.value, options.numPages.value);
        if (!container || currentPage === null) {
            return false;
        }
        if (options.classState.zoomMode.value === 'fit-height') {
            return options.doesFitHeightSpreadFitWidth(container, currentPage);
        }
        return renderedSpreadBounds.value
            ? renderedSpreadBounds.value.width + options.scaledMargin.value * 2 <=
                  container.clientWidth + HORIZONTAL_SCROLL_CLAMP_EPSILON_PX
            : container.scrollWidth <= container.clientWidth + HORIZONTAL_SCROLL_CLAMP_EPSILON_PX;
    });

    const isHorizontalScrollLocked = computed(() => fitWidthHorizontalScrollLocked.value || isActiveSpreadHorizontalScrollLocked.value);

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
        'pdfViewer--fit-height-overflow': options.classState.zoomMode.value === 'fit-height' && !isActiveSpreadHorizontalScrollLocked.value,
        'pdfViewer--active-spread-fits-width': isActiveSpreadHorizontalScrollLocked.value,
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
        if (!container || options.classState.fitMode.value !== 'width') {
            fitWidthHorizontalScrollLocked.value = false;
            invalidateHorizontalClampCache();
            return null;
        }

        const currentPage = parsePageNumber(options.currentPage.value, options.numPages.value);
        if (currentPage === null) {
            fitWidthHorizontalScrollLocked.value = false;
            invalidateHorizontalClampCache();
            return null;
        }

        const isHandoffActive =
            (options.navigationVisualHandoffTargetPage?.value ?? null) !== null || options.navigationAnchorPage.value !== null;
        const rowBounds = getPageRowBoundsForViewMode({
            pageNumber: currentPage,
            viewMode: options.viewMode.value,
            totalPages: options.numPages.value,
        });
        const activeRowElements: HTMLElement[] = [];
        const activeRowStyleWidths: string[] = [];
        const activeRowScales: number[] = [];
        let canUseStableDomCache = !isHandoffActive;
        for (let pageNumber = Number(rowBounds.start); pageNumber <= rowBounds.end; pageNumber += 1) {
            const normalizedPage = requirePageNumber(pageNumber, options.numPages.value);
            activeRowScales.push(virtualization.getPageLayoutScale(normalizedPage));
            if (!canUseStableDomCache) {
                continue;
            }
            const pageElement = container.querySelector<HTMLElement>(`.page_container[data-page="${normalizedPage}"]`);
            if (!pageElement || pageElement.classList.contains('page_container--buffered')) {
                canUseStableDomCache = false;
                continue;
            }
            activeRowElements.push(pageElement);
            activeRowStyleWidths.push(pageElement.style.width);
        }

        const clampKey = [
            currentPage,
            options.viewMode.value,
            viewRotation.value,
            options.numPages.value,
            options.effectiveScale.value,
            activeRowScales.join(','),
            activeRowStyleWidths.join(','),
            options.scaledMargin.value,
            viewportDimensionVersion.value,
            options.pageMetricsVersion.value,
            container.clientWidth,
        ].join(':');
        if (
            canUseStableDomCache &&
            lastHorizontalClampCache &&
            lastHorizontalClampCache.container === container &&
            lastHorizontalClampCache.key === clampKey &&
            lastHorizontalClampCache.elements.length === activeRowElements.length &&
            lastHorizontalClampCache.elements.every((element, index) => element === activeRowElements[index]) &&
            Math.abs(container.scrollLeft - lastHorizontalClampCache.scrollLeft) <= HORIZONTAL_SCROLL_CLAMP_EPSILON_PX
        ) {
            fitWidthHorizontalScrollLocked.value = lastHorizontalClampCache.result.shouldLock;
            return lastHorizontalClampCache.result;
        }

        const scrollClamp = resolveActiveSpreadHorizontalScrollClamp({
            container,
            fitMode: options.classState.fitMode.value,
            pageNumber: currentPage,
            viewMode: options.viewMode.value,
            numPages: options.numPages.value,
            basePageWidth: options.basePageWidth.value,
            basePageHeight: options.basePageHeight.value,
            pageWidths: virtualization.pageLayout.value?.base.pageWidths ?? [],
            effectiveScale: options.effectiveScale.value,
            getScaleForPage: virtualization.getPageLayoutScale,
            scaledMargin: options.scaledMargin.value,
            epsilon: HORIZONTAL_SCROLL_CLAMP_EPSILON_PX,
        });
        fitWidthHorizontalScrollLocked.value = scrollClamp?.shouldLock ?? false;
        if (
            canUseStableDomCache &&
            scrollClamp &&
            Math.abs(container.scrollLeft - scrollClamp.scrollLeft) <= HORIZONTAL_SCROLL_CLAMP_EPSILON_PX
        ) {
            syncObservedActiveRowElements(activeRowElements);
            lastHorizontalClampCache = {
                container,
                key: clampKey,
                elements: activeRowElements,
                scrollLeft: container.scrollLeft,
                result: scrollClamp,
            };
        } else {
            invalidateHorizontalClampCache();
        }
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
            (options.classState.zoomMode.value === 'fit-width' || options.classState.zoomMode.value === 'fit-height') &&
            container.scrollWidth <= container.clientWidth &&
            container.scrollLeft !== 0
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
        isHorizontalScrollLocked,
        resolveHorizontalScrollClampForActiveSpread,
        syncHorizontalScrollForZoomMode,
    };
};
