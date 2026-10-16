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
        clearSelectedShape: () => {viewer.selectedShapeId = null;},
        prepareAnnotationToolChange: vi.fn<() => void | Promise<void>>(),
        selectedShapeId: 'selected-shape' as string | null,
        getSelectedShape: vi.fn(() => null),
        updateShape: vi.fn(),
    };
    const keepActive = ref(true);
    const menuOpen = ref(true);
    const deps = {
        pdfViewerRef: ref(viewer),
        dragMode: ref(true),
        annotationKeepActive: keepActive,
        closeAnnotationContextMenu: () => {menuOpen.value = false;},
    };

    return {
        viewer,
        deps,
        keepActive,
        menuOpen,
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
            keepActive,
            tools,
        } = createHarness();
        keepActive.value = setting;
        tools.handleAnnotationToolChange('note');
        tools.handleAnnotationToolAutoReset();
        expect(tools.annotationTool.value).toBe('select');
        expect(keepActive.value).toBe(setting);
    });
    it('switches tools and clears context state', () => {
        const {
            deps,
            viewer,
            tools,
        } = createHarness();

        expect(tools.handleAnnotationToolChange('highlight')).toBe(true);

        expect(tools.annotationTool.value).toBe('highlight');
        expect(deps.dragMode.value).toBe(false);
        expect(viewer.selectedShapeId).toBeNull();
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

    it.each([
        true,
        false,
    ])('waits for text protection before changing the tool (accepted: %s)', async accepted => {
        const {
            viewer, deps, menuOpen, tools,
        } = createHarness();
        const protection = Promise.withResolvers<undefined>();
        viewer.prepareAnnotationToolChange.mockReturnValue(protection.promise);
        tools.annotationTool.value = 'text';
        const changing = tools.handleAnnotationToolChange('rectangle');
        expect.soft(tools.annotationTool.value).toBe('text');
        expect.soft(deps.dragMode.value).toBe(true);
        expect.soft(viewer.selectedShapeId).toBe('selected-shape');
        expect.soft(menuOpen.value).toBe(true);
        if (accepted) protection.resolve(undefined);
        else protection.reject(new Error('ENOSPC'));
        expect(await changing).toBe(accepted);
        expect(tools.annotationTool.value).toBe(accepted ? 'rectangle' : 'text');
        expect(deps.dragMode.value).toBe(!accepted);
        expect(viewer.selectedShapeId).toBe(accepted ? null : 'selected-shape');
        expect(menuOpen.value).toBe(!accepted);
    });

    it('keeps shape selection when select mode is activated', () => {
        const {
            viewer,
            tools,
        } = createHarness();

        tools.handleAnnotationToolChange('select');

        expect(viewer.selectedShapeId).toBe('selected-shape');
    });

    it('ends the active interaction when annotation tool is cancelled', () => {
        const {tools} = createHarness();

        tools.handleAnnotationToolCancel();

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
        expect(viewer.selectedShapeId).toBe('selected-shape');
    });
});
