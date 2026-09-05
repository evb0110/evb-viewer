import type { Ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationInventoryCompleteness,
    IAnnotationModifiedPayload,
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationCommentsStatus,
    TAnnotationTool,
    TShapeAnnotationPatch,
} from '@app/types/annotations';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import type { IAnnotationEnrichmentState } from '@app/modules/pdf-viewer/public';
import {
    isShapeTool,
    PENDING_ANNOTATION_ENRICHMENT_STATE,
} from '@app/modules/pdf-viewer/public';
import type { IWorkspacePdfViewerAnnotationToolsPort } from '@app/modules/workspace-shell/types/workspacePdfViewerPorts.types';

interface IPdfViewerForAnnotationTools extends Pick<IWorkspacePdfViewerAnnotationToolsPort,
    'selectedTextBox'
    | 'getSelectedTextBox'
    | 'updateSelectedTextBoxProperties'
> {
    clearSelectedShape: () => void;
    selectedShapeId: string | null;
    getSelectedShape: () => (IShapeAnnotation & { pdfSubtype?: string | null | undefined }) | null;
    updateShape: (id: string, updates: TShapeAnnotationPatch) => void;
}

interface IPageAnnotationToolsDeps {
    pdfViewerRef: Ref<IPdfViewerForAnnotationTools | null>;
    dragMode: Ref<boolean>;
    clearAnnotationChanges: () => void;
    closeAnnotationContextMenu: () => void;
    hasAnnotationChanges: () => boolean;
}

export const usePageAnnotationTools = (deps: IPageAnnotationToolsDeps) => {
    const {
        pdfViewerRef,
        dragMode,
        clearAnnotationChanges,
        closeAnnotationContextMenu,
        hasAnnotationChanges,
    } = deps;

    const annotationTool = ref<TAnnotationTool>('none');
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

    type TShapeSettingUpdateResolverMap = {
        [K in keyof IAnnotationSettings]?: (value: IAnnotationSettings[K]) => Partial<IShapeAnnotation>;
    };

    const inkShapeSettingUpdates: TShapeSettingUpdateResolverMap = {
        inkColor: value => ({ color: value }),
        inkThickness: value => ({ strokeWidth: value }),
        inkOpacity: value => ({ opacity: value }),
    };

    const shapeSettingUpdates: TShapeSettingUpdateResolverMap = {
        shapeColor: value => ({ color: value }),
        shapeStrokeWidth: value => ({ strokeWidth: value }),
        shapeOpacity: value => ({ opacity: value }),
        shapeFillColor: value => ({ fillColor: value === 'transparent' ? undefined : value }),
    };

    function resolveShapeSettingUpdate<K extends keyof IAnnotationSettings>(
        resolvers: TShapeSettingUpdateResolverMap,
        key: K,
        value: IAnnotationSettings[K],
    ) {
        const resolver = resolvers[key];
        return resolver?.(value) ?? null;
    }

    function getSelectedShapeSettingUpdate<K extends keyof IAnnotationSettings>(
        key: K,
        value: IAnnotationSettings[K],
        isInkShape: boolean,
    ) {
        return isInkShape
            ? resolveShapeSettingUpdate(inkShapeSettingUpdates, key, value) ?? resolveShapeSettingUpdate(shapeSettingUpdates, key, value)
            : resolveShapeSettingUpdate(shapeSettingUpdates, key, value);
    }

    function handleAnnotationToolChange(tool: TAnnotationTool) {
        annotationTool.value = tool;
        dragMode.value = false;
        if (tool !== 'select') {
            pdfViewerRef.value?.clearSelectedShape();
        }
        closeAnnotationContextMenu();
    }

    function handleAnnotationToolAutoReset() {
        if (annotationKeepActive.value) {
            return;
        }
        const previousTool = annotationTool.value;
        if (isShapeTool(previousTool)) {
            annotationTool.value = 'select';
            closeAnnotationContextMenu();
            return;
        }
        annotationTool.value = 'none';
        pdfViewerRef.value?.clearSelectedShape();
        closeAnnotationContextMenu();
    }

    function handleAnnotationToolCancel() {
        annotationTool.value = 'none';
        pdfViewerRef.value?.clearSelectedShape();
        closeAnnotationContextMenu();
    }

    function handleAnnotationSettingChange<K extends keyof IAnnotationSettings>(payload: {
        key: K;
        value: IAnnotationSettings[K]
    }) {
        annotationSettings.value = {
            ...annotationSettings.value,
            [payload.key]: payload.value,
        };

        const selectedTextBox = pdfViewerRef.value?.getSelectedTextBox?.();
        if (selectedTextBox && pdfViewerRef.value?.updateSelectedTextBoxProperties) {
            if (payload.key === 'textColor' && typeof payload.value === 'string') {
                pdfViewerRef.value.updateSelectedTextBoxProperties({color: payload.value});
                return;
            }
            if (payload.key === 'textSize' && typeof payload.value === 'number') {
                pdfViewerRef.value.updateSelectedTextBoxProperties({fontSize: payload.value});
                return;
            }
        }

        const selectedShapeId = pdfViewerRef.value?.selectedShapeId;
        if (!selectedShapeId) {
            return;
        }

        const selectedShape = pdfViewerRef.value?.getSelectedShape();
        const updates = getSelectedShapeSettingUpdate(
            payload.key,
            payload.value,
            selectedShape?.pdfSubtype === 'Ink',
        );
        if (updates) {
            pdfViewerRef.value?.updateShape(selectedShapeId, updates);
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
        annotationTool,
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
        handleAnnotationToolChange,
        handleAnnotationToolAutoReset,
        handleAnnotationToolCancel,
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
