// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    nextTick,
    ref,
} from 'vue';
import type {TAnnotationTool} from '@app/types/annotations';
import {createAnnotationSelectionInteractionController} from '@app/modules/pdf-viewer/runtime/annotations/createAnnotationSelectionInteractionController';
import {useAnnotationTextSelectionCache} from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationTextSelectionCache';

const cleanups: Array<() => void> = [];

function harness(initialTool: TAnnotationTool = 'highlight') {
    const viewer = document.createElement('div');
    viewer.innerHTML = '<div class="text-layer"><span>Selected document text</span></div>';
    const outside = document.createElement('button');
    document.body.append(viewer, outside);
    const text = viewer.querySelector('span')!;
    const tool = ref(initialTool);
    const active = ref(true);
    const scope = effectScope();
    const selectionCache = scope.run(() => useAnnotationTextSelectionCache({
        viewerContainer: ref(viewer),
        currentPage: ref(1),
    }))!;
    const apply = vi.fn(async (_range?: Range | null) => true);
    const invalidate = vi.fn();
    const dispose = scope.run(() => createAnnotationSelectionInteractionController({
        viewerContainer: ref(viewer),
        isActive: computed(() => active.value),
        annotationTool: computed(() => tool.value),
        selectionCache,
        selectionLifecycle: {invalidateActiveRequests: invalidate},
        applySelectionMarkup: apply,
    }))!;
    cleanups.push(() => {dispose(); scope.stop();});
    function select() {
        const range = document.createRange();
        range.selectNodeContents(text);
        document.getSelection()?.removeAllRanges();
        document.getSelection()?.addRange(range);
        return range;
    }
    function pointer(target: Element, type: string, pointerId = 1) {
        target.dispatchEvent(new PointerEvent(type, {
            bubbles: true,
            button: 0,
            pointerId,
        }));
    }
    return {
        text,
        outside,
        tool,
        active,
        apply,
        invalidate,
        dispose,
        select,
        pointer,
    };
}

afterEach(() => {
    cleanups.splice(0).forEach(cleanup => cleanup());
    document.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
});

describe('annotation selection interaction controller', () => {
    it.each([
        'highlight',
        'underline',
        'strikethrough',
        'squiggly',
    ] as const)(
        'commits one %s drag that ends outside the viewer', async tool => {
            const h = harness(tool);
            h.pointer(h.text, 'pointerdown');
            h.select();
            h.pointer(h.outside, 'pointerup');
            await nextTick();
            expect(h.apply).toHaveBeenCalledOnce();
            expect(h.apply.mock.calls[0]?.[0]?.toString()).toBe('Selected document text');
            h.pointer(h.outside, 'pointerup');
            expect(h.apply).toHaveBeenCalledOnce();
        },
    );

    it('does not apply an old selection on an unrelated pointer release', async () => {
        const h = harness();
        h.select();
        h.pointer(h.outside, 'pointerdown');
        h.pointer(h.text, 'pointerup');
        await nextTick();
        expect(h.apply).not.toHaveBeenCalled();
    });

    it('cancels a selection gesture on pointercancel', async () => {
        const h = harness();
        h.pointer(h.text, 'pointerdown');
        h.select();
        h.pointer(h.text, 'pointercancel');
        h.pointer(h.outside, 'pointerup');
        await nextTick();
        expect(h.apply).not.toHaveBeenCalled();
    });

    it('does not commit gestures from an inactive document', async () => {
        const h = harness();
        h.active.value = false;
        h.pointer(h.text, 'pointerdown');
        h.select();
        h.pointer(h.outside, 'pointerup');
        await nextTick();
        expect(h.apply).not.toHaveBeenCalled();
    });


    it('does not let an unrelated pointer release or cancellation discard the current drag', async () => {
        const h = harness();
        h.pointer(h.text, 'pointerdown', 1);
        h.select();
        h.pointer(h.outside, 'pointerup', 2);
        h.pointer(h.outside, 'pointercancel', 2);
        await nextTick();
        expect(h.apply).not.toHaveBeenCalled();
        h.pointer(h.outside, 'pointerup', 1);
        expect(h.apply).toHaveBeenCalledOnce();
    });

    it('does not resume an unfinished drag after switching tools away and back', async () => {
        const h = harness();
        h.pointer(h.text, 'pointerdown');
        h.select();
        h.tool.value = 'select';
        h.tool.value = 'highlight';
        await nextTick();
        h.apply.mockClear();
        h.pointer(h.outside, 'pointerup');
        await nextTick();
        expect(h.apply).not.toHaveBeenCalled();
    });

    it('invalidates pending creation before routing another tool and removes listeners on disposal', async () => {
        const h = harness('select');
        h.select();
        h.tool.value = 'underline';
        expect(h.invalidate).toHaveBeenCalledOnce();
        expect(h.apply).toHaveBeenCalledOnce();
        expect(h.invalidate.mock.invocationCallOrder[0]).toBeLessThan(h.apply.mock.invocationCallOrder[0]!);
        h.dispose();
        h.apply.mockClear();
        h.pointer(h.text, 'pointerdown');
        h.pointer(h.outside, 'pointerup');
        h.tool.value = 'highlight';
        await nextTick();
        expect(h.apply).not.toHaveBeenCalled();
    });
});
