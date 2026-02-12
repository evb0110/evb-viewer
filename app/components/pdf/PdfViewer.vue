<template>
    <div
        class="relative h-full w-full"
        :class="{ 'pdf-viewer-container--dark': invertColors }"
    >
        <div v-if="src && isLoading" class="absolute inset-0 z-[1] flex items-center justify-center bg-[var(--ui-bg-muted)]">
            <USkeleton class="size-16 rounded-lg" />
        </div>
        <div
            id="pdf-viewer"
            ref="viewerContainer"
            class="pdfViewer app-scrollbar"
            :class="{
                'is-dragging': isDragging,
                'drag-mode': dragMode,
                'is-placing-comment': highlightComposable.isPlacingComment.value,
                'pdfViewer--single-page': !continuousScroll,
                'pdfViewer--hidden': src && isLoading,
                'pdfViewer--fit-height': fitMode === 'height',
            }"
            :style="containerStyle"
            @scroll.passive="singlePageScroll.handleScroll"
            @wheel="singlePageScroll.handleWheel"
            @mousedown="handleDragStart"
            @mousemove="handleDragMove"
            @mouseup="highlightComposable.handleViewerMouseUp"
            @mouseleave="stopDrag"
            @click="commentCrud.handleAnnotationCommentClick"
            @dblclick="commentCrud.handleAnnotationEditorDblClick"
            @contextmenu="commentCrud.handleAnnotationCommentContextMenu"
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
    provide,
    ref,
    shallowRef,
    watch,
} from 'vue';
import {
    useDebounceFn,
    useResizeObserver,
} from '@vueuse/core';
import type {AnnotationEditorUIManager} from 'pdfjs-dist';
import {
    AnnotationEditorParamsType,
    PixelsPerInch,
} from 'pdfjs-dist';
import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';
import PdfViewerPage from '@app/components/pdf/PdfViewerPage.vue';
import { usePdfDocument } from '@app/composables/pdf/usePdfDocument';
import { usePdfDrag } from '@app/composables/pdf/usePdfDrag';
import { usePdfPageRenderer } from '@app/composables/pdf/usePdfPageRenderer';
import { usePdfScale } from '@app/composables/pdf/usePdfScale';
import { usePdfScroll } from '@app/composables/pdf/usePdfScroll';
import { usePdfSkeletonInsets } from '@app/composables/pdf/usePdfSkeletonInsets';
import {
    useAnnotationShapes,
    isShapeTool,
} from '@app/composables/pdf/useAnnotationShapes';
import type { IShapeContextProvide } from '@app/composables/pdf/useAnnotationShapes';
import { delay } from 'es-toolkit/promise';
import { range } from 'es-toolkit/math';
import { useFreeTextResize } from '@app/composables/pdf/useFreeTextResize';
import { useAnnotationCommentIdentity } from '@app/composables/pdf/useAnnotationCommentIdentity';
import { useAnnotationMarkupSubtype } from '@app/composables/pdf/useAnnotationMarkupSubtype';
import { useAnnotationCommentSync } from '@app/composables/pdf/useAnnotationCommentSync';
import { useInlineCommentIndicators } from '@app/composables/pdf/useInlineCommentIndicators';
import { useAnnotationToolManager } from '@app/composables/pdf/useAnnotationToolManager';
import { useAnnotationEditorLifecycle } from '@app/composables/pdf/useAnnotationEditorLifecycle';
import { useAnnotationHighlight } from '@app/composables/pdf/useAnnotationHighlight';
import { useAnnotationCommentCrud } from '@app/composables/pdf/useAnnotationCommentCrud';
import { usePdfSinglePageScroll } from '@app/composables/pdf/usePdfSinglePageScroll';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    PDFDocumentProxy,
    TPdfSource,
    TFitMode,
} from '@app/types/pdf';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationTool,
    TShapeType,
} from '@app/types/annotations';
import type { IAnnotationContextMenuPayload } from '@app/composables/pdf/pdfAnnotationUtils';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotation-defaults';

