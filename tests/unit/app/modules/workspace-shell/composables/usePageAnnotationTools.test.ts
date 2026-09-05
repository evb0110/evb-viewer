import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type {
    IAnnotationEditorState,
    IShapeAnnotation,
} from '@app/types/annotations';
import type { ITextBoxEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
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

function createShapeAnnotation(overrides: Partial<IShapeAnnotation> = {}): IShapeAnnotation {
    return {
        id: 'shape-1',
        type: 'rectangle',
        pageIndex: 0,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        color: '#000000',
        opacity: 1,
        strokeWidth: 1,
        ...overrides,
    };
}

function createTextBoxEntity(): ITextBoxEntity {
    return {
        kind: 'text-box',
        identity: {id: 'text-box' as ITextBoxEntity['identity']['id']},
        pageIndex: 0,
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        text: 'text box',
        rect: {
            left: 0.1,
            top: 0.1,
            width: 0.3,
            height: 0.1,
        },
        rotation: 0,
        fontSize: 14,
        color: '#000000',
    };
}

function createHarness() {
    const viewer = {
        clearSelectedShape: vi.fn(),
        selectedShapeId: null as string | null,
        getSelectedShape: vi.fn<() => IShapeAnnotation | null>(() => null),
        updateShape: vi.fn(),
        getSelectedTextBox: vi.fn<() => ITextBoxEntity | null>(() => null),
        updateSelectedTextBoxProperties: vi.fn(),
    };

    const deps = {
        pdfViewerRef: ref(viewer),
        dragMode: ref(true),
        clearAnnotationChanges: vi.fn(),
        closeAnnotationContextMenu: vi.fn(),
        hasAnnotationChanges: vi.fn(() => false),
    };

    return {
        viewer,
        deps,
        tools: usePageAnnotationTools(deps),
    };
}

describe('usePageAnnotationTools', () => {
    it('switches tools and clears context state', () => {
        const {
            deps,
            viewer,
            tools,
        } = createHarness();

        tools.handleAnnotationToolChange('highlight');

        expect(tools.annotationTool.value).toBe('highlight');
        expect(deps.dragMode.value).toBe(false);
        expect(viewer.clearSelectedShape).toHaveBeenCalledOnce();
        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
    });

    it('keeps shape selection when select mode is activated', () => {
        const {
            viewer,
            tools,
        } = createHarness();

        tools.handleAnnotationToolChange('select');

        expect(viewer.clearSelectedShape).not.toHaveBeenCalled();
    });

    it('clears shape selection when annotation tool is cancelled', () => {
        const {
            viewer,
            tools,
        } = createHarness();

        tools.handleAnnotationToolCancel();

        expect(viewer.clearSelectedShape).toHaveBeenCalledOnce();
    });

    it('auto-resets draw tools into select mode without forcing a clearSelectedShape call', () => {
        const {
            viewer,
            tools,
        } = createHarness();

        tools.annotationKeepActive.value = false;
        tools.annotationTool.value = 'draw';

        tools.handleAnnotationToolAutoReset();

        expect(tools.annotationTool.value).toBe('select');
        expect(viewer.clearSelectedShape).not.toHaveBeenCalled();
    });

    it('propagates shape setting updates to selected shape', () => {
        const {
            viewer,
            tools,
        } = createHarness();

        viewer.selectedShapeId = 'shape-1';

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
        expect(viewer.updateShape).toHaveBeenNthCalledWith(1, 'shape-1', { strokeWidth: 5 });
        expect(viewer.updateShape).toHaveBeenNthCalledWith(2, 'shape-1', { fillColor: undefined });
    });

    it('updates selected shape when viewer exposes unwrapped selectedShapeId value', () => {
        const {
            viewer,
            tools,
        } = createHarness();

        viewer.selectedShapeId = 'shape-public-instance';

        tools.handleAnnotationSettingChange({
            key: 'shapeColor',
            value: '#10b981',
        });

        expect(viewer.updateShape).toHaveBeenCalledWith('shape-public-instance', { color: '#10b981' });
    });

    it('propagates draw style updates to selected ink shapes', () => {
        const {
            viewer,
            tools,
        } = createHarness();

        viewer.selectedShapeId = 'ink-shape-1';
        viewer.getSelectedShape.mockReturnValue(createShapeAnnotation({ pdfSubtype: 'Ink' }));

        tools.handleAnnotationSettingChange({
            key: 'inkThickness',
            value: 6,
        });
        tools.handleAnnotationSettingChange({
            key: 'inkOpacity',
            value: 0.4,
        });

        expect(viewer.updateShape).toHaveBeenNthCalledWith(1, 'ink-shape-1', { strokeWidth: 6 });
        expect(viewer.updateShape).toHaveBeenNthCalledWith(2, 'ink-shape-1', { opacity: 0.4 });
    });

    it('routes text size and color changes to the selected canonical text box', () => {
        const {
            viewer,
            tools,
        } = createHarness();

        viewer.getSelectedTextBox.mockReturnValue(createTextBoxEntity());

        tools.handleAnnotationSettingChange({
            key: 'textSize',
            value: 22,
        });
        tools.handleAnnotationSettingChange({
            key: 'textColor',
            value: '#ef4444',
        });

        expect(viewer.updateSelectedTextBoxProperties).toHaveBeenNthCalledWith(1, {fontSize: 22});
        expect(viewer.updateSelectedTextBoxProperties).toHaveBeenNthCalledWith(2, {color: '#ef4444'});
        expect(viewer.updateShape).not.toHaveBeenCalled();
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

    it('holds the viewer enrichment verdict and forgets it when the document is swapped', () => {
        const { tools } = createHarness();

        expect(tools.annotationEnrichmentState.value.status).toBe('pending');

        tools.applyAnnotationEnrichmentState({
            status: 'skipped',
            reason: 'over-byte-limit',
            canRetry: false,
        });

        expect(tools.annotationEnrichmentState.value).toEqual({
            status: 'skipped',
            reason: 'over-byte-limit',
            canRetry: false,
        });

        // The next document has not been read yet. Carrying the previous
        // verdict over would tell the user a fresh file was skipped.
        tools.clearAnnotationComments();

        expect(tools.annotationEnrichmentState.value).toEqual({
            status: 'pending',
            reason: null,
            canRetry: false,
        });
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
