import type { Ref } from 'vue';
import { requirePageNumber } from '@contracts/pageNumbers';
import type { TDocumentRef } from '@contracts/documentRef';
import * as VueUse from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browserLogger';
import type * as WorkspaceOrchestration from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import type { TPageAnnotationActionsPdfViewer } from '@app/modules/workspace-shell/composables/pageAnnotationActionsPdfViewer';
import type {
    IAnnotationCommentSummary,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import {annotationIdForSummary} from '@app/modules/pdf-viewer/public';
import { getAnnotationPageNumber } from '@app/modules/workspace-shell/annotations/getAnnotationPageNumber';
import { withOpenedAnnotationNoteCreationTimestamp } from '@app/modules/workspace-shell/annotations/withOpenedAnnotationNoteCreationTimestamp';
import { pickPageAnnotationImageFile } from '@app/modules/workspace-shell/annotations/pickPageAnnotationImageFile';
import { readPageAnnotationImageFileFromClipboard } from '@app/modules/workspace-shell/annotations/readPageAnnotationImageFileFromClipboard';
import { createPageAnnotationDeleteActions } from '@app/modules/workspace-shell/composables/createPageAnnotationDeleteActions';

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
    handleAnnotationToolChange: (tool: TAnnotationTool) => void;
    openAnnotationNoteWindow: (comment: IAnnotationCommentSummary) => void;
    removeAnnotationNoteWindow: (annotationId: string) => void;
    setAnnotationNoteWindowError: (annotationId: string, error: string | null) => void;
    isSameAnnotationComment: (a: IAnnotationCommentSummary, b: IAnnotationCommentSummary) => boolean;
    annotationNoteWindows: Ref<Array<{
        annotationId: string;
        draftText: string;
        createdAtMs?: number | undefined;
    }>>;
    invalidateThumbnailPages?: (pages: number[]) => void;
    getAnnotationCommentsSnapshot?: () => IAnnotationCommentSummary[];
    getAnnotationCommentsStatusSnapshot?: () => TAnnotationCommentsStatus;

}

