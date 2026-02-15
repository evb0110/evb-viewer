import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import { useWorkspaceViewState } from '@app/composables/page/workspace-view-state';

function createState() {
    return useWorkspaceViewState({
        fitMode: ref('width'),
        zoom: ref(1),
        dragMode: ref(true),
        showSidebar: ref(false),
        sidebarTab: ref('thumbnails'),
        annotationTool: ref('none'),
        annotationPlacingPageNote: ref(false),
        annotationEditorState: ref({
            isEditing: false,
            isEmpty: true,
            hasSomethingToUndo: false,
            hasSomethingToRedo: false,
            hasSelectedEditor: false,
        }),
        canUndoFile: ref(false),
        canRedoFile: ref(false),
        pdfViewerRef: ref({
            scrollToPage: () => {},
            cancelCommentPlacement: () => {},
        }),
    });
}

describe('useWorkspaceViewState', () => {
    it('marks fit width active at zoom 1', () => {
        const state = createState();
        expect(state.isFitWidthActive.value).toBe(true);
        expect(state.isFitHeightActive.value).toBe(false);
    });

    it('resets zoom when fit mode changes via helper', () => {
        const state = createState();
        state.handleFitMode('height');

        expect(state.isFitHeightActive.value).toBe(true);
        expect(state.isFitWidthActive.value).toBe(false);
    });

    it('disables annotation cursor when drag mode is enabled', () => {
        const state = createState();
        expect(state.annotationCursorMode.value).toBe(false);
    });
});
