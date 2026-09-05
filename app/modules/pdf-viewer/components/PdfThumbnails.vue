<template>
  <DocumentThumbnailRail
    :set-root="setContainerRef"
    tabindex="-1"
    role="listbox"
    aria-multiselectable="true"
    :aria-label="t('sidebar.pages')"
    class="pdf-thumbnails"
    :class="{
      'is-reorder-dragging': isDragging,
      'is-external-drag': isExternalDragOver,
    }"
    @scroll.passive="handleContainerScroll"
    @wheel.passive="handleContainerWheel"
    @pointerdown="handleContainerPointerDown"
    @pointercancel="handleDragPointerCancel"
    @lostpointercapture="handleDragPointerCancel"
    @dragenter="handleExternalDragEnter"
    @dragover="handleExternalDragOver"
    @dragleave="handleExternalDragLeave"
    @drop="handleExternalDrop"
    @focusin="handleContainerFocusIn"
    @keydown="handleContainerKeyDown"
  >
    <div
      role="presentation"
      class="pdf-thumbnails-virtual-wrapper"
      :data-thumbnail-scroll-segment="thumbnailScrollSegmentIndex"
      :style="virtualWrapperStyle"
    >
      <DocumentThumbnailItem
        v-for="page in virtualPages"
        :key="page"
        tag="div"
        class="pdf-thumbnail pdf-thumbnail--virtual"
        :current="page === clampPage(currentPage)"
        label-class="pdf-thumbnail-number"
        :selected="isSelected(page)"
        :frame-style="getThumbnailCanvasStyle(page)"
        :class="{
          'is-active': page === clampPage(currentPage),
          'is-dragged': isDragging && draggedPages.includes(page),
          'is-drop-before': dropInsertIndex === page - 1,
          'is-drop-after': page === totalPages && dropInsertIndex === totalPages,
        }"
        :data-page="page"
        data-pane-relocation-scroll-item
        role="option"
        :aria-selected="isSelected(page)"
        :aria-label="t('pageOps.pageTarget', {page: formatPageIndicatorWithOptions(page, pageLabels ?? null)})"
        :tabindex="page === rovingFocusPage ? 0 : -1"
        :style="getThumbnailStyle(page)"
        @mousedown="handleDragMouseDown($event, page)"
        @click="handleThumbnailClick($event, page)"
        @contextmenu.prevent="handleThumbnailContextMenu($event, page)"
      >
        <template #overlay>
          <AppTooltip
            :text="getThumbnailSelectionLabel(page)"
            :delay-duration="400"
          >
            <button
              type="button"
              :aria-pressed="isSelected(page)"
              :aria-label="getThumbnailSelectionLabel(page)"
              class="pdf-thumbnail-selection-toggle"
              :class="{ 'is-selected': isSelected(page) }"
              @mousedown.stop
              @click.stop="toggleSinglePageSelection(page)"
            >
              <UIcon
                v-if="isSelected(page)"
                name="i-ph-check"
                class="pdf-thumbnail-selection-icon"
              />
            </button>
          </AppTooltip>
        </template>
        <span class="pdf-thumbnail-skeleton" aria-hidden="true" />
        <canvas v-if="isActive" class="pdf-thumbnail-canvas" />
        <template #label>{{ formatPageIndicatorWithOptions(page, pageLabels ?? null) }}</template>
      </DocumentThumbnailItem>
    </div>
  </DocumentThumbnailRail>
</template>

