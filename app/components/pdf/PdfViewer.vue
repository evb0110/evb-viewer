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

let restoreModeAfterCommentEdit: TAnnotationEditorMode | null = null;

function getCommentText(editor: any) {
    if (!editor) {
        return '';
    }
    const comment = editor.comment;
    if (typeof comment === 'string') {
        return comment;
    }
    if (comment && typeof comment.text === 'string') {
        return comment.text;
    }
    return '';
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

function createSimpleCommentManager(container: HTMLElement) {
    const popup = document.createElement('div');
    popup.id = 'commentPopup';
    popup.className = 'pdf-annotation-comment-popup is-hidden';
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-live', 'polite');
    popup.tabIndex = -1;

    const textEl = document.createElement('div');
    textEl.className = 'pdf-annotation-comment-popup__text';
    popup.append(textEl);

    const textarea = document.createElement('textarea');
    textarea.className = 'pdf-annotation-comment-popup__textarea';
    textarea.setAttribute('rows', '5');
    textarea.setAttribute('placeholder', 'Write a comment…');
    textarea.addEventListener('keydown', (event) => event.stopPropagation());
    textarea.addEventListener('keyup', (event) => event.stopPropagation());
    textarea.addEventListener('pointerdown', (event) => event.stopPropagation());
    popup.append(textarea);

    const actionRow = document.createElement('div');
    actionRow.className = 'pdf-annotation-comment-popup__actions';

    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.textContent = 'Edit';
    editButton.className = 'pdf-annotation-comment-popup__btn pdf-annotation-comment-popup__btn--edit';

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.textContent = 'Save';
    saveButton.className = 'pdf-annotation-comment-popup__btn pdf-annotation-comment-popup__btn--save';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.textContent = 'Cancel';
    cancelButton.className = 'pdf-annotation-comment-popup__btn pdf-annotation-comment-popup__btn--cancel';

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = 'Close';
    closeButton.className = 'pdf-annotation-comment-popup__btn pdf-annotation-comment-popup__btn--close';

    actionRow.append(editButton, saveButton, cancelButton, closeButton);
    popup.append(actionRow);
    container.append(popup);

    let activeEditor: any = null;
    let sidebarUiManager: AnnotationEditorUIManager | null = null;
    let isEditing = false;

    const commitEdit = () => {
        if (!activeEditor) {
            return;
        }

        const text = textarea.value.trim();
        const previousText = getCommentText(activeEditor).trim();
        if (text !== previousText) {
            activeEditor.comment = text.length ? text : null;
            activeEditor.addToAnnotationStorage?.();
            emit('annotation-modified');
        }

        isEditing = false;
        popup.classList.toggle('is-editing', false);
        textarea.blur();

        if (text.length) {
            showPopup(activeEditor);
        } else {
            hidePopup();
        }

        activeEditor?.focusCommentButton?.();

        if (restoreModeAfterCommentEdit && sidebarUiManager) {
            // Restore the tool/mode after a one-off comment operation (e.g. "Comment Selection").
            void sidebarUiManager.updateMode(restoreModeAfterCommentEdit);
            restoreModeAfterCommentEdit = null;
        }
    };

    const cancelEdit = () => {
        if (!activeEditor) {
            hidePopup();
        } else {
            showPopup(activeEditor);
        }

        isEditing = false;
        popup.classList.toggle('is-editing', false);
        textarea.blur();

        activeEditor?.focusCommentButton?.();

        if (restoreModeAfterCommentEdit && sidebarUiManager) {
            void sidebarUiManager.updateMode(restoreModeAfterCommentEdit);
            restoreModeAfterCommentEdit = null;
        }
    };

    const positionPopup = (editor: any, clientPosition?: { x: number; y: number }) => {
        const containerRect = container.getBoundingClientRect();
        let left: number;
        let top: number;

        if (clientPosition) {
            // Use provided client position
            left = clientPosition.x - containerRect.left + container.scrollLeft;
            top = clientPosition.y - containerRect.top + container.scrollTop;
        } else {
            // Try to find the editToolbar near this editor for positioning reference
            const editToolbar = editor?.div?.querySelector('.editToolbar')
                || container.querySelector('.editToolbar:not([style*="display: none"])');

            if (editToolbar) {
                const toolbarRect = editToolbar.getBoundingClientRect();
                left = toolbarRect.left - containerRect.left + container.scrollLeft;
                top = toolbarRect.bottom - containerRect.top + container.scrollTop + 8;
            } else if (editor?.div) {
                // Use editor's DOM element
                const editorRect = editor.div.getBoundingClientRect();
                left = editorRect.left - containerRect.left + container.scrollLeft;
                top = editorRect.bottom - containerRect.top + container.scrollTop + 8;
            } else {
                // Fallback: use editor's relative coordinates within its parent layer
                const layerRect = editor?.parent?.div?.getBoundingClientRect();
                if (layerRect && typeof editor?.x === 'number' && typeof editor?.y === 'number') {
                    const editorWidth = typeof editor.width === 'number' ? editor.width : 0.1;
                    const editorHeight = typeof editor.height === 'number' ? editor.height : 0.05;
                    left = layerRect.left + layerRect.width * editor.x - containerRect.left + container.scrollLeft;
                    top = layerRect.top + layerRect.height * (editor.y + editorHeight) - containerRect.top + container.scrollTop + 8;
                } else {
                    // Last resort: center of visible area
                    left = container.scrollLeft + container.clientWidth / 2 - popup.offsetWidth / 2;
                    top = container.scrollTop + container.clientHeight / 3;
                }
            }
        }

        // Keep popup within container bounds
        const maxLeft = container.scrollWidth - popup.offsetWidth - 8;
        const maxTop = container.scrollHeight - popup.offsetHeight - 8;
        left = Math.min(Math.max(8, left), Math.max(8, maxLeft));
        top = Math.min(Math.max(8, top), Math.max(8, maxTop));

        popup.style.left = `${left}px`;
        popup.style.top = `${top}px`;
    };

    const showPopup = (editor: any) => {
        if (!editor?.hasComment) {
            hidePopup();
            return;
        }

        const commentText = getCommentText(editor);
        if (!commentText) {
            hidePopup();
            return;
        }

        isEditing = false;
        popup.classList.toggle('is-editing', false);

        activeEditor = editor;
        textEl.textContent = commentText;
        positionPopup(editor);
        popup.classList.remove('is-hidden');
    };

    const hidePopup = () => {
        activeEditor = null;
        isEditing = false;
        popup.classList.toggle('is-editing', false);
        popup.classList.add('is-hidden');
    };

    editButton.addEventListener('click', () => {
        if (activeEditor) {
            isEditing = true;
            popup.classList.toggle('is-editing', true);
            textarea.value = getCommentText(activeEditor);
            positionPopup(activeEditor);
            popup.classList.remove('is-hidden');
            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        }
    });

    saveButton.addEventListener('click', () => commitEdit());
    cancelButton.addEventListener('click', () => cancelEdit());

    closeButton.addEventListener('click', () => {
        // Deselect the editor to hide both popup and toolbar
        if (activeEditor?.setSelected) {
            activeEditor.setSelected(false);
        }
        hidePopup();
    });

    popup.addEventListener('click', (event) => {
        event.stopPropagation();
    });
    popup.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
    });

    return {
        dialogElement: popup,
        setSidebarUiManager: (uiManager: AnnotationEditorUIManager) => {
            sidebarUiManager = uiManager;
        },
        // Called by the UI manager on mode changes. In the full PDF.js viewer this
        // closes any currently opened comment UI; for us it just hides the popup.
        destroyPopup: () => {
            hidePopup();
        },
        // Sidebar comments aren't implemented yet; we keep these as no-ops so
        // PDF.js can safely call them.
        showSidebar: () => {},
        hideSidebar: () => {},
        showDialog: (_uiManager: unknown, editor: any, x?: number, y?: number) => {
            activeEditor = editor;
            isEditing = true;
            popup.classList.toggle('is-editing', true);
            textarea.value = getCommentText(editor);
            positionPopup(editor, typeof x === 'number' && typeof y === 'number' ? { x, y } : undefined);
            popup.classList.remove('is-hidden');
            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        },
        updateComment: (data: { uid?: string } & { text?: string }) => {
            if (activeEditor && data?.uid && activeEditor.uid === data.uid) {
                showPopup(activeEditor);
            }
        },
        updatePopupColor: () => {},
        removeComments: (uids: string[]) => {
            if (activeEditor && uids.includes(activeEditor.uid)) {
                hidePopup();
            }
        },
        toggleCommentPopup: (editor: any, isSelected: boolean, visibility?: boolean) => {
            if (visibility === false && !isSelected) {
                hidePopup();
                return;
            }
            if (visibility || isSelected) {
                showPopup(editor);
            }
        },
        makeCommentColor: (color: string, opacity = 1) => {
            if (!color) {
                return null;
            }
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
            return color;
        },
        destroy: () => {
            popup.remove();
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

type TAnnotationEditorMode = (typeof AnnotationEditorType)[keyof typeof AnnotationEditorType];

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
    uiManager.updateParams(AnnotationEditorParamsType.HIGHLIGHT_FREE, settings.highlightFree);
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

async function runWithAnnotationMode(mode: TAnnotationEditorMode, action: () => void) {
    const uiManager = annotationUiManager.value;
    if (!uiManager) {
        return;
    }

    const previousMode = uiManager.getMode();
    if (previousMode === mode) {
        action();
        return;
    }

    try {
        await uiManager.updateMode(mode);
        action();
    } finally {
        // Restore whatever tool/mode was active before the quick action.
        try {
            await uiManager.updateMode(previousMode);
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
                ? `Failed to restore annotation mode: ${message}\n${stack}`
                : `Failed to restore annotation mode: ${message}`;

            console.warn(text);
        }
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

function destroyAnnotationEditor() {
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
    uiManager.copy = (event: ClipboardEvent) => {
        if (shouldIgnoreEditorEvent(event)) {
            return;
        }
        originalCopy(event);
    };

    const originalCut = uiManager.cut.bind(uiManager);
    uiManager.cut = (event: ClipboardEvent) => {
        if (shouldIgnoreEditorEvent(event)) {
            return;
        }
        originalCut(event);
    };

    const originalPaste = uiManager.paste.bind(uiManager);
    uiManager.paste = (event: ClipboardEvent) => {
        if (shouldIgnoreEditorEvent(event)) {
            return;
        }
        void originalPaste(event);
    };

    const originalAddToAnnotationStorage = uiManager.addToAnnotationStorage.bind(uiManager);
    uiManager.addToAnnotationStorage = (editor) => {
        const result = originalAddToAnnotationStorage(editor);
        emit('annotation-modified');
        return result;
    };

    const originalAddCommands = uiManager.addCommands.bind(uiManager);
    uiManager.addCommands = (params) => {
        emit('annotation-modified');
        return originalAddCommands(params);
    };

    const originalUndo = uiManager.undo.bind(uiManager);
    uiManager.undo = () => {
        const result = originalUndo();
        emit('annotation-modified');
        return result;
    };

    const originalRedo = uiManager.redo.bind(uiManager);
    uiManager.redo = () => {
        const result = originalRedo();
        emit('annotation-modified');
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
        pdfDoc.annotationStorage.onSetModified = () => emit('annotation-modified');
    } catch (error) {
        console.warn('Failed to attach annotation modified handler:', error);
    }

    uiManager.addEditListeners();
    uiManager.onScaleChanging({ scale: effectiveScale.value / PixelsPerInch.PDF_TO_CSS_UNITS });
    uiManager.onPageChanging({ pageNumber: currentPage.value });

    applyAnnotationSettings(pendingAnnotationSettings.value);
    void setAnnotationTool(pendingAnnotationTool.value);
    emit('annotation-state', annotationState.value);
}

async function highlightSelectionInternal(withComment: boolean) {
    const uiManager = annotationUiManager.value;
    if (!uiManager) {
        return;
    }

    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) {
        return;
    }

    const {
        anchorNode,
        anchorOffset,
        focusNode,
        focusOffset,
    } = selection;

    const text = selection.toString();
    const anchorElement = anchorNode?.nodeType === Node.TEXT_NODE
        ? anchorNode.parentElement
        : (anchorNode as HTMLElement | null);
    const textLayer = anchorElement?.closest('.textLayer') as HTMLElement | null;
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

    selection.empty();

    const previousMode = uiManager.getMode();

    if (withComment) {
        restoreModeAfterCommentEdit = previousMode;
    }

    try {
        await uiManager.updateMode(AnnotationEditorType.HIGHLIGHT);
        await uiManager.waitForEditorsRendered(pageNumber);

        const layer = uiManager.getLayer(pageNumber - 1) ?? uiManager.currentLayer;
        const editor = layer?.createAndAddNewEditor(
            { offsetX: 0, offsetY: 0 } as unknown as PointerEvent,
            false,
            {
                methodOfCreation: 'toolbar',
                boxes,
                anchorNode,
                anchorOffset,
                focusNode,
                focusOffset,
                text,
            },
        );

        if (withComment) {
            if (editor) {
                await editor.editComment();
                return;
            }
            restoreModeAfterCommentEdit = null;
        }
    } catch (error) {
        console.warn('Failed to highlight selection:', error);
        if (withComment) {
            restoreModeAfterCommentEdit = null;
        }
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
    loadFromSource();
});

onUnmounted(() => {
    cleanupRenderedPages();
    destroyAnnotationEditor();
    cleanupDocument();
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
    { deep: true, immediate: true },
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

.pdfViewer :deep(.commentPopup) {
    background: var(--color-surface, #ffffff);
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

.pdfViewer :deep(#commentManagerDialog) {
    background: var(--color-surface, #ffffff);
    border: 1px solid var(--ui-border, #e5e7eb);
    box-shadow:
        0 6px 18px rgba(15, 23, 42, 0.15),
        0 2px 6px rgba(15, 23, 42, 0.08);
    color: var(--ui-text, #111827);
}

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

.pdfViewer :deep(.pdf-annotation-comment-popup) {
    position: absolute;
    z-index: 6;
    min-width: 160px;
    max-width: 260px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--color-surface, #ffffff);
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

.pdfViewer :deep(.pdf-annotation-comment-popup.is-hidden) {
    opacity: 0;
    pointer-events: none;
    transform: translate3d(0, 6px, 0);
}

.pdfViewer :deep(.pdf-annotation-comment-popup__text) {
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
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