import 'pdfjs-dist/web/pdf_viewer.css';

interface IProps {
    src: TPdfSource | null;
    bufferPages?: number;
    zoom?: number;
    dragMode?: boolean;
    fitMode?: TFitMode;
    continuousScroll?: boolean;
    isResizing?: boolean;
    invertColors?: boolean;
    showAnnotations?: boolean;
    annotationTool?: TAnnotationTool;
    annotationCursorMode?: boolean;
    annotationKeepActive?: boolean;
    annotationSettings?: IAnnotationSettings | null;
    searchPageMatches?: Map<number, IPdfPageMatches>;
    currentSearchMatch?: IPdfSearchMatch | null;
    workingCopyPath?: string | null;
    authorName?: string | null;
}

const props = defineProps<IProps>();

const src = computed(() => props.src);
const bufferPages = computed(() => props.bufferPages ?? 2);
const zoom = computed(() => props.zoom ?? 1);
const dragMode = computed(() => props.dragMode ?? false);
const fitMode = computed<TFitMode>(() => props.fitMode ?? 'width');
const isResizing = computed(() => props.isResizing ?? false);
const invertColors = computed(() => props.invertColors ?? false);
const showAnnotations = computed(() => props.showAnnotations ?? true);
const annotationTool = computed<TAnnotationTool>(() => props.annotationTool ?? 'none');
const annotationCursorMode = computed(() => props.annotationCursorMode ?? false);
const annotationKeepActive = computed(() => props.annotationKeepActive ?? true);
const annotationSettings = computed<IAnnotationSettings | null>(() => props.annotationSettings ?? null);
const emptySearchPageMatches = new Map<number, IPdfPageMatches>();
const searchPageMatches = computed(() => props.searchPageMatches ?? emptySearchPageMatches);
const currentSearchMatch = computed(() => props.currentSearchMatch ?? null);
const workingCopyPath = computed(() => props.workingCopyPath ?? null);
const continuousScroll = computed(() => props.continuousScroll ?? true);
const authorName = computed(() => props.authorName);

const emit = defineEmits<{
    (e: 'update:zoom', value: number): void;
    (e: 'update:currentPage', page: number): void;
    (e: 'update:totalPages', total: number): void;
    (e: 'update:loading', loading: boolean): void;
    (e: 'update:document', document: PDFDocumentProxy | null): void;
    (e: 'loading', loading: boolean): void;
    (e: 'annotation-state', state: IAnnotationEditorState): void;
    (e: 'annotation-modified'): void;
    (e: 'annotation-comments', comments: IAnnotationCommentSummary[]): void;
    (e: 'annotation-open-note', comment: IAnnotationCommentSummary): void;
    (e: 'annotation-context-menu', payload: IAnnotationContextMenuPayload): void;
    (e: 'annotation-tool-auto-reset'): void;
    (e: 'annotation-setting', payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings]
    }): void;
    (e: 'annotation-comment-click', comment: IAnnotationCommentSummary): void;
    (e: 'annotation-tool-cancel'): void;
    (e: 'annotation-note-placement-change', active: boolean): void;
    (e: 'shape-context-menu', payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }): void;
}>();

const viewerContainer = ref<HTMLElement | null>(null);

const annotationUiManager = shallowRef<AnnotationEditorUIManager | null>(null);
const annotationL10n = shallowRef<GenericL10n | null>(null);
const annotationCommentsCache = ref<IAnnotationCommentSummary[]>([]);
const activeCommentStableKey = ref<string | null>(null);

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
} = usePdfDrag(() => dragMode.value);

const {
    containerStyle,
    scaledMargin,
    computeFitWidthScale,
    effectiveScale,
    resetScale,
} = usePdfScale(zoom, fitMode, basePageWidth, basePageHeight);

const {
    computeSkeletonInsets,
    resetInsets,
} = usePdfSkeletonInsets(basePageWidth, basePageHeight, effectiveScale);

