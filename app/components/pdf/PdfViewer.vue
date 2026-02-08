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
                'pdfViewer--single-page': !continuousScroll,
                'pdfViewer--hidden': src && isLoading,
                'pdfViewer--fit-height': fitMode === 'height',
            }"
            :style="containerStyle"
            @scroll.passive="handleScroll"
            @mousedown="handleDragStart"
            @mousemove="handleDragMove"
            @mouseup="stopDrag"
            @mouseleave="stopDrag"
            @click="handleAnnotationCommentClick"
            @dblclick="handleAnnotationEditorDblClick"
            @contextmenu="handleAnnotationCommentContextMenu"
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
    shallowRef,
    watch,
} from 'vue';
import {
    useDebounceFn,
    useResizeObserver,
} from '@vueuse/core';
import {
    AnnotationEditorParamsType,
    AnnotationEditorType,
    AnnotationEditorUIManager,
    PDFDateString,
    PixelsPerInch,
} from 'pdfjs-dist';
import {
    EventBus,
    GenericL10n,
} from 'pdfjs-dist/web/pdf_viewer.mjs';
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
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationMarkerRect,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';

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
    annotationKeepActive?: boolean;
    annotationSettings?: IAnnotationSettings | null;
    searchPageMatches?: Map<number, IPdfPageMatches>;
    currentSearchMatch?: IPdfSearchMatch | null;
    /** Path to the working copy of the PDF for OCR text layer lookup */
    workingCopyPath?: string | null;
}

const props = defineProps<IProps>();

// Important: avoid destructuring `props` into plain values, otherwise changes from
// the parent won't propagate (Vue can't track those locals).
const src = computed(() => props.src);
const bufferPages = computed(() => props.bufferPages ?? 2);
const zoom = computed(() => props.zoom ?? 1);
const dragMode = computed(() => props.dragMode ?? false);
const fitMode = computed<TFitMode>(() => props.fitMode ?? 'width');
const isResizing = computed(() => props.isResizing ?? false);
const invertColors = computed(() => props.invertColors ?? false);
const showAnnotations = computed(() => props.showAnnotations ?? true);
const annotationTool = computed<TAnnotationTool>(() => props.annotationTool ?? 'none');
const annotationKeepActive = computed(() => props.annotationKeepActive ?? true);
const annotationSettings = computed<IAnnotationSettings | null>(() => props.annotationSettings ?? null);
const emptySearchPageMatches = new Map<number, IPdfPageMatches>();
const searchPageMatches = computed(() => props.searchPageMatches ?? emptySearchPageMatches);
const currentSearchMatch = computed(() => props.currentSearchMatch ?? null);
const workingCopyPath = computed(() => props.workingCopyPath ?? null);

const continuousScroll = computed(() => props.continuousScroll ?? true);

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
    (e: 'annotation-context-menu', payload: {
        comment: IAnnotationCommentSummary;
        clientX: number;
        clientY: number;
    }): void;
    (e: 'annotation-tool-auto-reset'): void;
    (e: 'annotation-tool-cancel'): void;
}>();

const viewerContainer = ref<HTMLElement | null>(null);

const annotationEventBus = shallowRef<EventBus | null>(null);
const annotationUiManager = shallowRef<AnnotationEditorUIManager | null>(null);
const annotationL10n = shallowRef<GenericL10n | null>(null);
const annotationState = ref<IAnnotationEditorState>({
    isEditing: false,
    isEmpty: true,
    hasSomethingToUndo: false,
    hasSomethingToRedo: false,
    hasSelectedEditor: false,
});
const annotationCommentsCache = ref<IAnnotationCommentSummary[]>([]);
const pendingAnnotationTool = ref<TAnnotationTool>(annotationTool.value);
const pendingAnnotationSettings = ref<IAnnotationSettings | null>(annotationSettings.value);

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
    scrollToPage,
    searchPageMatches,
    currentSearchMatch,
    workingCopyPath,
});

const pagesToRender = computed(() => range(1, numPages.value + 1));

const SKELETON_BUFFER = 3;
const isSnapping = ref(false);

let annotationStateListener: ((event: { details?: Partial<IAnnotationEditorState> }) => void) | null = null;

const DEFAULT_PDFJS_HIGHLIGHT_COLORS = 'yellow=#FFFF98,green=#98FF98,blue=#98C0FF,pink=#FF98FF,red=#FF9090';
let annotationCommentsSyncToken = 0;
const editorRuntimeIds = new WeakMap<IPdfjsEditor, string>();
let editorRuntimeIdCounter = 0;
let cachedSelectionRange: Range | null = null;
let cachedSelectionTimestamp = 0;
const SELECTION_CACHE_TTL_MS = 3000;
const activeCommentStableKey = ref<string | null>(null);
const pendingCommentEditorKeys = new Set<string>();
const trackedCreatedEditors = new WeakSet<object>();
const patchedAnnotationLayerDestroy = new WeakSet<object>();
let inlineCommentMarkerObserver: MutationObserver | null = null;
const commentSummaryMemory = new Map<string, {
    text: string;
    modifiedAt: number | null;
    author: string | null;
    kindLabel: string | null;
    subtype: string | null;
    color: string | null;
    markerRect: IAnnotationMarkerRect | null;
}>();

/**
 * Minimal shape for PDF.js annotation editor instances.
 * PDF.js doesn't export a public type for individual editors, so we define
 * just the properties we actually access to satisfy the type checker.
 */
interface IPdfjsEditor {
    id?: string;
    div?: HTMLElement;
    uid?: string;
    annotationElementId?: string | null;
    comment?: string | { text?: string } | null;
    hasComment?: boolean;
    color?: string | number[] | null;
    opacity?: number;
    parentPageIndex?: number;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    parent?: { div?: HTMLElement };
    getData?: () => {
        modificationDate?: string | null;
        creationDate?: string | null;
        color?: string | number[] | null;
        opacity?: number;
    };
    toggleComment?: (isSelected: boolean, visibility?: boolean) => void;
    addToAnnotationStorage?: () => void;
    focusCommentButton?: () => void;
    remove?: () => void;
    delete?: () => void;
}

function getCommentText(editor: IPdfjsEditor | null | undefined) {
    if (!editor) {
        return '';
    }
    try {
        const comment = editor.comment;
        if (typeof comment === 'string') {
            return comment;
        }
        if (comment && typeof comment.text === 'string') {
            return comment.text;
        }
    } catch {
        return '';
    }
    return '';
}

function hasEditorCommentPayload(editor: IPdfjsEditor | null | undefined) {
    if (!editor) {
        return false;
    }
    try {
        const comment = editor.comment;
        if (typeof comment === 'string') {
            return true;
        }
        if (comment && typeof comment === 'object' && 'text' in comment) {
            return true;
        }
    } catch {
        return false;
    }
    return Boolean(editor.hasComment);
}

function parsePdfDateTimestamp(value: string | null | undefined) {
    if (!value) {
        return null;
    }

    try {
        const date = PDFDateString.toDateObject(value);
        if (!date) {
            return null;
        }
        return date.getTime();
    } catch {
        return null;
    }
}

