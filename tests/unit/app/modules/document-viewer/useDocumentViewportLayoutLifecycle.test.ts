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
import { useDocumentViewportLayoutLifecycle } from '@app/modules/document-viewer/lifecycle/useDocumentViewportLayoutLifecycle';
import { DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS } from '@app/modules/document-viewer/input/documentWheelInteraction';

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
            applyRestoredScroll: (restored, onApplied) => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = restored.top;
                writes.push(restored.top);
                onApplied?.();
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        const transaction = {};
        lifecycle.beginLayoutTransaction(transaction);
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
        await lifecycle.endLayoutTransaction(transaction);
        await nextTick();

        expect(viewport.scrollTop).toBe(240);
        expect(writes.at(-1)).toBe(240);
        scope.stop();
    });

    it('keeps the first mode-change anchor when metric publication coalesces before the restore frame', async () => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        const scope = effectScope();
        const viewport = createViewport(216_250);
        Object.defineProperties(viewport, {
            clientHeight: {value: 550},
            clientWidth: {value: 885},
        });
        const mode = ref<'fit-width' | 'fit-height'>('fit-width');
        const metricRevision = ref(0);
        const pageLayouts = computed(() => {
            // Metric publication can invalidate the same geometry collection
            // while the fit-mode restore is waiting for its frame.
            void metricRevision.value;
            const pageHeight = mode.value === 'fit-width' ? 845 : 510;
            const pageWidth = pageHeight;
            return Array.from({length: 501}, (_, index) => ({
                top: 20 + index * (pageHeight + 20),
                width: pageWidth,
                height: pageHeight,
            }));
        });
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer: ref<HTMLElement | null>(viewport),
            pageLayouts,
            captureRestoreEpoch: () => 1,
            canRestore: () => true,
            applyRestoredScroll: (restored, onApplied) => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = restored.top;
                onApplied?.();
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        // The mode watcher captures page 251 from the previous fit-width
        // geometry and projects it before the DOM adopts the new layout.
        void pageLayouts.value;
        mode.value = 'fit-height';
        await nextTick();
        await nextTick();

        // Metric publication must preserve that semantic position while the
        // queued post-patch restore remains pending.
        lifecycle.preserveLayoutMutation(() => {
            metricRevision.value += 1;
        });
        expect(viewport.scrollTop).toBeCloseTo(132_398.9, 1);
        frames.splice(0).forEach(callback => callback(0));

        expect(viewport.scrollTop).toBeCloseTo(132_398.9, 1);
        scope.stop();
    });

    it('projects a shrinking layout before native clamp can cancel its semantic restore', async () => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        const scope = effectScope();
        const viewport = createViewport(132_399);
        Object.defineProperties(viewport, {
            clientHeight: {value: 550},
            clientWidth: {value: 885},
            scrollHeight: {
                value: 265_550,
                writable: true,
            },
        });
        const mode = ref<'fit-height' | 'custom'>('fit-height');
        const pageLayouts = computed(() => {
            const pageHeight = mode.value === 'fit-height' ? 510 : 123;
            return Array.from({length: 501}, (_, index) => ({
                top: 20 + index * (pageHeight + 20),
                width: pageHeight,
                height: pageHeight,
            }));
        });
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer: ref<HTMLElement | null>(viewport),
            pageLayouts,
            captureRestoreEpoch: () => 1,
            canRestore: () => true,
            applyRestoredScroll: (restored, onApplied) => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = restored.top;
                onApplied?.();
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        void pageLayouts.value;
        mode.value = 'custom';
        await nextTick();

        // The real browser now adopts the smaller document and clamps only
        // when the stale raw offset is still present. The synchronous semantic
        // projection keeps page 251 in range, so this clamp leaves it there.
        Object.defineProperty(viewport, 'scrollHeight', {value: 71_663});
        viewport.scrollTop = Math.min(viewport.scrollTop, viewport.scrollHeight - viewport.clientHeight);
        lifecycle.cancelPendingRestore();
        frames.splice(0).forEach(callback => callback(0));

        expect(viewport.scrollTop).toBeCloseTo(35_532.1, 1);
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
            applyRestoredScroll: (restored, onApplied) => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = restored.top;
                onApplied?.();
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        const transaction = {};
        lifecycle.beginLayoutTransaction(transaction);
        viewport.scrollTop = 240;
        lifecycle.commitReadingPoint();
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
        await lifecycle.endLayoutTransaction(transaction);

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
            applyRestoredScroll: (restored, onApplied) => {
                viewport.scrollTop = restored.top;
                writes.push(restored.top);
                onApplied?.();
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        const predecessor = {};
        lifecycle.beginLayoutTransaction(predecessor);
        viewport.scrollTop = 0;
        const successor = {};
        lifecycle.beginLayoutTransaction(successor);
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
            applyRestoredScroll: (restored, onApplied) => {
                viewport.scrollTop = restored.top;
                onApplied?.();
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
            applyRestoredScroll: (restored, onApplied) => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = restored.top;
                onApplied?.();
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        const transaction = {};
        lifecycle.beginLayoutTransaction(transaction);
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

    it.each([
        'commit',
        'complete',
    ] as const)('centres a resize after a pointer zoom settles via %s', async (retention) => {
        vi.useFakeTimers();
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        const scope = effectScope();
        const viewport = createViewport(300);
        Object.defineProperties(viewport, {
            clientWidth: {
                value: 900,
                writable: true,
            },
            clientHeight: {value: 700},
            offsetWidth: {
                value: 900,
                writable: true,
            },
            offsetHeight: {value: 700},
        });
        viewport.scrollLeft = 100;
        viewport.getBoundingClientRect = () => ({
            left: 0,
            top: 0,
        } as DOMRect);
        const pageLayouts = ref([{
            left: 16,
            top: 16,
            width: 1200,
            height: 2000,
        }]);
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer: ref<HTMLElement | null>(viewport),
            pageLayouts,
            captureRestoreEpoch: () => 1,
            canRestore: () => true,
            applyRestoredScroll: (restored, onApplied) => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = restored.top;
                onApplied?.();
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');
        try {
            const transaction = retention === 'complete' ? {} : null;
            if (transaction) lifecycle.beginLayoutTransaction(transaction);
            lifecycle.capturePointerAnchor({
                clientX: 100,
                clientY: 100,
            });
            pageLayouts.value = [{
                left: 16,
                top: 16,
                width: 1800,
                height: 3000,
            }];
            await nextTick();
            await nextTick();
            // The zoom still keeps the original page point under the pointer.
            expect(viewport.scrollLeft).toBe(192);
            expect(viewport.scrollTop).toBe(492);
            if (transaction === null) lifecycle.commitReadingPoint();
            else await lifecycle.endLayoutTransaction(transaction);
            await vi.advanceTimersByTimeAsync(200);
            const centreX = viewport.scrollLeft + viewport.clientWidth / 2;
            const centreY = viewport.scrollTop + viewport.clientHeight / 2;
            Object.defineProperties(viewport, {
                clientWidth: {value: 760},
                offsetWidth: {value: 760},
            });
            pageLayouts.value = pageLayouts.value.map(layout => ({...layout}));
            await nextTick();
            await nextTick();
            expect(viewport.scrollLeft + viewport.clientWidth / 2).toBeCloseTo(centreX, 5);
            expect(viewport.scrollTop + viewport.clientHeight / 2).toBeCloseTo(centreY, 5);
        } finally {
            scope.stop();
        }
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
            applyRestoredScroll: (restored, onApplied) => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = restored.top;
                onApplied?.();
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        const transaction = {};
        lifecycle.beginLayoutTransaction(transaction);
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
        lifecycle.commitReadingPoint();

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
            applyRestoredScroll: (restored, onApplied) => {
                viewport.scrollTop = restored.top;
                onApplied?.();
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        const transaction = {};
        lifecycle.beginLayoutTransaction(transaction);
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
            applyRestoredScroll: (restored, onApplied) => {
                appliedScrolls.push(restored.top);
                viewport.scrollTop = restored.top;
                onApplied?.();
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        const transaction = {};
        lifecycle.beginLayoutTransaction(transaction);
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
            applyRestoredScroll: (restored, onApplied) => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = restored.top;
                onApplied?.();
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
            applyRestoredScroll: (restored, onApplied) => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = restored.top;
                onApplied?.();
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

    it('keeps the resize anchor when a pane deactivation cancels restores during a split', async () => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        const scope = effectScope();
        const viewport = createViewport(240);
        const isResizing = ref(false);
        const pageLayouts = ref([
            0,
            120,
            240,
        ].map(top => ({
            top,
            width: 100,
            height: 100,
        })));
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer: ref<HTMLElement | null>(viewport),
            pageLayouts,
            isResizing,
            captureRestoreEpoch: () => 1,
            canRestore: () => true,
            applyRestoredScroll: (restored, onApplied) => {
                viewport.scrollTop = restored.top;
                onApplied?.();
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        isResizing.value = true;
        lifecycle.cancelPendingRestore();
        // Moving the pane into its split slot resets the DOM scroll offset.
        viewport.scrollTop = 0;
        pageLayouts.value = [
            0,
            60,
            120,
        ].map(top => ({
            top,
            width: 50,
            height: 50,
        }));
        await nextTick();
        await nextTick();

        expect(viewport.scrollTop).toBe(95);
        scope.stop();
    });
});

describe('useDocumentViewportLayoutLifecycle reading point', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const pageLayoutsAt = (scale: number) => Array.from({length: 6}, (_, index) => ({
        left: 0,
        top: index * (100 * scale + 20),
        width: 100 * scale,
        height: 100 * scale,
    }));

    /**
     * A page-source view as its runtime drives the lifecycle: writes land and
     * then run their `onApplied`, a navigation and a user scroll commit the
     * point, echoes and residue commit nothing, and hiding zeroes the box.
     */
    function createReader(options: {clientHeight?: number} = {}) {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        const scope = effectScope();
        const viewport = createViewport(0);
        const setClientHeight = (value: number) => Object.defineProperty(viewport, 'clientHeight', {
            configurable: true,
            value,
        });
        setClientHeight(options.clientHeight ?? 100);
        viewport.getBoundingClientRect = () => ({
            left: 0,
            top: 0,
        } as DOMRect);
        const pageLayouts = ref(pageLayoutsAt(1));
        const state = {
            // The physical segment's origin: logical offset = origin + scrollTop.
            origin: 0,
            // The scroll range the DOM allows before Vue patches the new height.
            maxScrollTop: Number.POSITIVE_INFINITY,
        };
        const writes: number[] = [];
        const readLogicalTop = () => state.origin + viewport.scrollTop;
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer: ref<HTMLElement | null>(viewport),
            pageLayouts,
            readViewport: container => ({
                clientHeight: container.clientHeight,
                clientWidth: container.clientWidth,
                scrollHeight: container.scrollHeight,
                scrollLeft: container.scrollLeft,
                scrollTop: state.origin + container.scrollTop,
                scrollWidth: container.scrollWidth,
            }),
            captureRestoreEpoch: () => 1,
            canRestore: () => viewport.clientHeight > 0,
            applyRestoredScroll: (restored, onApplied) => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = Math.min(restored.top, state.maxScrollTop) - state.origin;
                writes.push(readLogicalTop());
                onApplied?.();
                return true;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');
        return {
            lifecycle,
            pageLayouts,
            setClientHeight,
            state,
            viewport,
            writes,
            readLogicalTop,
            async flush() {
                await nextTick();
                await nextTick();
                while (frames.length > 0) {
                    frames.splice(0).forEach(callback => callback(0));
                    await nextTick();
                }
            },
            navigate(top: number) {
                viewport.scrollTop = top - state.origin;
                lifecycle.commitReadingPoint();
            },
            userScroll(top: number) {
                lifecycle.cancelPendingRestore();
                viewport.scrollTop = top - state.origin;
                lifecycle.commitReadingPoint();
            },
            /** A tab switch resets the wheel session first; a tab move does not. */
            hide({tabSwitch = true} = {}) {
                if (tabSwitch) lifecycle.cancelPendingRestore();
                lifecycle.suspend();
                setClientHeight(0);
                viewport.scrollTop = 0;
            },
            /** Showing lays the box out a flush before the restore places the point. */
            reveal() {
                setClientHeight(100);
            },
            show() {
                setClientHeight(100);
                lifecycle.resume();
            },
            stop: () => scope.stop(),
        };
    }

    it('places a navigation that lands before a queued restore frame', async () => {
        const reader = createReader();
        reader.navigate(0);
        // Metric publication queues a restore of page one's point.
        reader.lifecycle.preserveLayoutMutation(() => {
            reader.pageLayouts.value = pageLayoutsAt(2);
        });
        await nextTick();
        // Page one's point, before paint: the mutation and the watcher project it.
        expect(new Set(reader.writes)).toEqual(new Set([50]));
        // scrollToPage(2) lands before the restore's frame.
        reader.navigate(220);
        await reader.flush();

        expect(reader.readLogicalTop()).toBe(220);
        expect(reader.writes.at(-1)).toBe(220);
        expect(reader.lifecycle.readReadingPoint()?.pageIndex).toBe(1);
        reader.stop();
    });

    it('places a navigation that lands after metric hydration ends and before its frame', async () => {
        const reader = createReader();
        reader.navigate(0);
        const transition = {};
        reader.lifecycle.beginLayoutTransaction(transition);
        // Hydration ends at page one's point; its post-paint restore is still queued.
        const ending = reader.lifecycle.endLayoutTransaction(transition, true);
        await nextTick();
        // The opening's scrollToPage(2) lands before that frame.
        reader.navigate(120);
        await reader.flush();
        await ending;

        expect(reader.readLogicalTop()).toBe(120);
        expect(reader.lifecycle.readReadingPoint()?.pageIndex).toBe(1);
        reader.stop();
    });

    it('places a navigation that lands after a pointer zoom ended with metric hydration', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        try {
            const reader = createReader();
            reader.viewport.getBoundingClientRect = () => ({
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
            reader.navigate(0);
            const transition = {};
            reader.lifecycle.beginLayoutTransaction(transition);
            reader.lifecycle.capturePointerAnchor({
                clientX: 50,
                clientY: 10,
            });
            // Hydration ends during the zoom: its queued restore carries the pointer's point.
            const ending = reader.lifecycle.endLayoutTransaction(transition, true);
            // The gesture ends, then a navigation lands before that restore's frame.
            vi.advanceTimersByTime(DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS);
            await nextTick();
            reader.navigate(240);
            await reader.flush();
            await ending;

            expect(reader.readLogicalTop()).toBe(240);
            expect(reader.lifecycle.readReadingPoint()?.pageIndex).toBe(2);
            reader.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('settles a transaction end without a restore at once, even with a restore queued', async () => {
        const reader = createReader();
        reader.userScroll(250);
        const transition = {};
        reader.lifecycle.beginLayoutTransaction(transition);
        reader.pageLayouts.value = pageLayoutsAt(1.5);
        await nextTick();
        const settled: string[] = [];
        void reader.lifecycle.endLayoutTransaction(transition, false).then(() => settled.push('ended'));
        await nextTick();
        await nextTick();

        expect(settled).toEqual(['ended']);
        await reader.flush();
        reader.stop();
    });

    it('keeps the point when the restore write before paint is clamped', async () => {
        const reader = createReader();
        reader.navigate(240);
        const point = reader.lifecycle.readReadingPoint();
        reader.state.maxScrollTop = 300;
        reader.lifecycle.preserveLayoutMutation(() => {
            reader.pageLayouts.value = pageLayoutsAt(3);
        });
        // The DOM still has the old height: the write and its echo read 300.
        expect(reader.writes).toEqual([300]);
        expect(reader.lifecycle.readReadingPoint()).toEqual(point);
        reader.state.maxScrollTop = Number.POSITIVE_INFINITY;
        await reader.flush();

        expect(reader.readLogicalTop()).toBe(740);
        expect(reader.lifecycle.readReadingPoint()?.pageIndex).toBe(2);
        expect(reader.lifecycle.readReadingPoint()?.yRatio).toBeCloseTo(0.5, 5);
        reader.stop();
    });

    it('keeps the point through command residue the write port repairs', async () => {
        const reader = createReader();
        reader.navigate(240);
        const point = reader.lifecycle.readReadingPoint();
        // A superseded gesture's last inertial delta: the runtime commits nothing.
        reader.viewport.scrollTop = 263;
        expect(reader.lifecycle.readReadingPoint()).toEqual(point);
        reader.hide();
        reader.show();
        await reader.flush();

        expect(reader.readLogicalTop()).toBe(240);
        reader.stop();
    });

    it('keeps the document offset across a segment rebase after a user scroll', async () => {
        const reader = createReader();
        reader.userScroll(360);
        const point = reader.lifecycle.readReadingPoint();
        // The rebase keeps the logical offset in a new physical segment.
        reader.state.origin = 300;
        reader.viewport.scrollTop = 60;
        reader.lifecycle.commitReadingPoint();
        expect(reader.lifecycle.readReadingPoint()).toEqual(point);
        reader.hide();
        reader.show();
        await reader.flush();

        expect(reader.readLogicalTop()).toBe(360);
        expect(reader.viewport.scrollTop).toBe(60);
        reader.stop();
    });

    it('places nothing on show when the view was hidden before its first measurement', async () => {
        const reader = createReader({clientHeight: 0});
        reader.lifecycle.beginLayoutTransaction({});
        reader.lifecycle.preserveLayoutMutation(() => {
            reader.pageLayouts.value = pageLayoutsAt(1);
        });
        await nextTick();
        reader.lifecycle.commitReadingPoint();
        reader.hide();
        reader.show();
        await reader.flush();

        expect(reader.lifecycle.readReadingPoint()).toBeNull();
        expect(reader.writes).toEqual([]);
        // The opening's or a navigation's placement governs.
        reader.navigate(360);
        expect(reader.lifecycle.readReadingPoint()?.pageIndex).toBe(3);
        reader.stop();
    });

    it('keeps the point when a metric-hydration transaction ends while hidden', async () => {
        const reader = createReader();
        reader.navigate(240);
        const transition = {};
        reader.lifecycle.beginLayoutTransaction(transition);
        const point = reader.lifecycle.readReadingPoint();
        reader.hide({tabSwitch: false});
        const ending = reader.lifecycle.endLayoutTransaction(transition, true);
        await reader.flush();
        await ending;
        expect(reader.writes).toEqual([]);
        expect(reader.lifecycle.readReadingPoint()).toEqual(point);
        reader.show();
        await reader.flush();

        expect(reader.readLogicalTop()).toBe(240);
        reader.stop();
    });

    it('does not take the reset offset of a shown view before its point is placed', async () => {
        const reader = createReader();
        reader.navigate(360);
        const point = reader.lifecycle.readReadingPoint();
        reader.hide();
        reader.reveal();
        // Metric hydration and publication run in the flush before the restore.
        const transition = {};
        reader.lifecycle.beginLayoutTransaction(transition);
        reader.lifecycle.endLayoutTransaction(transition, false);
        reader.lifecycle.preserveLayoutMutation(() => {
            reader.pageLayouts.value = pageLayoutsAt(1);
        });
        await nextTick();
        expect(reader.lifecycle.readReadingPoint()).toEqual(point);
        reader.lifecycle.resume();
        await reader.flush();

        expect(reader.readLogicalTop()).toBe(360);
        reader.stop();
    });

    it('keeps the point when fit geometry changes as a view is being shown', async () => {
        const reader = createReader();
        reader.navigate(360);
        reader.hide();
        reader.reveal();
        // The window was resized while hidden: the show measures new fit geometry.
        reader.pageLayouts.value = pageLayoutsAt(1.5);
        await nextTick();
        expect(reader.lifecycle.readReadingPoint()?.pageIndex).toBe(3);
        reader.lifecycle.resume();
        await reader.flush();

        expect(reader.readLogicalTop()).toBe(3 * 170 + 75 - 50);
        reader.stop();
    });

    it('lets a navigation that lands while a view is being shown win over its restore', async () => {
        const reader = createReader();
        reader.navigate(360);
        reader.hide();
        reader.reveal();
        reader.navigate(120);
        reader.lifecycle.resume();
        await reader.flush();

        expect(reader.readLogicalTop()).toBe(120);
        expect(reader.lifecycle.readReadingPoint()?.pageIndex).toBe(1);
        reader.stop();
    });

    it('follows the reader after a show whose restore went stale', async () => {
        const reader = createReader();
        reader.navigate(360);
        reader.hide();
        reader.reveal();
        // The restore transition was superseded: resume never runs.
        reader.userScroll(480);
        reader.pageLayouts.value = pageLayoutsAt(2);
        await reader.flush();

        expect(reader.lifecycle.readReadingPoint()?.pageIndex).toBe(4);
        expect(reader.readLogicalTop()).toBe(4 * 220 + 50);
        reader.stop();
    });

    it('returns to the zoomed point on every tab return and forgets it for another document', async () => {
        const reader = createReader();
        reader.navigate(240);
        reader.userScroll(275);
        for (const scale of [
            1.5,
            2.25,
        ]) {
            reader.pageLayouts.value = pageLayoutsAt(scale);
            await reader.flush();
            const zoomed = {
                left: reader.viewport.scrollLeft,
                top: reader.readLogicalTop(),
            };
            reader.hide();
            reader.show();
            await reader.flush();
            expect(reader.viewport.scrollLeft).toBeCloseTo(zoomed.left, 5);
            expect(reader.readLogicalTop()).toBeCloseTo(zoomed.top, 5);
        }
        // A pointer zoom commits the centre its restore placed.
        reader.lifecycle.capturePointerAnchor({
            clientX: 20,
            clientY: 80,
        });
        reader.pageLayouts.value = pageLayoutsAt(3);
        await reader.flush();
        const pointerZoomed = reader.readLogicalTop();
        reader.hide();
        reader.show();
        await reader.flush();
        expect(reader.readLogicalTop()).toBeCloseTo(pointerZoomed, 5);

        reader.lifecycle.resetReadingPoint();
        const writes = reader.writes.length;
        reader.hide();
        reader.show();
        await reader.flush();
        expect(reader.writes).toHaveLength(writes);
        reader.stop();
    });

    it('keeps the viewport centre as the reading point after a pointer zoom over another page during metric hydration', async () => {
        const reader = createReader();
        reader.viewport.getBoundingClientRect = () => ({
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
        // Page 0 ends at 100, page 1 starts at 120: scrollTop 80 puts viewport centre (130) on page 1
        // while the top of the viewport (clientY 10 -> logical 90) still shows page 0.
        reader.userScroll(80);
        expect(reader.lifecycle.readReadingPoint()?.pageIndex).toBe(1);

        const hydration = {};
        reader.lifecycle.beginLayoutTransaction(hydration);
        reader.lifecycle.capturePointerAnchor({
            clientX: 50,
            clientY: 10,
        });
        // Even before the restore frame lands, the cursor's page does not replace the reading point.
        expect(reader.lifecycle.readReadingPoint()?.pageIndex).toBe(1);

        reader.lifecycle.preserveLayoutMutation(() => {
            reader.pageLayouts.value = pageLayoutsAt(1.5);
        });
        await reader.flush();
        // After the pointer zoom lands during hydration, the reading point is the new viewport centre on page 1.
        const zoomedTop = reader.readLogicalTop();
        expect(reader.lifecycle.readReadingPoint()?.pageIndex).toBe(1);
        expect(reader.lifecycle.readReadingPoint()?.viewportY).toBeUndefined();

        // Switching tabs cancels hydration; returning preserves the post-zoom centre on page 1.
        reader.hide();
        reader.show();
        await reader.flush();
        expect(reader.lifecycle.readReadingPoint()?.pageIndex).toBe(1);
        expect(reader.readLogicalTop()).toBeCloseTo(zoomedTop, 5);
        reader.stop();
    });

    it('settles the layout receipt at once without a restore and after the restore frame with one', async () => {
        const reader = createReader();
        reader.userScroll(250);
        const settled: string[] = [];
        // An unchanged box queues no restore: nothing to wait for.
        void reader.lifecycle.whenRestored().then(() => settled.push('unchanged'));
        await nextTick();
        expect(settled).toEqual(['unchanged']);

        // A wider box lays the pages out larger; the watcher queues the restore.
        reader.pageLayouts.value = pageLayoutsAt(1.5);
        await nextTick();
        void reader.lifecycle.whenRestored().then(() => settled.push('resized'));
        await nextTick();
        await nextTick();
        expect(settled).toEqual(['unchanged']);
        await reader.flush();

        expect(settled).toEqual(['unchanged', 'resized']);
        // The viewport centre the reader saw, 60% down page 3, is the centre in the new layout.
        expect(reader.readLogicalTop()).toBeCloseTo(2 * 170 + 0.6 * 150 - 50, 5);
        reader.stop();
    });

    it('settles a queued restore receipt when the view closes before its frame', async () => {
        const reader = createReader();
        reader.userScroll(250);
        reader.pageLayouts.value = pageLayoutsAt(1.5);
        await nextTick();
        const receipt = reader.lifecycle.whenRestored();

        reader.stop();

        await expect(receipt).resolves.toBeUndefined();
    });
});
