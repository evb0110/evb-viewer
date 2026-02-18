import {
    ref,
    computed,
    nextTick,
    type Ref,
} from 'vue';
import { clamp } from 'es-toolkit/math';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import { BrowserLogger } from '@app/utils/browser-logger';

type TPdfSidebarTab = 'annotations' | 'thumbnails' | 'bookmarks' | 'search';

interface IPdfViewerForAnnotationActions {
    commentSelection: () => Promise<boolean>;
    commentAtPoint: (
        pageNumber: number,
        pageX: number,
        pageY: number,
        options?: { preferTextAnchor?: boolean },
    ) => Promise<boolean>;
    startCommentPlacement: () => void;
    cancelCommentPlacement: () => void;
    focusAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<void>;
    highlightSelection: () => Promise<boolean>;
    updateAnnotationComment: (comment: IAnnotationCommentSummary, text: string) => boolean;
    deleteAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<boolean>;
    selectedShapeId: { value: string | null };
    updateShape: (id: string, updates: Partial<IShapeAnnotation>) => void;
    getSelectedShape: () => IShapeAnnotation | null;
    saveDocument: () => Promise<Uint8Array | null>;
}

export interface IPageAnnotationActionsDeps {
    pdfViewerRef: Ref<IPdfViewerForAnnotationActions | null>;
    annotationTool: Ref<TAnnotationTool>;
    annotationKeepActive: Ref<boolean>;
    annotationPlacingPageNote: Ref<boolean>;
    annotationSettings: Ref<IAnnotationSettings>;
    annotationActiveCommentStableKey: Ref<string | null>;
    annotationContextMenu: Ref<{
        visible: boolean;
        comment: IAnnotationCommentSummary | null;
        hasSelection: boolean;
        selectionText: string;
        pageNumber: number | null;
        pageX: number | null;
        pageY: number | null;
    }>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TPdfSidebarTab>;
    dragMode: Ref<boolean>;
    currentPage: Ref<number>;
    workingCopyPath: Ref<string | null>;
    closeAnnotationContextMenu: () => void;
    showAnnotationContextMenu: (payload: {
        comment: IAnnotationCommentSummary | null;
        clientX: number;
        clientY: number;
        hasSelection: boolean;
        selectionText: string;
        pageNumber: number | null;
        pageX: number | null;
        pageY: number | null;
    }) => void;
    handleAnnotationToolChange: (tool: TAnnotationTool) => void;
    openAnnotationNoteWindow: (comment: IAnnotationCommentSummary) => void;
    removeAnnotationNoteWindow: (stableKey: string) => void;
    setAnnotationNoteWindowError: (stableKey: string, error: string | null) => void;
    isSameAnnotationComment: (a: IAnnotationCommentSummary, b: IAnnotationCommentSummary) => boolean;
    annotationNoteWindows: Ref<Array<{ comment: IAnnotationCommentSummary }>>;
    deleteEmbeddedByRef: (comment: IAnnotationCommentSummary) => Promise<Uint8Array | null>;
    loadPdfFromData: (data: Uint8Array, opts?: {
        pushHistory?: boolean;
        persistWorkingCopy?: boolean;
    }) => Promise<void>;
    waitForPdfReload: (page: number) => Promise<void>;
}

