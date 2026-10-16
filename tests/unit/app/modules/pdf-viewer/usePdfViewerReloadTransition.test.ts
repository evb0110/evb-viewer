import {
    describe,
    expect,
    it,
} from 'vitest';
import { usePdfViewerReloadTransition } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerReloadTransition';

describe('usePdfViewerReloadTransition', () => {
    it('keeps the visual reload transition active until it ends', () => {
        const transition = usePdfViewerReloadTransition({});
        expect(transition.isVisualReloadTransitionActive.value).toBe(false);

        const token = transition.beginVisualReloadTransition('reload-recovery');
        expect(transition.isVisualReloadTransitionActive.value).toBe(true);

        transition.endVisualReloadTransition(token, 'warm-render-complete');
        expect(transition.isVisualReloadTransitionActive.value).toBe(false);
    });

    it('ignores stale transition tokens when ending the visual reload transition', () => {
        const transition = usePdfViewerReloadTransition({});
        transition.beginVisualReloadTransition('first');
        const activeToken = transition.beginVisualReloadTransition('second');
        transition.endVisualReloadTransition(activeToken - 1, 'stale');
        expect(transition.isVisualReloadTransitionActive.value).toBe(true);

        transition.endVisualReloadTransition(activeToken, 'complete');
        expect(transition.isVisualReloadTransitionActive.value).toBe(false);
    });

    it('keeps a newer visual reload active when the older reload ends', () => {
        const transition = usePdfViewerReloadTransition({});
        const firstToken = transition.beginVisualReloadTransition('first');
        const secondToken = transition.beginVisualReloadTransition('second');

        transition.endVisualReloadTransition(firstToken, 'stale');
        expect(transition.isVisualReloadTransitionActive.value).toBe(true);

        transition.endVisualReloadTransition(secondToken, 'complete');
        expect(transition.isVisualReloadTransitionActive.value).toBe(false);
    });
});
