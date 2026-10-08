import type { Ref } from 'vue';
import type {TWorkspaceFailureSurface} from '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface';
import {
    syncRef,
    useStorage,
} from '@vueuse/core';
import { STORAGE_KEYS } from '@app/constants/storageKeys';
import { getLocalStorageForVueUse } from '@app/utils/localStorage';
import {
    annotationIdForSummary,
    type AnnotationId,
    type IPdfDocument,
} from '@app/modules/pdf-viewer/public';
import { useAnnotationNoteWindows } from '@app/modules/workspace-shell/composables/useAnnotationNoteWindows';
import { usePageAnnotationTools } from '@app/modules/workspace-shell/composables/usePageAnnotationTools';
import type { IWorkspacePdfViewerAnnotationSessionPort } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import { hasAnnotationChanges as detectAnnotationChanges } from '@app/modules/workspace-shell/annotations/hasAnnotationChanges';
import type { TDocumentViews } from '@app/modules/workspace-shell/document-sessions/createDocumentViews';
const INVISIBLE_NOTE_PLACEHOLDER_RE = /[\u200B\uFEFF]/gu;

interface IWorkspaceAnnotationSessionOptions {
    /** The document's views: commands reach the viewer of the one in use. */
    views: Pick<TDocumentViews, 'commandView' | 'commandTabId'>;
    pdfDocument: Ref<IPdfDocument | null>;
    reportNoteFailure: TWorkspaceFailureSurface['reportNoteFailure'];
}

export const useWorkspaceAnnotationSession = (options: IWorkspaceAnnotationSessionOptions) => {
    const {
        views,
        pdfDocument,
    } = options;
    const pdfViewerRef = computed<IWorkspacePdfViewerAnnotationSessionPort | null>(() => views.commandView.value?.view.pdfViewerRef.value ?? null);

    function clearAnnotationChanges() {}

    function hasAnnotationChanges() {
        return detectAnnotationChanges({
            pdfViewerRef,
            pdfDocument,
        });
    }


    const {
        annotationKeepActive,
        annotationSettings,
        annotationComments,
        annotationCommentsStatus,
        annotationInventory,
        annotationEnrichmentState,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationDirty,
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
        clearAnnotationChanges,
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
        getLocalStorageForVueUse(),
        {initOnMounted: true},
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

    function focusAnnotationNote(annotationId: string) {
        return pdfViewerRef.value?.focusSelectedAnnotation?.(annotationId) ?? false;
    }

    const {
        annotationNoteWindows,
        annotationNotePositions,
        sortedAnnotationNoteWindows,
        isAnyAnnotationNoteSaving,
        updateAnnotationNoteText,
        captureAnnotationNoteDrafts,
        getAnnotationNoteDraftsChangeSignature,
        restoreAnnotationNoteDraft,
        updateAnnotationNotePosition,
        minimizeAnnotationNote,
        restoreAnnotationNote,
        getAnnotationNoteFailurePresentation,
        persistAllAnnotationNotes,
        closeAnnotationNote,
        discardAnnotationNote,
        closeAllAnnotationNotes,
        handleOpenAnnotationNote: openAnnotationNoteWindow,
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        bringAnnotationNoteToFront,
        isSameAnnotationComment,
    } = useAnnotationNoteWindows({
        annotationComments,
        markAnnotationDirty,
        reportNoteFailure: options.reportNoteFailure,
        updateAnnotationCommentInViewer: (annotationId, text) => {
            const comment = resolveNoteComment(annotationId);
            return comment
                ? pdfViewerRef.value?.updateAnnotationComment(comment, text) ?? false
                : false;
        },
        isAnnotationCommentSyncReady: () => Boolean(pdfDocument.value) && annotationCommentsStatus.value === 'ready',
        getDeletedCanonicalAnnotationIds: () => pdfViewerRef.value?.getDeletedCanonicalAnnotationIds?.() ?? [],
        getViewInUse: () => views.commandTabId.value,
    });

    const hasOpenAnnotationNotes = ref(false);
    watch(() => annotationNoteWindows.value.length, (count) => {
        hasOpenAnnotationNotes.value = count > 0;
    }, { immediate: true });

    // Canonical annotation storage is framework-agnostic. The sidebar
    // projection is the reactive invalidation edge; the viewer stays the
    // source of truth.
    const pendingEmbeddedAnnotationDeleteCount = computed(() => {
        void annotationComments.value;
        return pdfViewerRef.value?.getDeletedPersistedCanonicalAnnotationCount?.() ?? 0;
    });
    // Thumbnails filter deleted annotations by their durable PDF identities.
    const thumbnailHiddenAnnotationIds = computed<string[]>(() => {
        void annotationComments.value;
        return pdfViewerRef.value?.getDeletedCanonicalAnnotationIds?.() ?? [];
    });
    const hasUnsavedAnnotationChanges = computed(() => {
        void annotationComments.value;
        return annotationDirty.value
            || annotationEditorState.value.hasPendingFreeTextDraft === true
            || hasAnnotationChanges()
            || pendingEmbeddedAnnotationDeleteCount.value > 0;
    });
    const hasOpenEmptyEditorNote = computed(() => annotationNoteWindows.value.some(note => (
        note.source === 'editor'
        && note.hasNote
        && note.draftText.replace(INVISIBLE_NOTE_PLACEHOLDER_RE, '').trim().length === 0
    )));
    const appAnnotationUndoDepth = computed(() => (
        pendingEmbeddedAnnotationDeleteCount.value + (hasOpenEmptyEditorNote.value ? 1 : 0)
    ));
    const selectedAnnotations = computed(() => pdfViewerRef.value?.selectedAnnotations ?? []);
    const selectedTextBox = computed(() => (
        pdfViewerRef.value?.selectedTextBox
        ?? null
    ));

    return {
        clearAnnotationChanges,
        hasAnnotationChanges,
        hasUnsavedAnnotationChanges,
        pendingEmbeddedAnnotationDeleteCount,
        thumbnailHiddenAnnotationIds,
        appAnnotationUndoDepth,
        selectedAnnotations,
        selectedTextBox,
        annotationKeepActive,
        annotationSettings,
        annotationComments,
        annotationCommentsStatus,
        annotationInventory,
        annotationEnrichmentState,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationDirty,
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
        captureAnnotationNoteDrafts,
        getAnnotationNoteDraftsChangeSignature,
        restoreAnnotationNoteDraft,
        updateAnnotationNotePosition,
        minimizeAnnotationNote,
        restoreAnnotationNote,
        getAnnotationNoteFailurePresentation,
        persistAllAnnotationNotes,
        closeAnnotationNote,
        discardAnnotationNote,
        closeAllAnnotationNotes,
        openAnnotationNoteWindow,
        focusAnnotationNote,
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        bringAnnotationNoteToFront,
        isSameAnnotationComment,
    };
};
