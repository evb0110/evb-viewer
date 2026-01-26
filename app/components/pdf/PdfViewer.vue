<template>
    <div
        class="pdf-viewer-container"
        :class="{ 'pdf-viewer-container--dark': invertColors }"
    >
        <div v-if="src && isLoading" class="pdf-loader">
            <USkeleton class="pdf-loader__skeleton" />
        </div>
        <div
            id="pdf-viewer"
            ref="viewerContainer"
            class="pdfViewer app-scrollbar"
            :class="{
                'is-dragging': isDragging,
                'drag-mode': dragMode,
                'pdfViewer--hidden': src && isLoading,
                'pdfViewer--fit-height': fitMode === 'height',
            }"
            :style="containerStyle"
            @scroll.passive="handleScroll"
            @mousedown="handleDragStart"
            @mousemove="handleDragMove"
            @mouseup="stopDrag"
            @mouseleave="stopDrag"
        >
            <PdfViewerPage
                v-for="page in pagesToRender"
                :key="page"
                :page="page"
                :show-skeleton="shouldShowSkeleton(page)"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    nextTick,
    onMounted,
    onUnmounted,
    ref,
    watch,
} from 'vue';
import {
    useDebounceFn,
    useResizeObserver,
} from '@vueuse/core';
import PdfViewerPage from '@app/components/pdf/PdfViewerPage.vue';
import { usePdfDocument } from '@app/composables/pdf/usePdfDocument';
import { usePdfDrag } from '@app/composables/pdf/usePdfDrag';
import { usePdfPageRenderer } from '@app/composables/pdf/usePdfPageRenderer';
import { usePdfScale } from '@app/composables/pdf/usePdfScale';
import { usePdfScroll } from '@app/composables/pdf/usePdfScroll';
import { usePdfSkeletonInsets } from '@app/composables/pdf/usePdfSkeletonInsets';
import { delay } from 'es-toolkit/promise';
import { range } from 'es-toolkit/math';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    PDFDocumentProxy,
    TPdfSource,
    TFitMode,
} from '@app/types/pdf';

import 'pdfjs-dist/web/pdf_viewer.css';

interface IProps {
    src: TPdfSource | null;
    bufferPages?: number;
    zoom?: number;
    dragMode?: boolean;
    fitMode?: TFitMode;
    isResizing?: boolean;
    invertColors?: boolean;
    showAnnotations?: boolean;
    searchPageMatches?: Map<number, IPdfPageMatches>;
    currentSearchMatch?: IPdfSearchMatch | null;
    /** Path to the working copy of the PDF for OCR text layer lookup */
    workingCopyPath?: string | null;
}

const {
    src,
    bufferPages = 2,
    zoom = 1,
    dragMode = false,
    fitMode = 'width',
    isResizing = false,
    invertColors = false,
    showAnnotations = true,
    searchPageMatches = new Map<number, IPdfPageMatches>(),
    currentSearchMatch = null,
    workingCopyPath = null,
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:zoom', value: number): void;
    (e: 'update:currentPage', page: number): void;
    (e: 'update:totalPages', total: number): void;
    (e: 'update:loading', loading: boolean): void;
    (e: 'update:document', document: PDFDocumentProxy | null): void;
    (e: 'loading', loading: boolean): void;
}>();

const viewerContainer = ref<HTMLElement | null>(null);

const pdfDocumentResult = usePdfDocument();
const {
    pdfDocument,
    numPages,
    isLoading,
    basePageWidth,
    basePageHeight,
    getRenderVersion,
    loadPdf,
    getPage,
    saveDocument,
    cleanup: cleanupDocument,
} = pdfDocumentResult;

const {
    currentPage,
    visibleRange,
    getMostVisiblePage,
    scrollToPage: scrollToPageInternal,
    updateCurrentPage,
    updateVisibleRange,
} = usePdfScroll();

const {
    isDragging,
    startDrag,
    onDrag,
    stopDrag,
} = usePdfDrag(() => dragMode);

const {
    containerStyle,
    scaledMargin,
    computeFitWidthScale,
    effectiveScale,
    resetScale,
} = usePdfScale(() => zoom, () => fitMode, basePageWidth, basePageHeight);

const {
    computeSkeletonInsets,
    resetInsets,
} = usePdfSkeletonInsets(basePageWidth, basePageHeight, effectiveScale);