const shapeComposable = useAnnotationShapes();

const isShapeToolActive = computed(() => isShapeTool(annotationTool.value));
const activeShapeTool = computed<TShapeType | null>(() => isShapeTool(annotationTool.value) ? annotationTool.value : null);

provide<IShapeContextProvide>('shapeContext', {
    selectedShapeId: shapeComposable.selectedShapeId,
    drawingShape: shapeComposable.drawingShape,
    isShapeToolActive,
    activeShapeTool,
    settings: computed(() => annotationSettings.value ?? DEFAULT_ANNOTATION_SETTINGS),
    getShapesForPage: shapeComposable.getShapesForPage,
    handleStartDrawing(pageIndex: number, coords: {
        x: number;
        y: number
    }) {
        const tool = activeShapeTool.value;
        if (!tool) {
            return;
        }
        const settings = annotationSettings.value;
        if (!settings) {
            return;
        }
        shapeComposable.startDrawing(pageIndex, tool, coords.x, coords.y, settings);
    },
    handleContinueDrawing(coords: {
        x: number;
        y: number
    }) {
        shapeComposable.continueDrawing(coords.x, coords.y);
    },
    handleFinishDrawing() {
        const shape = shapeComposable.finishDrawing();
        if (shape) {
            emit('annotation-modified');
        }
    },
    handleSelectShape(id: string | null) {
        shapeComposable.selectShape(id);
    },
    handleShapeContextMenu(payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }) {
        shapeComposable.selectShape(payload.shapeId);
        emit('shape-context-menu', payload);
    },
});

const identity = useAnnotationCommentIdentity(annotationCommentsCache);

const markupSubtypeComposable = useAnnotationMarkupSubtype({
    annotationUiManager,
    annotationSettings,
    numPages,
    getEditorIdentity: identity.getEditorIdentity,
});

const freeTextResize = useFreeTextResize({
    getAnnotationUiManager: () => annotationUiManager.value,
    getNumPages: () => numPages.value,
    emitAnnotationModified: () => emit('annotation-modified'),
    emitAnnotationSetting: (payload) => emit('annotation-setting', payload),
    scheduleAnnotationCommentsSync: () => commentSync.scheduleAnnotationCommentsSync(),
});

const commentSync = useAnnotationCommentSync({
    pdfDocument,
    numPages,
    currentPage,
    annotationUiManager,
    authorName,
    identity,
    markupSubtype: markupSubtypeComposable,
    annotationCommentsCache,
    activeCommentStableKey,
    emitAnnotationComments: (comments) => emit('annotation-comments', comments),
    syncInlineCommentIndicators: () => inlineIndicators.syncInlineCommentIndicators(),
});

const toolManager = useAnnotationToolManager({
    annotationUiManager,
    currentPage,
    annotationTool,
    annotationCursorMode,
    annotationKeepActive,
    freeTextResize,
    markupSubtype: markupSubtypeComposable,
    emitAnnotationToolAutoReset: () => emit('annotation-tool-auto-reset'),
});

const highlightComposable = useAnnotationHighlight({
    viewerContainer,
    annotationUiManager,
    numPages,
    currentPage,
    annotationTool,
    identity,
    markupSubtype: markupSubtypeComposable,
    commentSync,
    toolManager,
    stopDrag,
    emitAnnotationOpenNote: (comment) => emit('annotation-open-note', comment),
    emitAnnotationNotePlacementChange: (active) => emit('annotation-note-placement-change', active),
});

const inlineIndicators = useInlineCommentIndicators({
    viewerContainer,
    numPages,
    annotationUiManager,
    annotationCommentsCache,
    activeCommentStableKey,
    setActiveCommentStableKey: (key) => commentSync.setActiveCommentStableKey(key),
    identity,
    commentSync,
    emitAnnotationOpenNote: (comment) => emit('annotation-open-note', comment),
    emitAnnotationContextMenu: (payload) => emit('annotation-context-menu', payload),
    buildAnnotationContextMenuPayload: (comment, clientX, clientY) =>
        highlightComposable.buildAnnotationContextMenuPayload(comment, clientX, clientY),
});

