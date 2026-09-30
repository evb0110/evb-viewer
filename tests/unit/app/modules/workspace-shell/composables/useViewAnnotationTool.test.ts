import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { useViewAnnotationTool } from '@app/modules/workspace-shell/composables/useViewAnnotationTool';

function createHarness() {
    const viewer = {
        clearSelectedShape: vi.fn(),
        prepareAnnotationToolChange: vi.fn(),
        selectedShapeId: null as string | null,
        getSelectedShape: vi.fn(() => null),
        updateShape: vi.fn(),
    };
    const keepActive = ref(true);
    const deps = {
        pdfViewerRef: ref(viewer),
        dragMode: ref(true),
        annotationKeepActive: keepActive,
        closeAnnotationContextMenu: vi.fn(),
    };

    return {
        viewer,
        deps,
        keepActive,
        tools: useViewAnnotationTool(deps),
    };
}

describe('useViewAnnotationTool', () => {
    it.each([
        'text',
        'draw',
        'rectangle',
        'circle',
        'line',
        'arrow',
        'highlight',
        'underline',
        'strikethrough',
        'squiggly',
        'stamp',
    ] as const)(
        'applies Keep active consistently after completed %s creation', (tool) => {
            const {
                keepActive,
                tools,
            } = createHarness();
            tools.annotationTool.value = tool;
            tools.handleAnnotationToolAutoReset();
            expect(tools.annotationTool.value).toBe(tool);
            keepActive.value = false;
            tools.handleAnnotationToolAutoReset();
            expect(tools.annotationTool.value).toBe('select');
        },
    );
    it.each([
        true,
        false,
    ])('exits note placement after creation with Keep active=%s', (setting) => {
        const {
            deps,
            keepActive,
            tools,
            viewer,
        } = createHarness();
        keepActive.value = setting;
        tools.handleAnnotationToolChange('note');
        viewer.prepareAnnotationToolChange.mockClear();
        deps.closeAnnotationContextMenu.mockClear();
        tools.handleAnnotationToolAutoReset();
        expect(tools.annotationTool.value).toBe('select');
        expect(keepActive.value).toBe(setting);
        expect(viewer.prepareAnnotationToolChange).not.toHaveBeenCalled();
        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
    });
    it('switches tools and clears context state', () => {
        const {
            deps,
            viewer,
            tools,
        } = createHarness();

        tools.handleAnnotationToolChange('highlight');
        expect(viewer.prepareAnnotationToolChange).toHaveBeenCalledOnce();

        expect(tools.annotationTool.value).toBe('highlight');
        expect(deps.dragMode.value).toBe(false);
        expect(viewer.clearSelectedShape).toHaveBeenCalledOnce();
        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
    });

    it.each([
        'highlight',
        'note',
        'stamp',
    ] as const)(
        'keeps explicit %s activation idempotent for action and agent commands', (tool) => {
            const {tools} = createHarness();
            tools.handleAnnotationToolChange(tool);
            tools.handleAnnotationToolChange(tool);
            expect(tools.annotationTool.value).toBe(tool);
        },
    );

    it('keeps shape selection when select mode is activated', () => {
        const {
            viewer,
            tools,
        } = createHarness();

        tools.handleAnnotationToolChange('select');

        expect(viewer.clearSelectedShape).not.toHaveBeenCalled();
    });

    it('ends the active interaction when annotation tool is cancelled', () => {
        const {
            viewer,
            tools,
        } = createHarness();

        tools.handleAnnotationToolCancel();

        expect(viewer.prepareAnnotationToolChange).toHaveBeenCalledOnce();
        expect(tools.annotationTool.value).toBe('select');
    });

    it('auto-resets draw tools into select mode without forcing a clearSelectedShape call', () => {
        const {
            keepActive,
            viewer,
            tools,
        } = createHarness();

        keepActive.value = false;
        tools.annotationTool.value = 'draw';

        tools.handleAnnotationToolAutoReset();

        expect(tools.annotationTool.value).toBe('select');
        expect(viewer.clearSelectedShape).not.toHaveBeenCalled();
    });
});