const {
    setupPagePlaceholders,
    renderVisiblePages,
    reRenderAllVisiblePages,
    cleanupAllPages: cleanupRenderedPages,
    applySearchHighlights,
    isPageRendered,
} = usePdfPageRenderer({
    container: viewerContainer,
    document: pdfDocumentResult,
    currentPage,
    effectiveScale,
    bufferPages: () => bufferPages,
    showAnnotations: () => showAnnotations,
    scrollToPage,
    searchPageMatches: () => searchPageMatches,
    currentSearchMatch: () => currentSearchMatch,
    workingCopyPath: () => workingCopyPath,
});

const pagesToRender = computed(() => range(1, numPages.value + 1));

const SKELETON_BUFFER = 3;

function isPageNearVisible(page: number) {
    const start = Math.max(1, visibleRange.value.start - SKELETON_BUFFER);
    const end = Math.min(numPages.value, visibleRange.value.end + SKELETON_BUFFER);
    return page >= start && page <= end;
}

function shouldShowSkeleton(page: number) {
    return isPageNearVisible(page) && !isPageRendered(page);
}

function handleDragStart(e: MouseEvent) {
    startDrag(e, viewerContainer.value);
}

function handleDragMove(e: MouseEvent) {
    onDrag(e, viewerContainer.value);
}

function getVisibleRange() {
    updateVisibleRange(viewerContainer.value, numPages.value);
    return visibleRange.value;
}

async function loadFromSource() {
    if (!src) {
        return;
    }

    // Notify listeners before tearing down the previous PDF instance.
    // This prevents consumers (e.g. sidebar thumbnails) from calling into a document that is being destroyed.
    emit('update:document', null);
    emit('update:totalPages', 0);
    emit('update:currentPage', 1);

    cleanupRenderedPages();
    resetScale();
    resetInsets();

    currentPage.value = 1;
    visibleRange.value = {
        start: 1,
        end: 1,
    };

    const loaded = await loadPdf(src);
    if (!loaded) {
        return;
    }

    emit('update:document', pdfDocument.value);

    currentPage.value = 1;
    emit('update:totalPages', numPages.value);
    emit('update:currentPage', 1);

    void (async () => {
        try {
            const firstPage = await getPage(1);
            await computeSkeletonInsets(firstPage, loaded.version, getRenderVersion);
        } catch (error) {
            console.warn('Failed to compute PDF skeleton insets:', error);
        }
    })();

    await nextTick();

    computeFitWidthScale(viewerContainer.value);
    setupPagePlaceholders();

    updateVisibleRange(viewerContainer.value, numPages.value);
    await renderVisiblePages(visibleRange.value);
    applySearchHighlights();
}

const debouncedRenderOnScroll = useDebounceFn(() => {
    if (isLoading.value || !pdfDocument.value) {
        return;
    }
    void renderVisiblePages(visibleRange.value);
}, 100);

function handleScroll() {
    if (isLoading.value) {
        return;
    }

    updateVisibleRange(viewerContainer.value, numPages.value);
    debouncedRenderOnScroll();

    const previous = currentPage.value;
    const page = updateCurrentPage(viewerContainer.value, numPages.value);
    if (page !== previous) {
        emit('update:currentPage', page);
    }
}

function scrollToPage(pageNumber: number) {
    if (!viewerContainer.value || numPages.value === 0) {
        return;
    }

    scrollToPageInternal(
        viewerContainer.value,
        pageNumber,
        numPages.value,
        scaledMargin.value,
    );
    emit('update:currentPage', currentPage.value);

    queueMicrotask(() => {
        if (isLoading.value || !pdfDocument.value) {
            return;
        }
        updateVisibleRange(viewerContainer.value, numPages.value);
        void renderVisiblePages(visibleRange.value);
    });
}

const debouncedRenderOnResize = useDebounceFn(() => {
    if (isLoading.value || !pdfDocument.value) {
        return;
    }
    void reRenderAllVisiblePages(getVisibleRange);
}, 200);

function handleResize() {
    if (isLoading.value || isResizing) {
        return;
    }

    const updated = computeFitWidthScale(viewerContainer.value);
    if (updated && pdfDocument.value) {
        debouncedRenderOnResize();
    }
}

useResizeObserver(viewerContainer, handleResize);

onMounted(() => {
    loadFromSource();
});