export const usePageAnnotationActions = (deps: IPageAnnotationActionsDeps) => {
    const { t } = useTypedI18n();
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
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        annotationNoteWindows,
        invalidateThumbnailPages,
        isSameAnnotationComment,
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

    async function handleQuickNoteAction() {
        const viewer = pdfViewerRef.value;
        if (!viewer) {
            return;
        }

        const previousSidebarVisibility = showSidebar.value;
        const previousSidebarTab = sidebarTab.value;
        try {
            dragMode.value = false;
            handleAnnotationToolChange(deps.annotationTool.value === 'note' ? 'select' : 'note');
        } finally {
            await nextTick();
            showSidebar.value = previousSidebarVisibility;
            sidebarTab.value = previousSidebarTab;
        }
    }

    async function handleAnnotationFocusComment(comment: IAnnotationCommentSummary) {
        if (!pdfViewerRef.value) {
            return;
        }
        handleAnnotationToolChange('select');
        annotationActiveCommentStableKey.value = annotationIdForSummary(comment);
        showSidebar.value = true;
        sidebarTab.value = 'annotations';
        dragMode.value = false;
        await pdfViewerRef.value.focusAnnotationComment(comment);
    }

    function handleAnnotationCommentClick(comment: IAnnotationCommentSummary) {
        annotationActiveCommentStableKey.value = annotationIdForSummary(comment);
        dragMode.value = false;
    }

    function invalidateAnnotationPage(comment: IAnnotationCommentSummary) {
        const page = getAnnotationPageNumber(comment);
        pdfViewerRef.value?.invalidatePages([page]);
        invalidateThumbnailPages?.([page]);
    }

    function toAnnotationNoteWindowComment(note: {
        annotationId: string;
        draftText: string;
    }): IAnnotationCommentSummary | null {
        const comment = getAnnotationCommentsSnapshot()?.find(candidate => (
            annotationIdForSummary(candidate) === note.annotationId
        ));
        if (!comment) {
            return null;
        }
        return {
            ...comment,
            text: note.draftText,
            hasNote: true,
        };
    }

    function getAnnotationCommentsSnapshot() {
        return deps.getAnnotationCommentsSnapshot?.() ?? null;
    }

    function isAnnotationCommentsSnapshotReady() {
        return deps.getAnnotationCommentsStatusSnapshot?.() === 'ready';
    }

    function shouldCloseRemainingNoteWindowsAfterExplicitDelete(
        commentsBeforeDelete: IAnnotationCommentSummary[] | null,
    ) {
        const commentsAfterDelete = getAnnotationCommentsSnapshot();
        if (
            !commentsAfterDelete
            || commentsAfterDelete.length > 0
            || annotationNoteWindows.value.length === 0
        ) {
            return false;
        }

        if (commentsBeforeDelete && commentsBeforeDelete.length > 0) {
            return true;
        }

        return isAnnotationCommentsSnapshotReady();
    }

    function closeRemainingAnnotationNoteWindows(stableKeys: Set<string>) {
        annotationNoteWindows.value.forEach((note) => {
            const comment = toAnnotationNoteWindowComment(note);
            if (!comment || stableKeys.has(comment.stableKey)) {
                return;
            }
            stableKeys.add(comment.stableKey);
            removeAnnotationNoteWindow(note.annotationId ?? annotationIdForSummary(comment));
        });
    }

    function removeDeletedAnnotationState(
        comment: IAnnotationCommentSummary,
        commentsBeforeDelete: IAnnotationCommentSummary[] | null = null,
    ) {
        const stableKeys = new Set<string>([comment.stableKey]);
        annotationNoteWindows.value
            .filter((note) => {
                const noteComment = toAnnotationNoteWindowComment(note);
                return Boolean(noteComment && isSameAnnotationComment(noteComment, comment)) || (
                    note.annotationId
                    ?? (noteComment ? annotationIdForSummary(noteComment) : null)
                ) === annotationIdForSummary(comment);
            })
            .forEach((note) => {
                const noteComment = toAnnotationNoteWindowComment(note);
                if (noteComment) stableKeys.add(noteComment.stableKey);
                removeAnnotationNoteWindow(note.annotationId ?? annotationIdForSummary(noteComment ?? comment));
            });

        if (shouldCloseRemainingNoteWindowsAfterExplicitDelete(commentsBeforeDelete)) {
            closeRemainingAnnotationNoteWindows(stableKeys);
        }

        if (
            annotationActiveCommentStableKey.value === annotationIdForSummary(comment)
        ) {
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
        updateTextMarkupColorWithHistory(comment, color);
        closeAnnotationContextMenu();
    }

    function handleShapeContextMenu(payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }) {
        closeAnnotationContextMenu();
        handleAnnotationToolChange('select');
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

    async function copyContextMenuSelectionText() {
        const text = annotationContextMenu.value.selectionText.trim();
        closeAnnotationContextMenu();
        if (!text) {
            return;
        }
        try {
            await copyClipboardText(text);
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
            BrowserLogger.diagnostic('note-placement', 'Failed to create note from annotation context menu', error);
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

    async function createContextMenuMarkup(tool: TAnnotationTool) {
        if (!pdfViewerRef.value) {
            closeAnnotationContextMenu();
            return;
        }
        handleAnnotationToolChange(tool);
        await nextTick();
        await pdfViewerRef.value.highlightSelection();
        closeAnnotationContextMenu();
    }

    async function handleCopyAnnotationComment(comment: IAnnotationCommentSummary) {
        closeAnnotationContextMenu();
        const text = comment.text?.trim();
        if (!text) {
            return;
        }
        try {
            await copyClipboardText(text);
        } catch (error) {
            BrowserLogger.debug('annotations', 'Failed to copy annotation comment text to clipboard', error);
        }
    }

    const { handleDeleteAnnotationComment } = createPageAnnotationDeleteActions({
        pdfViewerRef,
        closeAnnotationContextMenu,
        getAnnotationCommentsSnapshot,
        getDeleteErrorMessage: () => t('errors.annotation.delete'),
        invalidateAnnotationPage,
        removeDeletedAnnotationState,
        setAnnotationNoteWindowError,
    });

    return {
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
