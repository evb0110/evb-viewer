import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfViewerReloadTransition } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerReloadTransition';

describe('usePdfViewerReloadTransition', () => {
    it('defers effective zoom updates until the visual reload transition ends', () => {
        const emitEffectiveZoom = vi.fn();
        const transition = usePdfViewerReloadTransition({ emitEffectiveZoom });

        transition.emitEffectiveZoom(1.94);
        expect(emitEffectiveZoom).toHaveBeenCalledWith(1.94);

        const token = transition.beginVisualReloadTransition('reload-recovery');
        transition.emitEffectiveZoom(1);
        transition.emitEffectiveZoom(1.94);

        expect(emitEffectiveZoom).toHaveBeenCalledTimes(1);
        expect(transition.isVisualReloadTransitionActive.value).toBe(true);

        transition.endVisualReloadTransition(token, 'warm-render-complete');

        expect(transition.isVisualReloadTransitionActive.value).toBe(false);
        expect(emitEffectiveZoom).toHaveBeenCalledTimes(2);
        expect(emitEffectiveZoom).toHaveBeenLastCalledWith(1.94);
    });

    it('publishes committed effective zoom immediately during a visual reload', () => {
        const emitEffectiveZoom = vi.fn();
        const transition = usePdfViewerReloadTransition({ emitEffectiveZoom });
        const token = transition.beginVisualReloadTransition('page-mutation');

        transition.emitEffectiveZoom(1.17);
        transition.commitEffectiveZoom(0.74);

        expect(emitEffectiveZoom).toHaveBeenCalledOnce();
        expect(emitEffectiveZoom).toHaveBeenCalledWith(0.74);

        transition.endVisualReloadTransition(token, 'warm-render-complete');

        expect(emitEffectiveZoom).toHaveBeenCalledOnce();
    });

    it('still defers a later effective zoom change after an immediate reload commit', () => {
        const emitEffectiveZoom = vi.fn();
        const transition = usePdfViewerReloadTransition({ emitEffectiveZoom });
        const token = transition.beginVisualReloadTransition('page-mutation');

        transition.commitEffectiveZoom(0.74);
        transition.emitEffectiveZoom(0.72);
        expect(emitEffectiveZoom.mock.calls.map(([value]) => value)).toEqual([0.74]);

        transition.endVisualReloadTransition(token, 'warm-render-complete');

        expect(emitEffectiveZoom.mock.calls.map(([value]) => value)).toEqual([
            0.74,
            0.72,
        ]);
    });

    it('ignores stale transition tokens when ending the visual reload transition', () => {
        const emitEffectiveZoom = vi.fn();
        const transition = usePdfViewerReloadTransition({ emitEffectiveZoom });

        transition.beginVisualReloadTransition('first');
        const activeToken = transition.beginVisualReloadTransition('second');
        transition.emitEffectiveZoom(1.5);
        transition.endVisualReloadTransition(activeToken - 1, 'stale');

        expect(transition.isVisualReloadTransitionActive.value).toBe(true);
        expect(emitEffectiveZoom).not.toHaveBeenCalled();

        transition.endVisualReloadTransition(activeToken, 'complete');

        expect(transition.isVisualReloadTransitionActive.value).toBe(false);
        expect(emitEffectiveZoom).toHaveBeenCalledWith(1.5);
    });

    it('preserves a deferred effective zoom when a newer reload transition starts', () => {
        const emitEffectiveZoom = vi.fn();
        const transition = usePdfViewerReloadTransition({ emitEffectiveZoom });

        const firstToken = transition.beginVisualReloadTransition('first');
        transition.emitEffectiveZoom(1.75);
        const secondToken = transition.beginVisualReloadTransition('second');

        transition.endVisualReloadTransition(firstToken, 'stale');
        expect(emitEffectiveZoom).not.toHaveBeenCalled();

        transition.endVisualReloadTransition(secondToken, 'complete');

        expect(emitEffectiveZoom).toHaveBeenCalledOnce();
        expect(emitEffectiveZoom).toHaveBeenCalledWith(1.75);
    });
});