<script setup lang="ts">
import {
    useDebounceFn,
    useResizeObserver,
} from '@vueuse/core';
import { clamp } from 'es-toolkit/math';
import { BrowserLogger } from '@app/utils/browserLogger';
import { formatPageIndicatorWithOptions } from '@app/utils/pdfPageLabels';
import { THUMBNAIL_WIDTH } from '@app/constants/pdfLayout';
import { usePageDragDrop } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePageDragDrop';
import {
    DEFAULT_THUMBNAIL_ITEM_HEIGHT,
    VIRTUAL_OVERSCAN,
    createThumbnailCanvasStyle,
    createThumbnailItemStyle,
    resolveThumbnailVirtualPages,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailLayout';
import { usePdfThumbnailSelection } from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailSelection';
import {
    resolveThumbnailRasterWidth,
    roundMetric,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailRenderMetrics';
import {
    PDF_THUMBNAIL_LOG_SECTION,
    usePdfThumbnailRenderRuntime,
} from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailRenderRuntime';
import { createThumbnailMeasurementDiagnostics } from '@app/modules/pdf-viewer/thumbnails/createThumbnailMeasurementDiagnostics';
import {createDocumentThumbnailResizeAnchorLifecycle} from '@app/utils/document-viewer/thumbnails/createDocumentThumbnailResizeAnchorLifecycle';
import DocumentThumbnailItem from '@app/components/document-viewer/DocumentThumbnailItem.vue';
import DocumentThumbnailRail from '@app/components/document-viewer/DocumentThumbnailRail.vue';
import type {IDocumentThumbnailLayoutAnchor} from '@app/utils/document-viewer/thumbnails/documentThumbnailLayout';
import {usePdfThumbnailVirtualLayout} from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailVirtualLayout';
import {createPdfThumbnailScrollController} from '@app/modules/pdf-viewer/thumbnails/createPdfThumbnailScrollController';
import {
    DOCUMENT_THUMBNAIL_AUTO_FOLLOW_COOLDOWN_MS,
    DOCUMENT_THUMBNAIL_PROGRAMMATIC_SCROLL_GUARD_MS,
} from '@app/utils/document-viewer/thumbnails/documentThumbnailViewport';
import {
    describeContainerGeometry,
    isContainerVisible,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailContainerGeometry';
import type {
    IPdfThumbnailsEmits,
    IPdfThumbnailsProps,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailComponentContract';
import type {
    TPageMoveOperation,
    TPageSelection,
} from '@contracts/pageNumbers';
const THUMBNAIL_WIDTH_CHANGE_THRESHOLD = 1;
const THUMBNAIL_RASTER_RESIZE_SETTLE_MS = 120;
const INTERACTION_DIAGNOSTIC_THROTTLE_MS = 160;
const AUTO_SYNC_LAYOUT_RETRY_COUNT = 4;
const {
    annotationComments = undefined,
    annotationSettings = undefined,
    currentPage,
    hiddenAnnotationIds = undefined,
    invalidationRequest = undefined,
    isActive = true,
    isResizing = false,
    pageLabels = undefined,
    pdfDocument,
    rasterScheduler,
    selectedPages = undefined,
    selectedPageSelection = undefined,
    totalPages,
} = defineProps<IPdfThumbnailsProps>();
const emit = defineEmits<IPdfThumbnailsEmits>();
const hasPageSelectionModel = selectedPageSelection !== undefined;
const containerRef = ref<HTMLElement | null>(null);
function setContainerRef(element: HTMLElement | null) {
    containerRef.value = element;
}
let containerVisibilityState: 'unknown' | 'visible' | 'hidden' = 'unknown';
let lastUserInteractionAtMs = 0;
let lastUserInteractionLogAtMs = 0;
let lastUserInteractionReason: string | null = null;
let lastProgrammaticScrollAtMs = 0;
let currentPageSyncRunId = 0;
let thumbnailSourceCycleId = 0;
let manualScrollSourceCycleId = -1;
let activePaneRefreshRunId = 0;
const scrollTop = ref(0);
const viewportHeight = ref(0);
const thumbnailRenderWidth = ref(THUMBNAIL_WIDTH);
const thumbnailMeasurementDiagnostics = createThumbnailMeasurementDiagnostics({
    currentPage: () => currentPage,
    describeContainerGeometry,
    logSection: PDF_THUMBNAIL_LOG_SECTION,
    totalPages: () => totalPages,
});
let getThumbnailRenderSummary = () => ({
    renderedCount: 0,
    renderingCount: 0,
});
const {
    activeScrollSegmentIndex: thumbnailScrollSegmentIndex,
    aspectRatios: thumbnailAspectRatios,
    clearAspectRatios: clearThumbnailAspectRatios,
    contentHeight: thumbnailContentHeight,
    getMaxScrollTop: getThumbnailMaxScrollTop,
    getPageBounds: getThumbnailPageBounds,
    getPageTop: getThumbnailTop,
    getViewport: getThumbnailViewport,
    itemChromeHeight: thumbnailItemChromeHeight,
    layout: thumbnailLayout,
    layoutWidth: thumbnailLayoutWidth,
    resolveInsertionIndex,
    resolvePageAtOffset: resolvePageAtScrollOffset,
    resolveScrollSegmentTransition,
    setActiveScrollSegmentForPage,
    updateAspectRatio: updateThumbnailAspectRatio,
} = usePdfThumbnailVirtualLayout({
    captureAnchor: captureThumbnailLayoutAnchor,
    pageCount: computed(() => totalPages),
    scheduleReaction: scheduleThumbnailLayoutReaction,
});
const viewportStartIndex = computed(() => {
    if (totalPages <= 0) {
        return 0;
    }
    const startPage = resolvePageAtScrollOffset(scrollTop.value) ?? 1;
    return Math.max(0, startPage - 1);
});
const viewportEndIndex = computed(() => {
    if (totalPages <= 0) {
        return -1;
    }
    const viewportBottom = scrollTop.value + Math.max(viewportHeight.value, DEFAULT_THUMBNAIL_ITEM_HEIGHT);
    const endPage = resolvePageAtScrollOffset(viewportBottom) ?? totalPages;
    return Math.min(totalPages - 1, endPage - 1);
});
const visibleStartIndex = computed(() => Math.max(0, viewportStartIndex.value - VIRTUAL_OVERSCAN));
const visibleEndIndex = computed(() => Math.min(totalPages - 1, viewportEndIndex.value + VIRTUAL_OVERSCAN));
const viewportPages = computed(() => {
    if (totalPages <= 0 || viewportEndIndex.value < viewportStartIndex.value) {
        return [] as number[];
    }
    return Array.from(
        {length: viewportEndIndex.value - viewportStartIndex.value + 1},
        (_, index) => viewportStartIndex.value + index + 1,
    );
});
const virtualPages = computed(() => {
    return resolveThumbnailVirtualPages(
        visibleStartIndex.value,
        visibleEndIndex.value,
        totalPages,
        currentPage,
        thumbnailLayout.value.getScrollSegment(thumbnailScrollSegmentIndex.value),
    );
});
const virtualWrapperStyle = computed(() => {
    if (totalPages <= 0) {
        return {height: '0px'};
    }
    return {height: `${Math.max(0, thumbnailContentHeight.value)}px`};
});

watch(() => currentPage, page => {
    setActiveScrollSegmentForPage(page);
}, {immediate: true});
function getThumbnailCanvasStyle(page: number) {
    return createThumbnailCanvasStyle(thumbnailLayout.value.getPageAspect(page));
}
function getThumbnailStyle(page: number) {
    return createThumbnailItemStyle(
        getThumbnailTop(page),
        thumbnailLayout.value.getPageHeight(page),
    );
}

const {
    isDragging,
    isExternalDragOver,
    draggedPages,
    dropInsertIndex,
    handleMouseDown: handleDragMouseDown,
    handlePointerCancel: handleDragPointerCancel,
    consumeClickSkip,
    handleDragEnter: handleExternalDragEnter,
    handleDragOver: handleExternalDragOver,
    handleDragLeave: handleExternalDragLeave,
    handleExternalDrop,
} = usePageDragDrop({
    containerRef,
    totalPages: computed(() => totalPages),
    selectedPages: computed(() => selectedPages ?? []),
    selectedPageSelection: computed(() => selectedPageSelection ?? null),
    resolveDropIndex: (clientY, container) => {
        const rect = container.getBoundingClientRect();
        const offsetY = clientY - rect.top + container.scrollTop;
        return clamp(resolveInsertionIndex(offsetY), 0, totalPages);
    },
    onReorder: (newOrder) => emit('reorder', newOrder),
    onMove: hasPageSelectionModel ? (move: TPageMoveOperation) => emit('move', move) : undefined,
    onExternalFileDrop: (afterPage, filePaths) =>
        emit('file-drop', {
            afterPage,
            filePaths,
        }),
});
const { t } = useTypedI18n();
const {
    handleContainerFocusIn,
    handleContainerKeyDown,
    handleThumbnailClick,
    handleThumbnailContextMenu,
    isSelected,
    rovingFocusPage,
    toggleSinglePageSelection,
} = usePdfThumbnailSelection({
    consumeClickSkip,
    currentPage: computed(() => currentPage),
    focusPageElement: page => void nextTick()
        .then(waitForNextFrame)
        .then(() => getThumbnailElement(page)?.focus({preventScroll: true})),
    isDragging,
    isExternalDragOver,
    markUserInteraction,
    onContextMenu: payload => emit('page-context-menu', payload),
    onGoToPage: page => emit('go-to-page', page, {navigationSource: 'thumbnail'}),
    onMove: hasPageSelectionModel ? (move: TPageMoveOperation) => emit('move', move) : undefined,
    onReorder: newOrder => emit('reorder', newOrder),
    onSelectedPagesChange: pages => emit('update:selected-pages', pages),
    onPageSelectionChange: hasPageSelectionModel ? (selection: TPageSelection) => emit('update:selected-page-selection', selection) : undefined,
    renderedPages: virtualPages,
    scrollPageIntoKeyboardView,
    selectedPages: computed(() => selectedPages ?? []),
    selectedPageSelection: hasPageSelectionModel ? computed<TPageSelection | null>(() => selectedPageSelection ?? null) : undefined,
    totalPages: computed(() => totalPages),
});

function getThumbnailSelectionLabel(page: number) {
    return isSelected(page)
        ? t('pageOps.deselectPage', { page: formatPageIndicatorWithOptions(page, pageLabels ?? null) })
        : t('pageOps.selectPage', { page: formatPageIndicatorWithOptions(page, pageLabels ?? null) });
}
function getCanvas(pageNum: number): HTMLCanvasElement | null {
    if (!containerRef.value) {
        return null;
    }
    const thumbnail = containerRef.value.querySelector<HTMLElement>(
        `.pdf-thumbnail[data-page="${pageNum}"]`,
    );
    return thumbnail?.querySelector('canvas') ?? null;
}
function getThumbnailElement(pageNum: number) {
    if (!containerRef.value) {
        return null;
    }
    return containerRef.value.querySelector<HTMLElement>(
        `.pdf-thumbnail[data-page="${pageNum}"]`,
    );
}
function markUserInteraction(reason: string) {
    const now = Date.now();
    lastUserInteractionAtMs = now;
    if (
        reason === lastUserInteractionReason
        && (now - lastUserInteractionLogAtMs) < INTERACTION_DIAGNOSTIC_THROTTLE_MS
    ) {
        return;
    }

    lastUserInteractionReason = reason;
    lastUserInteractionLogAtMs = now;
    BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Thumbnail user interaction detected', {
        reason,
        currentPage: currentPage,
        totalPages: totalPages,
    });
}
function isRecentProgrammaticScroll() {
    return (Date.now() - lastProgrammaticScrollAtMs) < DOCUMENT_THUMBNAIL_PROGRAMMATIC_SCROLL_GUARD_MS;
}

function isCurrentPageAutoSyncSuppressed() {
    if ((Date.now() - lastUserInteractionAtMs) < DOCUMENT_THUMBNAIL_AUTO_FOLLOW_COOLDOWN_MS) {
        return true;
    }

    return manualScrollSourceCycleId === thumbnailSourceCycleId
        && isThumbnailLayoutStabilizing();
}

function waitForNextFrame() {
    return new Promise<void>((resolve) => {
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
            resolve();
            return;
        }

        window.requestAnimationFrame(() => resolve());
    });
}

function isThumbnailPaneActive() {
    return isActive !== false;
}
function isThumbnailLayoutStabilizing() {
    return (
        thumbnailAspectRatios.value.size === 0
        || !thumbnailMeasurementDiagnostics.isReady()
        || !thumbnailRenderRuntime.hasRenderedThumbnails()
    );
}

function clampPage(page: number) {
    return clamp(page, 1, Math.max(1, totalPages));
}

function resolveViewportAnchorPage() {
    if (totalPages <= 0) {
        return null;
    }

    return clampPage(resolvePageAtScrollOffset(scrollTop.value) ?? 1);
}

function shouldPreferVisibleAnchorOverCurrentPage() {
    return !getThumbnailElement(currentPage);
}

function markManualThumbnailScroll(reason: string) {
    manualScrollSourceCycleId = thumbnailSourceCycleId;
    markUserInteraction(reason);
}

function captureThumbnailLayoutAnchor(): IDocumentThumbnailLayoutAnchor | null {
    if (!isResizing && manualScrollSourceCycleId !== thumbnailSourceCycleId) {
        return null;
    }

    const container = resolveVisibleContainer('thumbnail-measure-anchor');
    if (!container) {
        return null;
    }

    const resizeViewportAnchor = thumbnailResizeAnchorLifecycle.read();
    const anchorPage = resizeViewportAnchor?.page ?? resolveViewportAnchorPage();
    if (anchorPage === null) {
        return null;
    }

    return {
        page: anchorPage,
        offset: resizeViewportAnchor?.offset ?? scrollTop.value - getThumbnailTop(anchorPage),
    };
}

function restoreThumbnailLayoutAnchor(anchor: IDocumentThumbnailLayoutAnchor | null) {
    if (!anchor) {
        return false;
    }
    const container = resolveVisibleContainer('thumbnail-measure-anchor');
    if (!container) {
        return false;
    }
    setActiveScrollSegmentForPage(anchor.page);
    const nextScrollTop = getThumbnailTop(anchor.page) + anchor.offset;
    return applyThumbnailScrollTop(
        container,
        clamp(nextScrollTop, 0, getThumbnailMaxScrollTop(container.clientHeight)),
    );
}

const thumbnailResizeAnchorLifecycle = createDocumentThumbnailResizeAnchorLifecycle<IDocumentThumbnailLayoutAnchor>({
    capture: () => {
        const container = resolveVisibleContainer('thumbnail-resize-anchor-capture');
        if (!container || totalPages <= 0) {
            return null;
        }
        const page = clampPage(resolvePageAtScrollOffset(container.scrollTop) ?? 1);
        return {
            page,
            offset: container.scrollTop - getThumbnailTop(page),
        };
    },
    restore: restoreThumbnailLayoutAnchor,
});

let pendingThumbnailLayoutAnchor: IDocumentThumbnailLayoutAnchor | null | undefined;
function scheduleThumbnailLayoutReaction(
    capturedAnchor: IDocumentThumbnailLayoutAnchor | null = captureThumbnailLayoutAnchor(),
) {
    if (pendingThumbnailLayoutAnchor !== undefined || capturedAnchor && restoreThumbnailLayoutAnchor(capturedAnchor)) {
        return;
    }
    pendingThumbnailLayoutAnchor = capturedAnchor;
    void nextTick(() => {
        const anchor = pendingThumbnailLayoutAnchor ?? null;
        pendingThumbnailLayoutAnchor = undefined;
        if (restoreThumbnailLayoutAnchor(anchor)) {
            return;
        }
        if (!isCurrentPageAutoSyncSuppressed()) {
            void syncCurrentPageIntoView('thumbnail-measure');
        }
    });
}

function scrollPageIntoKeyboardView(page: number): void | Promise<void> {
    const container = resolveVisibleContainer('keyboard-selection');
    if (!container) {
        return;
    }

    const switchedSegment = setActiveScrollSegmentForPage(page);
    if (switchedSegment) {
        return nextTick(async () => {
            const currentContainer = resolveVisibleContainer('keyboard-selection-segment');
            if (!currentContainer) {
                return;
            }
            // The segment wrapper must be in the DOM before this geometry is
            // resolved. Updating the viewport also makes the target page part
            // of the next virtual range before focus is requested.
            updateViewportMetrics();
            const targetScrollTop = resolveCurrentPageSyncScrollTop(currentContainer, page);
            if (targetScrollTop !== null) {
                applyThumbnailScrollTop(currentContainer, targetScrollTop);
            } else {
                void scheduleVisibleThumbnailRender();
            }
            await nextTick();
        });
    }

    const targetScrollTop = resolveCurrentPageSyncScrollTop(container, page);
    if (targetScrollTop !== null) {
        applyThumbnailScrollTop(container, targetScrollTop);
    }
}

function isThumbnailElementFullyVisible(container: HTMLElement, page: number) {
    const thumbnail = getThumbnailElement(page);
    if (!thumbnail) {
        return false;
    }

    const containerRect = container.getBoundingClientRect();
    const thumbnailRect = thumbnail.getBoundingClientRect();
    return (
        thumbnailRect.top >= containerRect.top
        && thumbnailRect.bottom <= containerRect.bottom
    );
}

function resolveCurrentPageSyncRequest(
    reason: string,
    options: { force?: boolean } = {},
) {
    const container = resolveVisibleContainer(`current-page-sync:${reason}`);
    if (
        !container ||
        totalPages <= 0 ||
        (isResizing || thumbnailResizeAnchorLifecycle.isActive()) ||
        isDragging.value ||
        isExternalDragOver.value ||
        (!options.force && isCurrentPageAutoSyncSuppressed())
    ) {
        return null;
    }
    const targetScrollTop = resolveCurrentPageSyncScrollTop(container, currentPage);
    return targetScrollTop === null ? null : {
        container,
        targetScrollTop,
    };
}

async function isCurrentPageSyncRunActive(syncRunId: number) {
    await nextTick();
    return syncRunId === currentPageSyncRunId;
}

function applyRefinedCurrentPageSync(
    container: HTMLElement,
    options: { force?: boolean } = {},
) {
    if (!options.force && isCurrentPageAutoSyncSuppressed()) {
        return;
    }

    const refinedScrollTop = resolveRefinedCurrentPageScrollTop(container, currentPage);
    if (refinedScrollTop !== null) {
        applyThumbnailScrollTop(container, refinedScrollTop);
    }
}

function resolveVisibleContainer(reason: string) {
    if (isActive === false) {
        return null;
    }

    const container = containerRef.value;
    if (!container) {
        if (containerVisibilityState !== 'unknown') {
            BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Thumbnail container detached', {
                reason,
                stateBeforeDetach: containerVisibilityState,
                currentPage: currentPage,
                totalPages: totalPages,
            });
            containerVisibilityState = 'unknown';
        }
        return null;
    }

    const isVisible = isContainerVisible(container);
    const nextState = isVisible ? 'visible' : 'hidden';
    if (containerVisibilityState !== nextState) {
        const renderSummary = getThumbnailRenderSummary();
        containerVisibilityState = nextState;
        BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, nextState === 'visible'
            ? 'Thumbnail container became visible'
            : 'Thumbnail container became hidden', {
            reason,
            currentPage: currentPage,
            totalPages: totalPages,
            geometry: describeContainerGeometry(container),
            contentHeight: roundMetric(thumbnailContentHeight.value),
            renderedPages: renderSummary.renderedCount,
            renderingPages: renderSummary.renderingCount,
        });
    }

    if (!isVisible) {
        return null;
    }

    return container;
}