const lifecycle = useAnnotationEditorLifecycle({
    viewerContainer,
    pdfDocument,
    numPages,
    currentPage,
    effectiveScale,
    annotationTool,
    annotationUiManager,
    annotationL10n,
    freeTextResize,
    markupSubtype: markupSubtypeComposable,
    commentSync,
    toolManager,
    identity,
    emitAnnotationModified: () => emit('annotation-modified'),
    emitAnnotationState: (state) => emit('annotation-state', state),
    emitAnnotationOpenNote: (comment) => emit('annotation-open-note', comment),
});

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
    bufferPages,
    showAnnotations,
    annotationUiManager,
    annotationL10n,
    scrollToPage: (pageNumber: number) => singlePageScroll.scrollToPage(pageNumber),
    searchPageMatches,
    currentSearchMatch,
    workingCopyPath,
});

const singlePageScroll = usePdfSinglePageScroll({
    viewerContainer,
    numPages,
    currentPage,
    scaledMargin,
    continuousScroll,
    isLoading,
    pdfDocument,
    getMostVisiblePage,
    scrollToPageInternal,
    updateVisibleRange,
    updateCurrentPage,
    renderVisiblePages,
    visibleRange,
    emitCurrentPage: (page) => emit('update:currentPage', page),
});

const commentCrud = useAnnotationCommentCrud({
    viewerContainer,
    pdfDocument,
    annotationUiManager,
    numPages,
    currentPage,
    visibleRange,
    annotationTool,
    identity,
    commentSync,
    freeTextResize,
    toolManager,
    inlineIndicators,
    highlight: highlightComposable,
    scrollToPage: (pageNumber) => singlePageScroll.scrollToPage(pageNumber),
    renderVisiblePages,
    updateVisibleRange,
    emitAnnotationModified: () => emit('annotation-modified'),
    emitAnnotationOpenNote: (comment) => emit('annotation-open-note', comment),
    emitAnnotationCommentClick: (comment) => emit('annotation-comment-click', comment),
    emitAnnotationContextMenu: (payload) => emit('annotation-context-menu', payload),
    emitAnnotationToolCancel: () => emit('annotation-tool-cancel'),
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

function hasRenderedPageCanvas() {
    const container = viewerContainer.value;
    if (!container) {
        return false;
    }
    return Boolean(container.querySelector('.page_container .page_canvas canvas'));
}

function hasRenderedTextLayerContent() {
    const container = viewerContainer.value;
    if (!container) {
        return false;
    }
    return Boolean(container.querySelector('.page_container .text-layer span, .page_container .textLayer span'));
}

async function recoverInitialRenderIfNeeded() {
    if (!pdfDocument.value || isLoading.value || numPages.value <= 0) {
        return;
    }
    if (hasRenderedPageCanvas() || hasRenderedTextLayerContent()) {
        return;
    }

    await nextTick();
    await delay(40);
    if (hasRenderedPageCanvas() || hasRenderedTextLayerContent()) {
        return;
    }

    updateVisibleRange(viewerContainer.value, numPages.value);
    await reRenderAllVisiblePages(getVisibleRange);

    await nextTick();
    await delay(80);
    if (hasRenderedPageCanvas() || hasRenderedTextLayerContent()) {
        return;
    }

    updateVisibleRange(viewerContainer.value, numPages.value);
    await renderVisiblePages(getVisibleRange());
}

async function loadFromSource(isReload = false) {
    if (!src.value) {
        commentSync.incrementSyncToken();
        annotationCommentsCache.value = [];
        activeCommentStableKey.value = null;
        emit('annotation-comments', []);
        return;
    }

    const pageToRestore = isReload ? currentPage.value : 1;

    emit('update:document', null);
    if (!isReload) {
        emit('update:totalPages', 0);
    }
    emit('update:currentPage', pageToRestore);

    cleanupRenderedPages();
    lifecycle.destroyAnnotationEditor();
    resetScale();
    resetInsets();

    currentPage.value = pageToRestore;
    visibleRange.value = {
        start: pageToRestore,
        end: pageToRestore,
    };

    const loaded = await loadPdf(src.value);
    if (!loaded) {
        return;
    }

    emit('update:document', pdfDocument.value);
    lifecycle.initAnnotationEditor();

    currentPage.value = Math.min(pageToRestore, numPages.value);
    emit('update:totalPages', numPages.value);
    emit('update:currentPage', currentPage.value);

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

    if (isReload && currentPage.value > 1) {
        singlePageScroll.scrollToPage(currentPage.value);
        await nextTick();
    }

    updateVisibleRange(viewerContainer.value, numPages.value);
    await renderVisiblePages(visibleRange.value);
    applySearchHighlights();
    commentSync.scheduleAnnotationCommentsSync(true);
    void recoverInitialRenderIfNeeded();
}

function undoAnnotation() {
    annotationUiManager.value?.undo();
}

function redoAnnotation() {
    annotationUiManager.value?.redo();
}

function applyStampImage(file: File) {
    const uiManager = annotationUiManager.value;
    if (!uiManager) {
        return;
    }
    uiManager.updateParams(AnnotationEditorParamsType.CREATE, { bitmapFile: file });
}

function getSelectedShape(): IShapeAnnotation | null {
    const id = shapeComposable.selectedShapeId.value;
    if (!id) {
        return null;
    }
    const all = shapeComposable.getAllShapes();
    return all.find(s => s.id === id) ?? null;
}

function updateShape(id: string, updates: Partial<IShapeAnnotation>) {
    shapeComposable.updateShape(id, updates);
    emit('annotation-modified');
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
    document.addEventListener('selectionchange', highlightComposable.cacheCurrentTextSelection, { passive: true });
    document.addEventListener('pointerup', highlightComposable.handleDocumentPointerUp, { passive: true });
    inlineIndicators.attachInlineCommentMarkerObserver();
    loadFromSource();
});

onUnmounted(() => {
    document.removeEventListener('selectionchange', highlightComposable.cacheCurrentTextSelection);
    document.removeEventListener('pointerup', highlightComposable.handleDocumentPointerUp);
    inlineIndicators.cleanup();
    highlightComposable.clearSelectionCache();
    cleanupRenderedPages();
    lifecycle.destroyAnnotationEditor();
    cleanupDocument();
    annotationCommentsCache.value = [];
    activeCommentStableKey.value = null;
    emit('annotation-comments', []);
});

watch(
    fitMode,
    async (mode) => {
        const pageToSnapTo = mode === 'height'
            ? getMostVisiblePage(viewerContainer.value, numPages.value)
            : null;

        const updated = computeFitWidthScale(viewerContainer.value);
        if (updated && pdfDocument.value) {
            await reRenderAllVisiblePages(getVisibleRange);
            if (pageToSnapTo !== null) {
                await nextTick();
                singlePageScroll.scrollToPage(pageToSnapTo);
            }
        }
    },
);

watch(
    src,
    (newSrc, oldSrc) => {
        if (newSrc !== oldSrc) {
            if (!newSrc) {
                emit('update:document', null);
                annotationCommentsCache.value = [];
                activeCommentStableKey.value = null;
                emit('annotation-comments', []);
            }
            loadFromSource(!!oldSrc && !!newSrc);
        }
    },
);

watch(
    annotationCommentsCache,
    (comments) => {
        const activeKey = activeCommentStableKey.value;
        if (!activeKey) {
            return;
        }
        if (!comments.some(comment => comment.stableKey === activeKey)) {
            activeCommentStableKey.value = null;
        }
    },
    { deep: true },
);

watch(
    () => continuousScroll.value,
    () => {
        singlePageScroll.resetContinuousScrollState();
    },
);

watch(
    zoom,
    () => {
        if (pdfDocument.value) {
            void reRenderAllVisiblePages(getVisibleRange);
        }
    },
);

watch(
    effectiveScale,
    (scale) => {
        annotationUiManager.value?.onScaleChanging({ scale: scale / PixelsPerInch.PDF_TO_CSS_UNITS });
    },
);

watch(
    currentPage,
    (page) => {
        annotationUiManager.value?.onPageChanging({ pageNumber: page });
    },
);

watch(
    annotationTool,
    (tool) => {
        if (tool !== 'none') {
            highlightComposable.cancelCommentPlacement();
        }
        void toolManager.setAnnotationTool(tool);
    },
    { immediate: true },
);

watch(
    annotationCursorMode,
    () => {
        if (annotationTool.value === 'none') {
            void toolManager.setAnnotationTool('none');
        }
    },
);

watch(
    annotationSettings,
    (settings) => {
        toolManager.applyAnnotationSettings(settings);
    },
    {
        deep: true,
        immediate: true,
    },
);

watch(
    isResizing,
    async (value) => {
        if (!value && pdfDocument.value && !isLoading.value) {
            await nextTick();
            await delay(20);
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
            void recoverInitialRenderIfNeeded();
        }
        emit('update:loading', value);
        emit('loading', value);
    },
    { immediate: true },
);

defineExpose({
    scrollToPage: (pageNumber: number) => singlePageScroll.scrollToPage(pageNumber),
    saveDocument,
    highlightSelection: highlightComposable.highlightSelection,
    commentSelection: highlightComposable.commentSelection,
    commentAtPoint: highlightComposable.commentAtPoint,
    startCommentPlacement: highlightComposable.startCommentPlacement,
    cancelCommentPlacement: highlightComposable.cancelCommentPlacement,
    undoAnnotation,
    redoAnnotation,
    focusAnnotationComment: commentCrud.focusAnnotationComment,
    updateAnnotationComment: commentCrud.updateAnnotationComment,
    deleteAnnotationComment: commentCrud.deleteAnnotationComment,
    getMarkupSubtypeOverrides: markupSubtypeComposable.getMarkupSubtypeOverrides,
    getAllShapes: shapeComposable.getAllShapes,
    loadShapes: shapeComposable.loadShapes,
    clearShapes: shapeComposable.clearShapes,
    deleteSelectedShape: shapeComposable.deleteSelectedShape,
    hasShapes: shapeComposable.hasShapes,
    selectedShapeId: shapeComposable.selectedShapeId,
    updateShape,
    getSelectedShape,
    applyStampImage,
});
</script>

<style lang="scss">
/* ── Page Container & Canvas ───────────────────────────────────────── */

.page_container {
    position: relative;
    margin: 0 auto;
    flex-shrink: 0;
    content-visibility: auto;
    contain-intrinsic-size: auto 800px;

    --scale-round-x: 1px;
    --scale-round-y: 1px;

    &.page_container--scroll-target {
        content-visibility: visible;
    }

    canvas {
        background: transparent;
        box-shadow: none;
        border-radius: inherit;
    }
}

.pdfViewer .page_container--rendered .pdf-page-skeleton {
    display: none;
}

.page_canvas {
    position: relative;
    width: 100%;
    height: 100%;
    z-index: 0;
    background: var(--pdf-page-bg);
    box-shadow: var(--pdf-page-shadow);
    border-radius: 2px;
}

/* ── Text Layer (PDF.js) ───────────────────────────────────────────── */

.pdfViewer .text-layer {
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

    --min-font-size: 1;
    --text-scale-factor: calc(var(--total-scale-factor, 1) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size));

    span,
    br {
        color: transparent;
        position: absolute;
        white-space: pre;
        cursor: text;
        transform-origin: 0% 0%;
    }

    > :not(.markedContent),
    .markedContent span:not(.markedContent) {
        z-index: 1;
        font-size: calc(var(--text-scale-factor) * var(--font-height, 10px));
        transform: rotate(var(--rotate, 0deg)) scaleX(var(--scale-x, 1)) scale(var(--min-font-size-inv));
    }

    .markedContent {
        display: contents;
    }

    br {
        user-select: none;
    }

    ::selection {
        background: rgb(0 0 255 / 0.25);
    }

    br::selection {
        background: transparent;
    }

    .end-of-content {
        display: block;
        position: absolute;
        inset: 100% 0 0;
        z-index: 0;
        cursor: default;
        user-select: none;
    }

    &.selecting .end-of-content {
        top: 0;
    }
}

