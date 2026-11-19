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
    type TPdfDocumentAnnotations,
} from '@app/modules/pdf-viewer/public';
import type {
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
} from '@app/types/annotations';
import { useAnnotationNoteWindows } from '@app/modules/workspace-shell/composables/useAnnotationNoteWindows';
import { usePageAnnotationTools } from '@app/modules/workspace-shell/composables/usePageAnnotationTools';
import type { IWorkspacePdfViewerAnnotationSessionPort } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import { hasAnnotationChanges as detectAnnotationChanges } from '@app/modules/workspace-shell/annotations/hasAnnotationChanges';
import type { TDocumentViews } from '@app/modules/workspace-shell/document-sessions/createDocumentViews';
const INVISIBLE_NOTE_PLACEHOLDER_RE = /[\u200B\uFEFF]/gu;

interface IWorkspaceAnnotationSessionOptions {
    /** The document's views: what a viewer answers about the shared annotation store. */
    views: Pick<TDocumentViews, 'pdfViewer'>;
    pdfDocument: Readonly<Ref<IPdfDocument | null>>;
    /** The document's annotations: its summaries, readiness and tombstones. */
    documentAnnotations: TPdfDocumentAnnotations;
    reportNoteFailure: TWorkspaceFailureSurface['reportNoteFailure'];
}

export const useWorkspaceAnnotationSession = (options: IWorkspaceAnnotationSessionOptions) => {
    const {
        views,
        pdfDocument,
        documentAnnotations,
    } = options;
    const pdfViewerRef = computed<IWorkspacePdfViewerAnnotationSessionPort | null>(() => views.pdfViewer.value);

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
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationDirty,
        handleAnnotationSettingChange,
        handleAnnotationState,
        handleAnnotationModified,
        markAnnotationSaved: markAnnotationRevisionSaved,
        getAnnotationRevision,
        resetAnnotationTracking: resetAnnotationRevisionTracking,
    } = usePageAnnotationTools({
        clearAnnotationChanges,
        hasAnnotationChanges,
    });
    const annotationComments = documentAnnotations.comments;
    const annotationCommentsStatus = documentAnnotations.commentsStatus;
    // Unknown (null) until the store has read the whole document.
    const annotationInventory = computed<IAnnotationInventoryCompleteness | null>(() => {
        void documentAnnotations.entities.value;
        const pages = pdfDocument.value?.numPages ?? 0;
        return pdfDocument.value && documentAnnotations.application.value.store.readWholeDocument ? {
            complete: true,
            omissions: [],
            scannedPageCount: pages,
            totalPageCount: pages,
            failedPageCount: 0,
        } : null;
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
        return annotationComments.value.find(comment => annotationIdForSummary(comment) === annotationId) ?? null;
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
        persistAnnotationNote,
        persistAllAnnotationNotes,
        closeAnnotationNote,
        discardAnnotationNote,
        closeAllAnnotationNotes,
        handleOpenAnnotationNote: openAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        bringAnnotationNoteToFront,
    } = useAnnotationNoteWindows({
        documentAnnotations,
        reportNoteFailure: options.reportNoteFailure,
        updateAnnotationCommentInViewer: (annotationId, text) => {
            const comment = resolveNoteComment(annotationId);
            return comment
                ? pdfViewerRef.value?.updateAnnotationComment(comment, text) ?? false
                : false;
        },
    });

    // A minimized window is still open.
    const hasOpenAnnotationNotes = computed(() => annotationNoteWindows.value.length > 0);

    // Canonical annotation storage is framework-agnostic. The document's
    // store snapshot is the reactive invalidation edge; the viewer stays the
    // source of truth.
    const pendingEmbeddedAnnotationDeleteCount = computed(() => {
        void documentAnnotations.entities.value;
        return pdfViewerRef.value?.getDeletedPersistedCanonicalAnnotationCount?.() ?? 0;
    });
    // Thumbnails filter deleted annotations by their durable PDF identities.
    const thumbnailHiddenAnnotationIds = computed<string[]>(() => {
        void documentAnnotations.entities.value;
        return pdfViewerRef.value?.getDeletedCanonicalAnnotationIds?.() ?? [];
    });
    const hasUnsavedAnnotationChanges = computed(() => {
        void documentAnnotations.entities.value;
        return annotationDirty.value
            || annotationNoteWindows.value.some(note => note.dirty)
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

    return {
        clearAnnotationChanges,
        hasAnnotationChanges,
        hasUnsavedAnnotationChanges,
        pendingEmbeddedAnnotationDeleteCount,
        thumbnailHiddenAnnotationIds,
        appAnnotationUndoDepth,
        annotationKeepActive,
        annotationSettings,
        annotationComments,
        annotationCommentsStatus,
        annotationInventory,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationDirty,
        handleAnnotationSettingChange,
        handleAnnotationState,
        handleAnnotationModified,
        markAnnotationSaved,
        getAnnotationSaveStateToken,
        resetAnnotationTracking,
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
        persistAnnotationNote,
        persistAllAnnotationNotes,
        closeAnnotationNote,
        discardAnnotationNote,
        closeAllAnnotationNotes,
        openAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        bringAnnotationNoteToFront,
        // The agent options still declare this unused field; it goes with that declaration.
        isSameAnnotationComment: (left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) => (
            annotationIdForSummary(left) === annotationIdForSummary(right)
        ),
    };
};