function updateViewportMetrics() {
    const container = resolveVisibleContainer('update-viewport-metrics');
    if (!container) {
        return;
    }
    const previousViewportHeight = viewportHeight.value;
    scrollTop.value = container.scrollTop;
    viewportHeight.value = container.clientHeight;
    const nextThumbnailLayoutWidth = thumbnailRenderRuntime.resolveThumbnailRenderWidth(container);
    if (Math.abs(nextThumbnailLayoutWidth - thumbnailLayoutWidth.value) >= THUMBNAIL_WIDTH_CHANGE_THRESHOLD) {
        const previousThumbnailLayoutWidth = thumbnailLayoutWidth.value;
        thumbnailLayoutWidth.value = nextThumbnailLayoutWidth;
        BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Thumbnail layout width changed', {
            previousThumbnailLayoutWidth: roundMetric(previousThumbnailLayoutWidth),
            nextThumbnailLayoutWidth: roundMetric(thumbnailLayoutWidth.value),
            currentPage: currentPage,
            totalPages: totalPages,
            geometry: describeContainerGeometry(container),
        });
    }
    const nextThumbnailItemChromeHeight = thumbnailRenderRuntime.resolveThumbnailItemChromeHeight(container);
    if (
        nextThumbnailItemChromeHeight !== null
        && Math.abs(nextThumbnailItemChromeHeight - thumbnailItemChromeHeight.value) >= 0.5
    ) {
        const previousThumbnailItemChromeHeight = thumbnailItemChromeHeight.value;
        thumbnailItemChromeHeight.value = nextThumbnailItemChromeHeight;
        BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Thumbnail item chrome height changed', {
            previousThumbnailItemChromeHeight: roundMetric(previousThumbnailItemChromeHeight),
            nextThumbnailItemChromeHeight: roundMetric(nextThumbnailItemChromeHeight),
            currentPage,
            totalPages,
        });
    }
    if (Math.abs(previousViewportHeight - viewportHeight.value) >= 1) {
        BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Thumbnail viewport height changed', {
            previousViewportHeight: roundMetric(previousViewportHeight),
            nextViewportHeight: roundMetric(viewportHeight.value),
            currentPage: currentPage,
            totalPages: totalPages,
            geometry: describeContainerGeometry(container),
        });
    }
    thumbnailRenderRuntime.reconcileSurfaceResidency();
}

