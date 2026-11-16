import type {
    IAnnotationEditorState,
    IAnnotationModifiedPayload,
    IAnnotationSettings,
} from '@app/types/annotations';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';

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

    return {
        annotationKeepActive,
        annotationSettings,
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
    };
};