onUnmounted(() => {
    cleanupRenderedPages();
    cleanupDocument();
});

watch(
    () => fitMode,
    async (mode) => {
        const pageToSnapTo = mode === 'height'
            ? getMostVisiblePage(viewerContainer.value, numPages.value)
            : null;

        const updated = computeFitWidthScale(viewerContainer.value);
        if (updated && pdfDocument.value) {
            await reRenderAllVisiblePages(getVisibleRange);
            if (pageToSnapTo !== null) {
                await nextTick();
                scrollToPage(pageToSnapTo);
            }
        }
    },
);

watch(
    () => src,
    (newSrc, oldSrc) => {
        if (newSrc !== oldSrc) {
            if (!newSrc) {
                emit('update:document', null);
            }
            loadFromSource();
        }
    },
);

watch(
    () => zoom,
    () => {
        if (pdfDocument.value) {
            void reRenderAllVisiblePages(getVisibleRange);
        }
    },
);

watch(
    () => isResizing,
    async (value) => {
        if (!value && pdfDocument.value && !isLoading.value) {
            await nextTick();
            await delay(20);
            computeFitWidthScale(viewerContainer.value);
            void reRenderAllVisiblePages(getVisibleRange);
        }
    },
);

const isEffectivelyLoading = computed(() => !!src && isLoading.value);

watch(
    isEffectivelyLoading,
    async (value, oldValue) => {
        if (oldValue === true && value === false) {
            await nextTick();
        }
        emit('update:loading', value);
        emit('loading', value);
    },
    { immediate: true },
);

defineExpose({
    scrollToPage,
    saveDocument,
});
</script>

<style scoped>
.pdf-viewer-container {
    position: relative;
    height: 100%;
    width: 100%;
}

.pdf-loader {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: flex;
    justify-content: center;
    align-items: center;
    background: var(--color-surface-muted);
}

.pdf-loader__skeleton {
    width: 64px;
    height: 64px;
    border-radius: 8px;
}

.pdfViewer {
    width: 100%;
    height: 100%;
    overflow: auto;
    background: var(--color-surface-muted);
    display: flex;
    flex-direction: column;
}

.pdfViewer--fit-height {
    overflow-x: auto;
}

.pdfViewer--hidden {
    opacity: 0;
    pointer-events: none;
}

.pdfViewer.drag-mode.is-dragging {
    cursor: grabbing;
    user-select: none;
}

.pdfViewer.drag-mode:not(.is-dragging) {
    cursor: grab;
}

.page_container {
    position: relative;
    margin: 0 auto;
    flex-shrink: 0;
    content-visibility: auto;
    contain-intrinsic-size: auto 800px;
}

.page_container--scroll-target {
    content-visibility: visible;
}

.page_container canvas {
    background: var(--pdf-page-bg);
    box-shadow: var(--pdf-page-shadow);
    border-radius: 2px;
}

.pdfViewer :deep(.page_container--rendered .pdf-page-skeleton) {
    display: none;
}

.page_canvas {
    position: relative;
    width: 100%;
    height: 100%;
    z-index: 0;
}

.pdfViewer :deep(.text-layer) {
    position: absolute;
    text-align: initial;
    inset: 0;
    overflow: clip;
    opacity: 1;
    line-height: 1;
    text-size-adjust: none;
    forced-color-adjust: none;
    transform-origin: 0 0;
    caret-color: CanvasText;
    z-index: 1;
    pointer-events: auto;
    user-select: text;

    /* We multiply the font size by --min-font-size, and then scale the text
     * elements by 1/--min-font-size. This allows us to effectively ignore the
     * minimum font size enforced by the browser, so that the text layer <span>s
     * can always match the size of the text in the canvas. */
    --min-font-size: 1;
    --text-scale-factor: calc(var(--total-scale-factor, 1) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size));
}

.pdfViewer :deep(.text-layer span),
.pdfViewer :deep(.text-layer br) {
    color: transparent;
    position: absolute;
    white-space: pre;
    cursor: text;
    transform-origin: 0% 0%;
}

.pdfViewer :deep(.text-layer > :not(.markedContent)),
.pdfViewer :deep(.text-layer .markedContent span:not(.markedContent)) {
    z-index: 1;
    font-size: calc(var(--text-scale-factor) * var(--font-height, 10px));
    transform: rotate(var(--rotate, 0deg)) scaleX(var(--scale-x, 1)) scale(var(--min-font-size-inv));
}

