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
            class="pdfViewer"
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
                :show-skeleton="isPageNearVisible(page)"
                :skeleton-padding="scaledSkeletonPadding"
                :content-height="scaledPageHeight"
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
    toRef,
    watch,
} from 'vue';
import {
    useDebounceFn,
    useResizeObserver,
} from '@vueuse/core';
import PdfViewerPage from './PdfViewerPage.vue';
import { usePdfDocument } from '../../composables/pdf/usePdfDocument';
import { usePdfDrag } from '../../composables/pdf/usePdfDrag';
import { usePdfPageRenderer } from '../../composables/pdf/usePdfPageRenderer';
import { usePdfScale } from '../../composables/pdf/usePdfScale';
import { usePdfScroll } from '../../composables/pdf/usePdfScroll';
import { usePdfSkeletonInsets } from '../../composables/pdf/usePdfSkeletonInsets';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    TFitMode,
} from '../../types/pdf';

import 'pdfjs-dist/web/pdf_viewer.css';

const { setupTextLayer } = useTextLayerSelection();
const {
    clearHighlights,
    highlightPage,
    scrollToHighlight,
} = usePdfSearchHighlight();

interface IPdfViewerProps {
    src: Blob | null;
    bufferPages?: number;
    zoom?: number;
    dragMode?: boolean;
    fitMode?: TFitMode;
    isResizing?: boolean;
    invertColors?: boolean;
    showAnnotations?: boolean;
    searchPageMatches?: Map<number, IPdfPageMatches>;
    currentSearchMatch?: IPdfSearchMatch | null;
}

const props = withDefaults(defineProps<IPdfViewerProps>(), {
    bufferPages: 2,
    zoom: 1,
    dragMode: false,
    fitMode: 'width',
    isResizing: false,
    invertColors: false,
    showAnnotations: true,
    currentSearchMatch: null,
});

const emit = defineEmits<{
    (e: 'update:zoom', value: number): void;
    (e: 'update:currentPage', page: number): void;
    (e: 'update:totalPages', total: number): void;
    (e: 'update:loading', loading: boolean): void;
    (e: 'loading', loading: boolean): void;
}>();

const viewerContainer = ref<HTMLElement | null>(null);

const src = toRef(props, 'src');
const bufferPages = toRef(props, 'bufferPages');
const zoom = toRef(props, 'zoom');
const dragMode = toRef(props, 'dragMode');
const fitMode = toRef(props, 'fitMode');
const isResizing = toRef(props, 'isResizing');
const invertColors = toRef(props, 'invertColors');
const showAnnotations = toRef(props, 'showAnnotations');
const searchPageMatches = toRef(props, 'searchPageMatches');
const currentSearchMatch = toRef(props, 'currentSearchMatch');

const {
    pdfDocument,
    numPages,
    isLoading,
    basePageWidth,
    basePageHeight,
    getRenderVersion,
    loadPdf,
    getPage,
    evictPage,
    cleanupPageCache,
    cleanup: cleanupDocument,
} = usePdfDocument();

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
} = usePdfDrag(() => dragMode.value);

const {
    containerStyle,
    scaledMargin,
    computeFitWidthScale,
    effectiveScale,
    resetScale,
} = usePdfScale(zoom, fitMode, basePageWidth, basePageHeight);

const {
    scaledSkeletonPadding,
    scaledPageHeight,
    computeSkeletonInsets,
    resetInsets,
} = usePdfSkeletonInsets(basePageWidth, basePageHeight, effectiveScale);

const {
    setupPagePlaceholders,
    renderVisiblePages,
    reRenderAllVisiblePages,
    cleanupAllPages: cleanupRenderedPages,
    applySearchHighlights,
    scrollToCurrentMatch,
} = usePdfPageRenderer({
    container: viewerContainer,
    numPages,
    currentPage,
    bufferPages,
    effectiveScale,
    basePageWidth,
    basePageHeight,
    showAnnotations,
    isLoading,
    getPage,
    evictPage,
    cleanupPageCache,
    onGoToPage: (pageNumber) => scrollToPage(pageNumber),
    setupTextLayer,
    searchPageMatches,
    currentSearchMatch,
    clearHighlights,
    highlightPage,
    scrollToHighlight,
});

const pagesToRender = computed(() =>
    Array.from({ length: numPages.value }, (_, i) => i + 1),
);

const SKELETON_BUFFER = 3;