function updateScrollPosition() {
    const container = containerRef.value;
    if (!container || !isThumbnailPaneActive()) {
        return;
    }
    scrollTop.value = container.scrollTop;
}

function commitThumbnailRasterWidth() {
    const nextThumbnailRenderWidth = resolveThumbnailRasterWidth(thumbnailLayoutWidth.value);
    if (nextThumbnailRenderWidth === thumbnailRenderWidth.value) {
        return false;
    }

    const previousThumbnailRenderWidth = thumbnailRenderWidth.value;
    thumbnailRenderWidth.value = nextThumbnailRenderWidth;
    BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Thumbnail raster width committed', {
        previousThumbnailRenderWidth: roundMetric(previousThumbnailRenderWidth),
        nextThumbnailRenderWidth: roundMetric(nextThumbnailRenderWidth),
        thumbnailLayoutWidth: roundMetric(thumbnailLayoutWidth.value),
        currentPage,
        totalPages,
    });
    return true;
}

const scheduleThumbnailRasterWidthCommit = useDebounceFn(() => {
    if (isResizing || !commitThumbnailRasterWidth()) {
        return;
    }
    void nextTick(() => scheduleVisibleThumbnailRender());
}, THUMBNAIL_RASTER_RESIZE_SETTLE_MS);

async function syncCurrentPageIntoView(
    reason: string,
    options: { force?: boolean } = {},
) {
    const request = resolveCurrentPageSyncRequest(reason, options);
    if (!request || !applyThumbnailScrollTop(request.container, request.targetScrollTop)) {
        return;
    }

    const syncRunId = ++currentPageSyncRunId;
    if (!await isCurrentPageSyncRunActive(syncRunId)) {
        return;
    }

    applyRefinedCurrentPageSync(request.container, options);
}

