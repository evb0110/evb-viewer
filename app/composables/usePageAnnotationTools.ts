import {
    ref,
    computed,
    type Ref,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotation-defaults';

interface IPdfViewerForAnnotationTools {
    cancelCommentPlacement: () => void;
    selectedShapeId: { value: string | null };
    updateShape: (id: string, updates: Record<string, unknown>) => void;
}

export interface IPageAnnotationToolsDeps {
    pdfViewerRef: Ref<IPdfViewerForAnnotationTools | null>;
    dragMode: Ref<boolean>;
    markDirty: () => void;
    closeAnnotationContextMenu: () => void;
}

export const usePageAnnotationTools = (deps: IPageAnnotationToolsDeps) => {
    const {
        pdfViewerRef,
        dragMode,
        markDirty,
        closeAnnotationContextMenu,
    } = deps;

    const annotationTool = ref<TAnnotationTool>('none');
    const annotationKeepActive = ref(true);
    const annotationPlacingPageNote = ref(false);
    const annotationSettings = ref<IAnnotationSettings>({ ...DEFAULT_ANNOTATION_SETTINGS });
    const annotationComments = ref<IAnnotationCommentSummary[]>([]);
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

    function handleAnnotationToolChange(tool: TAnnotationTool) {
        annotationTool.value = tool;
        dragMode.value = false;
        pdfViewerRef.value?.cancelCommentPlacement();
        annotationPlacingPageNote.value = false;
        closeAnnotationContextMenu();
    }

    function handleAnnotationToolAutoReset() {
        if (annotationKeepActive.value) {
            return;
        }
        annotationTool.value = 'none';
        annotationPlacingPageNote.value = false;
        closeAnnotationContextMenu();
    }

    function handleAnnotationToolCancel() {
        annotationTool.value = 'none';
        annotationPlacingPageNote.value = false;
        closeAnnotationContextMenu();
    }

    function handleAnnotationSettingChange(payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings]
    }) {
        annotationSettings.value = {
            ...annotationSettings.value,
            [payload.key]: payload.value,
        };

        const selectedShapeId = pdfViewerRef.value?.selectedShapeId?.value;
        if (!selectedShapeId) {
            return;
        }

        if (payload.key === 'shapeColor') {
            pdfViewerRef.value?.updateShape(selectedShapeId, { color: String(payload.value) });
            return;
        }

        if (payload.key === 'shapeStrokeWidth') {
            pdfViewerRef.value?.updateShape(selectedShapeId, { strokeWidth: Number(payload.value) });
            return;
        }

        if (payload.key === 'shapeOpacity') {
            pdfViewerRef.value?.updateShape(selectedShapeId, { opacity: Number(payload.value) });
            return;
        }

        if (payload.key === 'shapeFillColor') {
            const fill = String(payload.value);
            pdfViewerRef.value?.updateShape(selectedShapeId, { fillColor: fill === 'transparent' ? undefined : fill });
        }
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
    }

    function handleAnnotationModified() {
        markAnnotationDirty();
    }

    function markAnnotationDirty() {
        annotationRevision.value += 1;
        markDirty();
    }

    function markAnnotationSaved() {
        annotationSavedRevision.value = annotationRevision.value;
    }

    function resetAnnotationTracking() {
        annotationRevision.value = 0;
        annotationSavedRevision.value = 0;
    }

    return {
        annotationTool,
        annotationKeepActive,
        annotationPlacingPageNote,
        annotationSettings,
        annotationComments,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationRevision,
        annotationSavedRevision,
        annotationDirty,
        handleAnnotationToolChange,
        handleAnnotationToolAutoReset,
        handleAnnotationToolCancel,
        handleAnnotationSettingChange,
        handleAnnotationState,
        handleAnnotationModified,
        markAnnotationDirty,
        markAnnotationSaved,
        resetAnnotationTracking,
    };
};