/* ── Annotation Layers ─────────────────────────────────────────────── */

.pdfViewer .annotation-layer {
    position: absolute;
    inset: 0;
    overflow: hidden;
    z-index: 2;
    pointer-events: none;

    a {
        pointer-events: auto;
        display: block;
        position: absolute;
    }

    section {
        position: absolute;
    }

    .linkAnnotation > a {
        background: rgb(255 255 0 / 0);
        transition: background 150ms ease;

        &:hover {
            background: rgb(255 255 0 / 0.2);
        }
    }
}

.pdfViewer .annotation-editor-layer,
.pdfViewer .annotationEditorLayer {
    position: absolute;
    inset: 0;
    z-index: 3;
}

/* ── Container & Viewer ────────────────────────────────────────────── */

.pdfViewer {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: auto;
    background: var(--ui-bg-muted);
    display: flex;
    flex-direction: column;

    &.is-placing-comment {
        cursor: crosshair;
    }

    &.pdfViewer--fit-height {
        overflow-x: auto;
    }

    &.pdfViewer--single-page {
        scroll-snap-type: y mandatory;
        scroll-snap-stop: always;
    }

    &.pdfViewer--hidden {
        opacity: 0;
        pointer-events: none;
    }

    /* Hidden PDF.js UI — Okular-style workflow: comment editing is handled from side reviews + note window. */
    /* stylelint-disable selector-id-pattern -- pdf.js internal element ID */
    .editToolbar,
    .annotationCommentButton,
    .commentPopup,
    #commentManagerDialog {
        display: none !important;
    }
    /* stylelint-enable selector-id-pattern */
}

