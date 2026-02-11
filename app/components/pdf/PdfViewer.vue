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
    settings: computed(() => annotationSettings.value ?? {
        highlightColor: '#ffd400',
        highlightOpacity: 0.35,
        highlightThickness: 12,
        highlightFree: true,
        highlightShowAll: true,
        underlineColor: '#2563eb',
        underlineOpacity: 0.8,
        strikethroughColor: '#dc2626',
        strikethroughOpacity: 0.7,
        squigglyColor: '#16a34a',
        squigglyOpacity: 0.7,
        inkColor: '#e11d48',
        inkOpacity: 0.9,
        inkThickness: 2,
        textColor: '#111827',
        textSize: 22,
        shapeColor: '#2563eb',
        shapeFillColor: 'transparent',
        shapeOpacity: 1,
        shapeStrokeWidth: 2,
    }),
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

async function loadFromSource() {
    if (!src.value) {
        commentSync.incrementSyncToken();
        annotationCommentsCache.value = [];
        activeCommentStableKey.value = null;
        emit('annotation-comments', []);
        return;
    }

    emit('update:document', null);
    emit('update:totalPages', 0);
    emit('update:currentPage', 1);

    cleanupRenderedPages();
    lifecycle.destroyAnnotationEditor();
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

    emit('update:document', pdfDocument.value);
    lifecycle.initAnnotationEditor();

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
            loadFromSource();
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
    position: relative;
    width: 100%;
    height: 100%;
    overflow: auto;
    background: var(--color-surface-muted);
    display: flex;
    flex-direction: column;

    --pdfjs-comment-edit-icon: url('/pdfjs/comment-editButton.svg');
    --pdfjs-comment-popup-edit-icon: url('/pdfjs/comment-popup-editButton.svg');
    --pdfjs-comment-close-icon: url('/pdfjs/comment-closeButton.svg');
    --pdfjs-highlight-icon: url('/pdfjs/toolbarButton-editorHighlight.svg');
    --pdfjs-delete-icon: url('/pdfjs/editor-toolbar-delete.svg');
    --comment-edit-button-icon: var(--pdfjs-comment-edit-icon);
    --editor-toolbar-highlight-image: var(--pdfjs-highlight-icon);
    --editor-toolbar-delete-image: var(--pdfjs-delete-icon);
    --comment-popup-edit-button-icon: var(--pdfjs-comment-popup-edit-icon);
    --comment-popup-delete-button-icon: var(--pdfjs-delete-icon);
    --comment-close-button-icon: var(--pdfjs-comment-close-icon);
}

.pdfViewer.is-placing-comment {
    cursor: crosshair;
}

.pdfViewer :deep(.editToolbar) {
    --editor-toolbar-height: 32px;
    --editor-toolbar-padding: 4px;
    --editor-toolbar-highlight-image: var(--pdfjs-highlight-icon);
    --editor-toolbar-delete-image: var(--pdfjs-delete-icon);
    --comment-edit-button-icon: var(--pdfjs-comment-edit-icon);
    --comment-popup-edit-button-icon: var(--pdfjs-comment-popup-edit-icon);
    --comment-popup-delete-button-icon: var(--pdfjs-delete-icon);
    --comment-close-button-icon: var(--pdfjs-comment-close-icon);
}

.pdfViewer :deep(.annotationCommentButton) {
    --comment-edit-button-icon: var(--pdfjs-comment-edit-icon);
}

/* Okular-style workflow: comment editing is handled from side reviews + note window. */
/* stylelint-disable selector-id-pattern -- pdf.js internal element ID */
.pdfViewer :deep(.editToolbar),
.pdfViewer :deep(.annotationCommentButton),
.pdfViewer :deep(.commentPopup),
.pdfViewer :deep(#commentManagerDialog) {
    display: none !important;
}
/* stylelint-enable selector-id-pattern */

