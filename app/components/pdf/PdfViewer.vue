<template>
    <div
        ref="viewerHost"
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
                'pdfViewer--mode-single': viewMode === 'single',
                'pdfViewer--mode-facing': viewMode === 'facing',
                'pdfViewer--mode-facing-first-single': viewMode === 'facing-first-single',
                'pdfViewer--hidden': src && isLoading,
                'pdfViewer--fit-height': fitMode === 'height',
            }"
            :style="containerStyle"
            @scroll.passive="singlePageScroll.handleScroll"
            @wheel="handleViewerWheel"
            @mousedown="handleViewerMouseDown"
            @mousemove="handleViewerMouseMove"
            @mouseup="handleViewerMouseUp"
            @mouseleave="handleViewerMouseLeave"
            @click="handleViewerClick"
            @dblclick="handleViewerDblClick"
            @contextmenu="handleViewerContextMenu"
        >
            <div
                v-if="topVirtualSpacerStyle"
                class="pdf-viewer-virtual-spacer"
                :style="topVirtualSpacerStyle"
            />
            <PdfViewerPage
                v-for="page in pagesToRender"
                :key="page"
                :page="page"
                :show-skeleton="shouldShowSkeleton(page)"
                :spread-single="isSpreadSingle(page)"
            />
            <div
                v-if="bottomVirtualSpacerStyle"
                class="pdf-viewer-virtual-spacer"
                :style="bottomVirtualSpacerStyle"
            />
        </div>
        <PdfRegionSnipOverlay
            :active="regionSnip.isActive.value"
            :selection-rect="regionSnip.selectionRect.value"
            :flash-rect="regionSnip.flashRect.value"
            :badge-position="regionSnip.badgePosition.value"
            :hint-label="t('toolbar.captureHint')"
            :copied-label="t('toolbar.captureCopied')"
            @pointer-start="regionSnip.onPointerStart"
            @pointer-move="regionSnip.onPointerMove"
            @pointer-end="regionSnip.onPointerEnd"
            @cancel="regionSnip.cancelCapture"
        />
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    onBeforeUnmount,
    ref,
    shallowRef,
    watchEffect,
} from 'vue';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import { AnnotationEditorParamsType } from 'pdfjs-dist';
import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';
import PdfViewerPage from '@app/components/pdf/PdfViewerPage.vue';
import PdfRegionSnipOverlay from '@app/components/pdf/PdfRegionSnipOverlay.vue';
import { usePdfDocument } from '@app/composables/pdf/usePdfDocument';
import { usePdfDrag } from '@app/composables/pdf/usePdfDrag';
import { usePdfPageRenderer } from '@app/composables/pdf/usePdfPageRenderer';
import { usePdfScale } from '@app/composables/pdf/usePdfScale';
import { usePdfScroll } from '@app/composables/pdf/usePdfScroll';
import { usePdfSkeletonInsets } from '@app/composables/pdf/usePdfSkeletonInsets';
import { useAnnotationShapes } from '@app/composables/pdf/useAnnotationShapes';
import { range } from 'es-toolkit/math';
import { usePdfSinglePageScroll } from '@app/composables/pdf/usePdfSinglePageScroll';
import { useAnnotationOrchestrator } from '@app/composables/pdf/useAnnotationOrchestrator';
import { usePdfViewerCore } from '@app/composables/pdf/usePdfViewerCore';
import { usePdfShapeContext } from '@app/composables/pdf/usePdfShapeContext';
import { usePdfRegionSnip } from '@app/composables/pdf/usePdfRegionSnip';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    PDFDocumentProxy,
    TPdfSource,
    TFitMode,
    TPdfViewMode,
} from '@app/types/pdf';
import { isStandaloneSpreadPage } from '@app/utils/pdf-view-mode';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IAnnotationContextMenuPayload } from '@app/composables/pdf/pdfAnnotationUtils';

import 'pdfjs-dist/web/pdf_viewer.css';