/* ── Drag Mode Cursor Overrides ────────────────────────────────────── */

.pdfViewer.drag-mode {
    &.is-dragging {
        cursor: grabbing !important;
        user-select: none;
    }

    &:not(.is-dragging) {
        cursor: grab !important;
    }

    *,
    &.is-dragging * {
        cursor: inherit !important;
    }

    /* stylelint-disable no-descending-specificity -- drag mode uses !important on all props; specificity order is irrelevant */
    .text-layer,
    .text-layer span,
    .text-layer br,
    .annotation-layer a,
    .annotation-editor-layer,
    .annotationEditorLayer,
    .page_container,
    .page_container canvas,
    .annotationLayer,
    .annotationLayer *,
    .canvasWrapper {
        cursor: inherit !important;
        user-select: none !important;
        pointer-events: none !important;
    }
    /* stylelint-enable no-descending-specificity */
}

/* ── Markup Subtype Visual Overrides (underline / strikethrough) ──── */

.pdfViewer .annotationEditorLayer .highlightEditor[class*='pdf-markup-subtype-underline'] .internal,
.pdfViewer .annotation-editor-layer .highlightEditor[class*='pdf-markup-subtype-underline'] .internal,
.pdfViewer .annotationEditorLayer .highlightEditor[class*='pdf-markup-subtype-strikeout'] .internal,
.pdfViewer .annotation-editor-layer .highlightEditor[class*='pdf-markup-subtype-strikeout'] .internal {
    opacity: 0 !important;
}

