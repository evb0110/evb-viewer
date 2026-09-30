import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationInventoryCompleteness,
    IAnnotationModifiedPayload,
    IAnnotationSettings,
    TAnnotationCommentsStatus,
} from '@app/types/annotations';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import type { IAnnotationEnrichmentState } from '@app/modules/pdf-viewer/public';
import {PENDING_ANNOTATION_ENRICHMENT_STATE} from '@app/modules/pdf-viewer/public';


interface IPageAnnotationToolsDeps {
    clearAnnotationChanges: () => void;
    hasAnnotationChanges: () => boolean;
}

export const usePageAnnotationTools = (deps: IPageAnnotationToolsDeps) => {
    const {
        clearAnnotationChanges,
        hasAnnotationChanges,
    } = deps;

    const annotationKeepActive = ref(true);
    const annotationSettings = ref<IAnnotationSettings>({ ...DEFAULT_ANNOTATION_SETTINGS });
    const annotationComments = ref<IAnnotationCommentSummary[]>([]);
    const annotationCommentsStatus = ref<TAnnotationCommentsStatus>('loading');
    // Null means "no inventory has reported yet"; a complete inventory reports
    // a completeness record with `complete: true`.
    const annotationInventory = ref<IAnnotationInventoryCompleteness | null>(null);
    const annotationEnrichmentState = ref<IAnnotationEnrichmentState>(PENDING_ANNOTATION_ENRICHMENT_STATE);
    const annotationActiveCommentStableKey = ref<string | null>(null);
    const annotationEditorState = ref<IAnnotationEditorState>({
        isEditing: false,
        isEmpty: true,
        hasSomethingToUndo: false,
        hasSomethingToRedo: false,
        hasSelectedEditor: false,
    });

    const annotationRevision = ref(0);
    const annotationSavedRevision = ref(0);
    const annotationDirty = computed(() => annotationRevision.value !== annotationSavedRevision.value);

    function handleAnnotationSettingChange<K extends keyof IAnnotationSettings>(payload: {
        key: K;
        value: IAnnotationSettings[K]
    }) {
        annotationSettings.value = {
            ...annotationSettings.value,
            [payload.key]: payload.value,
        };
    }

    function handleAnnotationState(state: IAnnotationEditorState) {
        const hadUndo = annotationEditorState.value.hasSomethingToUndo;
        annotationEditorState.value = {
            ...annotationEditorState.value,
            ...state,
        };
        if (!hadUndo && annotationEditorState.value.hasSomethingToUndo) {
            markAnnotationDirty();
        }
        if (hadUndo && !annotationEditorState.value.hasSomethingToUndo) {
            clearAnnotationChanges();
            if (!hasAnnotationChanges()) {
                syncAnnotationClean();
            }
        }
    }

    function handleAnnotationModified(payload: IAnnotationModifiedPayload = {}) {
        if (payload.forceDirty) {
            markAnnotationDirty();
            return;
        }
        if (
            !annotationEditorState.value.hasSomethingToUndo
            && !hasAnnotationChanges()
        ) {
            syncAnnotationClean();
            return;
        }
        if (!hasAnnotationChanges()) {
            syncAnnotationClean();
            return;
        }
        markAnnotationDirty();
    }

    function markAnnotationDirty() {
        annotationRevision.value += 1;
    }

    function syncAnnotationClean() {
        annotationRevision.value = annotationSavedRevision.value;
    }

    function markAnnotationSaved() {
        annotationSavedRevision.value = annotationRevision.value;
    }

    function getAnnotationRevision() {
        return annotationRevision.value;
    }

    function resetAnnotationTracking() {
        annotationRevision.value = 0;
        annotationSavedRevision.value = 0;
    }

    function markAnnotationCommentsLoading() {
        if (annotationCommentsStatus.value === 'ready' && annotationComments.value.length === 0) {
            return;
        }
        annotationCommentsStatus.value = 'loading';
    }

    function applyAnnotationComments(comments: IAnnotationCommentSummary[]) {
        annotationComments.value = comments;
        annotationCommentsStatus.value = 'ready';
    }

    function clearAnnotationComments() {
        annotationComments.value = [];
        annotationCommentsStatus.value = 'loading';
        annotationInventory.value = null;
        annotationEnrichmentState.value = PENDING_ANNOTATION_ENRICHMENT_STATE;
    }

    function applyAnnotationInventory(completeness: IAnnotationInventoryCompleteness | null) {
        annotationInventory.value = completeness;
    }

    function applyAnnotationEnrichmentState(state: IAnnotationEnrichmentState) {
        annotationEnrichmentState.value = state;
    }

    return {
        annotationKeepActive,
        annotationSettings,
        annotationComments,
        annotationCommentsStatus,
        annotationInventory,
        annotationEnrichmentState,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationRevision,
        annotationSavedRevision,
        annotationDirty,
        handleAnnotationSettingChange,
        handleAnnotationState,
        handleAnnotationModified,
        markAnnotationDirty,
        markAnnotationSaved,
        getAnnotationRevision,
        resetAnnotationTracking,
        markAnnotationCommentsLoading,
        applyAnnotationComments,
        applyAnnotationInventory,
        applyAnnotationEnrichmentState,
        clearAnnotationComments,
    };
};