interface IProps {
    src: TPdfSource | null;
    bufferPages?: number;
    zoom?: number;
    dragMode?: boolean;
    fitMode?: TFitMode;
    viewMode?: TPdfViewMode;
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
const viewMode = computed<TPdfViewMode>(() => props.viewMode ?? 'single');
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
const { t } = useTypedI18n();

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

const viewerHost = ref<HTMLElement | null>(null);
const viewerContainer = ref<HTMLElement | null>(null);
const annotationUiManager = shallowRef<AnnotationEditorUIManager | null>(null);
const annotationL10n = shallowRef<GenericL10n | null>(null);
const annotationCommentsCache = shallowRef<IAnnotationCommentSummary[]>([]);
const activeCommentStableKey = ref<string | null>(null);
const regionSnip = usePdfRegionSnip({ viewerContainer });

const pdfDocumentResult = usePdfDocument();
const {
    pdfDocument,
    numPages,
    isLoading,
    basePageWidth,
    basePageHeight,
    saveDocument,
} = pdfDocumentResult;

const {
    currentPage,
    visibleRange,
    getMostVisiblePage,
    scrollToPage: scrollToPageInternal,
    updateCurrentPage,
    updateVisibleRange,
    setUniformLayoutMetrics,
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
} = usePdfScale(
    zoom,
    fitMode,
    viewMode,
    numPages,
    basePageWidth,
    basePageHeight,
);
const {
    computeSkeletonInsets,
    resetInsets,
} = usePdfSkeletonInsets(basePageWidth, basePageHeight, effectiveScale);

const shapeComposable = useAnnotationShapes();

function registerShapeHistoryCommand(command: {
    cmd: () => void;
    undo: () => void;
}) {
    annotationUiManager.value?.addCommands({
        ...command,
        mustExec: false,
    });
}

function handleShapeCreated(shape: IShapeAnnotation) {
    emit('annotation-modified');

    registerShapeHistoryCommand({
        cmd: () => {
            shapeComposable.addShape(shape);
            shapeComposable.selectShape(shape.id);
            emit('annotation-modified');
        },
        undo: () => {
            shapeComposable.deleteShape(shape.id);
            emit('annotation-modified');
        },
    });
}

usePdfShapeContext({
    shapeComposable,
    annotationTool,
    annotationSettings,
    onShapeCreated: handleShapeCreated,
    onShapeContextMenu: (payload) => {
        emit('shape-context-menu', payload);
    },
});

const {
    setupPagePlaceholders,
    renderVisiblePages,
    reRenderAllVisiblePages,
    cleanupAllPages: cleanupRenderedPages,
    invalidatePages: invalidateRenderedPages,
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
    viewMode,
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

const annotations = useAnnotationOrchestrator({
    viewerContainer,
    pdfDocument,
    numPages,
    currentPage,
    effectiveScale,
    visibleRange,
    annotationTool,
    annotationCursorMode,
    annotationKeepActive,
    annotationSettings,
    annotationUiManager,
    annotationL10n,
    annotationCommentsCache,
    activeCommentStableKey,
    authorName,
    stopDrag,
    scrollToPage: (pageNumber) => singlePageScroll.scrollToPage(pageNumber),
    renderVisiblePages,
    updateVisibleRange,
    emitAnnotationModified: () => emit('annotation-modified'),
    emitAnnotationState: (state) => emit('annotation-state', state),
    emitAnnotationComments: (comments) => emit('annotation-comments', comments),
    emitAnnotationOpenNote: (comment) => emit('annotation-open-note', comment),
    emitAnnotationContextMenu: (payload) => emit('annotation-context-menu', payload),
    emitAnnotationToolAutoReset: () => emit('annotation-tool-auto-reset'),
    emitAnnotationSetting: (payload) => emit('annotation-setting', payload),
    emitAnnotationCommentClick: (comment) => emit('annotation-comment-click', comment),
    emitAnnotationToolCancel: () => emit('annotation-tool-cancel'),
    emitAnnotationNotePlacementChange: (active) => emit('annotation-note-placement-change', active),
});

const highlightComposable = annotations.highlight;
const commentCrud = annotations.crud;

const {
    shouldShowSkeleton,
    handleDragStart,
    handleDragMove,
    undoAnnotation,
    redoAnnotation,
    invalidatePages,
} = usePdfViewerCore({
    viewerContainer,
    src,
    zoom,
    fitMode,
    viewMode,
    isResizing,
    continuousScroll,
    annotationTool,
    annotationCursorMode,
    annotationSettings,
    annotationUiManager,
    annotationCommentsCache,
    activeCommentStableKey,
    pdfDocumentResult,
    annotations,
    currentPage,
    visibleRange,
    effectiveScale,
    basePageWidth,
    basePageHeight,
    computeFitWidthScale,
    resetScale,
    computeSkeletonInsets,
    resetInsets,
    setupPagePlaceholders,
    renderVisiblePages,
    reRenderAllVisiblePages,
    cleanupRenderedPages,
    invalidateRenderedPages,
    applySearchHighlights,
    isPageRendered,
    getMostVisiblePage,
    updateVisibleRange,
    scrollToPage: (pageNumber) => singlePageScroll.scrollToPage(pageNumber),
    resetContinuousScrollState: () => singlePageScroll.resetContinuousScrollState(),
    startDrag,
    onDrag,
    stopDrag,
    emit,
});

const VIRTUAL_MOUNT_BUFFER_MIN = 6;
const pageHeightEstimate = computed(() => {
    const baseHeight = basePageHeight.value;
    if (!baseHeight) {
        return 0;
    }
    return baseHeight * effectiveScale.value;
});
const pageGapEstimate = computed(() => scaledMargin.value);

const virtualizedContinuousMode = computed(() =>
    continuousScroll.value
    && viewMode.value === 'single'
    && numPages.value > 0
    && pageHeightEstimate.value > 0,
);
const virtualMountBuffer = computed(() =>
    Math.max(VIRTUAL_MOUNT_BUFFER_MIN, bufferPages.value + 2),
);
const virtualWindowStart = computed(() => {
    if (!virtualizedContinuousMode.value) {
        return 1;
    }
    return Math.max(1, visibleRange.value.start - virtualMountBuffer.value);
});
const virtualWindowEnd = computed(() => {
    if (!virtualizedContinuousMode.value) {
        return numPages.value;
    }
    return Math.min(numPages.value, visibleRange.value.end + virtualMountBuffer.value);
});

function computeVirtualSpacerHeight(hiddenPages: number) {
    if (hiddenPages <= 0) {
        return 0;
    }
    return hiddenPages * pageHeightEstimate.value
        + Math.max(0, hiddenPages - 1) * pageGapEstimate.value;
}

const topVirtualSpacerStyle = computed<Record<string, string> | null>(() => {
    if (!virtualizedContinuousMode.value) {
        return null;
    }

    const hiddenBefore = Math.max(0, virtualWindowStart.value - 1);
    const spacerHeight = computeVirtualSpacerHeight(hiddenBefore);
    if (spacerHeight <= 0) {
        return null;
    }

    return {height: `${spacerHeight}px`};
});

const bottomVirtualSpacerStyle = computed<Record<string, string> | null>(() => {
    if (!virtualizedContinuousMode.value) {
        return null;
    }

    const hiddenAfter = Math.max(0, numPages.value - virtualWindowEnd.value);
    const spacerHeight = computeVirtualSpacerHeight(hiddenAfter);
    if (spacerHeight <= 0) {
        return null;
    }

    return {height: `${spacerHeight}px`};
});

const pagesToRender = computed(() => {
    if (numPages.value <= 0) {
        return [];
    }

    if (!virtualizedContinuousMode.value) {
        return range(1, numPages.value + 1);
    }

    return range(virtualWindowStart.value, virtualWindowEnd.value + 1);
});

watchEffect(() => {
    const totalPages = numPages.value;
    const pageHeight = pageHeightEstimate.value;
    const gap = pageGapEstimate.value;

    if (viewMode.value === 'single' && totalPages > 0 && pageHeight > 0) {
        setUniformLayoutMetrics({
            pageHeight,
            gap,
            paddingTop: scaledMargin.value,
            totalPages,
        });
        return;
    }

    setUniformLayoutMetrics(null);
});

onBeforeUnmount(() => {
    setUniformLayoutMetrics(null);
});

function isSpreadSingle(page: number) {
    return isStandaloneSpreadPage(page, viewMode.value, numPages.value);
}

function isSnipActive() {
    return regionSnip.isActive.value;
}

function handleViewerWheel(event: WheelEvent) {
    if (isSnipActive()) {
        event.preventDefault();
        return;
    }
    singlePageScroll.handleWheel(event);
}

function handleViewerMouseDown(event: MouseEvent) {
    if (isSnipActive()) {
        return;
    }
    handleDragStart(event);
}

function handleViewerMouseMove(event: MouseEvent) {
    if (isSnipActive()) {
        return;
    }
    handleDragMove(event);
}

function handleViewerMouseUp() {
    if (isSnipActive()) {
        return;
    }
    highlightComposable.handleViewerMouseUp();
}

function handleViewerMouseLeave() {
    if (isSnipActive()) {
        return;
    }
    stopDrag();
}

function handleViewerClick(event: MouseEvent) {
    if (isSnipActive()) {
        return;
    }
    commentCrud.handleAnnotationCommentClick(event);
}

function handleViewerDblClick(event: MouseEvent) {
    if (isSnipActive()) {
        return;
    }
    commentCrud.handleAnnotationEditorDblClick(event);
}

function handleViewerContextMenu(event: MouseEvent) {
    if (isSnipActive()) {
        event.preventDefault();
        return;
    }
    commentCrud.handleAnnotationCommentContextMenu(event);
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
    return shapeComposable.getShapeById(id);
}

function updateShape(id: string, updates: Partial<IShapeAnnotation>) {
    const previousShape = shapeComposable.getShapeById(id);
    if (!previousShape) {
        return;
    }

    const hasChanges = Object.entries(updates).some(
        ([
            key,
            value,
        ]) => previousShape[key as keyof IShapeAnnotation] !== value,
    );
    if (!hasChanges) {
        return;
    }

    const nextShape: IShapeAnnotation = {
        ...previousShape,
        ...updates,
    };

    shapeComposable.updateShape(id, updates);
    emit('annotation-modified');

    registerShapeHistoryCommand({
        cmd: () => {
            shapeComposable.updateShape(id, nextShape);
            shapeComposable.selectShape(id);
            emit('annotation-modified');
        },
        undo: () => {
            shapeComposable.updateShape(id, previousShape);
            shapeComposable.selectShape(id);
            emit('annotation-modified');
        },
    });
}

function deleteSelectedShape() {
    const id = shapeComposable.selectedShapeId.value;
    if (!id) {
        return;
    }

    const deletedShape = shapeComposable.getShapeById(id);
    if (!deletedShape) {
        return;
    }

    shapeComposable.deleteShape(id);
    emit('annotation-modified');

    registerShapeHistoryCommand({
        cmd: () => {
            shapeComposable.deleteShape(id);
            emit('annotation-modified');
        },
        undo: () => {
            shapeComposable.addShape(deletedShape);
            shapeComposable.selectShape(id);
            emit('annotation-modified');
        },
    });
}

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
    getMarkupSubtypeOverrides: annotations.editor.getMarkupSubtypeOverrides,
    getAllShapes: shapeComposable.getAllShapes,
    loadShapes: shapeComposable.loadShapes,
    clearShapes: shapeComposable.clearShapes,
    deleteSelectedShape,
    hasShapes: shapeComposable.hasShapes,
    selectedShapeId: shapeComposable.selectedShapeId,
    updateShape,
    getSelectedShape,
    applyStampImage,
    invalidatePages,
    captureRegionToClipboard: regionSnip.startCaptureSession,
    isCapturingRegion: regionSnip.isActive,
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

.pdf-viewer-virtual-spacer {
    flex-shrink: 0;
    width: 1px;
    pointer-events: none;
    opacity: 0;
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
    background: var(--app-pdf-viewer-bg);
    display: flex;
    flex-direction: column;

    &.pdfViewer--mode-facing,
    &.pdfViewer--mode-facing-first-single {
        display: grid;
        grid-template-columns: repeat(2, max-content);
        place-content: flex-start center;
    }

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

.pdfViewer.pdfViewer--mode-facing .page_container,
.pdfViewer.pdfViewer--mode-facing-first-single .page_container {
    margin: 0;
}

.pdfViewer .page_container--spread-single {
    grid-column: 1 / -1;
    justify-self: center;
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
        background: var(--app-pdf-viewer-bg);
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