.pdfViewer svg.highlight.pdf-markup-subtype-draw-underline,
.pdfViewer svg.highlight.pdf-markup-subtype-draw-strikeout {
    fill: transparent !important;
    fill-opacity: 0 !important;
    mix-blend-mode: normal !important;
}

.pdfViewer .annotationEditorLayer .highlightEditor[class*='pdf-markup-subtype-underline']::after,
.pdfViewer .annotation-editor-layer .highlightEditor[class*='pdf-markup-subtype-underline']::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 7%;
    border-bottom: max(1.5px, calc(var(--total-scale-factor, 1) * 1px)) solid var(--pdf-markup-subtype-color, #2563eb);
    pointer-events: none;
}

.pdfViewer .annotationEditorLayer .highlightEditor[class*='pdf-markup-subtype-strikeout']::after,
.pdfViewer .annotation-editor-layer .highlightEditor[class*='pdf-markup-subtype-strikeout']::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    border-top: max(1.5px, calc(var(--total-scale-factor, 1) * 1px)) solid var(--pdf-markup-subtype-color, #dc2626);
    pointer-events: none;
}

/* ── Dark Mode (Invert Colors) Overrides ───────────────────────────── */

.pdf-viewer-container--dark {
    .text-layer ::selection {
        background: rgb(255 200 0 / 0.35);
    }

    /* stylelint-disable no-descending-specificity -- dark mode filter targets different properties than drag mode */
    .page_container,
    .page_container canvas {
        filter: invert(1) hue-rotate(180deg) saturate(1.05);
    }
    /* stylelint-enable no-descending-specificity */

    .pdfViewer {
        background: var(--color-neutral-900);
    }
}