const measureThumbnailHeight = useDebounceFn(() => {
    const container = resolveVisibleContainer('measure-thumbnail-height');
    if (container) {
        thumbnailMeasurementDiagnostics.measure(container);
    }
}, 16);

function handleContainerWheel() {
    if (!isRecentProgrammaticScroll()) {
        markManualThumbnailScroll('wheel');
    }
}

function handleContainerPointerDown() {
    markManualThumbnailScroll('pointerdown');
}
async function refreshVisibleThumbnailPane(reason: string) {
    if (!isThumbnailPaneActive()) {
        return;
    }

    const refreshRunId = ++activePaneRefreshRunId;
    for (let attempt = 0; attempt < AUTO_SYNC_LAYOUT_RETRY_COUNT; attempt += 1) {
        await nextTick();
        await waitForNextFrame();
        if (refreshRunId !== activePaneRefreshRunId || !isThumbnailPaneActive()) {
            return;
        }
        updateViewportMetrics();
        await syncCurrentPageIntoView(reason);
        await nextTick();
        if (refreshRunId !== activePaneRefreshRunId || !isThumbnailPaneActive()) {
            return;
        }

        const container = containerRef.value;
        if (container && isContainerVisible(container) && isThumbnailElementFullyVisible(container, currentPage)) {
            break;
        }
    }

    void scheduleVisibleThumbnailRender();
    void measureThumbnailHeight();
}