function toCssColor(
    color: string | number[] | {
        r: number;
        g: number;
        b: number;
    } | null | undefined,
    opacity = 1,
) {
    if (!color) {
        return null;
    }

    if (typeof color === 'string') {
        return color;
    }

    if (Array.isArray(color) && color.length >= 3) {
        return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${opacity})`;
    }

    if (
        typeof (color as { r?: number }).r === 'number'
        && typeof (color as { g?: number }).g === 'number'
        && typeof (color as { b?: number }).b === 'number'
    ) {
        const rgb = color as {
            r: number;
            g: number;
            b: number;
        };
        return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
    }

    return null;
}

function normalizeMarkerRect(rect: IAnnotationMarkerRect | null | undefined): IAnnotationMarkerRect | null {
    if (!rect) {
        return null;
    }
    const left = Number.isFinite(rect.left) ? rect.left : 0;
    const top = Number.isFinite(rect.top) ? rect.top : 0;
    const width = Number.isFinite(rect.width) ? rect.width : 0;
    const height = Number.isFinite(rect.height) ? rect.height : 0;
    if (width <= 0 || height <= 0) {
        return null;
    }

    const clampedLeft = Math.min(1, Math.max(0, left));
    const clampedTop = Math.min(1, Math.max(0, top));
    const maxWidth = 1 - clampedLeft;
    const maxHeight = 1 - clampedTop;
    const clampedWidth = Math.min(maxWidth, Math.max(0, width));
    const clampedHeight = Math.min(maxHeight, Math.max(0, height));
    if (clampedWidth <= 0 || clampedHeight <= 0) {
        return null;
    }

    return {
        left: clampedLeft,
        top: clampedTop,
        width: clampedWidth,
        height: clampedHeight,
    };
}

function toMarkerRectFromPdfRect(
    rect: number[] | null | undefined,
    pageView: number[] | null | undefined,
): IAnnotationMarkerRect | null {
    if (!rect || rect.length < 4 || !pageView || pageView.length < 4) {
        return null;
    }

    const x1 = rect[0] ?? 0;
    const y1 = rect[1] ?? 0;
    const x2 = rect[2] ?? 0;
    const y2 = rect[3] ?? 0;
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);

    const xMin = pageView[0] ?? 0;
    const yMin = pageView[1] ?? 0;
    const xMax = pageView[2] ?? 0;
    const yMax = pageView[3] ?? 0;
    const pageWidth = xMax - xMin;
    const pageHeight = yMax - yMin;
    if (!Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth <= 0 || pageHeight <= 0) {
        return null;
    }

    return normalizeMarkerRect({
        left: (minX - xMin) / pageWidth,
        top: (yMax - maxY) / pageHeight,
        width: (maxX - minX) / pageWidth,
        height: (maxY - minY) / pageHeight,
    });
}

function toMarkerRectFromEditor(editor: IPdfjsEditor): IAnnotationMarkerRect | null {
    const editorDiv = editor.div;
    if (!editorDiv) {
        return null;
    }
    const pageContainer = editorDiv.closest<HTMLElement>('.page_container');
    if (!pageContainer) {
        return null;
    }
    const pageRect = pageContainer.getBoundingClientRect();
    const editorRect = editorDiv.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0 || editorRect.width <= 0 || editorRect.height <= 0) {
        return null;
    }

    return normalizeMarkerRect({
        left: (editorRect.left - pageRect.left) / pageRect.width,
        top: (editorRect.top - pageRect.top) / pageRect.height,
        width: editorRect.width / pageRect.width,
        height: editorRect.height / pageRect.height,
    });
}

function getAnnotationCommentText(annotation: {
    contents?: string;
    contentsObj?: { str?: string | null };
    richText?: { str?: string | null };
}) {
    const rich = annotation.richText?.str?.trim();
    if (rich) {
        return rich;
    }
    const structured = annotation.contentsObj?.str?.trim();
    if (structured) {
        return structured;
    }
    return annotation.contents?.trim() ?? '';
}

function getAnnotationAuthor(annotation: {
    titleObj?: { str?: string | null };
    title?: string;
}) {
    const withObj = annotation.titleObj?.str?.trim();
    if (withObj) {
        return withObj;
    }
    const direct = annotation.title?.trim();
    return direct || null;
}

function annotationKindLabelFromSubtype(subtype: string | null | undefined) {
    const normalized = (subtype ?? '').trim().toLowerCase();
    switch (normalized) {
        case 'highlight':
            return 'Highlight';
        case 'underline':
            return 'Underline';
        case 'squiggly':
            return 'Squiggle';
        case 'strikeout':
            return 'Strike Out';
        case 'text':
        case 'note-linked':
            return 'Pop-up Note';
        case 'freetext':
        case 'typewriter':
        case 'note-inline':
            return 'Inline Note';
        case 'ink':
            return 'Freehand Line';
        case 'line':
        case 'straight-line':
            return 'Line';
        case 'square':
        case 'geomsquare':
        case 'rectangle':
            return 'Rectangle';
        case 'circle':
        case 'geomcircle':
        case 'ellipse':
            return 'Ellipse';
        case 'polygon':
            return 'Polygon';
        case 'stamp':
            return 'Stamp';
        default:
            return 'Annotation';
    }
}

function isPopupSubtype(subtype: string | null | undefined) {
    return (subtype ?? '').trim().toLowerCase() === 'popup';
}

function detectEditorSubtype(editor: IPdfjsEditor) {
    const className = editor.div?.className ?? '';
    if (className.includes('highlightEditor')) {
        return 'Highlight';
    }
    if (className.includes('freeTextEditor')) {
        return 'Typewriter';
    }
    if (className.includes('inkEditor')) {
        return 'Ink';
    }
    return null;
}

function compareAnnotationComments(a: IAnnotationCommentSummary, b: IAnnotationCommentSummary) {
    if (a.pageIndex !== b.pageIndex) {
        return a.pageIndex - b.pageIndex;
    }

    const sortIndexA = typeof a.sortIndex === 'number' ? a.sortIndex : null;
    const sortIndexB = typeof b.sortIndex === 'number' ? b.sortIndex : null;
    if (sortIndexA !== null && sortIndexB !== null && sortIndexA !== sortIndexB) {
        return sortIndexA - sortIndexB;
    }
    if (sortIndexA !== null && sortIndexB === null) {
        return -1;
    }
    if (sortIndexA === null && sortIndexB !== null) {
        return 1;
    }

    const aTime = a.modifiedAt ?? 0;
    const bTime = b.modifiedAt ?? 0;
    if (aTime !== bTime) {
        return bTime - aTime;
    }
    return a.stableKey.localeCompare(b.stableKey);
}

function toCanonicalStableKey(summary: Pick<IAnnotationCommentSummary, 'id' | 'pageIndex' | 'source' | 'uid' | 'annotationId'>) {
    return computeSummaryStableKey({
        id: summary.id,
        pageIndex: summary.pageIndex,
        source: summary.source,
        uid: summary.uid,
        annotationId: summary.annotationId,
    });
}

function normalizeSummaryStableKey(summary: IAnnotationCommentSummary): IAnnotationCommentSummary {
    return {
        ...summary,
        stableKey: toCanonicalStableKey(summary),
    };
}

function markerRectIoU(
    leftRect: IAnnotationMarkerRect | null | undefined,
    rightRect: IAnnotationMarkerRect | null | undefined,
) {
    const left = normalizeMarkerRect(leftRect);
    const right = normalizeMarkerRect(rightRect);
    if (!left || !right) {
        return 0;
    }

    const intersectionLeft = Math.max(left.left, right.left);
    const intersectionTop = Math.max(left.top, right.top);
    const intersectionRight = Math.min(left.left + left.width, right.left + right.width);
    const intersectionBottom = Math.min(left.top + left.height, right.top + right.height);
    const intersectionWidth = Math.max(0, intersectionRight - intersectionLeft);
    const intersectionHeight = Math.max(0, intersectionBottom - intersectionTop);
    const intersectionArea = intersectionWidth * intersectionHeight;
    if (intersectionArea <= 0) {
        return 0;
    }

    const leftArea = left.width * left.height;
    const rightArea = right.width * right.height;
    const unionArea = leftArea + rightArea - intersectionArea;
    if (unionArea <= 0) {
        return 0;
    }

    return intersectionArea / unionArea;
}

function areTextMarkupCommentsLikelySame(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    if (left.pageIndex !== right.pageIndex) {
        return false;
    }
    if (!isTextMarkupSubtype(left.subtype) || !isTextMarkupSubtype(right.subtype)) {
        return false;
    }

    const iou = markerRectIoU(left.markerRect, right.markerRect);
    if (iou >= 0.46) {
        return true;
    }

    const leftRect = normalizeMarkerRect(left.markerRect);
    const rightRect = normalizeMarkerRect(right.markerRect);
    if (!leftRect || !rightRect) {
        return false;
    }

    const leftCenterX = leftRect.left + leftRect.width / 2;
    const leftCenterY = leftRect.top + leftRect.height / 2;
    const rightCenterX = rightRect.left + rightRect.width / 2;
    const rightCenterY = rightRect.top + rightRect.height / 2;
    const dx = leftCenterX - rightCenterX;
    const dy = leftCenterY - rightCenterY;
    const centerDistance = Math.hypot(dx, dy);

    const leftArea = leftRect.width * leftRect.height;
    const rightArea = rightRect.width * rightRect.height;
    const largerArea = Math.max(leftArea, rightArea);
    const smallerArea = Math.max(1e-6, Math.min(leftArea, rightArea));
    const areaRatio = largerArea / smallerArea;

    return centerDistance <= 0.045 && areaRatio <= 2.8;
}

function commentsAreSameLogicalAnnotation(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    if (left.pageIndex !== right.pageIndex) {
        return false;
    }

    if (left.annotationId && right.annotationId) {
        return left.annotationId === right.annotationId;
    }

    if (left.uid && right.uid) {
        return left.uid === right.uid;
    }

    if (left.annotationId && right.annotationId === null) {
        const rightHasText = right.text.trim().length > 0;
        const leftHasText = left.text.trim().length > 0;
        const textCompatible = !leftHasText || !rightHasText || left.text.trim() === right.text.trim();
        return textCompatible && areTextMarkupCommentsLikelySame(left, right);
    }

    if (right.annotationId && left.annotationId === null) {
        const rightHasText = right.text.trim().length > 0;
        const leftHasText = left.text.trim().length > 0;
        const textCompatible = !leftHasText || !rightHasText || left.text.trim() === right.text.trim();
        return textCompatible && areTextMarkupCommentsLikelySame(left, right);
    }

    if (left.uid && !right.uid) {
        const rightHasText = right.text.trim().length > 0;
        const leftHasText = left.text.trim().length > 0;
        const textCompatible = !leftHasText || !rightHasText || left.text.trim() === right.text.trim();
        return textCompatible && areTextMarkupCommentsLikelySame(left, right);
    }

    if (right.uid && !left.uid) {
        const rightHasText = right.text.trim().length > 0;
        const leftHasText = left.text.trim().length > 0;
        const textCompatible = !leftHasText || !rightHasText || left.text.trim() === right.text.trim();
        return textCompatible && areTextMarkupCommentsLikelySame(left, right);
    }

    return (
        left.id === right.id
        && left.source === right.source
    ) || areTextMarkupCommentsLikelySame(left, right);
}

function commentMergePriority(comment: IAnnotationCommentSummary) {
    let score = 0;
    if (comment.annotationId) {
        score += 110;
    }
    if (comment.uid) {
        score += 55;
    }
    if (comment.source === 'editor') {
        score += 22;
    }
    if (comment.text.trim()) {
        score += 12;
    }
    if (comment.hasNote) {
        score += 8;
    }
    if (comment.modifiedAt) {
        score += 5;
    }
    if (comment.markerRect) {
        score += 3;
    }
    return score;
}

function mergeDuplicateCommentSummary(
    primary: IAnnotationCommentSummary,
    secondary: IAnnotationCommentSummary,
): IAnnotationCommentSummary {
    const merged = mergeCommentSummaries(primary, secondary);
    const annotationId = primary.annotationId ?? secondary.annotationId ?? null;
    const uid = primary.uid ?? secondary.uid ?? null;
    const markerRect = normalizeMarkerRect(primary.markerRect)
        ?? normalizeMarkerRect(secondary.markerRect)
        ?? null;
    const source: IAnnotationCommentSummary['source'] = (
        primary.source === 'editor' || secondary.source === 'editor'
            ? 'editor'
            : 'pdf'
    );
    const primarySortIndex = typeof primary.sortIndex === 'number' ? primary.sortIndex : null;
    const secondarySortIndex = typeof secondary.sortIndex === 'number' ? secondary.sortIndex : null;
    const sortIndex = (
        primarySortIndex !== null && secondarySortIndex !== null
            ? Math.min(primarySortIndex, secondarySortIndex)
            : (primarySortIndex ?? secondarySortIndex)
    );

    const id = annotationId
        ? (
            primary.annotationId
                ? primary.id
                : secondary.id
        )
        : (
            uid
                ? (primary.uid ? primary.id : secondary.id)
                : merged.id
        );

    const normalized: IAnnotationCommentSummary = {
        ...merged,
        id,
        sortIndex,
        annotationId,
        uid,
        source,
        markerRect,
    };
    return normalizeSummaryStableKey(normalized);
}

function dedupeAnnotationCommentSummaries(comments: IAnnotationCommentSummary[]) {
    const sorted = comments
        .map(comment => normalizeSummaryStableKey(comment))
        .sort((left, right) => {
            const priorityDelta = commentMergePriority(right) - commentMergePriority(left);
            if (priorityDelta !== 0) {
                return priorityDelta;
            }
            const leftTs = left.modifiedAt ?? 0;
            const rightTs = right.modifiedAt ?? 0;
            if (leftTs !== rightTs) {
                return rightTs - leftTs;
            }
            return left.stableKey.localeCompare(right.stableKey);
        });

    const merged: IAnnotationCommentSummary[] = [];
    for (const candidate of sorted) {
        const existingIndex = merged.findIndex(existing => commentsAreSameLogicalAnnotation(existing, candidate));
        if (existingIndex === -1) {
            merged.push(candidate);
            continue;
        }
        const primary = merged[existingIndex];
        if (!primary) {
            merged.push(candidate);
            continue;
        }
        merged[existingIndex] = mergeDuplicateCommentSummary(primary, candidate);
    }

    return merged.sort(compareAnnotationComments);
}

function getEditorRuntimeId(editor: IPdfjsEditor, pageIndex: number) {
    let runtimeId = editorRuntimeIds.get(editor);
    if (!runtimeId) {
        editorRuntimeIdCounter += 1;
        runtimeId = `runtime-${pageIndex}-${editorRuntimeIdCounter}`;
        editorRuntimeIds.set(editor, runtimeId);
    }
    return runtimeId;
}

function getEditorIdentity(editor: IPdfjsEditor, pageIndex: number) {
    const rawEditorId = typeof editor.id === 'string' || typeof editor.id === 'number'
        ? String(editor.id)
        : '';
    return editor.uid
        ?? editor.annotationElementId
        ?? (rawEditorId ? `editor:${pageIndex}:${rawEditorId}` : null)
        ?? getEditorRuntimeId(editor, pageIndex);
}

function getEditorPendingKey(editor: IPdfjsEditor, pageIndex: number) {
    return `p${pageIndex}:${getEditorIdentity(editor, pageIndex)}`;
}

function computeSummaryStableKey(params: {
    pageIndex: number;
    id: string;
    source: IAnnotationCommentSummary['source'];
    uid?: string | null;
    annotationId?: string | null;
}) {
    if (params.annotationId) {
        return `ann:${params.pageIndex}:${params.annotationId}`;
    }
    if (params.uid) {
        return `uid:${params.pageIndex}:${params.uid}`;
    }
    return `src:${params.source}:${params.pageIndex}:${params.id}`;
}

function toEditorSummary(
    editor: IPdfjsEditor,
    pageIndex: number,
    textOverride?: string,
    sortIndex: number | null = null,
): IAnnotationCommentSummary {
    let data: ReturnType<NonNullable<IPdfjsEditor['getData']>> = {};
    try {
        data = editor.getData?.() ?? {};
    } catch {
        data = {};
    }
    const text = typeof textOverride === 'string'
        ? textOverride
        : getCommentText(editor).trim();
    const subtype = detectEditorSubtype(editor);
    const uid = editor.uid ?? null;
    const annotationId = editor.annotationElementId ?? null;
    const hasNote = hasEditorCommentPayload(editor) || text.length > 0;
    const id = getEditorIdentity(editor, pageIndex);

    return {
        id,
        stableKey: computeSummaryStableKey({
            id,
            pageIndex,
            source: 'editor',
            uid,
            annotationId,
        }),
        sortIndex,
        pageIndex,
        pageNumber: pageIndex + 1,
        text,
        kindLabel: annotationKindLabelFromSubtype(subtype),
        subtype,
        author: null,
        modifiedAt: parsePdfDateTimestamp(data.modificationDate) ?? parsePdfDateTimestamp(data.creationDate),
        color: toCssColor(data.color ?? editor.color, data.opacity ?? editor.opacity ?? 1),
        uid,
        annotationId,
        source: 'editor',
        hasNote,
        markerRect: toMarkerRectFromEditor(editor),
    };
}

function getSummaryMemoryKeys(summary: Pick<IAnnotationCommentSummary, 'stableKey' | 'pageIndex' | 'annotationId' | 'uid' | 'id'>) {
    const keys = new Set<string>();
    if (summary.stableKey) {
        keys.add(`stable:${summary.stableKey}`);
    }
    if (summary.annotationId) {
        keys.add(`ann:${summary.pageIndex}:${summary.annotationId}`);
        keys.add(`ann:any:${summary.annotationId}`);
    }
    if (summary.uid) {
        keys.add(`uid:${summary.pageIndex}:${summary.uid}`);
        keys.add(`uid:any:${summary.uid}`);
    }
    if (summary.id) {
        keys.add(`id:${summary.pageIndex}:${summary.id}`);
        keys.add(`id:any:${summary.id}`);
    }
    return Array.from(keys);
}

function rememberSummaryText(summary: IAnnotationCommentSummary) {
    const text = summary.text.trim();
    if (!text) {
        return;
    }
    const payload = {
        text: summary.text,
        modifiedAt: summary.modifiedAt ?? null,
        author: summary.author ?? null,
        kindLabel: summary.kindLabel ?? null,
        subtype: summary.subtype ?? null,
        color: summary.color ?? null,
        markerRect: summary.markerRect ?? null,
    };
    getSummaryMemoryKeys(summary).forEach((key) => {
        commentSummaryMemory.set(key, payload);
    });
}

function commentsMatchForEditorLookup(
    left: Pick<IAnnotationCommentSummary, 'stableKey' | 'annotationId' | 'uid' | 'id' | 'pageIndex' | 'source'>,
    right: Pick<IAnnotationCommentSummary, 'stableKey' | 'annotationId' | 'uid' | 'id' | 'pageIndex' | 'source'>,
) {
    if (left.stableKey && right.stableKey && left.stableKey === right.stableKey) {
        return true;
    }
    if (left.annotationId && right.annotationId) {
        return left.annotationId === right.annotationId && left.pageIndex === right.pageIndex;
    }
    if (left.uid && right.uid) {
        return left.uid === right.uid && left.pageIndex === right.pageIndex;
    }
    return (
        left.id === right.id
        && left.pageIndex === right.pageIndex
        && left.source === right.source
    );
}

function resolveCommentFromCache(comment: IAnnotationCommentSummary) {
    const direct = findCommentByStableKey(comment.stableKey);
    if (direct) {
        return direct;
    }
    return annotationCommentsCache.value.find(candidate => commentsMatchForEditorLookup(candidate, comment)) ?? null;
}

function forgetSummaryText(summary: IAnnotationCommentSummary) {
    getSummaryMemoryKeys(summary).forEach((key) => {
        commentSummaryMemory.delete(key);
    });
}

function hydrateSummaryFromMemory(summary: IAnnotationCommentSummary) {
    if (summary.text.trim()) {
        return summary;
    }
    if (summary.hasNote) {
        return summary;
    }

    for (const key of getSummaryMemoryKeys(summary)) {
        const cached = commentSummaryMemory.get(key);
        if (!cached || !cached.text.trim()) {
            continue;
        }
        return {
            ...summary,
            text: cached.text,
            modifiedAt: summary.modifiedAt ?? cached.modifiedAt,
            author: summary.author ?? cached.author,
            kindLabel: summary.kindLabel ?? cached.kindLabel,
            subtype: summary.subtype ?? cached.subtype,
            color: summary.color ?? cached.color,
            markerRect: summary.markerRect ?? cached.markerRect,
        };
    }

    return summary;
}

function cacheCurrentTextSelection() {
    const container = viewerContainer.value;
    if (!container) {
        cachedSelectionRange = null;
        return;
    }

    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return;
    }

    const range = selection.getRangeAt(0);
    const commonAncestor = range.commonAncestorContainer;
    const element = commonAncestor.nodeType === Node.TEXT_NODE
        ? commonAncestor.parentElement
        : commonAncestor as HTMLElement | null;

    if (!element?.closest('.text-layer, .textLayer') || !container.contains(element)) {
        cachedSelectionRange = null;
        cachedSelectionTimestamp = 0;
        return;
    }

    cachedSelectionRange = range.cloneRange();
    cachedSelectionTimestamp = Date.now();
}

function shouldIgnoreEditorEvent(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    if (target.isContentEditable) {
        return true;
    }
    const tagName = target.tagName;
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
        return true;
    }
    if (target.closest('.pdf-annotation-comment-popup, #commentPopup, #commentManagerDialog')) {
        return true;
    }
    if (target.closest('[contenteditable="true"], [contenteditable=""]')) {
        return true;
    }
    return false;
}

function createSimpleCommentManager(_container: HTMLElement) {
    const dialogElement = document.createElement('div');
    dialogElement.className = 'pdf-annotation-comment-dialog-placeholder';
    dialogElement.setAttribute('aria-hidden', 'true');
    dialogElement.style.display = 'none';

    return {
        dialogElement,
        setSidebarUiManager: (_uiManager: AnnotationEditorUIManager) => {},
        destroyPopup: () => {},
        showSidebar: () => {},
        hideSidebar: () => {},
        showDialog: (_uiManager: unknown, editor: IPdfjsEditor) => {
            const summary = hydrateSummaryFromMemory(
                toEditorSummary(editor, editor.parentPageIndex ?? currentPage.value - 1, getCommentText(editor)),
            );
            setActiveCommentStableKey(summary.stableKey);
            emit('annotation-open-note', summary);
        },
        updateComment: () => {
            scheduleAnnotationCommentsSync();
        },
        updatePopupColor: () => {},
        removeComments: () => {
            scheduleAnnotationCommentsSync();
        },
        toggleCommentPopup: () => {},
        makeCommentColor: (
            color: string | number[] | {
                r: number;
                g: number;
                b: number;
            } | null,
            opacity = 1,
        ) => toCssColor(color, opacity),
        destroy: () => {
            dialogElement.remove();
        },
    };
}

function installAnnotationLayerDestroyGuard(uiManager: AnnotationEditorUIManager) {
    const hiddenFallbackDiv = document.createElement('div');
    hiddenFallbackDiv.className = 'annotation-editor-layer-destroyed-fallback';
    hiddenFallbackDiv.setAttribute('aria-hidden', 'true');
    hiddenFallbackDiv.style.display = 'none';
    const hiddenTextLayerFallbackDiv = document.createElement('div');
    hiddenTextLayerFallbackDiv.className = 'annotation-editor-layer-text-fallback';
    hiddenTextLayerFallbackDiv.setAttribute('aria-hidden', 'true');
    hiddenTextLayerFallbackDiv.style.display = 'none';

    const hardenElementProperty = (
        owner: object,
        key: string,
        fallback: HTMLElement,
    ) => {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        if (descriptor && descriptor.get && descriptor.set && descriptor.configurable === false) {
            return;
        }

        const initial = Reflect.get(owner, key);
        let current = initial instanceof HTMLElement
            ? initial
            : fallback;

        Object.defineProperty(owner, key, {
            configurable: true,
            enumerable: true,
            get() {
                return current ?? fallback;
            },
            set(value: unknown) {
                current = value instanceof HTMLElement
                    ? value
                    : fallback;
            },
        });

        Reflect.set(owner, key, current);
    };

    const patchLayerSafety = (layer: unknown) => {
        if (!layer || typeof layer !== 'object' || patchedAnnotationLayerDestroy.has(layer)) {
            return;
        }
        const candidate = layer as {
            div?: HTMLElement | null;
            textLayer?: { div?: HTMLElement | null } | null;
            disable?: () => void;
            destroy?: () => void;
        };
        if (typeof candidate.destroy !== 'function' && typeof candidate.disable !== 'function') {
            return;
        }

        hardenElementProperty(candidate as object, 'div', hiddenFallbackDiv);
        if (candidate.textLayer && typeof candidate.textLayer === 'object') {
            hardenElementProperty(candidate.textLayer as object, 'div', hiddenTextLayerFallbackDiv);
        }

        if (typeof candidate.disable === 'function') {
            const originalDisable = candidate.disable.bind(candidate);
            candidate.disable = () => {
                if (!candidate.div) {
                    candidate.div = hiddenFallbackDiv;
                }
                if (candidate.textLayer && !candidate.textLayer.div) {
                    candidate.textLayer.div = hiddenTextLayerFallbackDiv;
                }
                originalDisable();
                if (!candidate.div) {
                    candidate.div = hiddenFallbackDiv;
                }
                if (candidate.textLayer && !candidate.textLayer.div) {
                    candidate.textLayer.div = hiddenTextLayerFallbackDiv;
                }
            };
        }

        if (typeof candidate.destroy === 'function') {
            const originalDestroy = candidate.destroy.bind(candidate);
            candidate.destroy = () => {
                originalDestroy();
                if (candidate.div == null) {
                    // PDF.js may invoke stale text-layer pointer listeners after destroy().
                    // Keep a harmless detached element so classList/contains access stays safe.
                    candidate.div = hiddenFallbackDiv;
                }
                if (candidate.textLayer && !candidate.textLayer.div) {
                    candidate.textLayer.div = hiddenTextLayerFallbackDiv;
                }
            };
        }

        if (candidate.div == null) {
            candidate.div = hiddenFallbackDiv;
        }
        if (candidate.textLayer && !candidate.textLayer.div) {
            candidate.textLayer.div = hiddenTextLayerFallbackDiv;
        }

        patchedAnnotationLayerDestroy.add(layer);
    };

    for (let pageIndex = 0; pageIndex < numPages.value; pageIndex += 1) {
        patchLayerSafety(uiManager.getLayer(pageIndex));
    }

    const managerWithAddLayer = uiManager as AnnotationEditorUIManager & { addLayer?: (layer: unknown) => void };
    const originalAddLayer = managerWithAddLayer.addLayer;
    if (typeof originalAddLayer === 'function') {
        managerWithAddLayer.addLayer = (layer: unknown) => {
            patchLayerSafety(layer);
            originalAddLayer.call(uiManager, layer);
        };
    }
}

function getAnnotationMode(tool: TAnnotationTool) {
    switch (tool) {
        case 'highlight':
            return AnnotationEditorType.HIGHLIGHT;
        case 'text':
            return AnnotationEditorType.FREETEXT;
        case 'draw':
            return AnnotationEditorType.INK;
        case 'none':
        default:
            return AnnotationEditorType.NONE;
    }
}

type TUiManagerSelectedEditor = Parameters<AnnotationEditorUIManager['setSelected']>[0];

function colorWithOpacity(color: string, opacity: number) {
    if (color.startsWith('#') && (color.length === 7 || color.length === 4)) {
        const hex = color.length === 4
            ? color
                .slice(1)
                .split('')
                .map((c) => c + c)
                .join('')
            : color.slice(1);
        const r = Number.parseInt(hex.slice(0, 2), 16);
        const g = Number.parseInt(hex.slice(2, 4), 16);
        const b = Number.parseInt(hex.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }

    // Unknown format: best-effort.
    return color;
}

function applyAnnotationSettings(settings: IAnnotationSettings | null) {
    pendingAnnotationSettings.value = settings;
    const uiManager = annotationUiManager.value;
    if (!uiManager || !settings) {
        return;
    }

    uiManager.updateParams(
        AnnotationEditorParamsType.HIGHLIGHT_COLOR,
        colorWithOpacity(settings.highlightColor, settings.highlightOpacity),
    );
    uiManager.updateParams(AnnotationEditorParamsType.HIGHLIGHT_THICKNESS, settings.highlightThickness);
    uiManager.updateParams(AnnotationEditorParamsType.HIGHLIGHT_FREE, settings.highlightFree);
    uiManager.updateParams(AnnotationEditorParamsType.HIGHLIGHT_SHOW_ALL, settings.highlightShowAll);
    uiManager.updateParams(AnnotationEditorParamsType.INK_COLOR, settings.inkColor);
    uiManager.updateParams(AnnotationEditorParamsType.INK_OPACITY, settings.inkOpacity);
    uiManager.updateParams(AnnotationEditorParamsType.INK_THICKNESS, settings.inkThickness);
    uiManager.updateParams(AnnotationEditorParamsType.FREETEXT_COLOR, settings.textColor);
    uiManager.updateParams(AnnotationEditorParamsType.FREETEXT_SIZE, settings.textSize);
}

async function setAnnotationTool(tool: TAnnotationTool) {
    pendingAnnotationTool.value = tool;
    const uiManager = annotationUiManager.value;
    if (!uiManager) {
        return;
    }
    const mode = getAnnotationMode(tool);
    try {
        await uiManager.updateMode(mode);
    } catch (error) {
        const message = error instanceof Error
            ? error.message
            : typeof error === 'string'
                ? error
                : (() => {
                    try {
                        return JSON.stringify(error);
                    } catch {
                        return String(error);
                    }
                })();

        const stack = error instanceof Error ? error.stack ?? '' : '';
        const text = stack
            ? `Failed to update annotation tool mode: ${message}\n${stack}`
            : `Failed to update annotation tool mode: ${message}`;

        console.warn(text);
    }
}

function maybeAutoResetAnnotationTool() {
    if (annotationKeepActive.value) {
        return;
    }
    if (annotationTool.value === 'none') {
        return;
    }
    queueMicrotask(() => {
        emit('annotation-tool-auto-reset');
    });
}

function highlightSelection() {
    void highlightSelectionInternal(false);
}

function commentSelection() {
    void highlightSelectionInternal(true);
}

function undoAnnotation() {
    annotationUiManager.value?.undo();
}

function redoAnnotation() {
    annotationUiManager.value?.redo();
}

function toSummaryKey(summary: IAnnotationCommentSummary) {
    return summary.stableKey;
}

function mergeCommentSummaries(
    existing: IAnnotationCommentSummary,
    incoming: IAnnotationCommentSummary,
): IAnnotationCommentSummary {
    const existingText = existing.text.trim();
    const text = existingText.length > 0
        ? existing.text
        : incoming.text;

    const author = existing.author?.trim()
        ? existing.author
        : incoming.author;

    const kindLabel = existing.kindLabel?.trim()
        ? existing.kindLabel
        : incoming.kindLabel;

    const modifiedAt = (() => {
        const existingTs = existing.modifiedAt ?? null;
        const incomingTs = incoming.modifiedAt ?? null;
        if (existingTs && incomingTs) {
            return Math.max(existingTs, incomingTs);
        }
        return existingTs ?? incomingTs;
    })();

    // Keep the editor/source identity for write operations, but hydrate empty
    // fields from persisted PDF annotation data when available.
    const source = existing.source === 'editor'
        ? 'editor'
        : incoming.source;
    const existingSortIndex = typeof existing.sortIndex === 'number' ? existing.sortIndex : null;
    const incomingSortIndex = typeof incoming.sortIndex === 'number' ? incoming.sortIndex : null;
    const sortIndex = (
        existingSortIndex !== null && incomingSortIndex !== null
            ? Math.min(existingSortIndex, incomingSortIndex)
            : (existingSortIndex ?? incomingSortIndex)
    );
    const hasNote = Boolean(existing.hasNote || incoming.hasNote);

    return {
        ...existing,
        text,
        author,
        kindLabel,
        modifiedAt,
        sortIndex,
        annotationId: existing.annotationId ?? incoming.annotationId,
        uid: existing.uid ?? incoming.uid,
        subtype: existing.subtype ?? incoming.subtype,
        color: existing.color ?? incoming.color,
        source,
        hasNote,
        markerRect: existing.markerRect ?? incoming.markerRect ?? null,
    };
}

function isTextMarkupSubtype(subtype: string | null | undefined) {
    const normalized = (subtype ?? '').trim().toLowerCase();
    return (
        normalized === 'highlight'
        || normalized === 'underline'
        || normalized === 'squiggly'
        || normalized === 'strikeout'
    );
}

function clearInlineCommentIndicators() {
    const container = viewerContainer.value;
    if (!container) {
        return;
    }
    container.querySelectorAll<HTMLElement>('.pdf-annotation-has-note-target, .pdf-annotation-has-comment').forEach((element) => {
        element.classList.remove(
            'pdf-annotation-has-note-target',
            'pdf-annotation-has-note-anchor',
            'pdf-annotation-has-note-active',
            // Legacy classes kept for safe cleanup during migration.
            'pdf-annotation-has-comment',
            'has-comment',
            'pdf-annotation-has-comment--active',
        );
        element.removeAttribute('data-comment-preview');
        element.removeAttribute('data-comment-stable-key');
    });
    container.querySelectorAll<HTMLElement>('.pdf-comment-marker-layer').forEach((layer) => {
        layer.remove();
    });
}

function markInlineCommentTarget(target: HTMLElement, text: string) {
    const normalizedText = text.trim();
    if (!normalizedText) {
        return;
    }
    const preview = normalizedText.length > 280
        ? `${normalizedText.slice(0, 277)}...`
        : normalizedText;
    target.classList.add('pdf-annotation-has-note-target');
    target.setAttribute('data-comment-preview', preview);
}

function isCommentActive(stableKey: string) {
    return activeCommentStableKey.value === stableKey;
}

function markInlineCommentTargetWithKey(
    target: HTMLElement,
    text: string,
    stableKey: string,
    options: { anchor?: boolean } = {},
) {
    markInlineCommentTarget(target, text);
    target.setAttribute('data-comment-stable-key', stableKey);
    target.classList.toggle('pdf-annotation-has-note-anchor', options.anchor === true);
    if (isCommentActive(stableKey)) {
        target.classList.add('pdf-annotation-has-note-active');
    } else {
        target.classList.remove('pdf-annotation-has-note-active');
    }
}

function pickInlineCommentAnchorTarget(targets: HTMLElement[]) {
    if (targets.length === 0) {
        return null;
    }
    return targets
        .slice()
        .sort((left, right) => {
            const leftRect = left.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();
            if (leftRect.top !== rightRect.top) {
                return leftRect.top - rightRect.top;
            }
            if (leftRect.right !== rightRect.right) {
                return rightRect.right - leftRect.right;
            }
            return leftRect.left - rightRect.left;
        })[0] ?? null;
}

function findCommentByStableKey(stableKey: string) {
    return annotationCommentsCache.value.find(comment => comment.stableKey === stableKey) ?? null;
}

function ensureCommentMarkerLayer(pageContainer: HTMLElement) {
    let layer = pageContainer.querySelector<HTMLElement>('.pdf-comment-marker-layer');
    if (layer) {
        return layer;
    }

    layer = document.createElement('div');
    layer.className = 'pdf-comment-marker-layer';
    layer.setAttribute('aria-hidden', 'false');
    pageContainer.append(layer);
    return layer;
}

interface IDetachedMarkerPlacement {
    leftPercent: number;
    topPercent: number;
}

interface IDetachedCommentCluster {
    anchorRect: IAnnotationMarkerRect;
    comments: IAnnotationCommentSummary[];
}

interface IDetachedMarkerOccupied {
    x: number;
    y: number;
}

interface IDetachedMarkerOffset {
    x: number;
    y: number;
}

interface IDetachedMarkerFallback {
    x: number;
    y: number;
    minDistanceSquared: number;
}

const DETACHED_MARKER_OFFSETS: IDetachedMarkerOffset[] = [
    {
        x: 0,
        y: 0,
    },
    {
        x: 18,
        y: -10,
    },
    {
        x: 18,
        y: 10,
    },
    {
        x: -18,
        y: -10,
    },
    {
        x: -18,
        y: 10,
    },
    {
        x: 30,
        y: 0,
    },
    {
        x: 0,
        y: -20,
    },
    {
        x: 0,
        y: 20,
    },
    {
        x: 30,
        y: -18,
    },
    {
        x: 30,
        y: 18,
    },
    {
        x: -30,
        y: 0,
    },
    {
        x: 42,
        y: 0,
    },
];

function pickPrimaryDetachedComment(comments: IAnnotationCommentSummary[]) {
    const active = comments.find(candidate => isCommentActive(candidate.stableKey));
    if (active) {
        return active;
    }
    return comments
        .slice()
        .sort((left, right) => {
            const leftTs = left.modifiedAt ?? 0;
            const rightTs = right.modifiedAt ?? 0;
            if (leftTs !== rightTs) {
                return rightTs - leftTs;
            }
            return left.stableKey.localeCompare(right.stableKey);
        })[0] ?? comments[0];
}

function commentPreviewText(comment: IAnnotationCommentSummary) {
    const raw = comment.text.trim();
    if (!raw) {
        return 'Empty note';
    }
    if (raw.length > 120) {
        return `${raw.slice(0, 117)}...`;
    }
    return raw;
}

function commentLogicalIndicatorKey(comment: IAnnotationCommentSummary) {
    if (comment.annotationId) {
        return `ann:${comment.pageNumber}:${comment.annotationId}`;
    }
    if (comment.uid) {
        return `uid:${comment.pageNumber}:${comment.uid}`;
    }
    return `stable:${comment.pageNumber}:${comment.stableKey}`;
}

function pickPreferredIndicatorComment(
    existing: IAnnotationCommentSummary,
    candidate: IAnnotationCommentSummary,
) {
    const priorityDelta = commentMergePriority(candidate) - commentMergePriority(existing);
    if (priorityDelta > 0) {
        return candidate;
    }
    if (priorityDelta < 0) {
        return existing;
    }
    const existingTs = existing.modifiedAt ?? 0;
    const candidateTs = candidate.modifiedAt ?? 0;
    if (candidateTs > existingTs) {
        return candidate;
    }
    if (candidateTs < existingTs) {
        return existing;
    }
    return existing.stableKey.localeCompare(candidate.stableKey) <= 0
        ? existing
        : candidate;
}

function createDetachedCommentClusterMarkerElement(
    comments: IAnnotationCommentSummary[],
    placement: IDetachedMarkerPlacement,
) {
    const primaryComment = pickPrimaryDetachedComment(comments);
    if (!primaryComment) {
        return null;
    }
    const noteCount = comments.length;
    const trimmedPreview = commentPreviewText(primaryComment);
    const preview = noteCount > 1
        ? `${trimmedPreview} (+${noteCount - 1} more note${noteCount > 2 ? 's' : ''})`
        : trimmedPreview;

    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'pdf-inline-comment-marker';
    if (comments.some(candidate => isCommentActive(candidate.stableKey))) {
        marker.classList.add('is-active');
    }
    if (noteCount > 1) {
        marker.classList.add('is-cluster');
        marker.dataset.commentCount = String(noteCount);
    }
    marker.dataset.commentStableKey = primaryComment.stableKey;
    marker.dataset.annotationId = primaryComment.annotationId ?? '';
    marker.style.left = `${placement.leftPercent}%`;
    marker.style.top = `${placement.topPercent}%`;
    marker.title = preview;
    marker.setAttribute(
        'aria-label',
        noteCount > 1
            ? `Open pop-up note (${noteCount} notes)`
            : 'Open pop-up note',
    );
    marker.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const summary = findCommentByStableKey(primaryComment.stableKey);
        if (summary) {
            setActiveCommentStableKey(summary.stableKey);
            emit('annotation-open-note', summary);
        }
    });
    marker.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const summary = findCommentByStableKey(primaryComment.stableKey);
        if (summary) {
            setActiveCommentStableKey(summary.stableKey);
            emit('annotation-context-menu', {
                comment: summary,
                clientX: event.clientX,
                clientY: event.clientY,
            });
        }
    });
    return marker;
}

function clusterDetachedComments(comments: IAnnotationCommentSummary[]) {
    const clusters: IDetachedCommentCluster[] = [];
    comments
        .slice()
        .sort((left, right) => {
            const leftRect = normalizeMarkerRect(left.markerRect);
            const rightRect = normalizeMarkerRect(right.markerRect);
            if (!leftRect || !rightRect) {
                return left.stableKey.localeCompare(right.stableKey);
            }
            if (leftRect.top !== rightRect.top) {
                return leftRect.top - rightRect.top;
            }
            if (leftRect.left !== rightRect.left) {
                return leftRect.left - rightRect.left;
            }
            return left.stableKey.localeCompare(right.stableKey);
        })
        .forEach((comment) => {
            const rect = normalizeMarkerRect(comment.markerRect);
            if (!rect) {
                return;
            }
            const candidate = clusters.find((cluster) => {
                const iou = markerRectIoU(cluster.anchorRect, rect);
                if (iou >= 0.35) {
                    return true;
                }
                const clusterCenterX = cluster.anchorRect.left + cluster.anchorRect.width / 2;
                const clusterCenterY = cluster.anchorRect.top + cluster.anchorRect.height / 2;
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                const dx = Math.abs(clusterCenterX - centerX);
                const dy = Math.abs(clusterCenterY - centerY);
                return dx <= 0.018 && dy <= 0.02;
            });
            if (candidate) {
                candidate.comments.push(comment);
                return;
            }
            clusters.push({
                anchorRect: rect,
                comments: [comment],
            });
        });
    return clusters;
}

function resolveDetachedMarkerPlacement(
    pageContainer: HTMLElement,
    markerRect: IAnnotationMarkerRect,
    occupied: IDetachedMarkerOccupied[],
) {
    const width = pageContainer.clientWidth;
    const height = pageContainer.clientHeight;
    if (width <= 0 || height <= 0) {
        return {
            leftPercent: Math.max(1, Math.min(99, (markerRect.left + markerRect.width) * 100)),
            topPercent: Math.max(1, Math.min(99, markerRect.top * 100)),
        };
    }

    const baseX = (markerRect.left + markerRect.width) * width;
    const baseY = markerRect.top * height;
    const markerRadius = 9;
    const minDistanceSquared = 18 * 18;
    let bestFallback: IDetachedMarkerFallback | null = null;

    for (const offset of DETACHED_MARKER_OFFSETS) {
        const x = Math.min(width - markerRadius, Math.max(markerRadius, baseX + offset.x));
        const y = Math.min(height - markerRadius, Math.max(markerRadius, baseY + offset.y));
        const minDistance = occupied.reduce((min, point) => {
            const dx = point.x - x;
            const dy = point.y - y;
            const distanceSquared = dx * dx + dy * dy;
            return Math.min(min, distanceSquared);
        }, Number.POSITIVE_INFINITY);

        if (minDistance >= minDistanceSquared || occupied.length === 0) {
            occupied.push({
                x,
                y,
            });
            return {
                leftPercent: (x / width) * 100,
                topPercent: (y / height) * 100,
            };
        }

        if (!bestFallback || minDistance > bestFallback.minDistanceSquared) {
            bestFallback = {
                x,
                y,
                minDistanceSquared: minDistance,
            };
        }
    }

    const fallbackX = bestFallback?.x ?? Math.min(width - markerRadius, Math.max(markerRadius, baseX));
    const fallbackY = bestFallback?.y ?? Math.min(height - markerRadius, Math.max(markerRadius, baseY));
    occupied.push({
        x: fallbackX,
        y: fallbackY,
    });
    return {
        leftPercent: (fallbackX / width) * 100,
        topPercent: (fallbackY / height) * 100,
    };
}

function renderDetachedCommentMarkers(pageContainer: HTMLElement, comments: IAnnotationCommentSummary[]) {
    const layer = ensureCommentMarkerLayer(pageContainer);
    const occupied: IDetachedMarkerOccupied[] = [];
    const clusters = clusterDetachedComments(comments);
    clusters.forEach((cluster) => {
        const placement = resolveDetachedMarkerPlacement(pageContainer, cluster.anchorRect, occupied);
        const marker = createDetachedCommentClusterMarkerElement(cluster.comments, placement);
        if (marker) {
            layer.append(marker);
        }
    });
}

function syncInlineCommentIndicators() {
    clearInlineCommentIndicators();

    const container = viewerContainer.value;
    if (!container || annotationCommentsCache.value.length === 0) {
        return;
    }

    const commentsWithNotes = annotationCommentsCache.value.filter(comment => (
        isTextMarkupSubtype(comment.subtype)
        && (comment.hasNote === true || comment.text.trim().length > 0)
    ));
    if (commentsWithNotes.length === 0) {
        return;
    }

    const commentsByAnnotationId = new Map<string, IAnnotationCommentSummary>();
    const handledLogicalCommentKeys = new Set<string>();
    const dedupedCommentsByLogicalKey = new Map<string, IAnnotationCommentSummary>();
    commentsWithNotes.forEach((comment) => {
        const logicalKey = commentLogicalIndicatorKey(comment);
        const existing = dedupedCommentsByLogicalKey.get(logicalKey);
        if (!existing) {
            dedupedCommentsByLogicalKey.set(logicalKey, comment);
            return;
        }
        dedupedCommentsByLogicalKey.set(
            logicalKey,
            pickPreferredIndicatorComment(existing, comment),
        );
    });

    const dedupedComments = Array.from(dedupedCommentsByLogicalKey.values());
    dedupedComments.forEach((comment) => {
        if (comment.annotationId) {
            commentsByAnnotationId.set(comment.annotationId, comment);
        }
    });

    const uiManager = annotationUiManager.value;
    if (uiManager) {
        for (let pageIndex = 0; pageIndex < numPages.value; pageIndex += 1) {
            for (const editor of uiManager.getEditors(pageIndex)) {
                const normalizedEditor = editor as IPdfjsEditor;
                const subtype = detectEditorSubtype(normalizedEditor);
                if ((subtype ?? '').trim().toLowerCase() !== 'highlight') {
                    continue;
                }
                const summary = hydrateSummaryFromMemory(
                    toEditorSummary(normalizedEditor, pageIndex, getCommentText(normalizedEditor).trim()),
                );
                if (!summary.hasNote && !summary.text.trim()) {
                    continue;
                }
                if (normalizedEditor.div) {
                    markInlineCommentTargetWithKey(normalizedEditor.div, summary.text, summary.stableKey, { anchor: true });
                    handledLogicalCommentKeys.add(commentLogicalIndicatorKey(summary));
                }
                if (summary.annotationId) {
                    commentsByAnnotationId.delete(summary.annotationId);
                }
            }
        }
    }

    commentsByAnnotationId.forEach((comment, annotationId) => {
        const selector = `.annotationLayer [data-annotation-id="${escapeCssAttr(annotationId)}"], .annotation-layer [data-annotation-id="${escapeCssAttr(annotationId)}"]`;
        const targets = Array.from(container.querySelectorAll<HTMLElement>(selector));
        const anchor = pickInlineCommentAnchorTarget(targets);
        let marked = false;
        targets.forEach((target) => {
            marked = true;
            markInlineCommentTargetWithKey(target, comment.text, comment.stableKey, { anchor: target === anchor });
        });
        if (marked) {
            handledLogicalCommentKeys.add(commentLogicalIndicatorKey(comment));
        }
    });

    const detachedCommentsByPage = new Map<number, IAnnotationCommentSummary[]>();
    const detachedGroupSeen = new Set<string>();
    dedupedComments.forEach((comment) => {
        const logicalKey = commentLogicalIndicatorKey(comment);
        if (handledLogicalCommentKeys.has(logicalKey)) {
            return;
        }
        const markerRect = normalizeMarkerRect(comment.markerRect);
        if (!markerRect) {
            return;
        }
        const groupKey = logicalKey;
        if (detachedGroupSeen.has(groupKey)) {
            return;
        }
        detachedGroupSeen.add(groupKey);

        const pageComments = detachedCommentsByPage.get(comment.pageNumber) ?? [];
        pageComments.push(comment);
        detachedCommentsByPage.set(comment.pageNumber, pageComments);
        handledLogicalCommentKeys.add(logicalKey);
    });

    detachedCommentsByPage.forEach((comments, pageNumber) => {
        const pageContainer = container.querySelector<HTMLElement>(`.page_container[data-page="${pageNumber}"]`);
        if (!pageContainer) {
            return;
        }
        renderDetachedCommentMarkers(pageContainer, comments);
    });
}

const debouncedSyncInlineCommentIndicators = useDebounceFn(() => {
    syncInlineCommentIndicators();
}, 70);

function attachInlineCommentMarkerObserver() {
    if (inlineCommentMarkerObserver) {
        inlineCommentMarkerObserver.disconnect();
        inlineCommentMarkerObserver = null;
    }
    const container = viewerContainer.value;
    if (!container || typeof MutationObserver === 'undefined') {
        return;
    }

    inlineCommentMarkerObserver = new MutationObserver((records) => {
        const hasRelevantMutation = records.some((record) => (
            Array.from(record.addedNodes).some((node) => (
                node instanceof HTMLElement
                && (
                    node.matches('.highlightEditor, [data-annotation-id], .annotationLayer, .annotation-layer')
                    || !!node.querySelector('.highlightEditor, [data-annotation-id]')
                )
            ))
        ));
        if (hasRelevantMutation) {
            debouncedSyncInlineCommentIndicators();
        }
    });
    inlineCommentMarkerObserver.observe(container, {
        childList: true,
        subtree: true,
    });
}

async function syncAnnotationComments() {
    const doc = pdfDocument.value;
    if (!doc || numPages.value <= 0) {
        commentSummaryMemory.clear();
        annotationCommentsCache.value = [];
        emit('annotation-comments', []);
        clearInlineCommentIndicators();
        return;
    }

    const localToken = ++annotationCommentsSyncToken;
    const commentsByKey = new Map<string, IAnnotationCommentSummary>();
    let sourceOrder = 0;

    const uiManager = annotationUiManager.value;
    const managerWithDeletedLookup = uiManager as (AnnotationEditorUIManager & { isDeletedAnnotationElement?: (annotationElementId: string) => boolean }) | null;
    if (uiManager) {
        for (let pageIndex = 0; pageIndex < numPages.value; pageIndex += 1) {
            for (const editor of uiManager.getEditors(pageIndex)) {
                const normalizedEditor = editor as IPdfjsEditor;
                const text = getCommentText(normalizedEditor).trim();
                const pendingKey = getEditorPendingKey(normalizedEditor, pageIndex);
                if (text) {
                    pendingCommentEditorKeys.delete(pendingKey);
                }

                const summary = toEditorSummary(normalizedEditor, pageIndex, text, sourceOrder);
                sourceOrder += 1;
                const hydrated = hydrateSummaryFromMemory(summary);
                commentsByKey.set(toSummaryKey(hydrated), hydrated);
            }
        }
    }

    for (let pageNumber = 1; pageNumber <= numPages.value; pageNumber += 1) {
        if (localToken !== annotationCommentsSyncToken) {
            return;
        }

        let pageAnnotations: Array<{
            id?: string;
            pageIndex?: number;
            rect?: number[];
            contents?: string;
            contentsObj?: { str?: string | null };
            richText?: { str?: string | null };
            title?: string;
            titleObj?: { str?: string | null };
            color?: number[] | string | null;
            opacity?: number;
            modificationDate?: string | null;
            creationDate?: string | null;
            subtype?: string;
            popupRef?: string | null;
        }> = [];
        let pageView: number[] | null = null;

        try {
            const page = await doc.getPage(pageNumber);
            pageAnnotations = await page.getAnnotations();
            pageView = ((page as { view?: number[] }).view ?? null);
        } catch {
            continue;
        }

        const popupById = new Map<string, (typeof pageAnnotations)[number]>();
        pageAnnotations.forEach((annotation) => {
            if (annotation.id && managerWithDeletedLookup?.isDeletedAnnotationElement?.(annotation.id)) {
                return;
            }
            if (!isPopupSubtype(annotation.subtype)) {
                return;
            }
            if (!annotation.id) {
                return;
            }
            popupById.set(annotation.id, annotation);
        });

        pageAnnotations.forEach((annotation, annotationIndex) => {
            if (annotation.id && managerWithDeletedLookup?.isDeletedAnnotationElement?.(annotation.id)) {
                return;
            }
            if (isPopupSubtype(annotation.subtype)) {
                return;
            }

            const popupAnnotation = annotation.popupRef
                ? popupById.get(annotation.popupRef) ?? null
                : null;
            const annotationText = getAnnotationCommentText(annotation);
            const popupText = popupAnnotation ? getAnnotationCommentText(popupAnnotation) : '';
            const text = annotationText || popupText;
            const subtype = annotation.subtype ?? null;
            const id = annotation.id ?? `pdf-${pageNumber}-${annotationIndex}`;
            const annotationId = annotation.id ?? null;
            const summaryKey = computeSummaryStableKey({
                id,
                pageIndex: pageNumber - 1,
                source: 'pdf',
                uid: null,
                annotationId,
            });

            const summary: IAnnotationCommentSummary = {
                id,
                stableKey: summaryKey,
                sortIndex: sourceOrder,
                pageIndex: pageNumber - 1,
                pageNumber,
                text,
                kindLabel: annotationKindLabelFromSubtype(subtype),
                subtype,
                author: getAnnotationAuthor(annotation) ?? (popupAnnotation ? getAnnotationAuthor(popupAnnotation) : null),
                modifiedAt: (() => {
                    const own = parsePdfDateTimestamp(annotation.modificationDate)
                        ?? parsePdfDateTimestamp(annotation.creationDate);
                    const popup = popupAnnotation
                        ? (
                            parsePdfDateTimestamp(popupAnnotation.modificationDate)
                            ?? parsePdfDateTimestamp(popupAnnotation.creationDate)
                        )
                        : null;
                    if (own && popup) {
                        return Math.max(own, popup);
                    }
                    return own ?? popup;
                })(),
                color: toCssColor(
                    annotation.color ?? popupAnnotation?.color ?? null,
                    annotation.opacity ?? popupAnnotation?.opacity ?? 1,
                ),
                uid: null,
                annotationId,
                source: 'pdf',
                hasNote: Boolean(
                    isTextMarkupSubtype(subtype)
                    && (Boolean(annotation.popupRef) || Boolean(popupAnnotation) || Boolean(annotationText.trim()) || Boolean(popupText.trim())),
                ),
                markerRect: toMarkerRectFromPdfRect(
                    annotation.rect ?? popupAnnotation?.rect,
                    pageView,
                ),
            };
            sourceOrder += 1;
            const hydratedSummary = hydrateSummaryFromMemory(summary);

            const key = summaryKey;
            const existing = commentsByKey.get(key);
            if (!existing) {
                commentsByKey.set(key, hydratedSummary);
                return;
            }
            commentsByKey.set(key, mergeCommentSummaries(existing, hydratedSummary));
        });
    }

    if (localToken !== annotationCommentsSyncToken) {
        return;
    }

    const comments = dedupeAnnotationCommentSummaries(Array.from(commentsByKey.values()));
    comments.forEach((comment) => {
        rememberSummaryText(comment);
    });
    annotationCommentsCache.value = comments;
    emit('annotation-comments', comments);
    syncInlineCommentIndicators();
}

const debouncedSyncAnnotationComments = useDebounceFn(() => {
    void syncAnnotationComments();
}, 140);

function scheduleAnnotationCommentsSync(immediate = false) {
    if (immediate) {
        void syncAnnotationComments();
        return;
    }
    debouncedSyncAnnotationComments();
}

function escapeCssAttr(value: string) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(value);
    }
    return value.replace(/"/g, '\\"');
}

function getCommentCandidateIds(comment: IAnnotationCommentSummary) {
    return [
        comment.uid,
        comment.annotationId,
        comment.id,
    ]
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .filter((id, index, arr) => arr.indexOf(id) === index);
}

function findEditorForComment(comment: IAnnotationCommentSummary) {
    const uiManager = annotationUiManager.value;
    if (!uiManager || numPages.value <= 0) {
        return null;
    }

    const candidateIds = getCommentCandidateIds(comment);
    if (candidateIds.length === 0) {
        return null;
    }

    const preferredPage = Math.max(0, Math.min(comment.pageIndex, numPages.value - 1));
    const pageIndexes = [
        preferredPage,
        ...Array.from({ length: numPages.value }, (_, index) => index).filter(index => index !== preferredPage),
    ];

    for (const pageIndex of pageIndexes) {
        for (const editor of uiManager.getEditors(pageIndex)) {
            const identity = getEditorIdentity(editor as IPdfjsEditor, pageIndex);
            if (
                candidateIds.includes(identity)
                || (editor.uid && candidateIds.includes(editor.uid))
                || (editor.annotationElementId && candidateIds.includes(editor.annotationElementId))
                || (editor.id && candidateIds.includes(editor.id))
            ) {
                return editor as IPdfjsEditor;
            }
        }
    }

    return null;
}

function findEditorByAnnotationElementId(pageIndex: number, annotationId: string) {
    const uiManager = annotationUiManager.value;
    if (!uiManager || numPages.value <= 0) {
        return null;
    }

    const preferredPage = Math.max(0, Math.min(pageIndex, numPages.value - 1));
    const pageIndexes = [
        preferredPage,
        ...Array.from({ length: numPages.value }, (_, index) => index).filter(index => index !== preferredPage),
    ];

    for (const candidatePageIndex of pageIndexes) {
        for (const editor of uiManager.getEditors(candidatePageIndex)) {
            const normalizedEditor = editor as IPdfjsEditor;
            if (normalizedEditor.annotationElementId === annotationId) {
                return normalizedEditor;
            }
        }
    }

    return null;
}

async function focusAnnotationComment(comment: IAnnotationCommentSummary) {
    if (!pdfDocument.value) {
        return;
    }
    setActiveCommentStableKey(comment.stableKey);

    const pageNumber = Math.max(1, Math.min(comment.pageNumber, numPages.value));
    scrollToPage(pageNumber);

    await nextTick();
    updateVisibleRange(viewerContainer.value, numPages.value);
    await renderVisiblePages(visibleRange.value, { preserveRenderedPages: true });

    const uiManager = annotationUiManager.value as (AnnotationEditorUIManager & {
        getLayer?: (pageIndex: number) => { getEditorByUID?: (uid: string) => IPdfjsEditor | null } | null;
        selectComment?: (pageIndex: number, uid: string) => void;
    }) | null;
    const pageIndex = pageNumber - 1;

    if (uiManager) {
        try {
            await uiManager.waitForEditorsRendered(pageNumber);
        } catch {
            // ignore
        }

        const layer = uiManager.getLayer?.(pageIndex) ?? null;
        const candidateIds = getCommentCandidateIds(comment);

        for (const id of candidateIds) {
            const editor = layer?.getEditorByUID?.(id);
            if (editor) {
                editor.toggleComment?.(true, true);
                return;
            }
        }

        if (typeof uiManager.selectComment === 'function') {
            for (const id of candidateIds) {
                uiManager.selectComment(pageIndex, id);
            }
        }
    }

    const annotationId = comment.annotationId;
    const container = viewerContainer.value;
    if (!annotationId || !container) {
        return;
    }

    const selector = `[data-annotation-id="${escapeCssAttr(annotationId)}"]`;
    const target = container.querySelector<HTMLElement>(selector);
    if (!target) {
        return;
    }
    target.classList.add('annotation-focus-pulse');
    setTimeout(() => {
        target.classList.remove('annotation-focus-pulse');
    }, 900);
}

function updateAnnotationComment(comment: IAnnotationCommentSummary, text: string) {
    const resolvedComment = resolveCommentFromCache(comment) ?? comment;
    const editor = findEditorForComment(resolvedComment) ?? findEditorForComment(comment);
    if (!editor) {
        return false;
    }
    const pendingKey = getEditorPendingKey(
        editor,
        Number.isFinite(editor.parentPageIndex) ? (editor.parentPageIndex as number) : resolvedComment.pageIndex,
    );

    const nextText = text;
    const nextTrimmed = nextText.trim();
    const previousText = getCommentText(editor);
    const previousTrimmed = previousText.trim();
    if (nextText === previousText) {
        return true;
    }

    // Preserve empty pop-up notes as real notes (Okular-like behavior),
    // instead of converting them to "no note".
    editor.comment = nextTrimmed.length > 0 ? nextText : '';
    editor.addToAnnotationStorage?.();
    if (nextTrimmed.length > 0) {
        pendingCommentEditorKeys.delete(pendingKey);
        rememberSummaryText({
            ...resolvedComment,
            text: nextText,
            hasNote: true,
            modifiedAt: Date.now(),
        });
    } else {
        pendingCommentEditorKeys.delete(pendingKey);
        if (previousTrimmed.length > 0) {
            forgetSummaryText(resolvedComment);
        }
    }
    emit('annotation-modified');
    scheduleAnnotationCommentsSync(true);
    debouncedSyncInlineCommentIndicators();
    return true;
}

async function deleteAnnotationComment(comment: IAnnotationCommentSummary) {
    const uiManager = annotationUiManager.value;
    if (!uiManager) {
        return false;
    }
    const resolvedComment = resolveCommentFromCache(comment) ?? comment;

    const pageNumber = Math.max(1, Math.min(resolvedComment.pageNumber, numPages.value));
    const pageIndex = Math.max(0, pageNumber - 1);
    const candidateIds = getCommentCandidateIds(resolvedComment);
    const managerWithCommentSelection = uiManager as AnnotationEditorUIManager & {
        selectComment?: (candidatePageIndex: number, uid: string) => void;
        getLayer?: (candidatePageIndex: number) => { getEditorByUID?: (uid: string) => IPdfjsEditor | null } | null;
    };

    let editor = findEditorForComment(resolvedComment);
    let switchedToPopupMode = false;
    const previousMode = uiManager.getMode();

    if (!editor && previousMode === AnnotationEditorType.NONE) {
        try {
            await uiManager.updateMode(AnnotationEditorType.POPUP);
            switchedToPopupMode = true;
        } catch {
            // Ignore mode-switch failure and continue with best effort.
        }
    }

    if (!editor) {
        try {
            await uiManager.waitForEditorsRendered(pageNumber);
        } catch {
            // Ignore and continue with best effort lookup.
        }
        editor = findEditorForComment(resolvedComment) ?? findEditorForComment(comment);
    }

    if (!editor && candidateIds.length > 0) {
        for (const id of candidateIds) {
            const fromLayer = managerWithCommentSelection.getLayer?.(pageIndex)?.getEditorByUID?.(id);
            if (fromLayer) {
                editor = fromLayer;
                break;
            }
        }
    }

    if (!editor && candidateIds.length > 0 && typeof managerWithCommentSelection.selectComment === 'function') {
        for (const id of candidateIds) {
            managerWithCommentSelection.selectComment(pageIndex, id);
        }
        await nextTick();
        editor = findEditorForComment(comment);
    }

    if (!editor && resolvedComment.annotationId) {
        const annotationStorage = pdfDocument.value?.annotationStorage as { getEditor?: (annotationElementId: string) => IPdfjsEditor | null } | undefined;
        editor = annotationStorage?.getEditor?.(resolvedComment.annotationId) ?? null;
    }

    if (!editor && resolvedComment.annotationId) {
        editor = findEditorByAnnotationElementId(pageIndex, resolvedComment.annotationId);
    }

    if (!editor) {
        if (switchedToPopupMode) {
            try {
                await uiManager.updateMode(previousMode);
            } catch {
                // Ignore mode restore failure.
            }
        }
        return false;
    }

    const pendingKey = getEditorPendingKey(
        editor,
        Number.isFinite(editor.parentPageIndex) ? (editor.parentPageIndex as number) : resolvedComment.pageIndex,
    );
    let deleted = false;

    try {
        uiManager.setSelected(editor as unknown as TUiManagerSelectedEditor);
        uiManager.delete();
        deleted = true;
    } catch {
        try {
            editor.remove?.();
            deleted = true;
        } catch {
            try {
                editor.delete?.();
                deleted = true;
            } catch {
                deleted = false;
            }
        }
    } finally {
        if (switchedToPopupMode) {
            try {
                await uiManager.updateMode(previousMode);
            } catch {
                // Ignore mode restore failure.
            }
        }
    }

    if (!deleted) {
        return false;
    }

    pendingCommentEditorKeys.delete(pendingKey);
    forgetSummaryText(resolvedComment);
    emit('annotation-modified');
    scheduleAnnotationCommentsSync(true);
    debouncedSyncInlineCommentIndicators();
    return true;
}

function destroyAnnotationEditor() {
    annotationCommentsSyncToken += 1;
    if (annotationEventBus.value && annotationStateListener) {
        annotationEventBus.value.off('annotationeditorstateschanged', annotationStateListener);
    }
    annotationStateListener = null;
    annotationUiManager.value?.removeEditListeners();
    annotationUiManager.value?.destroy();
    annotationUiManager.value = null;
    annotationEventBus.value = null;
    annotationL10n.value = null;
    pendingCommentEditorKeys.clear();
    commentSummaryMemory.clear();
}

function initAnnotationEditor() {
    const container = viewerContainer.value;
    const pdfDoc = pdfDocument.value;
    if (!container || !pdfDoc) {
        return;
    }

    destroyAnnotationEditor();

    const eventBus = new EventBus();
    annotationEventBus.value = eventBus;
    annotationL10n.value = new GenericL10n(undefined);
    annotationState.value = {
        isEditing: false,
        isEmpty: true,
        hasSomethingToUndo: false,
        hasSomethingToRedo: false,
        hasSelectedEditor: false,
    };

    const commentManager = createSimpleCommentManager(container);

    const uiManager = new AnnotationEditorUIManager(
        container,
        container,
        null,
        null,
        commentManager,
        null,
        eventBus,
        pdfDoc,
        null,
        DEFAULT_PDFJS_HIGHLIGHT_COLORS,
        false,
        false,
        false,
        null,
        null,
        false,
    );

    annotationUiManager.value = uiManager;
    installAnnotationLayerDestroyGuard(uiManager);

    const originalKeydown = uiManager.keydown.bind(uiManager);
    uiManager.keydown = (event: KeyboardEvent) => {
        if (shouldIgnoreEditorEvent(event)) {
            return;
        }
        originalKeydown(event);
    };

    const originalKeyup = uiManager.keyup.bind(uiManager);
    uiManager.keyup = (event: KeyboardEvent) => {
        if (shouldIgnoreEditorEvent(event)) {
            return;
        }
        originalKeyup(event);
    };

    const originalCopy = uiManager.copy.bind(uiManager);
    uiManager.copy = async (event: ClipboardEvent) => {
        if (shouldIgnoreEditorEvent(event)) {
            return;
        }
        await originalCopy(event);
    };

    const originalCut = uiManager.cut.bind(uiManager);
    uiManager.cut = async (event: ClipboardEvent) => {
        if (shouldIgnoreEditorEvent(event)) {
            return;
        }
        await originalCut(event);
    };

    const originalPaste = uiManager.paste.bind(uiManager);
    uiManager.paste = async (event: ClipboardEvent) => {
        if (shouldIgnoreEditorEvent(event)) {
            return;
        }
        await originalPaste(event);
    };

    const originalAddToAnnotationStorage = uiManager.addToAnnotationStorage.bind(uiManager);
    uiManager.addToAnnotationStorage = (editor) => {
        const result = originalAddToAnnotationStorage(editor);
        const editorObject = editor as object | null;
        if (editorObject && !trackedCreatedEditors.has(editorObject)) {
            trackedCreatedEditors.add(editorObject);
            maybeAutoResetAnnotationTool();
        }
        emit('annotation-modified');
        scheduleAnnotationCommentsSync();
        return result;
    };

    const originalAddCommands = uiManager.addCommands.bind(uiManager);
    uiManager.addCommands = (params) => {
        emit('annotation-modified');
        const result = originalAddCommands(params);
        scheduleAnnotationCommentsSync();
        return result;
    };

    const originalUndo = uiManager.undo.bind(uiManager);
    uiManager.undo = () => {
        const result = originalUndo();
        emit('annotation-modified');
        scheduleAnnotationCommentsSync();
        return result;
    };

    const originalRedo = uiManager.redo.bind(uiManager);
    uiManager.redo = () => {
        const result = originalRedo();
        emit('annotation-modified');
        scheduleAnnotationCommentsSync();
        return result;
    };

    annotationStateListener = (event) => {
        if (!event?.details) {
            return;
        }
        annotationState.value = {
            ...annotationState.value,
            ...event.details,
        };
        emit('annotation-state', annotationState.value);
    };
    eventBus.on('annotationeditorstateschanged', annotationStateListener);

    try {
        pdfDoc.annotationStorage.onSetModified = () => {
            emit('annotation-modified');
            scheduleAnnotationCommentsSync();
        };
    } catch (error) {
        console.warn('Failed to attach annotation modified handler:', error);
    }

    uiManager.addEditListeners();
    uiManager.onScaleChanging({ scale: effectiveScale.value / PixelsPerInch.PDF_TO_CSS_UNITS });
    uiManager.onPageChanging({ pageNumber: currentPage.value });

    applyAnnotationSettings(pendingAnnotationSettings.value);
    void setAnnotationTool(pendingAnnotationTool.value);
    emit('annotation-state', annotationState.value);
    scheduleAnnotationCommentsSync(true);
}

async function highlightSelectionInternal(withComment: boolean) {
    const uiManager = annotationUiManager.value;
    if (!uiManager) {
        return;
    }

    let selection = document.getSelection();
    const cachedRange = cachedSelectionRange;
    const hasFreshCachedSelection = (
        !!cachedRange
        && (Date.now() - cachedSelectionTimestamp) <= SELECTION_CACHE_TTL_MS
    );
    let activeRange: Range | null = null;
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
        activeRange = selection.getRangeAt(0).cloneRange();
    } else if (hasFreshCachedSelection) {
        activeRange = cachedRange.cloneRange();
    }

    if (!activeRange) {
        return;
    }

    try {
        selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(activeRange.cloneRange());
    } catch {
        // Ignore selection restoration failure and continue with available data.
    }

    const {
        startContainer,
        startOffset,
        endContainer,
        endOffset,
        commonAncestorContainer,
    } = activeRange;
    const text = activeRange.toString();

    const anchorElement = startContainer.nodeType === Node.TEXT_NODE
        ? startContainer.parentElement
        : (startContainer as HTMLElement | null);
    const commonAncestorElement = commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? commonAncestorContainer.parentElement
        : (commonAncestorContainer as HTMLElement | null);
    const textLayer = (anchorElement?.closest('.text-layer, .textLayer')
        ?? commonAncestorElement?.closest('.text-layer, .textLayer')) as HTMLElement | null;
    if (!textLayer) {
        return;
    }

    const boxes = uiManager.getSelectionBoxes(textLayer);
    if (!boxes) {
        return;
    }

    const pageContainer = textLayer.closest<HTMLElement>('.page_container');
    const pageNumber = pageContainer?.dataset.page
        ? Number(pageContainer.dataset.page)
        : currentPage.value;
    const pageIndex = Math.max(0, pageNumber - 1);

    const editorsBefore = Array.from(uiManager.getEditors(pageIndex)) as IPdfjsEditor[];
    const editorsBeforeRefs = new Set<IPdfjsEditor>(editorsBefore);
    const editorsBeforeIds = new Set<string>(editorsBefore.map(editor => getEditorIdentity(editor, pageIndex)));

    selection?.removeAllRanges();
    cachedSelectionRange = null;
    cachedSelectionTimestamp = 0;

    const previousMode = uiManager.getMode();
    let createdAnnotation = false;

    try {
        await uiManager.updateMode(AnnotationEditorType.HIGHLIGHT);
        await uiManager.waitForEditorsRendered(pageNumber);

        const layer = uiManager.getLayer(pageNumber - 1) ?? uiManager.currentLayer;
        const createdEditor = layer?.createAndAddNewEditor(
            {
                offsetX: 0,
                offsetY: 0, 
            } as unknown as PointerEvent,
            false,
            {
                methodOfCreation: 'toolbar',
                boxes,
                anchorNode: startContainer,
                anchorOffset: startOffset,
                focusNode: endContainer,
                focusOffset: endOffset,
                text,
            },
        );
        createdAnnotation = true;

        if (withComment) {
            let targetEditor = (createdEditor ?? null) as IPdfjsEditor | null;
            if (!targetEditor) {
                const activeEditor = (uiManager as AnnotationEditorUIManager & { getActive?: () => unknown })
                    .getActive?.() as IPdfjsEditor | null | undefined;
                if (activeEditor) {
                    targetEditor = activeEditor;
                }
            }

            if (!targetEditor) {
                try {
                    await uiManager.waitForEditorsRendered(pageNumber);
                } catch {
                    // ignore
                }
                await nextTick();
                const editorsAfter = Array.from(uiManager.getEditors(pageIndex)) as IPdfjsEditor[];
                targetEditor = editorsAfter.find((editor) => {
                    if (!editorsBeforeRefs.has(editor)) {
                        return true;
                    }
                    const identity = getEditorIdentity(editor, pageIndex);
                    return !editorsBeforeIds.has(identity);
                }) ?? editorsAfter.at(-1) ?? null;
            }

            if (targetEditor) {
                pendingCommentEditorKeys.add(getEditorPendingKey(targetEditor, pageIndex));
                const summary = toEditorSummary(targetEditor, pageIndex, getCommentText(targetEditor));
                emit('annotation-open-note', summary);
            } else {
                let attempts = 0;
                const tryEmitLater = () => {
                    const editorsLater = Array.from(uiManager.getEditors(pageIndex)) as IPdfjsEditor[];
                    const lateEditor = editorsLater.find((editor) => {
                        if (!editorsBeforeRefs.has(editor)) {
                            return true;
                        }
                        const identity = getEditorIdentity(editor, pageIndex);
                        return !editorsBeforeIds.has(identity);
                    }) ?? editorsLater.at(-1) ?? null;
                    if (!lateEditor) {
                        attempts += 1;
                        if (attempts < 12) {
                            setTimeout(tryEmitLater, 80);
                        }
                        return;
                    }
                    pendingCommentEditorKeys.add(getEditorPendingKey(lateEditor, pageIndex));
                    const summary = toEditorSummary(lateEditor, pageIndex, getCommentText(lateEditor));
                    emit('annotation-open-note', summary);
                };
                setTimeout(tryEmitLater, 80);
            }
        }
    } catch (error) {
        const message = error instanceof Error
            ? error.message
            : typeof error === 'string'
                ? error
                : (() => {
                    try {
                        return JSON.stringify(error);
                    } catch {
                        return String(error);
                    }
                })();
        const stack = error instanceof Error ? error.stack ?? '' : '';
        console.warn(stack ? `Failed to highlight selection: ${message}\n${stack}` : `Failed to highlight selection: ${message}`);
    }

    if (createdAnnotation) {
        maybeAutoResetAnnotationTool();
    }

    // If we're doing a one-off highlight (no comment dialog) then restore the previous mode right away.
    try {
        await uiManager.updateMode(previousMode);
    } catch (error) {
        console.warn('Failed to restore annotation mode:', error);
    }
}

function isPageNearVisible(page: number) {
    const start = Math.max(1, visibleRange.value.start - SKELETON_BUFFER);
    const end = Math.min(numPages.value, visibleRange.value.end + SKELETON_BUFFER);
    return page >= start && page <= end;
}

function shouldShowSkeleton(page: number) {
    return isPageNearVisible(page) && !isPageRendered(page);
}

function findEditorSummaryFromTarget(target: HTMLElement) {
    const uiManager = annotationUiManager.value;
    if (!uiManager) {
        return null;
    }

    const targetAnnotationId = target.closest<HTMLElement>('[data-annotation-id]')
        ?.dataset.annotationId
        ?? null;

    const editorElement = target.closest<HTMLElement>(
        '.annotation-editor-layer .highlightEditor, .annotation-editor-layer .freeTextEditor, .annotation-editor-layer .inkEditor, .annotationEditorLayer .highlightEditor, .annotationEditorLayer .freeTextEditor, .annotationEditorLayer .inkEditor',
    );
    if (!editorElement) {
        return null;
    }

    const pageContainer = editorElement.closest<HTMLElement>('.page_container');
    const pageNumber = pageContainer?.dataset.page
        ? Number(pageContainer.dataset.page)
        : currentPage.value;
    const pageIndex = Math.max(0, pageNumber - 1);

    for (const editor of uiManager.getEditors(pageIndex)) {
        const normalizedEditor = editor as IPdfjsEditor;
        const editorDiv = normalizedEditor.div;
        if (!editorDiv) {
            continue;
        }
        if (editorDiv === editorElement || editorDiv.contains(target)) {
            const summary = toEditorSummary(normalizedEditor, pageIndex, getCommentText(normalizedEditor));
            const normalizedSummary = {
                ...hydrateSummaryFromMemory(summary),
                annotationId: summary.annotationId ?? targetAnnotationId,
                stableKey: computeSummaryStableKey({
                    id: summary.id,
                    pageIndex: summary.pageIndex,
                    source: summary.source,
                    uid: summary.uid,
                    annotationId: summary.annotationId ?? targetAnnotationId,
                }),
            };
            const candidateIds = [
                normalizedSummary.annotationId,
                normalizedSummary.uid,
                normalizedSummary.id,
            ]
                .filter((id): id is string => typeof id === 'string' && id.length > 0)
                .filter((id, index, arr) => arr.indexOf(id) === index);

            const cached = annotationCommentsCache.value.find((comment) => (
                comment.pageIndex === pageIndex
                && (
                    candidateIds.includes(comment.annotationId ?? '')
                    || candidateIds.includes(comment.uid ?? '')
                    || candidateIds.includes(comment.id)
                )
            )) ?? annotationCommentsCache.value.find((comment) => (
                candidateIds.includes(comment.annotationId ?? '')
                || candidateIds.includes(comment.uid ?? '')
                || candidateIds.includes(comment.id)
            )) ?? null;

            // Prefer the persisted summary when available; editor objects can miss
            // comment/date fields after re-render, which causes blank "new note" popups.
            return cached ?? hydrateSummaryFromMemory(normalizedSummary);
        }
    }

    return null;
}

function findPdfAnnotationSummaryFromTarget(target: HTMLElement) {
    const annotationElement = target.closest<HTMLElement>(
        '.annotationLayer [data-annotation-id], .annotation-layer [data-annotation-id]',
    );
    if (!annotationElement) {
        return null;
    }

    const annotationId = annotationElement.dataset.annotationId ?? annotationElement.getAttribute('data-annotation-id');
    if (!annotationId) {
        return null;
    }

    const pageContainer = annotationElement.closest<HTMLElement>('.page_container');
    const pageNumber = pageContainer?.dataset.page
        ? Number(pageContainer.dataset.page)
        : currentPage.value;
    const pageIndex = Math.max(0, pageNumber - 1);

    return annotationCommentsCache.value.find(comment => (
        comment.annotationId === annotationId && comment.pageIndex === pageIndex
    )) ?? annotationCommentsCache.value.find(comment => comment.annotationId === annotationId) ?? null;
}

function findAnnotationSummaryFromTarget(target: HTMLElement) {
    const editorSummary = findEditorSummaryFromTarget(target);
    const pdfSummary = findPdfAnnotationSummaryFromTarget(target);

    if (!editorSummary) {
        return pdfSummary;
    }
    if (!pdfSummary) {
        return editorSummary;
    }

    const editorText = editorSummary.text.trim();
    const pdfText = pdfSummary.text.trim();
    if (!editorText && pdfText) {
        return pdfSummary;
    }
    if (!editorSummary.modifiedAt && pdfSummary.modifiedAt) {
        return pdfSummary;
    }
    return editorSummary;
}

function setActiveCommentStableKey(stableKey: string | null) {
    activeCommentStableKey.value = stableKey;
    debouncedSyncInlineCommentIndicators();
}

function findPageContainerFromClientPoint(clientX: number, clientY: number) {
    const container = viewerContainer.value;
    if (!container) {
        return null;
    }

    const pages = Array.from(container.querySelectorAll<HTMLElement>('.page_container'));
    if (pages.length === 0) {
        return null;
    }

    let nearest: {
        element: HTMLElement;
        distanceSquared: number;
    } | null = null;
    for (const element of pages) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            continue;
        }

        const inside = (
            clientX >= rect.left
            && clientX <= rect.right
            && clientY >= rect.top
            && clientY <= rect.bottom
        );
        if (inside) {
            return element;
        }

        const dx = clientX < rect.left
            ? rect.left - clientX
            : (clientX > rect.right ? clientX - rect.right : 0);
        const dy = clientY < rect.top
            ? rect.top - clientY
            : (clientY > rect.bottom ? clientY - rect.bottom : 0);
        const distanceSquared = dx * dx + dy * dy;
        if (!nearest || distanceSquared < nearest.distanceSquared) {
            nearest = {
                element,
                distanceSquared,
            };
        }
    }

    return nearest?.element ?? null;
}

function findAnnotationSummaryFromPoint(target: HTMLElement, clientX: number, clientY: number) {
    const pageContainer = target.closest<HTMLElement>('.page_container')
        ?? findPageContainerFromClientPoint(clientX, clientY);
    if (!pageContainer) {
        return null;
    }

    const pageNumber = pageContainer.dataset.page
        ? Number(pageContainer.dataset.page)
        : currentPage.value;
    if (!Number.isFinite(pageNumber) || pageNumber <= 0) {
        return null;
    }

    const pageRect = pageContainer.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) {
        return null;
    }

    const x = (clientX - pageRect.left) / pageRect.width;
    const y = (clientY - pageRect.top) / pageRect.height;
    const toleranceX = 14 / pageRect.width;
    const toleranceY = 14 / pageRect.height;

    let bestSummary: IAnnotationCommentSummary | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    annotationCommentsCache.value.forEach((summary) => {
        if (summary.pageNumber !== pageNumber) {
            return;
        }
        const rect = normalizeMarkerRect(summary.markerRect);
        if (!rect) {
            return;
        }

        const left = rect.left - toleranceX;
        const top = rect.top - toleranceY;
        const right = rect.left + rect.width + toleranceX;
        const bottom = rect.top + rect.height + toleranceY;

        if (x < left || x > right || y < top || y > bottom) {
            return;
        }

        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const distanceScore = ((x - centerX) ** 2 + (y - centerY) ** 2) * 10000;
        const areaScore = rect.width * rect.height;
        const score = distanceScore + areaScore;

        if (score < bestScore) {
            bestScore = score;
            bestSummary = summary;
        }
    });

    return bestSummary;
}

function handleAnnotationEditorDblClick(event: MouseEvent) {
    if (!(event.target instanceof HTMLElement)) {
        return;
    }

    const summary = findAnnotationSummaryFromTarget(event.target);
    if (summary) {
        setActiveCommentStableKey(summary.stableKey);
        emit('annotation-open-note', summary);
    }
}

function handleAnnotationCommentClick(event: MouseEvent) {
    if (!(event.target instanceof HTMLElement)) {
        return;
    }
    if (annotationTool.value !== 'none') {
        return;
    }
    if (event.target.closest('.pdf-annotation-comment-popup, #commentPopup, #commentManagerDialog')) {
        return;
    }

    const selection = document.getSelection();
    if (selection && !selection.isCollapsed) {
        return;
    }

    const inlineTarget = event.target.closest<HTMLElement>('.pdf-annotation-has-note-target, .pdf-annotation-has-comment');
    const stableKey = inlineTarget?.getAttribute('data-comment-stable-key') ?? null;
    if (stableKey) {
        const summary = findCommentByStableKey(stableKey);
        if (summary) {
            setActiveCommentStableKey(summary.stableKey);
            emit('annotation-open-note', summary);
            return;
        }
    }

    const summary = findAnnotationSummaryFromTarget(event.target)
        ?? findAnnotationSummaryFromPoint(event.target, event.clientX, event.clientY);
    if (!summary) {
        return;
    }
    setActiveCommentStableKey(summary.stableKey);
    emit('annotation-open-note', summary);
}

function handleAnnotationCommentContextMenu(event: MouseEvent) {
    if (!(event.target instanceof HTMLElement)) {
        return;
    }

    if (annotationTool.value !== 'none') {
        event.preventDefault();
        emit('annotation-tool-cancel');
        return;
    }

    const summary = findAnnotationSummaryFromTarget(event.target)
        ?? findAnnotationSummaryFromPoint(event.target, event.clientX, event.clientY);
    if (!summary) {
        return;
    }

    event.preventDefault();
    setActiveCommentStableKey(summary.stableKey);
    emit('annotation-context-menu', {
        comment: summary,
        clientX: event.clientX,
        clientY: event.clientY,
    });
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
        annotationCommentsSyncToken += 1;
        annotationCommentsCache.value = [];
        activeCommentStableKey.value = null;
        emit('annotation-comments', []);
        return;
    }

    // Notify listeners before tearing down the previous PDF instance.
    // This prevents consumers (e.g. sidebar thumbnails) from calling into a document that is being destroyed.
    emit('update:document', null);
    emit('update:totalPages', 0);
    emit('update:currentPage', 1);

    cleanupRenderedPages();
    destroyAnnotationEditor();
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
    initAnnotationEditor();

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
    scheduleAnnotationCommentsSync(true);
}

const debouncedRenderOnScroll = useDebounceFn(() => {
    if (isLoading.value || !pdfDocument.value) {
        return;
    }
    void renderVisiblePages(visibleRange.value);
}, 100);

const debouncedSnapToPage = useDebounceFn(() => {
    if (isLoading.value || !pdfDocument.value || continuousScroll.value || isSnapping.value) {
        return;
    }
    const page = getMostVisiblePage(viewerContainer.value, numPages.value);
    snapToPage(page);
}, 120);

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

    if (!continuousScroll.value && !isSnapping.value) {
        debouncedSnapToPage();
    }
}

function scrollToPage(pageNumber: number) {
    if (!viewerContainer.value || numPages.value === 0) {
        return;
    }

    if (continuousScroll.value) {
        scrollToPageInternal(
            viewerContainer.value,
            pageNumber,
            numPages.value,
            scaledMargin.value,
        );
        emit('update:currentPage', currentPage.value);
    } else {
        snapToPage(pageNumber);
    }

    queueMicrotask(() => {
        if (isLoading.value || !pdfDocument.value) {
            return;
        }
        updateVisibleRange(viewerContainer.value, numPages.value);
        void renderVisiblePages(visibleRange.value);
    });
}

function snapToPage(pageNumber: number) {
    if (!viewerContainer.value || numPages.value === 0) {
        return;
    }

    const targetPage = Math.max(1, Math.min(pageNumber, numPages.value));
    const pageContainers = viewerContainer.value.querySelectorAll('.page_container');
    const targetEl = pageContainers[targetPage - 1] as HTMLElement | undefined;
    if (!targetEl) {
        return;
    }

    const container = viewerContainer.value;
    const containerHeight = container.clientHeight;
    const targetHeight = targetEl.offsetHeight;
    const baseTop = targetEl.offsetTop - scaledMargin.value;
    const centerOffset = Math.max(0, (containerHeight - targetHeight) / 2);
    const maxTop = Math.max(0, container.scrollHeight - containerHeight);
    const targetTop = Math.min(maxTop, Math.max(0, baseTop - centerOffset));
    isSnapping.value = true;
    container.scrollTop = targetTop;
    currentPage.value = targetPage;
    emit('update:currentPage', targetPage);

    requestAnimationFrame(() => {
        isSnapping.value = false;
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
    document.addEventListener('selectionchange', cacheCurrentTextSelection, { passive: true });
    attachInlineCommentMarkerObserver();
    loadFromSource();
});

onUnmounted(() => {
    document.removeEventListener('selectionchange', cacheCurrentTextSelection);
    inlineCommentMarkerObserver?.disconnect();
    inlineCommentMarkerObserver = null;
    clearInlineCommentIndicators();
    cachedSelectionRange = null;
    cachedSelectionTimestamp = 0;
    cleanupRenderedPages();
    destroyAnnotationEditor();
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
                scrollToPage(pageToSnapTo);
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
    (value) => {
        if (!value) {
            void nextTick(() => {
                const page = getMostVisiblePage(viewerContainer.value, numPages.value);
                snapToPage(page);
            });
        }
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
        // PDF.js' UIManager expects the "viewer" scale (before PDF->CSS unit conversion).
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
        void setAnnotationTool(tool);
    },
    { immediate: true },
);

watch(
    annotationSettings,
    (settings) => {
        applyAnnotationSettings(settings);
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
        }
        emit('update:loading', value);
        emit('loading', value);
    },
    { immediate: true },
);

defineExpose({
    scrollToPage,
    saveDocument,
    highlightSelection,
    commentSelection,
    undoAnnotation,
    redoAnnotation,
    focusAnnotationComment,
    updateAnnotationComment,
    deleteAnnotationComment,
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
    width: 16px;
    height: 16px;
    border: 1px solid rgb(165 145 41 / 0.82);
    border-radius: 3px;
    transform: translate(-50%, -50%);
    background: linear-gradient(180deg, #fcf6ba 0%, #f2e68f 100%);
    box-shadow:
        0 2px 5px rgb(0 0 0 / 0.24),
        inset 0 0 0 1px rgb(255 255 255 / 0.64);
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
    right: 1px;
    top: 1px;
    width: 4px;
    height: 4px;
    background: linear-gradient(135deg, rgb(255 255 255 / 0.88) 0%, rgb(235 224 145 / 0.95) 100%);
    clip-path: polygon(0 0, 100% 0, 100% 100%);
}

.pdfViewer :deep(.pdf-inline-comment-marker.is-cluster)::after {
    content: attr(data-comment-count);
    right: -7px;
    top: -7px;
    width: 13px;
    height: 13px;
    border-radius: 999px;
    border: 1px solid rgb(120 104 34 / 0.9);
    background: linear-gradient(180deg, #fff9cf 0%, #f0e183 100%);
    color: rgb(87 73 16 / 0.95);
    clip-path: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 8px;
    font-weight: 700;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.22);
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

.pdfViewer :deep(.pdf-annotation-has-note-anchor)::after {
    content: '';
    position: absolute;
    top: -8px;
    right: -8px;
    width: 15px;
    height: 15px;
    background: linear-gradient(180deg, #fbf3b6 0%, #ecd978 100%);
    border: 1px solid rgb(137 116 31 / 0.9);
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2zm-2 9H6V9h12v2zm0 4H6v-2h12v2z'/%3E%3C/svg%3E");
    mask-repeat: no-repeat;
    mask-position: center;
    mask-size: 78% 78%;
    box-shadow:
        0 2px 4px rgb(0 0 0 / 0.2),
        inset 0 0 0 1px rgb(255 255 255 / 0.52);
    pointer-events: none;
    transition: transform 0.12s ease;
}

.pdfViewer :deep(.pdf-annotation-has-note-target) {
    position: relative;
    overflow: visible;
    cursor: pointer;
    outline: 1px solid rgb(150 126 36 / 0.68);
    outline-offset: 0;
    box-shadow:
        inset 0 -1.5px 0 rgb(126 103 20 / 0.72),
        0 0 0 1px rgb(255 246 172 / 0.36);
    background-image:
        linear-gradient(180deg, rgb(255 248 203 / 0.14), rgb(255 244 173 / 0.14)),
        repeating-linear-gradient(
            -45deg,
            rgb(137 116 31 / 0.08) 0 2px,
            transparent 2px 6px
        );
}

.pdfViewer :deep(.pdf-annotation-has-note-target:hover) {
    filter: drop-shadow(0 0 3px rgba(59, 130, 246, 0.35));
}

.pdfViewer :deep(.pdf-annotation-has-note-anchor:hover)::after {
    transform: scale(1.08);
}

.pdfViewer :deep(.pdf-annotation-has-note-active) {
    filter: drop-shadow(0 0 5px color-mix(in oklab, var(--ui-primary, #3b82f6) 35%, transparent));
    outline-color: color-mix(in oklab, var(--ui-primary, #3b82f6) 42%, rgb(137 116 31));
    box-shadow:
        inset 0 -2px 0 color-mix(in oklab, var(--ui-primary, #3b82f6) 36%, rgb(126 103 20)),
        0 0 0 2px color-mix(in oklab, var(--ui-primary, #3b82f6) 24%, transparent);
}

.pdfViewer :deep(.pdf-annotation-has-note-active.pdf-annotation-has-note-anchor)::after {
    transform: scale(1.1);
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
    overflow: hidden;
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