/* ── Single-Page Snap (after dark mode to satisfy specificity order) ── */

.pdfViewer.pdfViewer--single-page .page_container {
    scroll-snap-align: center;
}

.page {
    margin: 1px auto -3px !important;
    border: 1px dashed transparent !important;
    box-shadow: var(--pdf-page-shadow);
    box-sizing: content-box;
    user-select: none;
    position: relative;
}

/* ── FreeText Editor & Resize Handles ──────────────────────────────── */

.pdfViewer .freeTextEditor {
    --resizer-size: var(--evb-resizer-size, clamp(6px, calc(8px / var(--total-scale-factor, 1)), 10px));
    --resizer-shift: calc(
        0px - (var(--outline-width, 1px) + var(--resizer-size)) / 2 - var(--outline-around-width, 0px)
    );

    .overlay.enabled {
        display: block !important;
    }

    > .resizers {
        pointer-events: none;

        > .resizer {
            pointer-events: auto;
            background: transparent !important;
            border: none !important;
            box-sizing: border-box;
            touch-action: none;

            &::after {
                content: '';
                position: absolute;
                width: 6px;
                height: 6px;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: var(--resizer-bg-color, #0060df);
                border-radius: 2px;
                pointer-events: none;
            }

            &.topLeft,
            &.bottomRight {
                cursor: nwse-resize !important;
            }

            &.topRight,
            &.bottomLeft {
                cursor: nesw-resize !important;
            }

            &.topMiddle,
            &.middleRight,
            &.bottomMiddle,
            &.middleLeft {
                display: none !important;
            }
        }
    }
}

.pdfViewer .annotationEditorLayer.disabled.nonEditing .freeTextEditor,
.pdfViewer .annotation-editor-layer.disabled.nonEditing .freeTextEditor {
    pointer-events: auto !important;
}

.pdfViewer .annotationEditorLayer.disabled.nonEditing .freeTextEditor > .resizers,
.pdfViewer .annotation-editor-layer.disabled.nonEditing .freeTextEditor > .resizers,
.pdfViewer .annotationEditorLayer.disabled.nonEditing .freeTextEditor > .resizers > .resizer,
.pdfViewer .annotation-editor-layer.disabled.nonEditing .freeTextEditor > .resizers > .resizer,
.pdfViewer .annotationEditorLayer.disabled.nonEditing .freeTextEditor .overlay,
.pdfViewer .annotation-editor-layer.disabled.nonEditing .freeTextEditor .overlay {
    pointer-events: auto !important;
}
</style>
