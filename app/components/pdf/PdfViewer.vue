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

function compareAnnotationComments(a: IAnnotationCommentSummary, b: IAnnotationCommentSummary) {
    const aTime = a.modifiedAt ?? 0;
    const bTime = b.modifiedAt ?? 0;
    if (aTime !== bTime) {
        return bTime - aTime;
    }
    if (a.pageIndex !== b.pageIndex) {
        return a.pageIndex - b.pageIndex;
    }
    return a.id.localeCompare(b.id);
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
    return editor.uid
        ?? editor.annotationElementId
        ?? editor.id
        ?? getEditorRuntimeId(editor, pageIndex);
}

function toEditorSummary(
    editor: IPdfjsEditor,
    pageIndex: number,
    textOverride?: string,
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

    return {
        id: getEditorIdentity(editor, pageIndex),
        pageIndex,
        pageNumber: pageIndex + 1,
        text,
        author: null,
        modifiedAt: parsePdfDateTimestamp(data.modificationDate) ?? parsePdfDateTimestamp(data.creationDate),
        color: toCssColor(data.color ?? editor.color, data.opacity ?? editor.opacity ?? 1),
        uid: editor.uid ?? null,
        annotationId: editor.annotationElementId ?? null,
        source: 'editor',
    };
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
            const summary = toEditorSummary(editor, editor.parentPageIndex ?? currentPage.value - 1, getCommentText(editor));
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
    if (summary.annotationId) {
        return `ann:${summary.annotationId}`;
    }
    if (summary.uid) {
        return `uid:${summary.uid}`;
    }
    return `id:${summary.id}`;
}

async function syncAnnotationComments() {
    const doc = pdfDocument.value;
    if (!doc || numPages.value <= 0) {
        emit('annotation-comments', []);
        return;
    }

    const localToken = ++annotationCommentsSyncToken;
    const commentsByKey = new Map<string, IAnnotationCommentSummary>();

    const uiManager = annotationUiManager.value;
    if (uiManager) {
        for (let pageIndex = 0; pageIndex < numPages.value; pageIndex += 1) {
            for (const editor of uiManager.getEditors(pageIndex)) {
                const text = getCommentText(editor).trim();
                if (!text) {
                    continue;
                }

                const summary = toEditorSummary(editor as IPdfjsEditor, pageIndex, text);
                commentsByKey.set(toSummaryKey(summary), summary);
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
        }> = [];

        try {
            const page = await doc.getPage(pageNumber);
            pageAnnotations = await page.getAnnotations();
        } catch {
            continue;
        }

        pageAnnotations.forEach((annotation, annotationIndex) => {
            const text = getAnnotationCommentText(annotation);
            if (!text) {
                return;
            }

            const summary: IAnnotationCommentSummary = {
                id: annotation.id ?? `pdf-${pageNumber}-${annotationIndex}`,
                pageIndex: pageNumber - 1,
                pageNumber,
                text,
                author: getAnnotationAuthor(annotation),
                modifiedAt: parsePdfDateTimestamp(annotation.modificationDate)
                    ?? parsePdfDateTimestamp(annotation.creationDate),
                color: toCssColor(annotation.color, annotation.opacity ?? 1),
                uid: null,
                annotationId: annotation.id ?? null,
                source: 'pdf',
            };

            const key = toSummaryKey(summary);
            if (!commentsByKey.has(key)) {
                commentsByKey.set(key, summary);
            }
        });
    }

    if (localToken !== annotationCommentsSyncToken) {
        return;
    }

    const comments = Array.from(commentsByKey.values()).sort(compareAnnotationComments);
    emit('annotation-comments', comments);
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

function findEditorForComment(comment: IAnnotationCommentSummary) {
    const uiManager = annotationUiManager.value;
    if (!uiManager || numPages.value <= 0) {
        return null;
    }

    const pageIndex = Math.max(0, Math.min(comment.pageIndex, numPages.value - 1));
    const candidateIds = [
        comment.uid,
        comment.annotationId,
        comment.id,
    ]
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .filter((id, index, arr) => arr.indexOf(id) === index);

    for (const editor of uiManager.getEditors(pageIndex)) {
        if (candidateIds.length === 0) {
            continue;
        }
        const identity = getEditorIdentity(editor as IPdfjsEditor, pageIndex);
        if (
            candidateIds.includes(identity)
            || 
            (editor.uid && candidateIds.includes(editor.uid))
            || (editor.annotationElementId && candidateIds.includes(editor.annotationElementId))
            || (editor.id && candidateIds.includes(editor.id))
        ) {
            return editor as IPdfjsEditor;
        }
    }

    return null;
}

async function focusAnnotationComment(comment: IAnnotationCommentSummary) {
    if (!pdfDocument.value) {
        return;
    }

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
        const candidateIds = [
            comment.uid,
            comment.annotationId,
            comment.id,
        ]
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
            .filter((id, index, arr) => arr.indexOf(id) === index);

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
    const editor = findEditorForComment(comment);
    if (!editor) {
        return false;
    }

    const nextText = text.trim();
    const previousText = getCommentText(editor).trim();
    if (nextText === previousText) {
        return true;
    }

    editor.comment = nextText.length > 0 ? nextText : null;
    editor.addToAnnotationStorage?.();
    emit('annotation-modified');
    scheduleAnnotationCommentsSync(true);
    return true;
}

function deleteAnnotationComment(comment: IAnnotationCommentSummary) {
    const uiManager = annotationUiManager.value;
    const editor = findEditorForComment(comment);
    if (!uiManager || !editor) {
        return false;
    }

    try {
        uiManager.setSelected(editor as unknown as TUiManagerSelectedEditor);
        uiManager.delete();
        emit('annotation-modified');
        scheduleAnnotationCommentsSync(true);
        return true;
    } catch {
        try {
            editor.remove?.();
            emit('annotation-modified');
            scheduleAnnotationCommentsSync(true);
            return true;
        } catch {
            return false;
        }
    }
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
    loadFromSource();
});

onUnmounted(() => {
    document.removeEventListener('selectionchange', cacheCurrentTextSelection);
    cachedSelectionRange = null;
    cachedSelectionTimestamp = 0;
    cleanupRenderedPages();
    destroyAnnotationEditor();
    cleanupDocument();
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
            }
            loadFromSource();
        }
    },
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
.pdfViewer :deep(.editToolbar),
.pdfViewer :deep(.annotationCommentButton),
.pdfViewer :deep(.commentPopup),
.pdfViewer :deep(#commentManagerDialog) {
    display: none !important;
}

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

/* Visual indicator for highlights with comments */
.pdfViewer :deep(.highlightEditor.has-comment)::after {
    content: '';
    position: absolute;
    top: -8px;
    right: -8px;
    width: 16px;
    height: 16px;
    background-color: var(--ui-primary, #3b82f6);
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2zm-2 9H6V9h12v2zm0 4H6v-2h12v2z'/%3E%3C/svg%3E");
    mask-repeat: no-repeat;
    mask-position: center;
    mask-size: contain;
    border-radius: 0;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
    pointer-events: none;
    transition: transform 0.12s ease;
}

.pdfViewer :deep(.highlightEditor.has-comment) {
    cursor: pointer;
}

.pdfViewer :deep(.highlightEditor.has-comment:hover) {
    filter: drop-shadow(0 0 3px rgba(59, 130, 246, 0.35));
}

.pdfViewer :deep(.highlightEditor.has-comment:hover)::after {
    transform: scale(1.08);
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
