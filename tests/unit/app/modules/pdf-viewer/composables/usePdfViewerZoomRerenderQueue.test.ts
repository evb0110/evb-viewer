import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import { usePdfViewerZoomRerenderQueue } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerZoomRerenderQueue';
import type { IPdfViewerTransaction } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import { cast } from '@tests/helpers/cast';
import { resolvePdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';

type TQueueOptions = Parameters<typeof usePdfViewerZoomRerenderQueue>[0];
type TQueueTransactionController = NonNullable<TQueueOptions['transactionController']>;
const performancePolicy = resolvePdfRenderPerformancePolicy({
    lowCpu: false,
    lowMemory: false,
});
const constrainedPerformancePolicy = resolvePdfRenderPerformancePolicy({
    lowCpu: true,
    lowMemory: false,
});

function createViewerMetrics() {
    return {
        scrollTop: 0,
        scrollLeft: 0,
        clientWidth: 800,
        clientHeight: 600,
        scrollWidth: 1200,
        scrollHeight: 1600,
    };
}

function createResizeAnchor(page: number, transitionToken = page) {
    return {
        capturedAtMs: Date.now(),
        page,
        transitionToken,
        snapshot: null,
        visibleRange: {
            start: page,
            end: page,
        },
        viewerMetrics: createViewerMetrics(),
    };
}

async function flushQueuedRerenderFrame() {
    await vi.advanceTimersByTimeAsync(16);
    await Promise.resolve();
    await Promise.resolve();
}

function createQueueHarness(overrides: Partial<TQueueOptions> = {}) {
    const scheduleEndResizeTransition = vi.fn();
    const reRenderVisiblePagesAndSyncCurrentPage = vi.fn<TQueueOptions['reRenderVisiblePagesAndSyncCurrentPage']>(async () => {});
    const setZoomRerenderBusy = vi.fn();
    const queue = usePdfViewerZoomRerenderQueue({
        performancePolicy,
        pdfDocument: shallowRef<IPdfDocument | null>(cast<IPdfDocument>({ fingerprint: 'doc' })),
        isLoading: ref(false),
        viewerContainer: ref(null),
        summarizeViewerMetricsForLog: () => ({}),
        reRenderVisiblePagesAndSyncCurrentPage,
        buildResizeAnchorContext: () => createResizeAnchor(2, 41),
        scheduleEndResizeTransition,
        isZoomInteractionLocked: () => true,
        setZoomRerenderBusy,
        ...overrides,
    });
    return {
        queue,
        reRenderVisiblePagesAndSyncCurrentPage,
        scheduleEndResizeTransition: overrides.scheduleEndResizeTransition ?? scheduleEndResizeTransition,
        setZoomRerenderBusy,
    };
}

describe('usePdfViewerZoomRerenderQueue', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('coalesces same-turn discrete zoom changes before the next visual frame', async () => {
        vi.useFakeTimers();
        const {
            queue,
            reRenderVisiblePagesAndSyncCurrentPage,
        } = createQueueHarness({isZoomInteractionLocked: () => false});

        queue.enqueueZoomSync({
            source: 'zoom-mode-change',
            resizeAnchor: createResizeAnchor(1),
        });
        queue.enqueueZoomSync({
            source: 'zoom-change',
            resizeAnchor: createResizeAnchor(7),
        });
        expect(reRenderVisiblePagesAndSyncCurrentPage).not.toHaveBeenCalled();

        await Promise.resolve();
        await Promise.resolve();

        expect(reRenderVisiblePagesAndSyncCurrentPage).toHaveBeenCalledOnce();
        expect(reRenderVisiblePagesAndSyncCurrentPage).toHaveBeenCalledWith(
            expect.objectContaining({
                source: 'zoom-change',
                resizeAnchor: expect.objectContaining({page: 7}),
            }),
        );
        queue.cleanupZoomRerenderQueue();
    });

    it('ends a deferred resize transition when the queue is reset', () => {
        vi.useFakeTimers();
        const {
            queue,
            scheduleEndResizeTransition,
        } = createQueueHarness();

        queue.enqueueZoomSync({
            source: 'zoom-change',
            resizeAnchor: {
                capturedAtMs: Date.now(),
                page: 1,
                transitionToken: 40,
                visibleRange: {
                    start: 1,
                    end: 1,
                },
                viewerMetrics: createViewerMetrics(),
            },
        });
        queue.scheduleResizeAwareRerender('resize rerender', {
            source: 'resize-observer',
            resizeAnchor: {
                capturedAtMs: Date.now(),
                page: 2,
                transitionToken: 41,
                visibleRange: {
                    start: 2,
                    end: 2,
                },
                viewerMetrics: createViewerMetrics(),
            },
        });

        queue.resetZoomRerenderQueueState('fit-mode-change');

        expect(scheduleEndResizeTransition).toHaveBeenCalledWith(
            41,
            'zoom-queue-reset:fit-mode-change',
            2,
        );
        queue.cleanupZoomRerenderQueue();
    });

    it('bounds and flushes resize settle work when zoom remains busy', async () => {
        vi.useFakeTimers();
        const zoomRender = Promise.withResolvers<undefined>();
        const reRenderVisiblePagesAndSyncCurrentPage = vi.fn<TQueueOptions['reRenderVisiblePagesAndSyncCurrentPage']>(
            options => options?.source === 'zoom-change' ? zoomRender.promise : Promise.resolve(),
        );
        const {queue} = createQueueHarness({
            isZoomInteractionLocked: () => true,
            reRenderVisiblePagesAndSyncCurrentPage,
        });

        queue.enqueueZoomSync({
            source: 'zoom-change',
            resizeAnchor: createResizeAnchor(1, 40),
        });
        queue.scheduleResizeAwareRerender('resize settle', {
            source: 'resize-settle',
            resizeAnchor: createResizeAnchor(2, 41),
        });

        await vi.advanceTimersByTimeAsync(1_499);
        expect(reRenderVisiblePagesAndSyncCurrentPage.mock.calls.some(([options]) => (
            options?.source === 'resize-settle'
        ))).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(reRenderVisiblePagesAndSyncCurrentPage).toHaveBeenCalledWith(
            expect.objectContaining({source: 'resize-settle'}),
        );
        zoomRender.resolve(undefined);
        await Promise.resolve();
        queue.cleanupZoomRerenderQueue();
    });

    it('defers locked gesture rerenders and drains only the latest pending sync options', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const reRenderVisiblePagesAndSyncCurrentPage = vi.fn<TQueueOptions['reRenderVisiblePagesAndSyncCurrentPage']>(async () => {});
        const isZoomInteractionLocked = true;
        const {
            queue,
            setZoomRerenderBusy,
        } = createQueueHarness({
            reRenderVisiblePagesAndSyncCurrentPage,
            isZoomInteractionLocked: () => isZoomInteractionLocked,
        });

        try {
            queue.enqueueZoomSync({
                source: 'zoom-gesture-change',
                resizeAnchor: createResizeAnchor(1),
            });

            await flushQueuedRerenderFrame();

            expect(reRenderVisiblePagesAndSyncCurrentPage).toHaveBeenCalledOnce();
            expect(reRenderVisiblePagesAndSyncCurrentPage).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    source: 'zoom-gesture-change',
                    resizeAnchor: expect.objectContaining({ page: 1 }),
                }),
            );

            vi.advanceTimersByTime(50);
            queue.enqueueZoomSync({
                source: 'zoom-gesture-change',
                resizeAnchor: createResizeAnchor(2),
            });
            queue.enqueueZoomSync({
                source: 'zoom-change',
                resizeAnchor: createResizeAnchor(3),
            });

            await vi.advanceTimersByTimeAsync(79);
            expect(reRenderVisiblePagesAndSyncCurrentPage).toHaveBeenCalledOnce();

            await vi.advanceTimersByTimeAsync(1);
            expect(reRenderVisiblePagesAndSyncCurrentPage).toHaveBeenCalledTimes(2);

            await flushQueuedRerenderFrame();

            expect(reRenderVisiblePagesAndSyncCurrentPage).toHaveBeenCalledTimes(2);
            expect(reRenderVisiblePagesAndSyncCurrentPage).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    source: 'zoom-change',
                    resizeAnchor: expect.objectContaining({ page: 3 }),
                }),
            );
            expect(reRenderVisiblePagesAndSyncCurrentPage.mock.calls.some(([syncOptions]) => (
                syncOptions?.resizeAnchor?.page === 2
            ))).toBe(false);
            expect(setZoomRerenderBusy).toHaveBeenCalledWith(
                true,
                expect.objectContaining({ reason: expect.any(String) }),
            );
            expect(setZoomRerenderBusy).toHaveBeenLastCalledWith(
                false,
                expect.objectContaining({ reason: 'queue-end' }),
            );
        } finally {
            queue.cleanupZoomRerenderQueue();
        }
    });

    it('applies a normal-tier toolbar zoom-mode change without waiting for input quiet', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const {
            queue,
            reRenderVisiblePagesAndSyncCurrentPage,
        } = createQueueHarness({isZoomInteractionLocked: () => true});

        try {
            queue.enqueueZoomSync({
                source: 'zoom-gesture-change',
                resizeAnchor: createResizeAnchor(1),
            });
            await flushQueuedRerenderFrame();
            expect(reRenderVisiblePagesAndSyncCurrentPage).toHaveBeenCalledOnce();

            queue.enqueueZoomSync({
                source: 'zoom-mode-change',
                resizeAnchor: createResizeAnchor(2),
            });
            await Promise.resolve();
            await Promise.resolve();

            expect(reRenderVisiblePagesAndSyncCurrentPage).toHaveBeenCalledTimes(2);
            expect(reRenderVisiblePagesAndSyncCurrentPage).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    source: 'zoom-mode-change',
                    resizeAnchor: expect.objectContaining({page: 2}),
                }),
            );
        } finally {
            queue.cleanupZoomRerenderQueue();
        }
    });

    it('signals render completion with the current zoom lock operation id', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const {
            queue,
            setZoomRerenderBusy,
        } = createQueueHarness({ isZoomInteractionLocked: () => false });

        try {
            queue.enqueueZoomSync({
                source: 'zoom-gesture-change',
                resizeAnchor: createResizeAnchor(1),
                zoomLockOperationId: 42,
            });

            await flushQueuedRerenderFrame();

            expect(setZoomRerenderBusy).toHaveBeenCalledWith(
                true,
                expect.objectContaining({
                    operationId: 42,
                    reason: 'zoom-watch-enqueue',
                }),
            );
            expect(setZoomRerenderBusy).toHaveBeenLastCalledWith(
                false,
                expect.objectContaining({
                    operationId: 42,
                    reason: 'queue-end',
                }),
            );
        } finally {
            queue.cleanupZoomRerenderQueue();
        }
    });

    it('wraps queued zoom rerenders in transaction currentness', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        let activeTransactionId = 0;
        let nextTransactionId = 1;
        const beginTransaction = vi.fn<TQueueTransactionController['beginTransaction']>((options) => {
            activeTransactionId = nextTransactionId;
            nextTransactionId += 1;
            return cast<IPdfViewerTransaction>({
                id: activeTransactionId,
                kind: options.kind,
                source: options.source,
            });
        });
        const advanceTransaction = vi.fn<TQueueTransactionController['advanceTransaction']>((transactionId) => (
            transactionId === activeTransactionId
        ));
        const cancelActiveTransaction = vi.fn<TQueueTransactionController['cancelActiveTransaction']>((_cancellation, transactionId) => {
            if (transactionId === activeTransactionId) {
                activeTransactionId = 0;
            }
            return true;
        });
        const isTransactionCurrent = vi.fn<TQueueTransactionController['isTransactionCurrent']>(transactionId => (
            transactionId === activeTransactionId
        ));
        const reRenderVisiblePagesAndSyncCurrentPage = vi.fn<TQueueOptions['reRenderVisiblePagesAndSyncCurrentPage']>(async () => {});
        const {queue} = createQueueHarness({
            isZoomInteractionLocked: () => false,
            reRenderVisiblePagesAndSyncCurrentPage,
            transactionController: {
                beginTransaction,
                advanceTransaction,
                cancelActiveTransaction,
                isTransactionCurrent,
            },
        });

        try {
            queue.enqueueZoomSync({
                source: 'zoom-gesture-change',
                resizeAnchor: createResizeAnchor(4, 44),
            });

            await flushQueuedRerenderFrame();

            expect(beginTransaction).toHaveBeenCalledWith({
                kind: 'zoom',
                source: 'zoom-gesture',
                page: 4,
                range: {
                    start: 4,
                    end: 4,
                },
                anchor: 'center',
            });
            expect(advanceTransaction).toHaveBeenCalledWith(1, 'render-requested');
            expect(advanceTransaction).toHaveBeenCalledWith(1, 'settled');
            expect(reRenderVisiblePagesAndSyncCurrentPage).toHaveBeenCalledWith(
                expect.not.objectContaining({ transactionId: expect.any(Number) }),
            );
        } finally {
            queue.cleanupZoomRerenderQueue();
        }
    });

    it('waits for 160 ms of accepted-input idle and retains the first gesture anchor', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const {
            queue,
            reRenderVisiblePagesAndSyncCurrentPage,
        } = createQueueHarness({
            performancePolicy: constrainedPerformancePolicy,
            isZoomInteractionLocked: () => true,
        });

        queue.enqueueZoomSync({
            source: 'zoom-gesture-change',
            resizeAnchor: createResizeAnchor(2),
            zoomGestureSessionId: 7,
        });
        await vi.advanceTimersByTimeAsync(159);
        expect(reRenderVisiblePagesAndSyncCurrentPage).not.toHaveBeenCalled();

        queue.enqueueZoomSync({
            source: 'zoom-gesture-change',
            resizeAnchor: createResizeAnchor(9),
            zoomGestureSessionId: 7,
        });
        await vi.advanceTimersByTimeAsync(159);
        expect(reRenderVisiblePagesAndSyncCurrentPage).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();

        expect(reRenderVisiblePagesAndSyncCurrentPage).toHaveBeenCalledOnce();
        expect(reRenderVisiblePagesAndSyncCurrentPage).toHaveBeenCalledWith(
            expect.objectContaining({
                source: 'zoom-gesture-change',
                resizeAnchor: expect.objectContaining({page: 2}),
            }),
        );
        queue.cleanupZoomRerenderQueue();
    });

    it('cancels an idle-once gesture settle when the queue is reset', async () => {
        vi.useFakeTimers();
        const {
            queue,
            reRenderVisiblePagesAndSyncCurrentPage,
        } = createQueueHarness({performancePolicy: constrainedPerformancePolicy});

        queue.enqueueZoomSync({
            source: 'zoom-gesture-change',
            resizeAnchor: createResizeAnchor(2),
            zoomGestureSessionId: 7,
        });
        queue.resetZoomRerenderQueueState('source-change');
        await vi.advanceTimersByTimeAsync(500);

        expect(reRenderVisiblePagesAndSyncCurrentPage).not.toHaveBeenCalled();
        queue.cleanupZoomRerenderQueue();
    });
});