function isPageNearVisible(page: number) {
    const start = Math.max(1, visibleRange.value.start - SKELETON_BUFFER);
    const end = Math.min(numPages.value, visibleRange.value.end + SKELETON_BUFFER);
    return page >= start && page <= end;
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
    if (!src.value) {
        return;
    }

    cleanupRenderedPages();
    resetScale();
    resetInsets();

    currentPage.value = 1;
    visibleRange.value = {
        start: 1,
        end: 1,
    };

    const loaded = await loadPdf(src.value);
    if (!loaded) {
        return;
    }

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
    if (isLoading.value || isResizing.value) {
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
    () => fitMode.value,
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
    () => src.value,
    () => {
        loadFromSource();
    },
);

watch(
    () => zoom.value,
    () => {
        if (pdfDocument.value) {
            void reRenderAllVisiblePages(getVisibleRange);
        }
    },
);

watch(
    () => isResizing.value,
    async (value) => {
        if (!value && pdfDocument.value && !isLoading.value) {
            await nextTick();
            await new Promise((r) => setTimeout(r, 20));
            computeFitWidthScale(viewerContainer.value);
            void reRenderAllVisiblePages(getVisibleRange);
        }
    },
);

const isEffectivelyLoading = computed(() => !!src.value && isLoading.value);

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

function getPdfDocument() {
    return pdfDocument.value;
}

async function saveDocument(): Promise<Uint8Array | null> {
    if (!pdfDocument.value) {
        return null;
    }
    return pdfDocument.value.saveDocument();
}

defineExpose({
    scrollToPage,
    getPdfDocument,
    saveDocument,
    applySearchHighlights,
    scrollToCurrentMatch,
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
    scrollbar-width: thin;
    scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);

    &::-webkit-scrollbar {
        width: 0.5rem;
        height: 0.5rem;
    }

    &::-webkit-scrollbar-track {
        background: var(--scrollbar-track);
        border-radius: 0.4rem;
        border: none;
    }

    &::-webkit-scrollbar-thumb {
        background: var(--scrollbar-thumb);
        border-radius: 0.4rem;
        border: none;
    }

    &::-webkit-scrollbar-thumb:hover {
        background: var(--scrollbar-thumb-hover);
    }
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

.page_container canvas {
    background: var(--pdf-page-bg);
    box-shadow: var(--pdf-page-shadow);
    border-radius: 2px;
}

.page_canvas {
    position: relative;
    width: 100%;
    height: 100%;
    z-index: 0;
}

.text-layer {
    position: absolute;
    text-align: initial;
    inset: 0;
    overflow: clip;
    opacity: 1;
    line-height: 1;
    -webkit-text-size-adjust: none;
    -moz-text-size-adjust: none;
    text-size-adjust: none;
    forced-color-adjust: none;
    transform-origin: 0 0;
    caret-color: CanvasText;
    z-index: 0;
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

.text-layer :deep(span),
.text-layer :deep(br) {
    color: transparent;
    position: absolute;
    white-space: pre;
    cursor: text;
    transform-origin: 0% 0%;
}

.text-layer :deep(> span),
.text-layer :deep(.markedContent span) {
    z-index: 1;
    font-size: calc(var(--text-scale-factor) * var(--font-height, 10px));
    transform: rotate(var(--rotate, 0deg)) scaleX(var(--scale-x, 1)) scale(var(--min-font-size-inv));
}

.text-layer :deep(.markedContent) {
    display: contents;
}

.text-layer :deep(br) {
    user-select: none;
}

.text-layer :deep(::selection) {
    background: rgb(0 0 255 / 0.25);
}

.text-layer :deep(br::selection) {
    background: transparent;
}

.text-layer :deep(.pdf-search-highlight) {
    background-color: rgb(255 230 0 / 0.5);
    color: transparent;
    border-radius: 2px;
    padding: 0;
    margin: 0;
}

.text-layer :deep(.pdf-search-highlight--current) {
    background-color: rgb(255 150 0 / 0.7);
    outline: 2px solid rgb(255 100 0 / 0.8);
    outline-offset: 0;
}

.text-layer :deep(.end-of-content) {
    display: block;
    position: absolute;
    inset: 100% 0 0;
    z-index: 0;
    cursor: default;
    user-select: none;
}

.text-layer.selecting :deep(.end-of-content) {
    top: 0;
}

.annotation-layer {
    position: absolute;
    inset: 0;
    overflow: hidden;
    z-index: 2;
    pointer-events: none;
}

.annotation-layer :deep(a) {
    pointer-events: auto;
}

.annotation-layer :deep(section) {
    position: absolute;
}

.annotation-layer :deep(a) {
    display: block;
    position: absolute;
}

.annotation-layer :deep(.linkAnnotation > a) {
    background: rgb(255 255 0 / 0);
    transition: background 150ms ease;
}

.annotation-layer :deep(.linkAnnotation > a:hover) {
    background: rgb(255 255 0 / 0.2);
}

.pdf-viewer-container--dark .text-layer :deep(::selection) {
    background: rgb(255 200 0 / 0.35);
}

.pdf-viewer-container--dark .text-layer :deep(.pdf-search-highlight) {
    background-color: rgb(255 230 0 / 0.6);
}

.pdf-viewer-container--dark .text-layer :deep(.pdf-search-highlight--current) {
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
}
</style>