function cancelActivePaneRefresh() {
    activePaneRefreshRunId += 1;
}

function scheduleActivePaneRefresh(reason: string) {
    if (!isThumbnailPaneActive()) {
        cancelActivePaneRefresh();
        return;
    }

    void refreshVisibleThumbnailPane(reason);
}

const thumbnailRenderRuntime = usePdfThumbnailRenderRuntime({
    dom: {
        getCanvas,
        resolveVisibleContainer,
    },
    effects: {
        cancelActivePaneRefresh,
        measureThumbnailHeight,
        onSourceCycleStarted: () => {
            thumbnailSourceCycleId += 1;
            lastUserInteractionAtMs = 0;
            manualScrollSourceCycleId = -1;
        },
        refreshVisibleThumbnailPane,
        resetMeasurementState: () => {
            thumbnailMeasurementDiagnostics.reset();
        },
        scheduleActivePaneRefresh,
    },
    layout: {
        resolveViewportAnchorPage,
        shouldPreferVisibleAnchorOverCurrentPage,
        thumbnailAspectRatios,
        thumbnailLayoutWidth,
        thumbnailRenderWidth,
        viewportPages,
        clearThumbnailAspectRatios,
        updateThumbnailAspectRatio,
        virtualPages,
    },
    source: {
        currentPage: computed(() => currentPage),
        invalidationRequest: computed(() => invalidationRequest),
        isActive: computed(() => isActive ?? true),
        pdfDocument: computed(() => pdfDocument),
        rasterScheduler: computed(() => rasterScheduler),
        totalPages: computed(() => totalPages),
    },
    visuals: {
        annotationComments: computed(() => annotationComments ?? []),
        annotationSettings: computed(() => annotationSettings),
        hiddenAnnotationIds: computed(() => hiddenAnnotationIds ?? []),
    },
});
const { scheduleVisibleThumbnailRender } = thumbnailRenderRuntime;
getThumbnailRenderSummary = thumbnailRenderRuntime.getRenderSummary;
const {
    applyScrollTop: applyThumbnailScrollTop,
    cancel: cancelThumbnailScroll,
    handleContainerScroll,
    resolveCurrentPageSyncScrollTop,
    resolveRefinedCurrentPageScrollTop,
} = createPdfThumbnailScrollController({
    activeSegmentIndex: thumbnailScrollSegmentIndex,
    containerRef,
    getMaxScrollTop: getThumbnailMaxScrollTop,
    getPageBounds: getThumbnailPageBounds,
    getThumbnailElement,
    getViewport: getThumbnailViewport,
    isRecentProgrammaticScroll,
    markManualScroll: markManualThumbnailScroll,
    markProgrammaticScroll: () => {
        lastProgrammaticScrollAtMs = Date.now();
    },
    resolveSegmentTransition: resolveScrollSegmentTransition,
    scheduleVisibleThumbnailRender,
    setActiveSegmentForPage: setActiveScrollSegmentForPage,
    updateScrollPosition,
    updateViewportMetrics,
});