.pdfViewer :deep(.text-layer .markedContent) {
    display: contents;
}

.pdfViewer :deep(.text-layer br) {
    user-select: none;
}

.pdfViewer :deep(.text-layer ::selection) {
    background: rgb(0 0 255 / 0.25);
}

.pdfViewer :deep(.text-layer br::selection) {
    background: transparent;
}

.pdfViewer :deep(.pdf-search-highlight) {
    background-color: rgb(255 230 0 / 0.5);
    color: transparent;
    border-radius: 2px;
    padding: 0;
    margin: 0;
}

.pdfViewer :deep(.pdf-search-highlight--current) {
    background-color: rgb(255 150 0 / 0.6);
    outline-offset: 0;
}

.pdfViewer :deep(.text-layer .end-of-content) {
    display: block;
    position: absolute;
    inset: 100% 0 0;
    z-index: 0;
    cursor: default;
    user-select: none;
}

.pdfViewer :deep(.text-layer.selecting .end-of-content) {
    top: 0;
}

.pdfViewer :deep(.annotation-layer) {
    position: absolute;
    inset: 0;
    overflow: hidden;
    z-index: 2;
    pointer-events: none;
}

.pdfViewer :deep(.annotation-layer a) {
    pointer-events: auto;
    display: block;
    position: absolute;
}

.pdfViewer :deep(.annotation-layer section) {
    position: absolute;
}

.pdfViewer :deep(.annotation-layer .linkAnnotation > a) {
    background: rgb(255 255 0 / 0);
    transition: background 150ms ease;
}

.pdfViewer :deep(.annotation-layer .linkAnnotation > a:hover) {
    background: rgb(255 255 0 / 0.2);
}

.pdf-viewer-container--dark :deep(.text-layer ::selection) {
    background: rgb(255 200 0 / 0.35);
}

.pdf-viewer-container--dark :deep(.pdf-search-highlight) {
    background-color: rgb(255 230 0 / 0.6);
}

.pdf-viewer-container--dark :deep(.pdf-search-highlight--current) {
    background-color: rgb(255 150 0 / 0.8);
    outline: 2px solid rgb(255 100 0 / 0.9);
}

.pdf-viewer-container--dark .page_container,
.pdf-viewer-container--dark .page_container canvas {
    filter: invert(1) hue-rotate(180deg) saturate(1.05);
}

.pdf-viewer-container--dark .pdfViewer {
    background: var(--color-neutral-900);
}

:global(.page) {
    margin: 1px auto -3px !important;
    border: 1px dashed transparent !important;
    box-shadow: var(--pdf-page-shadow);
    box-sizing: content-box;
    user-select: none;
    position: relative;
}

.pdfViewer :deep(.pdf-word-boxes-layer) {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 0;
}

.pdfViewer :deep(.pdf-word-box) {
    position: absolute;
    border: 1px solid rgba(0, 100, 255, 0.4);
    background: rgba(0, 100, 255, 0.1);
    pointer-events: none;
    box-sizing: border-box;
}

.pdfViewer :deep(.pdf-word-box--current) {
    background: rgba(0, 150, 255, 0.25);
    border-color: rgba(0, 150, 255, 0.8);
}

/* OCR Debug boxes - orange to distinguish from regular word boxes (blue) */
.pdfViewer :deep(.pdf-ocr-debug-layer) {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 10;
}

.pdfViewer :deep(.pdf-ocr-debug-box) {
    position: absolute;
    border: 1px solid rgba(255, 140, 0, 0.7);
    background: rgba(255, 140, 0, 0.15);
    pointer-events: none;
    box-sizing: border-box;
}
</style>

<style>
/* CSS Custom Highlight API (global; works with Electron/Chromium). */
::highlight(pdf-search-match) {
    background-color: rgb(255 230 0 / 0.5);
}

::highlight(pdf-search-current-match) {
    background-color: rgb(255 150 0 / 0.7);
}

.pdf-viewer-container--dark ::highlight(pdf-search-match) {
    background-color: rgb(255 230 0 / 0.6);
}

.pdf-viewer-container--dark ::highlight(pdf-search-current-match) {
    background-color: rgb(255 150 0 / 0.8);
}
</style>
