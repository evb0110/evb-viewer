import {
    computed,
    type Ref,
} from 'vue';
import type { TFitMode } from '@app/types/shared';
import type {
    IAnnotationEditorState,
    TAnnotationTool,
} from '@app/types/annotations';

type TPdfSidebarTab = 'annotations' | 'thumbnails' | 'bookmarks' | 'search';

interface IWorkspaceViewStateDeps {
    fitMode: Ref<TFitMode>;
    zoom: Ref<number>;
    dragMode: Ref<boolean>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TPdfSidebarTab>;
    annotationTool: Ref<TAnnotationTool>;
    annotationPlacingPageNote: Ref<boolean>;
    annotationEditorState: Ref<IAnnotationEditorState>;
    canUndoFile: Ref<boolean>;
    canRedoFile: Ref<boolean>;
    pdfViewerRef: Ref<{
        scrollToPage: (page: number) => void;
        cancelCommentPlacement: () => void;
    } | null>;
}

export function useWorkspaceViewState(deps: IWorkspaceViewStateDeps) {
    const isFitWidthActive = computed(
        () => deps.fitMode.value === 'width' && Math.abs(deps.zoom.value - 1) < 0.01,
    );
    const isFitHeightActive = computed(
        () => deps.fitMode.value === 'height' && Math.abs(deps.zoom.value - 1) < 0.01,
    );
    const isAnnotationUndoContext = computed(
        () => deps.annotationTool.value !== 'none'
            || deps.annotationEditorState.value.hasSomethingToUndo
            || deps.annotationEditorState.value.hasSomethingToRedo,
    );
    const isAnnotationPanelOpen = computed(
        () => deps.showSidebar.value && deps.sidebarTab.value === 'annotations',
    );
    const annotationCursorMode = computed(() => {
        if (deps.dragMode.value) {
            return false;
        }

        return isAnnotationPanelOpen.value
            || deps.annotationTool.value !== 'none'
            || deps.annotationEditorState.value.hasSelectedEditor;
    });
    const canUndo = computed(() => (
        isAnnotationUndoContext.value
            ? deps.annotationEditorState.value.hasSomethingToUndo
            : deps.canUndoFile.value
    ));
    const canRedo = computed(() => (
        isAnnotationUndoContext.value
            ? deps.annotationEditorState.value.hasSomethingToRedo
            : deps.canRedoFile.value
    ));

    function handleFitMode(mode: TFitMode) {
        deps.zoom.value = 1;
        deps.fitMode.value = mode;
    }

    function enableDragMode() {
        deps.dragMode.value = true;
        deps.pdfViewerRef.value?.cancelCommentPlacement();
        deps.annotationPlacingPageNote.value = false;
        if (deps.annotationTool.value !== 'none') {
            deps.annotationTool.value = 'none';
        }
    }

    function handleGoToPage(page: number) {
        deps.pdfViewerRef.value?.scrollToPage(page);
    }

    return {
        isFitWidthActive,
        isFitHeightActive,
        isAnnotationUndoContext,
        annotationCursorMode,
        canUndo,
        canRedo,
        handleFitMode,
        enableDragMode,
        handleGoToPage,
    };
}
