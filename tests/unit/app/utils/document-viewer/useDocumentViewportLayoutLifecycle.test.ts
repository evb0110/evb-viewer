import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    nextTick,
    ref,
} from 'vue';
import { useDocumentViewportLayoutLifecycle } from '@app/utils/document-viewer/lifecycle/useDocumentViewportLayoutLifecycle';

function createViewport(scrollTop: number) {
    return {
        clientHeight: 100,
        clientWidth: 100,
        scrollHeight: 2_000,
        scrollLeft: 0,
        scrollTop,
        scrollWidth: 100,
    } as HTMLElement;
}

describe('useDocumentViewportLayoutLifecycle', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('preserves one semantic page anchor across progressive geometry mutations', async () => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        const scope = effectScope();
        const viewport = createViewport(0);
        const viewerContainer = ref<HTMLElement | null>(viewport);
        const pageLayouts = ref([
            {
                top: 0,
                width: 100,
                height: 100,
            },
            {
                top: 0,
                width: 100,
                height: 100,
            },
            {
                top: 0,
                width: 100,
                height: 100,
            },
        ]);
        const writes: number[] = [];
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer,
            pageLayouts,
            capturePageIndex: () => 2,
            captureRestoreEpoch: () => 1,
            canRestore: epoch => epoch === 1,
            applyRestoredScroll: restored => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = restored.top;
                writes.push(restored.top);
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        lifecycle.beginLayoutTransaction();
        lifecycle.preserveLayoutMutation(() => {
            pageLayouts.value = [
                {
                    top: 0,
                    width: 100,
                    height: 100,
                },
                {
                    top: 120,
                    width: 100,
                    height: 100,
                },
                {
                    top: 240,
                    width: 100,
                    height: 100,
                },
            ];
        });
        expect(viewport.scrollTop).toBe(240);

        lifecycle.preserveLayoutMutation(() => {
            pageLayouts.value = [
                {
                    top: 0,
                    width: 100,
                    height: 100,
                },
                {
                    top: 120,
                    width: 100,
                    height: 100,
                },
                {
                    top: 240,
                    width: 100,
                    height: 100,
                },
            ];
        });
        await lifecycle.endLayoutTransaction();
        await nextTick();

        expect(viewport.scrollTop).toBe(240);
        expect(writes.at(-1)).toBe(240);
        scope.stop();
    });

    it('retargets an active geometry transaction after viewport navigation', async () => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        const scope = effectScope();
        const viewport = createViewport(0);
        const viewerContainer = ref<HTMLElement | null>(viewport);
        const pageLayouts = ref([
            {
                top: 0,
                width: 100,
                height: 100,
            },
            {
                top: 120,
                width: 100,
                height: 100,
            },
            {
                top: 240,
                width: 100,
                height: 100,
            },
        ]);
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer,
            pageLayouts,
            captureRestoreEpoch: () => 1,
            canRestore: () => true,
            applyRestoredScroll: restored => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = restored.top;
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        lifecycle.beginLayoutTransaction();
        viewport.scrollTop = 240;
        lifecycle.refreshLayoutTransactionAnchor();
        lifecycle.preserveLayoutMutation(() => {
            pageLayouts.value = [
                {
                    top: 0,
                    width: 100,
                    height: 500,
                },
                {
                    top: 520,
                    width: 100,
                    height: 100,
                },
                {
                    top: 640,
                    width: 100,
                    height: 100,
                },
            ];
        });
        await lifecycle.endLayoutTransaction();

        expect(viewport.scrollTop).toBe(640);
        scope.stop();
    });

    it('does not let a stale transaction restore geometry after its successor begins', async () => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        const scope = effectScope();
        const viewport = createViewport(120);
        const viewerContainer = ref<HTMLElement | null>(viewport);
        const pageLayouts = ref([
            {
                top: 0,
                width: 100,
                height: 100,
            },
            {
                top: 120,
                width: 100,
                height: 100,
            },
        ]);
        const writes: number[] = [];
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer,
            pageLayouts,
            captureRestoreEpoch: () => 2,
            canRestore: epoch => epoch === 2,
            applyRestoredScroll: restored => {
                viewport.scrollTop = restored.top;
                writes.push(restored.top);
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        const predecessor = lifecycle.beginLayoutTransaction();
        viewport.scrollTop = 0;
        const successor = lifecycle.beginLayoutTransaction();
        await lifecycle.endLayoutTransaction(predecessor, false);
        expect(writes).toEqual([]);

        const endSuccessor = lifecycle.endLayoutTransaction(successor, true);
        await vi.waitFor(() => expect(frames).toHaveLength(1));
        frames.splice(0).forEach(callback => callback(0));
        await endSuccessor;
        expect(writes).not.toContain(120);
        scope.stop();
    });

    it('cancels a queued geometry restore when navigation supersedes its anchor', async () => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        const scope = effectScope();
        const viewport = createViewport(120);
        const pageLayouts = ref([
            {
                top: 0,
                width: 100,
                height: 100,
            },
            {
                top: 120,
                width: 100,
                height: 100,
            },
        ]);
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer: ref<HTMLElement | null>(viewport),
            pageLayouts,
            captureRestoreEpoch: () => 1,
            canRestore: () => true,
            applyRestoredScroll: restored => {
                viewport.scrollTop = restored.top;
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        pageLayouts.value = [
            {
                top: 0,
                width: 100,
                height: 500,
            },
            {
                top: 520,
                width: 100,
                height: 100,
            },
        ];
        await nextTick();
        await vi.waitFor(() => expect(frames).toHaveLength(1));
        lifecycle.cancelPendingRestore();
        viewport.scrollTop = 4_200;
        frames.splice(0).forEach(callback => callback(0));

        expect(viewport.scrollTop).toBe(4_200);
        scope.stop();
    });

    it('uses the wheel pointer instead of the viewport center for the next zoom layout', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        const scope = effectScope();
        const viewport = createViewport(600);
        viewport.scrollLeft = 500;
        viewport.getBoundingClientRect = () => ({
            bottom: 500,
            height: 400,
            left: 50,
            right: 550,
            top: 100,
            width: 500,
            x: 50,
            y: 100,
            toJSON: () => ({}),
        });
        Object.defineProperties(viewport, {
            clientHeight: {value: 400},
            clientWidth: {value: 500},
        });
        const pageLayouts = ref([{
            left: 300,
            top: 16,
            width: 400,
            height: 1_000,
        }]);
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer: ref<HTMLElement | null>(viewport),
            pageLayouts,
            captureRestoreEpoch: () => 1,
            canRestore: () => true,
            applyRestoredScroll: restored => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = restored.top;
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        const transaction = lifecycle.beginLayoutTransaction();
        lifecycle.capturePointerAnchor({
            clientX: 150,
            clientY: 200,
        });
        pageLayouts.value = [{
            left: 600,
            top: 16,
            width: 800,
            height: 2_000,
        }];
        await nextTick();
        await nextTick();

        expect(viewport.scrollLeft).toBe(1_100);
        expect(viewport.scrollTop).toBe(1_284);
        await vi.advanceTimersByTimeAsync(200);
        pageLayouts.value = [{
            left: 900,
            top: 16,
            width: 1_200,
            height: 3_000,
        }];
        await nextTick();
        await nextTick();
        expect(viewport.scrollLeft).toBe(1_700);
        expect(viewport.scrollTop).toBe(1_968);
        await lifecycle.endLayoutTransaction(transaction, false);
        scope.stop();
    });

    it('keeps one gesture anchor and recaptures when the wheel session explicitly restarts', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        const scope = effectScope();
        const viewport = createViewport(600);
        viewport.scrollLeft = 500;
        viewport.getBoundingClientRect = () => ({
            bottom: 500,
            height: 400,
            left: 50,
            right: 550,
            top: 100,
            width: 500,
            x: 50,
            y: 100,
            toJSON: () => ({}),
        });
        Object.defineProperties(viewport, {
            clientHeight: {value: 400},
            clientWidth: {value: 500},
        });
        const pageLayouts = ref([{
            left: 300,
            top: 16,
            width: 400,
            height: 1_000,
        }]);
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer: ref<HTMLElement | null>(viewport),
            pageLayouts,
            captureRestoreEpoch: () => 1,
            canRestore: () => true,
            applyRestoredScroll: restored => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = restored.top;
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        const transaction = lifecycle.beginLayoutTransaction();
        lifecycle.capturePointerAnchor({
            clientX: 150,
            clientY: 200,
        });
        lifecycle.preserveLayoutMutation(() => {
            pageLayouts.value = [{
                left: 600,
                top: 16,
                width: 800,
                height: 2_000,
            }];
        });
        expect(viewport.scrollLeft).toBe(1_100);
        expect(viewport.scrollTop).toBe(1_284);
        lifecycle.refreshLayoutTransactionAnchor();

        vi.advanceTimersByTime(100);
        lifecycle.capturePointerAnchor({
            clientX: 450,
            clientY: 450,
        });
        lifecycle.preserveLayoutMutation(() => {
            pageLayouts.value = [{
                left: 900,
                top: 16,
                width: 1_200,
                height: 3_000,
            }];
        });
        expect(viewport.scrollLeft).toBe(1_700);
        expect(viewport.scrollTop).toBe(1_968);

        vi.advanceTimersByTime(50);
        lifecycle.capturePointerAnchor({
            clientX: 450,
            clientY: 450,
        }, 150, true);
        lifecycle.preserveLayoutMutation(() => {
            pageLayouts.value = [{
                left: 1_800,
                top: 16,
                width: 2_400,
                height: 6_000,
            }];
        });
        expect(viewport.scrollLeft).toBe(3_800);
        expect(viewport.scrollTop).toBe(4_270);
        await lifecycle.endLayoutTransaction(transaction, false);
        scope.stop();
    });

    it('fences the post-frame half of a layout transaction after user supersession', async () => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        const scope = effectScope();
        const viewport = createViewport(120);
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer: ref<HTMLElement | null>(viewport),
            pageLayouts: ref([
                {
                    top: 0,
                    width: 100,
                    height: 100,
                },
                {
                    top: 120,
                    width: 100,
                    height: 100,
                },
            ]),
            captureRestoreEpoch: () => 1,
            canRestore: () => true,
            applyRestoredScroll: restored => {
                viewport.scrollTop = restored.top;
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        const transaction = lifecycle.beginLayoutTransaction();
        const ending = lifecycle.endLayoutTransaction(transaction);
        await vi.waitFor(() => expect(frames).toHaveLength(1));
        lifecycle.cancelPendingRestore();
        viewport.scrollTop = 4_200;
        frames.splice(0).forEach(callback => callback(0));
        await ending;

        expect(viewport.scrollTop).toBe(4_200);
        scope.stop();
    });

    it('cancels a pointer-authored transaction before a scrollbar drag emits scroll', async () => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        const scope = effectScope();
        const viewport = createViewport(600);
        viewport.getBoundingClientRect = () => ({
            bottom: 100,
            height: 100,
            left: 0,
            right: 100,
            top: 0,
            width: 100,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });
        const pageLayouts = ref([{
            top: 16,
            width: 400,
            height: 1_000,
        }]);
        const appliedScrolls: number[] = [];
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer: ref<HTMLElement | null>(viewport),
            pageLayouts,
            captureRestoreEpoch: () => 1,
            canRestore: () => true,
            applyRestoredScroll: restored => {
                appliedScrolls.push(restored.top);
                viewport.scrollTop = restored.top;
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        const transaction = lifecycle.beginLayoutTransaction();
        lifecycle.capturePointerAnchor({
            clientX: 50,
            clientY: 50,
        }, 100);
        pageLayouts.value = [{
            top: 16,
            width: 800,
            height: 2_000,
        }];
        await nextTick();
        lifecycle.cancelPendingRestore();
        await lifecycle.endLayoutTransaction(transaction);
        frames.splice(0).forEach(callback => callback(0));
        viewport.scrollTop = 900;
        await nextTick();

        expect(appliedScrolls).toEqual([]);
        expect(viewport.scrollTop).toBe(900);
        scope.stop();
    });

    it('keeps a pointer restore authoritative over an intervening layout-clamp scroll', async () => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        const scope = effectScope();
        const viewport = createViewport(600);
        viewport.scrollLeft = 500;
        viewport.getBoundingClientRect = () => ({
            bottom: 500,
            height: 400,
            left: 50,
            right: 550,
            top: 100,
            width: 500,
            x: 50,
            y: 100,
            toJSON: () => ({}),
        });
        Object.defineProperties(viewport, {
            clientHeight: {value: 400},
            clientWidth: {value: 500},
        });
        const pageLayouts = ref([{
            left: 300,
            top: 16,
            width: 400,
            height: 1_000,
        }]);
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer: ref<HTMLElement | null>(viewport),
            pageLayouts,
            captureRestoreEpoch: () => 1,
            canRestore: () => true,
            applyRestoredScroll: restored => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = restored.top;
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        lifecycle.capturePointerAnchor({
            clientX: 150,
            clientY: 200,
        });
        pageLayouts.value = [{
            left: 600,
            top: 16,
            width: 800,
            height: 2_000,
        }];
        await nextTick();
        await nextTick();
        expect(frames).toHaveLength(1);

        viewport.scrollLeft = 0;
        viewport.scrollTop = 0;
        expect(lifecycle.hasPendingPointerRestore()).toBe(true);
        frames.splice(0).forEach(callback => callback(0));

        expect(viewport.scrollLeft).toBe(1_100);
        expect(viewport.scrollTop).toBe(1_284);
        scope.stop();
    });

    it('retains pointer authorship when the gesture timer expires before the restore frame', async () => {
        vi.useFakeTimers();
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        const scope = effectScope();
        const viewport = createViewport(600);
        viewport.scrollLeft = 500;
        viewport.getBoundingClientRect = () => ({
            bottom: 500,
            height: 400,
            left: 50,
            right: 550,
            top: 100,
            width: 500,
            x: 50,
            y: 100,
            toJSON: () => ({}),
        });
        Object.defineProperties(viewport, {
            clientHeight: {value: 400},
            clientWidth: {value: 500},
        });
        const pageLayouts = ref([{
            left: 300,
            top: 16,
            width: 400,
            height: 1_000,
        }]);
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer: ref<HTMLElement | null>(viewport),
            pageLayouts,
            captureRestoreEpoch: () => 1,
            canRestore: () => true,
            applyRestoredScroll: restored => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = restored.top;
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        lifecycle.capturePointerAnchor({
            clientX: 150,
            clientY: 200,
        }, 100);
        pageLayouts.value = [{
            left: 600,
            top: 16,
            width: 800,
            height: 2_000,
        }];
        await nextTick();
        await nextTick();
        expect(frames).toHaveLength(1);

        vi.advanceTimersByTime(180);
        pageLayouts.value = [{
            left: 900,
            top: 16,
            width: 1_200,
            height: 3_000,
        }];
        await nextTick();
        viewport.scrollLeft = 0;
        viewport.scrollTop = 0;
        expect(lifecycle.hasPendingPointerRestore()).toBe(true);
        frames.splice(0).forEach(callback => callback(0));

        expect(viewport.scrollLeft).toBe(1_700);
        expect(viewport.scrollTop).toBe(1_968);
        scope.stop();
    });
});
