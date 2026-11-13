import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAnnotationEditorState } from '@app/types/annotations';
import { usePageAnnotationTools } from '@app/modules/workspace-shell/composables/usePageAnnotationTools';

function createEditorState(overrides: Partial<IAnnotationEditorState> = {}): IAnnotationEditorState {
    return {
        isEditing: false,
        isEmpty: true,
        hasSomethingToUndo: false,
        hasSomethingToRedo: false,
        hasSelectedEditor: false,
        ...overrides,
    };
}

function createHarness() {
    const viewer = {
        prepareAnnotationToolChange: vi.fn(),
    };

    const deps = {
        clearAnnotationChanges: vi.fn(),
        hasAnnotationChanges: vi.fn(() => false),
    };

    return {
        viewer,
        deps,
        tools: usePageAnnotationTools(deps),
    };
}

describe('usePageAnnotationTools', () => {
    it('keeps shape defaults separate from the current selection', () => {
        const {tools} = createHarness();

        tools.handleAnnotationSettingChange({
            key: 'shapeStrokeWidth',
            value: 5,
        });
        tools.handleAnnotationSettingChange({
            key: 'shapeFillColor',
            value: 'transparent',
        });

        expect(tools.annotationSettings.value.shapeStrokeWidth).toBe(5);
        expect(tools.annotationSettings.value.shapeFillColor).toBe('transparent');
    });

    it('tracks dirty state across editor undo transitions and save/reset', () => {
        const { tools } = createHarness();

        tools.handleAnnotationState(createEditorState({ hasSomethingToUndo: true }));

        expect(tools.annotationDirty.value).toBe(true);

        tools.markAnnotationSaved();
        expect(tools.annotationDirty.value).toBe(false);

        tools.handleAnnotationState(createEditorState({ hasSomethingToUndo: false }));
        expect(tools.annotationDirty.value).toBe(false);

        tools.markAnnotationDirty();
        expect(tools.annotationDirty.value).toBe(true);

        tools.resetAnnotationTracking();
        expect(tools.annotationRevision.value).toBe(0);
        expect(tools.annotationSavedRevision.value).toBe(0);
        expect(tools.annotationDirty.value).toBe(false);
    });

    it('clears annotation storage markers when undo stack becomes empty', () => {
        const {
            deps,
            tools,
        } = createHarness();

        deps.hasAnnotationChanges.mockReturnValue(false);

        tools.handleAnnotationState(createEditorState({ hasSomethingToUndo: true }));
        expect(tools.annotationDirty.value).toBe(true);

        tools.handleAnnotationState(createEditorState({ hasSomethingToUndo: false }));

        expect(deps.clearAnnotationChanges).toHaveBeenCalledOnce();
        expect(tools.annotationDirty.value).toBe(false);
    });

    it('keeps annotation dirty when changes still exist after undo stack is empty', () => {
        const {
            deps,
            tools,
        } = createHarness();

        deps.hasAnnotationChanges.mockReturnValue(true);

        tools.handleAnnotationState(createEditorState({ hasSomethingToUndo: true }));
        tools.handleAnnotationState(createEditorState({ hasSomethingToUndo: false }));

        expect(deps.clearAnnotationChanges).toHaveBeenCalledOnce();
        expect(tools.annotationDirty.value).toBe(true);
    });

    it('keeps add-then-undo clean when a late modified signal follows the empty undo stack state', () => {
        const {
            deps,
            tools,
        } = createHarness();

        deps.hasAnnotationChanges.mockReturnValue(false);

        tools.handleAnnotationState(createEditorState({ hasSomethingToUndo: true }));
        expect(tools.annotationDirty.value).toBe(true);

        tools.handleAnnotationState(createEditorState({ hasSomethingToUndo: false }));
        tools.handleAnnotationModified();

        expect(deps.clearAnnotationChanges).toHaveBeenCalledOnce();
        expect(tools.annotationDirty.value).toBe(false);
    });

    it('marks dirty from a forced modified signal even when PDF.js reports no live changes', () => {
        const {
            deps,
            tools,
        } = createHarness();

        deps.hasAnnotationChanges.mockReturnValue(false);

        tools.handleAnnotationModified({ forceDirty: true });

        expect(tools.annotationDirty.value).toBe(true);
    });

    it('keeps a resolved empty annotations list ready during a reload', () => {
        const { tools } = createHarness();

        tools.applyAnnotationComments([]);
        tools.markAnnotationCommentsLoading();

        expect(tools.annotationCommentsStatus.value).toBe('ready');
        expect(tools.annotationComments.value).toEqual([]);
    });

    it('drops a stale incomplete inventory when the document is closed', () => {
        const { tools } = createHarness();

        tools.applyAnnotationInventory({
            complete: false,
            omissions: ['page-parse-failure'],
            scannedPageCount: 2,
            totalPageCount: 3,
            failedPageCount: 1,
        });
        expect(tools.annotationInventory.value).toMatchObject({ complete: false });

        tools.clearAnnotationComments();

        expect(tools.annotationInventory.value).toBeNull();
    });

    it('marks dirty from a modified signal when the editor stack is empty but live annotation changes remain', () => {
        const {
            deps,
            tools,
        } = createHarness();

        deps.hasAnnotationChanges.mockReturnValue(true);

        tools.handleAnnotationModified();

        expect(tools.annotationDirty.value).toBe(true);
    });
});