export const usePageAnnotationActions = (deps: IPageAnnotationActionsDeps) => {
    const { t } = useTypedI18n();

    const {
        pdfViewerRef,
        annotationTool,
        annotationKeepActive,
        annotationPlacingPageNote,
        annotationSettings,
        annotationActiveCommentStableKey,
        annotationContextMenu,
        showSidebar,
        sidebarTab,
        dragMode,
        currentPage,
        workingCopyPath,
        closeAnnotationContextMenu,
        showAnnotationContextMenu,
        handleAnnotationToolChange,
        openAnnotationNoteWindow,
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        isSameAnnotationComment,
        annotationNoteWindows,
        deleteEmbeddedByRef,
        loadPdfFromData,
        waitForPdfReload,
    } = deps;

    const shapePropertiesPopover = ref<{
        visible: boolean;
        x: number;
        y: number;
    }>({
        visible: false,
        x: 0,
        y: 0,
    });

    const selectedShapeForProperties = computed(() =>
        shapePropertiesPopover.value.visible
            ? pdfViewerRef.value?.getSelectedShape() ?? null
            : null,
    );

    async function handleCommentSelection() {
        if (!pdfViewerRef.value) {
            return;
        }
        await pdfViewerRef.value.commentSelection();
    }

    function handleStartPlaceNote() {
        if (!pdfViewerRef.value) {
            return;
        }

        if (annotationPlacingPageNote.value) {
            pdfViewerRef.value.cancelCommentPlacement();
            annotationPlacingPageNote.value = false;
            return;
        }

        showSidebar.value = true;
        sidebarTab.value = 'annotations';
        dragMode.value = false;
        annotationTool.value = 'none';
        pdfViewerRef.value.startCommentPlacement();
        annotationPlacingPageNote.value = true;
    }

    async function handleAnnotationFocusComment(comment: IAnnotationCommentSummary) {
        if (!pdfViewerRef.value) {
            return;
        }
        annotationActiveCommentStableKey.value = comment.stableKey;
        showSidebar.value = true;
        sidebarTab.value = 'annotations';
        dragMode.value = false;
        await pdfViewerRef.value.focusAnnotationComment(comment);
    }

    function handleAnnotationCommentClick(comment: IAnnotationCommentSummary) {
        annotationActiveCommentStableKey.value = comment.stableKey;
        dragMode.value = false;
    }

    function handleOpenAnnotationNote(comment: IAnnotationCommentSummary) {
        closeAnnotationContextMenu();
        annotationActiveCommentStableKey.value = comment.stableKey;
        openAnnotationNoteWindow(comment);
        dragMode.value = false;
    }

    function closeShapeProperties() {
        shapePropertiesPopover.value = {
            visible: false,
            x: 0,
            y: 0,
        };
    }

    function handleShapePropertyUpdate(updates: Partial<IShapeAnnotation>) {
        const id = pdfViewerRef.value?.selectedShapeId?.value;
        if (!id) {
            return;
        }

        const nextSettings: IAnnotationSettings = { ...annotationSettings.value };
        let didUpdateDefaults = false;
        if (typeof updates.color === 'string' && updates.color.trim()) {
            nextSettings.shapeColor = updates.color;
            didUpdateDefaults = true;
        }
        if (typeof updates.strokeWidth === 'number' && Number.isFinite(updates.strokeWidth)) {
            nextSettings.shapeStrokeWidth = updates.strokeWidth;
            didUpdateDefaults = true;
        }
        if (typeof updates.opacity === 'number' && Number.isFinite(updates.opacity)) {
            nextSettings.shapeOpacity = updates.opacity;
            didUpdateDefaults = true;
        }
        if ('fillColor' in updates) {
            const fill = updates.fillColor ?? 'transparent';
            nextSettings.shapeFillColor = fill;
            didUpdateDefaults = true;
        }
        if (didUpdateDefaults) {
            annotationSettings.value = nextSettings;
        }

        pdfViewerRef.value?.updateShape(id, updates);
    }

    function handleShapeContextMenu(payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }) {
        closeAnnotationContextMenu();
        const popoverWidth = 260;
        const popoverHeight = 200;
        const margin = 8;
        const maxX = Math.max(margin, window.innerWidth - popoverWidth - margin);
        const maxY = Math.max(margin, window.innerHeight - popoverHeight - margin);

        shapePropertiesPopover.value = {
            visible: true,
            x: clamp(payload.clientX, margin, maxX),
            y: clamp(payload.clientY, margin, maxY),
        };
    }

    function handleViewerAnnotationContextMenu(payload: {
        comment: IAnnotationCommentSummary | null;
        clientX: number;
        clientY: number;
        hasSelection: boolean;
        selectionText: string;
        pageNumber: number | null;
        pageX: number | null;
        pageY: number | null;
    }) {
        if (payload.comment) {
            annotationActiveCommentStableKey.value = payload.comment.stableKey;
        } else {
            annotationActiveCommentStableKey.value = null;
        }

        showAnnotationContextMenu(payload);
    }

    function openContextMenuNote() {
        const comment = annotationContextMenu.value.comment;
        if (!comment) {
            return;
        }
        handleOpenAnnotationNote(comment);
        closeAnnotationContextMenu();
    }

    function copyContextMenuNoteText() {
        const comment = annotationContextMenu.value.comment;
        if (!comment) {
            return;
        }
        void handleCopyAnnotationComment(comment);
        closeAnnotationContextMenu();
    }

    async function copyContextMenuSelectionText() {
        const text = annotationContextMenu.value.selectionText.trim();
        closeAnnotationContextMenu();
        if (!text) {
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
        } catch (error) {
            BrowserLogger.debug('annotations', 'Failed to copy selected text to clipboard', error);
        }
    }

    function deleteContextMenuComment() {
        const comment = annotationContextMenu.value.comment;
        if (!comment) {
            return;
        }
        void handleDeleteAnnotationComment(comment);
        closeAnnotationContextMenu();
    }

    async function createContextMenuFreeNote() {
        if (!pdfViewerRef.value) {
            closeAnnotationContextMenu();
            return;
        }

        const {
            pageNumber,
            pageX,
            pageY,
        } = annotationContextMenu.value;
        if (
            !Number.isFinite(pageNumber)
            || !Number.isFinite(pageX)
            || !Number.isFinite(pageY)
        ) {
            closeAnnotationContextMenu();
            return;
        }

        await pdfViewerRef.value.commentAtPoint(
            pageNumber as number,
            pageX as number,
            pageY as number,
            { preferTextAnchor: false },
        );
        closeAnnotationContextMenu();
    }

    async function createContextMenuSelectionNote() {
        await pdfViewerRef.value?.commentSelection();
        closeAnnotationContextMenu();
    }

    async function createContextMenuMarkup(tool: TAnnotationTool) {
        if (!pdfViewerRef.value) {
            closeAnnotationContextMenu();
            return;
        }
        handleAnnotationToolChange(tool);
        await nextTick();
        await pdfViewerRef.value.highlightSelection();
        if (!annotationKeepActive.value) {
            annotationTool.value = 'none';
        }
        closeAnnotationContextMenu();
    }

    async function serializeCurrentPdfForEmbeddedFallback() {
        if (!pdfViewerRef.value) {
            return false;
        }

        const rawData = await pdfViewerRef.value.saveDocument();
        if (!rawData) {
            return false;
        }

        const pageToRestore = currentPage.value;
        const restorePromise = waitForPdfReload(pageToRestore);
        await loadPdfFromData(rawData, {
            pushHistory: true,
            persistWorkingCopy: !!workingCopyPath.value,
        });
        await restorePromise;
        return true;
    }

    async function handleCopyAnnotationComment(comment: IAnnotationCommentSummary) {
        closeAnnotationContextMenu();
        const text = comment.text?.trim();
        if (!text) {
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
        } catch (error) {
            BrowserLogger.debug('annotations', 'Failed to copy annotation comment text to clipboard', error);
        }
    }

    let annotationDeleteQueue: Promise<void> = Promise.resolve();

    async function performDeleteAnnotationComment(comment: IAnnotationCommentSummary) {
        closeAnnotationContextMenu();
        if (!pdfViewerRef.value) {
            return;
        }
        setAnnotationNoteWindowError(comment.stableKey, null);
        let deleted = await pdfViewerRef.value.deleteAnnotationComment(comment);
        if (!deleted) {
            const result = await deleteEmbeddedByRef(comment);
            if (result instanceof Uint8Array) {
                const pageToRestore = currentPage.value;
                const restorePromise = waitForPdfReload(pageToRestore);
                await loadPdfFromData(result, {
                    pushHistory: true,
                    persistWorkingCopy: !!workingCopyPath.value,
                });
                await restorePromise;
                deleted = true;
            }
        }
        if (!deleted) {
            const materialized = await serializeCurrentPdfForEmbeddedFallback();
            if (materialized) {
                const result = await deleteEmbeddedByRef(comment);
                if (result instanceof Uint8Array) {
                    const pageToRestore = currentPage.value;
                    const restorePromise = waitForPdfReload(pageToRestore);
                    await loadPdfFromData(result, {
                        pushHistory: true,
                        persistWorkingCopy: !!workingCopyPath.value,
                    });
                    await restorePromise;
                    deleted = true;
                }
            }
        }
        if (!deleted) {
            setAnnotationNoteWindowError(comment.stableKey, t('errors.annotation.delete'));
            return;
        }
        annotationNoteWindows.value
            .filter(note => isSameAnnotationComment(note.comment, comment))
            .forEach(note => removeAnnotationNoteWindow(note.comment.stableKey));
    }

    async function handleDeleteAnnotationComment(comment: IAnnotationCommentSummary) {
        annotationDeleteQueue = annotationDeleteQueue
            .catch(() => undefined)
            .then(async () => {
                await performDeleteAnnotationComment(comment);
            });
        await annotationDeleteQueue;
    }

    return {
        shapePropertiesPopover,
        selectedShapeForProperties,
        handleCommentSelection,
        handleStartPlaceNote,
        handleAnnotationFocusComment,
        handleAnnotationCommentClick,
        handleOpenAnnotationNote,
        closeShapeProperties,
        handleShapePropertyUpdate,
        handleShapeContextMenu,
        handleViewerAnnotationContextMenu,
        openContextMenuNote,
        copyContextMenuNoteText,
        copyContextMenuSelectionText,
        deleteContextMenuComment,
        createContextMenuFreeNote,
        createContextMenuSelectionNote,
        createContextMenuMarkup,
        serializeCurrentPdfForEmbeddedFallback,
        handleCopyAnnotationComment,
        handleDeleteAnnotationComment,
    };
};