watch(
    containerRef,
    () => {
        updateViewportMetrics();
        void syncCurrentPageIntoView('container-ref');
    },
    { immediate: true },
);

watch(
    virtualPages,
    async () => {
        await nextTick();
        await waitForNextFrame();
        updateViewportMetrics();
    },
    {
        flush: 'post',
        immediate: true,
    },
);

useResizeObserver(containerRef, () => {
    resolveVisibleContainer('resize-observer');
    if (thumbnailResizeAnchorLifecycle.isActive()) {
        thumbnailResizeAnchorLifecycle.preserve();
    }
    updateViewportMetrics();
    if (!isResizing && !thumbnailResizeAnchorLifecycle.isActive()) {
        void scheduleThumbnailRasterWidthCommit();
        void scheduleVisibleThumbnailRender();
    }
    void measureThumbnailHeight();
    if (!isResizing && !thumbnailResizeAnchorLifecycle.isActive()) {
        void syncCurrentPageIntoView('resize-observer');
    }
});

watch(
    () => isResizing,
    (resizing, wasResizing) => {
        if (resizing) {
            thumbnailResizeAnchorLifecycle.begin();
            updateViewportMetrics();
            currentPageSyncRunId += 1;
            return;
        }
        updateViewportMetrics();
        if (!wasResizing) {
            return;
        }
        if (commitThumbnailRasterWidth()) {
            void nextTick(() => scheduleVisibleThumbnailRender());
        }
        void measureThumbnailHeight();
        void thumbnailResizeAnchorLifecycle.finish().then(() => {
            updateViewportMetrics();
            void scheduleVisibleThumbnailRender();
        });
    },
);

onBeforeUnmount(() => {
    cancelThumbnailScroll();
    thumbnailResizeAnchorLifecycle.cancel();
});
</script>
<style scoped src="./PdfThumbnails.css"></style>
