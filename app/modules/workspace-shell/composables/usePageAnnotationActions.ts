import { useFailureToast } from '@app/composables/useFailureToast';
import { captureFailureForPresentation } from '@app/utils/failureReporter';
import type { Ref } from 'vue';
import { requirePageNumber } from '@contracts/pageNumbers';
import type { TDocumentRef } from '@contracts/documentRef';
import * as VueUse from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browserLogger';
import type * as WorkspaceOrchestration from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import type { TPageAnnotationActionsPdfViewer } from '@app/modules/workspace-shell/composables/pageAnnotationActionsPdfViewer';
import type {
    IAnnotationCommentSummary,
    IAnnotationModifiedPayload,
    TAnnotationTool,
} from '@app/types/annotations';
import {annotationIdForSummary} from '@app/modules/pdf-viewer/public';
import { getAnnotationPageNumber } from '@app/modules/workspace-shell/annotations/getAnnotationPageNumber';
import { withOpenedAnnotationNoteCreationTimestamp } from '@app/modules/workspace-shell/annotations/withOpenedAnnotationNoteCreationTimestamp';
import { pickPageAnnotationImageFile } from '@app/modules/workspace-shell/annotations/pickPageAnnotationImageFile';
import { readPageAnnotationImageFileFromClipboard } from '@app/modules/workspace-shell/annotations/readPageAnnotationImageFileFromClipboard';
import { createPageAnnotationDeleteActions } from '@app/modules/workspace-shell/composables/createPageAnnotationDeleteActions';
import { deleteAnnotationById } from '@app/modules/workspace-shell/annotations/deleteAnnotationById';

interface IPageAnnotationActionsDeps {
    pdfViewerRef: Ref<TPageAnnotationActionsPdfViewer | null>;
    annotationTool: Ref<TAnnotationTool>;
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
    sidebarTab: Ref<WorkspaceOrchestration.TPdfSidebarTab>;
    dragMode: Ref<boolean>;
    currentPage: Ref<number>;
    workingCopyPath: Ref<TDocumentRef | null>;
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
    handleAnnotationToolChange: (tool: TAnnotationTool, interaction?: {sidebarTab?: WorkspaceOrchestration.TPdfSidebarTab}) => boolean | Promise<boolean>;
    openAnnotationNoteWindow: (comment: IAnnotationCommentSummary) => void;
    setAnnotationNoteWindowError: (annotationId: string, error: string | null) => void;
    invalidateThumbnailPages?: (pages: number[]) => void;
    getAnnotationCommentsSnapshot?: () => IAnnotationCommentSummary[];
    discardAnnotationNote?: (annotationId: string) => Promise<void>;
    handleAnnotationModified?: (payload?: IAnnotationModifiedPayload) => void;
}