.pdfViewer :deep(.commentPopup) {
    background: var(--color-surface, #fff);
    border: 1px solid var(--ui-border, #e5e7eb);
    box-shadow:
        0 6px 18px rgba(15, 23, 42, 0.15),
        0 2px 6px rgba(15, 23, 42, 0.08);
    color: var(--ui-text, #111827);
}

.pdfViewer :deep(.commentPopup .commentPopupText) {
    color: var(--ui-text, #111827);
}

.pdfViewer :deep(.commentPopup .commentPopupTime) {
    color: var(--ui-text-muted, #6b7280);
}

/* stylelint-disable-next-line selector-id-pattern -- PDF.js internal ID */
.pdfViewer :deep(#commentManagerDialog) {
    background: var(--color-surface, #fff);
    border: 1px solid var(--ui-border, #e5e7eb);
    box-shadow:
        0 6px 18px rgba(15, 23, 42, 0.15),
        0 2px 6px rgba(15, 23, 42, 0.08);
    color: var(--ui-text, #111827);
}

/* stylelint-disable-next-line selector-id-pattern -- PDF.js internal IDs */
.pdfViewer :deep(#commentManagerDialog #commentManagerTextInput) {
    background: var(--color-surface-2, #f3f4f6);
    color: var(--ui-text, #111827);
    border: 1px solid var(--ui-border, #e5e7eb);
    border-radius: 8px;
    padding: 8px 10px;
}

.pdfViewer--fit-height {
    overflow-x: auto;
}

.pdfViewer--single-page {
    scroll-snap-type: y mandatory;
    scroll-snap-stop: always;
}

.pdfViewer--single-page :deep(.page_container) {
    scroll-snap-align: center;
}

.pdfViewer--hidden {
    opacity: 0;
    pointer-events: none;
}

.pdfViewer.drag-mode.is-dragging {
    cursor: grabbing !important;
    user-select: none;
}

.pdfViewer.drag-mode:not(.is-dragging) {
    cursor: grab !important;
}

.pdfViewer.drag-mode *,
.pdfViewer.drag-mode.is-dragging * {
    cursor: inherit !important;
}

.pdfViewer.drag-mode :deep(.text-layer),
.pdfViewer.drag-mode :deep(.text-layer span),
.pdfViewer.drag-mode :deep(.text-layer br),
.pdfViewer.drag-mode :deep(.annotation-layer a),
.pdfViewer.drag-mode :deep(.annotation-editor-layer),
.pdfViewer.drag-mode :deep(.annotationEditorLayer),
.pdfViewer.drag-mode :deep(.page_container),
.pdfViewer.drag-mode :deep(.page_container canvas),
.pdfViewer.drag-mode :deep(.annotationLayer),
.pdfViewer.drag-mode :deep(.annotationLayer *),
.pdfViewer.drag-mode :deep(.canvasWrapper) {
    cursor: inherit !important;
    user-select: none !important;
    pointer-events: none !important;
}

/* Hide edit toolbar when viewing a comment popup */
.pdfViewer.is-viewing-comment :deep(.editToolbar) {
    display: none !important;
}

/* Visual indicator for text markup annotations with comments. */
.pdfViewer :deep(.pdf-comment-marker-layer) {
    position: absolute;
    inset: 0;
    z-index: 4;
    pointer-events: none;
}

.pdfViewer :deep(.pdf-inline-comment-marker) {
    position: absolute;
    width: 22px;
    height: 22px;
    border: 1px solid rgb(150 129 33 / 0.78);
    border-radius: 3px;
    transform: translate(-50%, -50%);
    background: linear-gradient(180deg, #fcf6c6 0%, #efe187 100%);
    box-shadow:
        0 2px 5px rgb(0 0 0 / 0.2),
        inset 0 0 0 1px rgb(255 255 255 / 0.58);
    cursor: pointer;
    pointer-events: auto;
}

.pdfViewer :deep(.pdf-inline-comment-marker)::before {
    content: '';
    position: absolute;
    inset: 2px;
    background-color: rgb(110 96 23 / 0.95);
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 5V5z'/%3E%3C/svg%3E");
    mask-repeat: no-repeat;
    mask-position: center;
    mask-size: contain;
}

.pdfViewer :deep(.pdf-inline-comment-marker)::after {
    content: '';
    position: absolute;
    right: 2px;
    top: 2px;
    width: 5px;
    height: 5px;
    background: linear-gradient(135deg, rgb(255 255 255 / 0.88) 0%, rgb(235 224 145 / 0.95) 100%);
    clip-path: polygon(0 0, 100% 0, 100% 100%);
}

.pdfViewer :deep(.pdf-inline-comment-marker.is-cluster)::after {
    content: attr(data-comment-count);
    right: -9px;
    top: -9px;
    min-width: 17px;
    height: 17px;
    border-radius: 999px;
    border: 1.5px solid rgb(120 80 10 / 0.75);
    background: linear-gradient(180deg, #fff 0%, #fde68a 100%);
    color: rgb(60 40 5);
    clip-path: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
    padding: 0 3px;
    font-variant-numeric: tabular-nums;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.22);
}

.pdfViewer :deep(.pdf-inline-comment-marker.is-cluster:hover)::after,
.pdfViewer :deep(.pdf-inline-comment-marker.is-cluster.is-active)::after {
    border-color: rgb(100 65 5 / 0.9);
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.32);
}

.pdfViewer :deep(.pdf-inline-comment-marker:hover) {
    transform: translate(-50%, -50%) scale(1.08);
}

.pdfViewer :deep(.pdf-inline-comment-marker.is-active) {
    border-color: color-mix(in oklab, var(--ui-primary, #3b82f6) 44%, rgb(165 145 41));
    box-shadow:
        0 0 0 2px color-mix(in oklab, var(--ui-primary, #3b82f6) 28%, transparent),
        0 2px 6px rgb(0 0 0 / 0.28),
        inset 0 0 0 1px rgb(255 255 255 / 0.7);
}

.pdfViewer :deep(.pdf-inline-comment-marker.pdf-comment-focus-pulse) {
    animation: inline-comment-focus-pulse 0.9s ease-out;
}

.pdfViewer :deep(.pdf-inline-comment-anchor-marker) {
    position: absolute;
    right: -13px;
    top: -13px;
    width: 22px;
    height: 22px;
    border: 1px solid rgb(150 129 33 / 0.78);
    border-radius: 5px;
    background: linear-gradient(180deg, #fcf6c6 0%, #efe187 100%);
    box-shadow:
        0 1px 4px rgb(0 0 0 / 0.18),
        inset 0 0 0 1px rgb(255 255 255 / 0.54);
    cursor: pointer !important;
    z-index: 9999 !important;
    pointer-events: auto !important;
    padding: 0;
}

.pdfViewer :deep(.pdf-inline-comment-anchor-marker)::before {
    content: '';
    position: absolute;
    inset: 2px;
    background-color: rgb(110 96 23 / 0.95);
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 5V5z'/%3E%3C/svg%3E");
    mask-repeat: no-repeat;
    mask-position: center;
    mask-size: contain;
}

.pdfViewer :deep(.pdf-inline-comment-anchor-marker)::after {
    content: attr(data-comment-count);
    position: absolute;
    right: -9px;
    top: -9px;
    min-width: 17px;
    height: 17px;
    border-radius: 999px;
    border: 1.5px solid rgb(120 80 10 / 0.75);
    background: linear-gradient(180deg, #fff 0%, #fde68a 100%);
    color: rgb(60 40 5);
    display: none;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    padding: 0 3px;
    font-variant-numeric: tabular-nums;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.22);
}

.pdfViewer :deep(.pdf-inline-comment-anchor-marker.is-cluster)::after {
    display: inline-flex;
}

.pdfViewer :deep(.pdf-inline-comment-anchor-marker:hover) {
    transform: scale(1.08);
}

.pdfViewer :deep(.pdf-inline-comment-anchor-marker.is-active) {
    border-color: color-mix(in oklab, var(--ui-primary, #3b82f6) 44%, rgb(165 145 41));
    box-shadow:
        0 0 0 1.5px color-mix(in oklab, var(--ui-primary, #3b82f6) 28%, transparent),
        0 2px 6px rgb(0 0 0 / 0.24),
        inset 0 0 0 1px rgb(255 255 255 / 0.68);
}

.pdfViewer :deep(.pdf-inline-comment-anchor-marker.pdf-comment-focus-pulse) {
    animation: inline-comment-focus-pulse 0.9s ease-out;
}

.pdfViewer :deep(.pdf-annotation-has-note-target) {
    position: relative;
    overflow: visible;
    cursor: pointer;
    pointer-events: auto !important;
}

.pdfViewer :deep(.pdf-annotation-has-note-target:hover) {
    filter: drop-shadow(0 0 2px rgba(59, 130, 246, 0.28));
}

.pdfViewer :deep(.pdf-annotation-has-note-active) {
    filter: drop-shadow(0 0 4px color-mix(in oklab, var(--ui-primary, #3b82f6) 28%, transparent));
}

.pdfViewer :deep(.pdf-annotation-has-note-target.pdf-comment-focus-pulse) {
    animation: inline-comment-focus-pulse 0.9s ease-out;
}

.pdfViewer :deep(.annotationEditorLayer .highlightEditor[class*='pdf-markup-subtype-underline'] .internal),
.pdfViewer :deep(.annotation-editor-layer .highlightEditor[class*='pdf-markup-subtype-underline'] .internal),
.pdfViewer :deep(.annotationEditorLayer .highlightEditor[class*='pdf-markup-subtype-strikeout'] .internal),
.pdfViewer :deep(.annotation-editor-layer .highlightEditor[class*='pdf-markup-subtype-strikeout'] .internal) {
    opacity: 0 !important;
}

.pdfViewer :deep(svg.highlight.pdf-markup-subtype-draw-underline),
.pdfViewer :deep(svg.highlight.pdf-markup-subtype-draw-strikeout) {
    fill: transparent !important;
    fill-opacity: 0 !important;
    mix-blend-mode: normal !important;
}

.pdfViewer :deep(.annotationEditorLayer .highlightEditor[class*='pdf-markup-subtype-underline']::after),
.pdfViewer :deep(.annotation-editor-layer .highlightEditor[class*='pdf-markup-subtype-underline']::after) {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 7%;
    border-bottom: max(1.5px, calc(var(--total-scale-factor, 1) * 1px)) solid var(--pdf-markup-subtype-color, #2563eb);
    pointer-events: none;
}

.pdfViewer :deep(.annotationEditorLayer .highlightEditor[class*='pdf-markup-subtype-strikeout']::after),
.pdfViewer :deep(.annotation-editor-layer .highlightEditor[class*='pdf-markup-subtype-strikeout']::after) {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    border-top: max(1.5px, calc(var(--total-scale-factor, 1) * 1px)) solid var(--pdf-markup-subtype-color, #dc2626);
    pointer-events: none;
}

@keyframes inline-comment-focus-pulse {
    0% {
        filter: drop-shadow(0 0 0 color-mix(in oklab, var(--ui-primary, #3b82f6) 0%, transparent));
    }

    30% {
        filter: drop-shadow(0 0 6px color-mix(in oklab, var(--ui-primary, #3b82f6) 42%, transparent));
    }

    100% {
        filter: drop-shadow(0 0 0 color-mix(in oklab, var(--ui-primary, #3b82f6) 0%, transparent));
    }
}

.pdfViewer :deep(.pdf-annotation-comment-tooltip) {
    position: absolute;
    z-index: 5;
    max-width: 260px;
    padding: 8px 12px;
    border-radius: 6px;
    background: var(--color-surface, #fff);
    color: var(--ui-text, #111827);
    border: 1px solid var(--ui-border, #e5e7eb);
    box-shadow:
        0 6px 16px rgba(15, 23, 42, 0.12),
        0 2px 6px rgba(15, 23, 42, 0.1);
    font-size: 12px;
    line-height: 1.4;
    opacity: 0;
    transform: translate3d(0, 4px, 0);
    transition: opacity 0.12s ease, transform 0.12s ease;
    pointer-events: none;
    white-space: pre-wrap;
    overflow-wrap: break-word;
}

.pdfViewer :deep(.pdf-annotation-comment-tooltip.is-visible) {
    opacity: 1;
    transform: translate3d(0, 0, 0);
}

.pdfViewer :deep(.pdf-annotation-comment-tooltip)::before {
    content: '';
    position: absolute;
    left: 14px;
    bottom: -6px;
    width: 0;
    height: 0;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-top: 6px solid var(--color-surface, #fff);
    filter: drop-shadow(0 1px 1px rgba(15, 23, 42, 0.12));
}

.pdfViewer :deep(.pdf-annotation-comment-tooltip.is-below)::before {
    top: -6px;
    bottom: auto;
    border-top: none;
    border-bottom: 6px solid var(--color-surface, #fff);
    filter: drop-shadow(0 -1px 1px rgba(15, 23, 42, 0.12));
}

.pdfViewer :deep(.pdf-annotation-comment-popup) {
    position: absolute;
    z-index: 6;
    min-width: 180px;
    max-width: 280px;
    padding: 12px 14px;
    border-radius: 8px;
    background: var(--color-surface, #fff);
    color: var(--ui-text, #111827);
    border: 1px solid var(--ui-border, #e5e7eb);
    box-shadow:
        0 6px 18px rgba(15, 23, 42, 0.15),
        0 2px 6px rgba(15, 23, 42, 0.08);
    opacity: 1;
    transform: translate3d(0, 0, 0);
    transition: opacity 0.12s ease, transform 0.12s ease;
    pointer-events: auto;
}

/* Arrow pointing up to the highlight */
.pdfViewer :deep(.pdf-annotation-comment-popup)::before {
    content: '';
    position: absolute;
    top: -8px;
    left: 16px;
    width: 0;
    height: 0;
    border-left: 8px solid transparent;
    border-right: 8px solid transparent;
    border-bottom: 8px solid var(--color-surface, #fff);
    filter: drop-shadow(0 -1px 1px rgba(15, 23, 42, 0.08));
}

.pdfViewer :deep(.pdf-annotation-comment-popup.is-hidden) {
    opacity: 0;
    pointer-events: none;
    transform: translate3d(0, 6px, 0);
}

.pdfViewer :deep(.pdf-annotation-comment-popup__text) {
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: break-word;
}

.pdfViewer :deep(.pdf-annotation-comment-popup__textarea) {
    width: 100%;
    min-height: 84px;
    margin-top: 8px;
    border-radius: 8px;
    border: 1px solid var(--ui-border, #e5e7eb);
    background: var(--color-surface-2, #f3f4f6);
    color: inherit;
    font-size: 12px;
    line-height: 1.4;
    padding: 6px 8px;
    resize: vertical;
}

.pdfViewer :deep(.pdf-annotation-comment-popup.is-editing .pdf-annotation-comment-popup__text) {
    display: none;
}

.pdfViewer :deep(.pdf-annotation-comment-popup:not(.is-editing) .pdf-annotation-comment-popup__textarea) {
    display: none;
}

.pdfViewer :deep(.pdf-annotation-comment-popup.is-editing .pdf-annotation-comment-popup__btn--edit),
.pdfViewer :deep(.pdf-annotation-comment-popup.is-editing .pdf-annotation-comment-popup__btn--close) {
    display: none;
}

.pdfViewer :deep(.pdf-annotation-comment-popup:not(.is-editing) .pdf-annotation-comment-popup__btn--save),
.pdfViewer :deep(.pdf-annotation-comment-popup:not(.is-editing) .pdf-annotation-comment-popup__btn--cancel) {
    display: none;
}

.pdfViewer :deep(.pdf-annotation-comment-popup__actions) {
    display: flex;
    gap: 6px;
    margin-top: 10px;
    justify-content: flex-end;
}

.pdfViewer :deep(.pdf-annotation-comment-popup__btn) {
    border-radius: 4px;
    border: 1px solid var(--ui-border, #e5e7eb);
    background: var(--color-surface-2, #f3f4f6);
    color: inherit;
    font-size: 12px;
    padding: 4px 10px;
    min-height: 26px;
    cursor: pointer;
}

.pdfViewer :deep(.pdf-annotation-comment-popup__btn:hover) {
    background: var(--color-surface-3, #e5e7eb);
}

.pdfViewer :deep(.annotation-focus-pulse) {
    animation: annotation-focus-pulse 0.9s ease-out;
    outline: 2px solid color-mix(in oklab, var(--ui-primary, #3b82f6) 80%, white 20%);
    outline-offset: 2px;
}

@keyframes annotation-focus-pulse {
    0% {
        box-shadow: 0 0 0 0 color-mix(in oklab, var(--ui-primary, #3b82f6) 45%, transparent);
    }

    100% {
        box-shadow: 0 0 0 14px transparent;
    }
}

.page_container {
    position: relative;
    margin: 0 auto;
    flex-shrink: 0;
    content-visibility: auto;
    contain-intrinsic-size: auto 800px;

    --scale-round-x: 1px;
    --scale-round-y: 1px;
}

.page_container--scroll-target {
    content-visibility: visible;
}

.page_container canvas {
    background: transparent;
    box-shadow: none;
    border-radius: inherit;
}

.pdfViewer :deep(.page_container--rendered .pdf-page-skeleton) {
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

.pdfViewer :deep(.annotation-editor-layer),
.pdfViewer :deep(.annotationEditorLayer) {
    position: absolute;
    inset: 0;
    z-index: 3;
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

/* FreeText editors: hide middle (non-corner) resize handles as a CSS fallback.
   Normally _willKeepAspectRatio = true prevents their creation, but for editors
   created before our patch runs we still need to hide them. */
.pdfViewer :deep(.freeTextEditor > .resizers > .resizer.topMiddle),
.pdfViewer :deep(.freeTextEditor > .resizers > .resizer.middleRight),
.pdfViewer :deep(.freeTextEditor > .resizers > .resizer.bottomMiddle),
.pdfViewer :deep(.freeTextEditor > .resizers > .resizer.middleLeft) {
    display: none !important;
}

/* FreeText editors: fix PDF.js CSS bug — the selector for .overlay.enabled
   is missing the dot on "freeTextEditor" (element vs class), so the overlay
   never shows and the editor cannot be dragged after committing text. */
.pdfViewer :deep(.freeTextEditor .overlay.enabled) {
    display: block !important;
}

/* PDF.js disables pointer events for the whole annotation layer in non-editing
   mode. Re-enable them for existing FreeText editors so selecting/moving/
   resizing still works when no creation tool is active. */
.pdfViewer :deep(.annotationEditorLayer.disabled.nonEditing .freeTextEditor),
.pdfViewer :deep(.annotation-editor-layer.disabled.nonEditing .freeTextEditor) {
    pointer-events: auto !important;
}

.pdfViewer :deep(.annotationEditorLayer.disabled.nonEditing .freeTextEditor > .resizers),
.pdfViewer :deep(.annotation-editor-layer.disabled.nonEditing .freeTextEditor > .resizers),
.pdfViewer :deep(.annotationEditorLayer.disabled.nonEditing .freeTextEditor > .resizers > .resizer),
.pdfViewer :deep(.annotation-editor-layer.disabled.nonEditing .freeTextEditor > .resizers > .resizer),
.pdfViewer :deep(.annotationEditorLayer.disabled.nonEditing .freeTextEditor .overlay),
.pdfViewer :deep(.annotation-editor-layer.disabled.nonEditing .freeTextEditor .overlay) {
    pointer-events: auto !important;
}

/* Keep corner handles usable across zoom levels while keeping them anchored
   on the actual box corners (PDF.js default positioning model). */
.pdfViewer :deep(.freeTextEditor) {
    --resizer-size: var(--evb-resizer-size, clamp(6px, calc(8px / var(--total-scale-factor, 1)), 10px));
    --resizer-shift: calc(
        0px - (var(--outline-width, 1px) + var(--resizer-size)) / 2 - var(--outline-around-width, 0px)
    );
}

/* Prevent the .resizers container (which covers the full editor at z-index:1)
   from intercepting pointer events meant for the overlay (drag) or the
   internal editor (text).  Individual .resizer handles opt back in. */
.pdfViewer :deep(.freeTextEditor > .resizers) {
    pointer-events: none;
}

.pdfViewer :deep(.freeTextEditor > .resizers > .resizer) {
    pointer-events: auto;
    background: transparent !important;
    border: none !important;
    box-sizing: border-box;
    touch-action: none;
}

.pdfViewer :deep(.freeTextEditor > .resizers > .resizer)::after {
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

/* Explicit cursor for FreeText corner handles — PDF.js CSS rules depend on
   data-main-rotation / data-editor-rotation attributes that may not match,
   causing the cursor to fall back to 'auto' (arrow). */
.pdfViewer :deep(.freeTextEditor > .resizers > .resizer.topLeft),
.pdfViewer :deep(.freeTextEditor > .resizers > .resizer.bottomRight) {
    cursor: nwse-resize !important;
}

.pdfViewer :deep(.freeTextEditor > .resizers > .resizer.topRight),
.pdfViewer :deep(.freeTextEditor > .resizers > .resizer.bottomLeft) {
    cursor: nesw-resize !important;
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

/* Lock cursor to resize direction during FreeText corner resize drag.
   Without this, the cursor reverts when the pointer leaves the editor
   (PDF.js disables pointer-events on the layer during resize). */
html.pdf-resizing-nwse,
html.pdf-resizing-nwse * {
    cursor: nwse-resize !important;
}

html.pdf-resizing-nesw,
html.pdf-resizing-nesw * {
    cursor: nesw-resize !important;
}
</style>
