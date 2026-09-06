import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { Ref } from 'vue';
import {
    syncRef,
    useStorage,
} from '@vueuse/core';
import { STORAGE_KEYS } from '@app/constants/storageKeys';
import {annotationIdForSummary} from '@app/modules/pdf-viewer/public';
import { useAnnotationContextMenu } from '@app/modules/workspace-shell/composables/useAnnotationContextMenu';
import { useAnnotationNoteWindows } from '@app/modules/workspace-shell/composables/useAnnotationNoteWindows';
import { usePageAnnotationTools } from '@app/modules/workspace-shell/composables/usePageAnnotationTools';
import type { IWorkspacePdfViewerAnnotationSessionPort } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import { hasAnnotationChanges as detectAnnotationChanges } from '@app/modules/workspace-shell/annotations/hasAnnotationChanges';
import type { AnnotationId } from '@app/modules/pdf-viewer/public';

interface IWorkspaceAnnotationSessionOptions {
    pdfViewerRef: Ref<IWorkspacePdfViewerAnnotationSessionPort | null>;
    pdfDocument: Ref<IPdfDocument | null>;
    dragMode: Ref<boolean>;
}

export const useWorkspaceAnnotationSession = (options: IWorkspaceAnnotationSessionOptions) => {
    const {
        pdfViewerRef,
        pdfDocument,
        dragMode,
    } = options;

    const {
        annotationContextMenu,
        annotationContextMenuStyle,
        annotationContextMenuCanCopy,
        annotationContextMenuCanCopySelection,
        annotationContextMenuCanCreateFree,
        annotationContextMenuCanInsertImage,
        annotationContextMenuIsImage,
        contextMenuAnnotationLabel,
        contextMenuDeleteActionLabel,
        closeAnnotationContextMenu,
        showAnnotationContextMenu,
    } = useAnnotationContextMenu();

    function clearAnnotationChanges() {}

    function hasAnnotationChanges() {
        return detectAnnotationChanges({
            pdfViewerRef,
            pdfDocument,
        });
    }


    const {
        annotationTool,
        annotationKeepActive,
        annotationSettings,
        annotationComments,
        annotationCommentsStatus,
        annotationInventory,
        annotationEnrichmentState,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationDirty,
        handleAnnotationToolChange,
        handleAnnotationToolAutoReset,
        handleAnnotationToolCancel,
        handleAnnotationSettingChange,
        handleAnnotationState,
        handleAnnotationModified,
        markAnnotationDirty,
        markAnnotationSaved: markAnnotationRevisionSaved,
        getAnnotationRevision,
        resetAnnotationTracking: resetAnnotationRevisionTracking,
        markAnnotationCommentsLoading,
        applyAnnotationComments,
        applyAnnotationInventory,
        applyAnnotationEnrichmentState,
        clearAnnotationComments,
    } = usePageAnnotationTools({
        pdfViewerRef,
        dragMode,
        clearAnnotationChanges,
        closeAnnotationContextMenu,
        hasAnnotationChanges,
    });

    function markAnnotationSaved() {
        markAnnotationRevisionSaved();
    }

    function getAnnotationSaveStateToken() {
        return JSON.stringify({revision: getAnnotationRevision()});
    }

    function resetAnnotationTracking() {
        resetAnnotationRevisionTracking();
    }


    const annotationKeepActiveStorage = useStorage<string>(
        STORAGE_KEYS.ANNOTATION_KEEP_ACTIVE,
        '1',
        undefined,
        { initOnMounted: true },
    );
    syncRef(annotationKeepActive, annotationKeepActiveStorage, {transform: {
        ltr: value => (value ? '1' : '0'),
        rtl: stored => stored === '1',
    }});

    function resolveNoteComment(annotationId: AnnotationId) {
        return annotationComments.value.find((comment) => {
            if (comment.appAnnotationId) {
                return comment.appAnnotationId === annotationId;
            }
            return annotationIdForSummary(comment) === annotationId;
        }) ?? null;
    }

    const {
        annotationNoteWindows,
        annotationNotePositions,
        sortedAnnotationNoteWindows,
        isAnyAnnotationNoteSaving,
        updateAnnotationNoteText,
        updateAnnotationNotePosition,
        minimizeAnnotationNote,
        restoreAnnotationNote,
        persistAllAnnotationNotes,
        closeAnnotationNote,
        closeAllAnnotationNotes,
        handleOpenAnnotationNote: openAnnotationNoteWindow,
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        bringAnnotationNoteToFront,
        isSameAnnotationComment,
    } = useAnnotationNoteWindows({
        annotationComments,
        markAnnotationDirty,
        updateAnnotationCommentInViewer: (annotationId, text) => {
            const comment = resolveNoteComment(annotationId);
            return comment
                ? pdfViewerRef.value?.updateAnnotationComment(comment, text) ?? false
                : false;
        },
        isAnnotationCommentSyncReady: () => Boolean(pdfDocument.value),
    });

    const hasOpenAnnotationNotes = ref(false);
    watch(() => annotationNoteWindows.value.length, (count) => {
        hasOpenAnnotationNotes.value = count > 0;
    }, { immediate: true });

    const hasPendingTabChanges = computed(() => (
        annotationDirty.value
        || hasAnnotationChanges()
    ));
    const selectedTextBox = computed(() => (
        pdfViewerRef.value?.selectedTextBox
        ?? null
    ));

    return {
        annotationContextMenu,
        annotationContextMenuStyle,
        annotationContextMenuCanCopy,
        annotationContextMenuCanCopySelection,
        annotationContextMenuCanCreateFree,
        annotationContextMenuCanInsertImage,
        annotationContextMenuIsImage,
        contextMenuAnnotationLabel,
        contextMenuDeleteActionLabel,
        closeAnnotationContextMenu,
        showAnnotationContextMenu,
        clearAnnotationChanges,
        hasAnnotationChanges,
        hasPendingAnnotationChanges: hasPendingTabChanges,
        selectedTextBox,
        annotationTool,
        annotationKeepActive,
        annotationSettings,
        annotationComments,
        annotationCommentsStatus,
        annotationInventory,
        annotationEnrichmentState,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationDirty,
        handleAnnotationToolChange,
        handleAnnotationToolAutoReset,
        handleAnnotationToolCancel,
        handleAnnotationSettingChange,
        handleAnnotationState,
        handleAnnotationModified,
        markAnnotationDirty,
        markAnnotationSaved,
        getAnnotationSaveStateToken,
        resetAnnotationTracking,
        markAnnotationCommentsLoading,
        applyAnnotationComments,
        applyAnnotationInventory,
        applyAnnotationEnrichmentState,
        clearAnnotationComments,
        annotationNoteWindows,
        annotationNotePositions,
        sortedAnnotationNoteWindows,
        hasOpenAnnotationNotes,
        isAnyAnnotationNoteSaving,
        updateAnnotationNoteText,
        updateAnnotationNotePosition,
        minimizeAnnotationNote,
        restoreAnnotationNote,
        persistAllAnnotationNotes,
        closeAnnotationNote,
        closeAllAnnotationNotes,
        openAnnotationNoteWindow,
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        bringAnnotationNoteToFront,
        isSameAnnotationComment,
    };
};