export const usePageAnnotationActions = (deps: IPageAnnotationActionsDeps) => {
    const { t } = useTypedI18n();
    const toast = useToast();
    const { presentFailureToast } = useFailureToast();
    const { copy: copyClipboardText } = VueUse.useClipboard();

    const {
        pdfViewerRef,
        annotationActiveCommentStableKey,
        annotationContextMenu,
        showSidebar,
        sidebarTab,
        dragMode,
        workingCopyPath,
        closeAnnotationContextMenu,
        showAnnotationContextMenu,
        handleAnnotationToolChange,
        openAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        invalidateThumbnailPages,
    } = deps;

    let isCreatingContextMenuFreeNote = false;

    let imageRequestGeneration = 0;
    watch([
        workingCopyPath,
        pdfViewerRef,
    ], () => { imageRequestGeneration += 1; }, {flush: 'sync'});

    async function handleCommentSelection() {
        if (!pdfViewerRef.value) {
            return;
        }
        await pdfViewerRef.value.commentSelection();
    }

    // Quick Note leaves the sidebar as it was.
    async function handleQuickNoteAction() {
        return pdfViewerRef.value ? await handleAnnotationToolChange(deps.annotationTool.value === 'note' ? 'select' : 'note') : undefined;
    }

    async function handleAnnotationFocusComment(comment: IAnnotationCommentSummary) {
        if (!pdfViewerRef.value || await handleAnnotationToolChange('select', {sidebarTab: 'annotations'}) === false) return;
        annotationActiveCommentStableKey.value = annotationIdForSummary(comment);
        await pdfViewerRef.value?.focusAnnotationComment(comment);
    }

    function handleAnnotationCommentClick(comment: IAnnotationCommentSummary) {
        annotationActiveCommentStableKey.value = annotationIdForSummary(comment);
        dragMode.value = false;
    }

    function invalidateAnnotationPage(comment: IAnnotationCommentSummary) {
        const page = getAnnotationPageNumber(comment);
        invalidateThumbnailPages?.([page]);
    }

    function getAnnotationCommentsSnapshot() {
        return deps.getAnnotationCommentsSnapshot?.() ?? null;
    }

    // The store's tombstone closes the deleted note's window; the selection is this view's own.
    function clearDeletedAnnotationSelection(comment: IAnnotationCommentSummary) {
        if (annotationActiveCommentStableKey.value === annotationIdForSummary(comment)) {
            annotationActiveCommentStableKey.value = null;
        }
    }

    function handleOpenAnnotationNote(comment: IAnnotationCommentSummary) {
        closeAnnotationContextMenu();
        const noteComment = withOpenedAnnotationNoteCreationTimestamp(comment);
        annotationActiveCommentStableKey.value = annotationIdForSummary(noteComment);
        openAnnotationNoteWindow(noteComment);
        invalidateAnnotationPage(noteComment);
        dragMode.value = false;
    }

    function normalizeTextMarkupColorValue(color: string | null | undefined) {
        return color?.trim().toLowerCase() ?? '';
    }

    function applyContextTextMarkupColorUpdate(
        comment: IAnnotationCommentSummary,
        color: string,
        options: {
            colorEdited?: boolean;
            sourceColor?: string | null;
        } = {},
    ) {
        const colorEdited = options.colorEdited ?? true;
        const sourceColor = options.sourceColor ?? comment.color ?? null;
        const nextComment = {
            ...comment,
            color,
            colorEdited,
        };
        const didUpdate = pdfViewerRef.value?.updateTextMarkupAnnotationColor?.({
            ...nextComment,
            color: sourceColor ?? nextComment.color,
        }, color) === true;
        annotationContextMenu.value = {
            ...annotationContextMenu.value,
            comment: nextComment,
        };
        invalidateAnnotationPage(nextComment);
        if (!didUpdate) {
            BrowserLogger.debug('annotations', 'Context-menu text markup color state updated before DOM repaint', () => ({
                annotationId: comment.annotationId ?? null,
                stableKey: comment.stableKey,
                subtype: comment.subtype ?? null,
                color,
            }));
        }
        return didUpdate;
    }

    function resolveContextTextMarkupUndoColor(comment: IAnnotationCommentSummary) {
        if (comment.color) {
            return comment.color;
        }
        const container = pdfViewerRef.value?.getViewerContainer?.();
        if (!container) {
            return null;
        }
        return comment.color ?? null;
    }

    function updateTextMarkupColorWithHistory(
        comment: IAnnotationCommentSummary,
        color: string,
    ) {
        const previousColor = resolveContextTextMarkupUndoColor(comment);
        const previousColorEdited = comment.colorEdited === true;
        const didUpdate = applyContextTextMarkupColorUpdate(comment, color, { sourceColor: previousColor });
        if (
            previousColor
            && normalizeTextMarkupColorValue(previousColor) !== normalizeTextMarkupColorValue(color)
        ) {
            pdfViewerRef.value?.registerAnnotationHistoryCommand?.({
                cmd: () => {
                    applyContextTextMarkupColorUpdate(
                        {
                            ...comment,
                            color,
                            colorEdited: true,
                        },
                        color,
                        { sourceColor: previousColor },
                    );
                },
                undo: () => {
                    applyContextTextMarkupColorUpdate(
                        {
                            ...comment,
                            color: previousColor,
                            colorEdited: previousColorEdited,
                        },
                        previousColor,
                        {
                            colorEdited: previousColorEdited,
                            sourceColor: color,
                        },
                    );
                },
            });
        }
        return didUpdate;
    }

    function handleContextTextMarkupColorUpdate(color: string) {
        const comment = annotationContextMenu.value.comment;
        if (!comment) {
            return;
        }
        if (comment.annotationKind === 'shape' && comment.appAnnotationId) {
            // Shapes reuse the selection property command, which owns its history entry.
            if (pdfViewerRef.value?.selectAnnotationById?.(comment.appAnnotationId)) {
                void Promise.resolve(pdfViewerRef.value.updateSelectedAnnotationProperties?.({color}))
                    .catch(error => BrowserLogger.debug('annotations', 'Failed to update shape color', error));
            }
        } else updateTextMarkupColorWithHistory(comment, color);
        closeAnnotationContextMenu();
    }

    async function handleShapeContextMenu(payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }) {
        closeAnnotationContextMenu();
        if (await handleAnnotationToolChange('select') === false) return;
        pdfViewerRef.value?.selectAnnotationById?.(payload.shapeId);
        const comment = getAnnotationCommentsSnapshot()?.find(candidate => candidate.appAnnotationId === payload.shapeId) ?? null;
        if (comment) {
            showAnnotationContextMenu({
                comment,
                clientX: payload.clientX,
                clientY: payload.clientY,
                hasSelection: false,
                selectionText: '',
                pageNumber: comment.pageNumber,
                pageX: comment.markerRect?.left ?? null,
                pageY: comment.markerRect?.top ?? null,
            });
            return;
        }
        showSidebar.value = true;
        sidebarTab.value = 'annotations';
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
            annotationActiveCommentStableKey.value = annotationIdForSummary(payload.comment);
        } else {
            annotationActiveCommentStableKey.value = null;
        }

        showAnnotationContextMenu(payload);
    }

    async function insertImageFromFileAt(
        pageNumber?: number | null,
        pageX?: number | null,
        pageY?: number | null,
        existingImage?: {appAnnotationId: string;} | null,
    ) {
        const viewer = pdfViewerRef.value;
        if (!viewer) {
            return;
        }

        const requestGeneration = ++imageRequestGeneration;
        const targetPageNumber = pageNumber ?? viewer.getCurrentPage?.() ?? deps.currentPage.value;
        closeAnnotationContextMenu();
        try {
            const file = await pickPageAnnotationImageFile();
            if (!file || requestGeneration !== imageRequestGeneration || pdfViewerRef.value !== viewer) {
                return;
            }
            await viewer.startImagePlacement(file, {
                pageNumber: requirePageNumber(targetPageNumber),
                ...(pageX !== undefined ? { pageX } : {}),
                ...(pageY !== undefined ? { pageY } : {}),
                ...(existingImage ?? {}),
            });
        } catch (error) {
            BrowserLogger.warn('annotations', 'Failed to insert image from file', error);
        }
    }

    async function pasteImageFromClipboardAt(
        pageNumber?: number | null,
        pageX?: number | null,
        pageY?: number | null,
        existingImage?: {appAnnotationId: string;} | null,
    ): Promise<boolean> {
        const viewer = pdfViewerRef.value;
        if (!viewer) {
            return false;
        }

        const requestGeneration = ++imageRequestGeneration;
        const targetPageNumber = pageNumber ?? viewer.getCurrentPage?.() ?? deps.currentPage.value;
        closeAnnotationContextMenu();

        try {
            const file = await readPageAnnotationImageFileFromClipboard();
            if (!file || requestGeneration !== imageRequestGeneration || pdfViewerRef.value !== viewer) {
                return false;
            }
            const targetPage = requirePageNumber(
                targetPageNumber,
            );
            return await viewer.startImagePlacement(file, {
                pageNumber: targetPage,
                ...(pageX !== undefined ? { pageX } : {}),
                ...(pageY !== undefined ? { pageY } : {}),
                ...(existingImage ?? {}),
            });
        } catch (error) {
            // A browser may refuse clipboard reads; its paste event still
            // carries the image, so point the user at the paste shortcut.
            if (error instanceof DOMException && error.name === 'NotAllowedError') {
                toast.add({
                    color: 'warning',
                    title: t('annotations.clipboardImageReadBlocked'),
                });
                return false;
            }
            BrowserLogger.warn('annotations', 'Failed to paste image from clipboard', error);
            return false;
        }
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

    async function copyAnnotationText(text: string) {
        closeAnnotationContextMenu();
        if (!text) return;
        try {
            await copyClipboardText(text);
        } catch (error) {
            BrowserLogger.warn('annotations', 'Failed to copy annotation text to clipboard', error);
            presentFailureToast({
                ...captureFailureForPresentation({code: 'RENDERER_WORKSPACE_OPERATION_FAILED', local: {source: 'annotations', message: 'Failed to copy annotation text to clipboard', cause: error}}),
                title: t('assistant.copyFailed'),
            });
        }
    }

    function copyContextMenuSelectionText() {
        return copyAnnotationText(annotationContextMenu.value.selectionText.trim());
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
        if (isCreatingContextMenuFreeNote) {
            closeAnnotationContextMenu();
            return;
        }
        if (!pdfViewerRef.value) {
            closeAnnotationContextMenu();
            return;
        }

        const contextMenu = annotationContextMenu.value;
        const pageNumber = typeof contextMenu.pageNumber === 'number' && Number.isFinite(contextMenu.pageNumber) ? contextMenu.pageNumber : null;
        const pageX = typeof contextMenu.pageX === 'number' && Number.isFinite(contextMenu.pageX) ? contextMenu.pageX : null;
        const pageY = typeof contextMenu.pageY === 'number' && Number.isFinite(contextMenu.pageY) ? contextMenu.pageY : null;
        if (
            pageNumber === null
            || pageX === null
            || pageY === null
        ) {
            closeAnnotationContextMenu();
            return;
        }

        isCreatingContextMenuFreeNote = true;
        closeAnnotationContextMenu();
        try {
            await pdfViewerRef.value.commentAtPoint(
                requirePageNumber(pageNumber),
                pageX,
                pageY,
                { preferTextAnchor: false },
            );
        } catch (error) {
            BrowserLogger.warn('note-placement', 'Failed to create note from annotation context menu', error);
            presentFailureToast({
                ...captureFailureForPresentation({code: 'RENDERER_WORKSPACE_OPERATION_FAILED', local: {source: 'note-placement', message: 'Failed to create note from annotation context menu', cause: error}}),
                title: t('errors.annotation.create'),
            });
        } finally {
            isCreatingContextMenuFreeNote = false;
        }
    }

    async function createContextMenuSelectionNote() {
        await pdfViewerRef.value?.commentSelection();
        closeAnnotationContextMenu();
    }

    function resolveContextMenuPlacedImageTarget() {
        const comment = annotationContextMenu.value.comment;
        const subtype = comment?.subtype?.trim().toLowerCase();
        if (
            !comment
            || (comment.annotationKind !== 'placed-image' && subtype !== 'stamp')
            || !comment.appAnnotationId
        ) {
            return null;
        }

        const markerRect = comment.markerRect;
        return {
            pageNumber: comment.pageNumber,
            pageX: markerRect ? markerRect.left + markerRect.width / 2 : annotationContextMenu.value.pageX,
            pageY: markerRect ? markerRect.top + markerRect.height / 2 : annotationContextMenu.value.pageY,
            identity: {appAnnotationId: comment.appAnnotationId},
        };
    }

    async function insertContextMenuImageFromFile() {
        const target = resolveContextMenuPlacedImageTarget();
        await insertImageFromFileAt(
            target?.pageNumber ?? annotationContextMenu.value.pageNumber,
            target?.pageX ?? annotationContextMenu.value.pageX,
            target?.pageY ?? annotationContextMenu.value.pageY,
            target?.identity ?? null,
        );
    }

    async function pasteContextMenuImageFromClipboard() {
        const target = resolveContextMenuPlacedImageTarget();
        await pasteImageFromClipboardAt(
            target?.pageNumber ?? annotationContextMenu.value.pageNumber,
            target?.pageX ?? annotationContextMenu.value.pageX,
            target?.pageY ?? annotationContextMenu.value.pageY,
            target?.identity ?? null,
        );
    }

    // The markup is made with the tool asked for, not the one the viewer was last told.
    async function createContextMenuMarkup(tool: TAnnotationTool) {
        if (pdfViewerRef.value && await handleAnnotationToolChange(tool) === false) return;
        await pdfViewerRef.value?.highlightSelection(tool);
        closeAnnotationContextMenu();
    }

    function handleCopyAnnotationComment(comment: IAnnotationCommentSummary) {
        return copyAnnotationText(comment.text?.trim() ?? '');
    }

    const { handleDeleteAnnotationComment } = createPageAnnotationDeleteActions({
        pdfViewerRef,
        closeAnnotationContextMenu,
        getDeleteErrorMessage: () => t('errors.annotation.delete'),
        invalidateAnnotationPage,
        clearDeletedAnnotationSelection,
        setAnnotationNoteWindowError,
    });

    function handleDeleteAnnotationById(annotationId: string) {
        const requested = deleteAnnotationById(
            deps.getAnnotationCommentsSnapshot?.() ?? [],
            annotationId,
            handleDeleteAnnotationComment,
            () => deps.discardAnnotationNote?.(annotationId),
        );
        if (!requested) {
            setAnnotationNoteWindowError(annotationId, t('errors.annotation.delete'));
        }
    }

    function handleAnnotationModified(payload?: IAnnotationModifiedPayload) {
        deps.handleAnnotationModified?.(payload);
        invalidateThumbnailPages?.([deps.currentPage.value]);
    }

    return {
        handleDeleteAnnotationById,
        handleAnnotationModified,
        insertImageFromFile: () => insertImageFromFileAt(deps.currentPage.value, 0.5, 0.5),
        pasteImageFromClipboard: () => pasteImageFromClipboardAt(deps.currentPage.value, 0.5, 0.5),
        handleCommentSelection,
        handleQuickNoteAction,
        handleAnnotationFocusComment,
        handleAnnotationCommentClick,
        handleOpenAnnotationNote,
        handleContextTextMarkupColorUpdate,
        updateTextMarkupColorWithHistory,
        handleShapeContextMenu,
        handleViewerAnnotationContextMenu,
        openContextMenuNote,
        copyContextMenuNoteText,
        copyContextMenuSelectionText,
        deleteContextMenuComment,
        createContextMenuFreeNote,
        createContextMenuSelectionNote,
        insertContextMenuImageFromFile,
        pasteContextMenuImageFromClipboard,
        createContextMenuMarkup,
        handleCopyAnnotationComment,
        handleDeleteAnnotationComment,
        insertImageFromFileAt,
        pasteImageFromClipboardAt,
    };
};
