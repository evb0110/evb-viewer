import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IDocumentSurfaceLease} from '@app/utils/document-viewer/source/documentPageSource';
import {
    createDocumentThumbnailScheduler,
    type IDocumentThumbnailDemand,
} from '@app/utils/document-viewer/thumbnails/documentThumbnailScheduler';

interface IDeferred<T> {
    promise: Promise<T>;
    reject: (reason: unknown) => void;
    resolve: (value: T) => void;
}

function deferred<T>(): IDeferred<T> {
    let reject!: (reason: unknown) => void;
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve, nextReject) => {
        reject = nextReject;
        resolve = nextResolve;
    });
    return {
        promise,
        reject,
        resolve,
    };
}

function demand(
    pageNumber: number,
    widthPx: number,
    rank = 1,
): IDocumentThumbnailDemand {
    return {
        distance: pageNumber,
        pageNumber,
        priority: rank === 0 ? 'navigation' : 'visible',
        quality: 'settled',
        rank,
        widthPx,
    };
}

function lease(widthPx: number, release = vi.fn()): IDocumentSurfaceLease {
    return {
        bytes: widthPx * 2,
        heightPx: widthPx * 2,
        release,
        surface: `thumbnail-${String(widthPx)}`,
        widthPx,
    };
}

/**
 * A provider that answers every request with the same native raster and leaves
 * every call past `cap` unanswered. A scheduler that does not recognise its own
 * commit re-queues the page as soon as a render settles, so answering forever
 * spins that loop until the worker dies of a heap error; leaving the over-cap
 * call open parks the loop instead. Awaiting this helper's `whenIdle` rather
 * than the scheduler's is what makes the parked call visible: it races idleness
 * against an error that fires the moment the cap trips, so a scheduler that
 * re-queues committed work fails the scenario by name instead of hanging it
 * until the suite times out.
 */
function cappedLeaseRender(widthPx: number, cap: number, release = vi.fn()) {
    let calls = 0;
    let reportRunaway!: (error: Error) => void;
    const runaway = new Promise<never>((_resolve, reject) => {
        reportRunaway = reject;
    });
    // Nothing awaits the signal until a scenario races it, and a scenario that
    // stays under the cap never does; keep that from surfacing as an unhandled
    // rejection.
    void runaway.catch(() => undefined);
    const render = vi.fn(async () => {
        calls += 1;
        if (calls > cap) {
            reportRunaway(new Error(
                `render was called ${String(calls)} times for a ${String(cap)}-call scenario: `
                + 'the scheduler is re-queueing work it already committed',
            ));
            return new Promise<never>(() => undefined);
        }
        return lease(widthPx, release);
    });
    return {
        render,
        /** Scheduler idle, or the cap's failure, whichever comes first. */
        whenIdle: (scheduler: {whenIdle: () => Promise<void>}) => Promise.race([
            scheduler.whenIdle(),
            runaway,
        ]),
    };
}

interface IRenderRequest {
    pageNumber: number;
    signal: AbortSignal;
}

describe('createDocumentThumbnailScheduler', () => {
    it('frees a slot when a render ignores its abort signal', async () => {
        vi.useFakeTimers();
        const schedulerHolder: {scheduler: ReturnType<typeof createDocumentThumbnailScheduler> | null} = {scheduler: null};
        const aborted = vi.fn(() => schedulerHolder.scheduler?.reconcile([demand(2, 128)]));
        const render = vi.fn((request: IRenderRequest) => {
            const pageNumber = request.pageNumber;
            const signal = request.signal;
            signal.addEventListener('abort', aborted, {once: true});
            return pageNumber === 1
                ? new Promise<IDocumentSurfaceLease>(() => undefined)
                : Promise.resolve(lease(128));
        });
        const scheduler = createDocumentThumbnailScheduler({
            maxConcurrency: 1,
            onStateChange: vi.fn(),
            prepareSurface: vi.fn(async () => undefined),
            render,
            renderTimeoutMs: 100,
        });
        schedulerHolder.scheduler = scheduler;

        scheduler.reconcile([
            demand(1, 128),
            demand(2, 128),
        ]);
        const idle = scheduler.whenIdle();

        await vi.advanceTimersByTimeAsync(100);
        await expect(idle).resolves.toBeUndefined();
        expect(aborted).toHaveBeenCalledOnce();
        expect(render.mock.calls.map(([request]) => request.pageNumber)).toEqual([
            1,
            2,
        ]);
        expect(scheduler.getSnapshot().activeCount).toBe(0);
        scheduler.dispose();
        vi.useRealTimers();
    });

    it('schedules navigation before nearby work and respects the concurrency limit', async () => {
        const pending: Array<IDeferred<IDocumentSurfaceLease>> = [];
        const started: number[] = [];
        const scheduler = createDocumentThumbnailScheduler({
            maxConcurrency: 1,
            onStateChange: vi.fn(),
            prepareSurface: vi.fn(async () => undefined),
            render: vi.fn(request => {
                started.push(request.pageNumber);
                const item = deferred<IDocumentSurfaceLease>();
                pending.push(item);
                return item.promise;
            }),
        });

        scheduler.reconcile([
            demand(40, 128, 2),
            demand(12, 128, 0),
            demand(13, 128, 1),
        ]);
        expect(started).toEqual([12]);
        expect(scheduler.getSnapshot().activeCount).toBe(1);

        pending[0]!.resolve(lease(128));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(started[1]).toBe(13);
        scheduler.dispose();
    });

    it('releases a cancelled stale lease once and commits only the replacement', async () => {
        const pending: Array<IDeferred<IDocumentSurfaceLease>> = [];
        const releases = [
            vi.fn(),
            vi.fn(),
        ];
        const committed: number[] = [];
        const scheduler = createDocumentThumbnailScheduler({
            maxConcurrency: 1,
            onStateChange(_page, state) {
                if (state) committed.push(state.widthPx);
            },
            prepareSurface: vi.fn(async (_lease, signal) => signal.throwIfAborted()),
            render: vi.fn(() => {
                const item = deferred<IDocumentSurfaceLease>();
                pending.push(item);
                return item.promise;
            }),
        });

        scheduler.reconcile([demand(1, 128)]);
        scheduler.reconcile([demand(1, 256)]);
        pending[0]!.resolve(lease(128, releases[0]));
        await Promise.resolve();
        await Promise.resolve();
        expect(pending).toHaveLength(2);
        pending[1]!.resolve(lease(256, releases[1]));
        await scheduler.whenIdle();

        expect(committed).toEqual([256]);
        expect(releases[0]).toHaveBeenCalledTimes(1);
        expect(releases[1]).not.toHaveBeenCalled();
        scheduler.dispose();
        expect(releases[1]).toHaveBeenCalledTimes(1);
    });

    it('releases retained leases exactly once when demand disappears', async () => {
        const release = vi.fn();
        const scheduler = createDocumentThumbnailScheduler({
            maxConcurrency: 2,
            onStateChange: vi.fn(),
            prepareSurface: vi.fn(async () => undefined),
            render: vi.fn(async () => lease(128, release)),
        });

        scheduler.reconcile([demand(7, 128)]);
        await scheduler.whenIdle();
        scheduler.reconcile([]);
        scheduler.dispose();

        expect(release).toHaveBeenCalledTimes(1);
    });

    it('retries a failed page until the caller drops it from demand', async () => {
        const reported: number[] = [];
        const committed: number[] = [];
        const render = vi.fn(async (request: {
            pageNumber: number;
            widthPx: number;
        }) => {
            if (request.pageNumber !== 5) {
                return lease(request.widthPx);
            }
            throw new Error('render failed');
        });
        // eslint-disable-next-line prefer-const
        let scheduler: ReturnType<typeof createDocumentThumbnailScheduler>;
        const onError = vi.fn((_error: unknown, failedDemand: IDocumentThumbnailDemand) => {
            reported.push(failedDemand.pageNumber);
            expect(failedDemand.widthPx).toBe(128);
            // The scheduler re-queues a failed page as soon as this returns, so the
            // caller has to withdraw the demand here to stop the retries.
            if (reported.length >= 3) scheduler.reconcile([demand(6, 128)]);
        });
        scheduler = createDocumentThumbnailScheduler({
            maxConcurrency: 1,
            onError,
            onStateChange: (pageNumber, state) => {
                if (state) committed.push(pageNumber);
            },
            prepareSurface: vi.fn(async () => undefined),
            render,
        });

        scheduler.reconcile([
            demand(5, 128),
            demand(6, 128),
        ]);
        await scheduler.whenIdle();

        expect(reported).toEqual([
            5,
            5,
            5,
        ]);
        expect(render.mock.calls.filter(([request]) => request.pageNumber === 5)).toHaveLength(3);
        expect(committed).toEqual([6]);
        scheduler.dispose();
    });

    it('reports the requested width alongside the leased raster it committed', async () => {
        const states: Array<{
            requestWidthPx: number;
            widthPx: number;
        }> = [];
        const provider = cappedLeaseRender(180, 2);
        const scheduler = createDocumentThumbnailScheduler({
            maxConcurrency: 1,
            onStateChange: (_pageNumber, state) => {
                if (state) {
                    states.push({
                        requestWidthPx: state.requestWidthPx,
                        widthPx: state.widthPx,
                    });
                }
            },
            prepareSurface: vi.fn(async () => undefined),
            // A provider that answers a 256 px request with a 180 px native raster.
            render: provider.render,
        });

        scheduler.reconcile([demand(2, 256)]);
        await provider.whenIdle(scheduler);

        // Callers need the requested width to tell a satisfied demand from a
        // pending upgrade; the leased width alone cannot say which one it is.
        expect(states).toEqual([{
            requestWidthPx: 256,
            widthPx: 180,
        }]);
        scheduler.dispose();
    });

    it('does not report a render that fails after its cancellation', async () => {
        const onError = vi.fn();
        const onStateChange = vi.fn();
        const pending: Array<IDeferred<IDocumentSurfaceLease>> = [];
        const scheduler = createDocumentThumbnailScheduler({
            maxConcurrency: 1,
            onError,
            onStateChange,
            prepareSurface: vi.fn(async () => undefined),
            render: vi.fn(() => {
                const item = deferred<IDocumentSurfaceLease>();
                pending.push(item);
                return item.promise;
            }),
        });

        scheduler.reconcile([demand(4, 128)]);
        scheduler.reset();
        // A provider that notices the abort late rejects with an ordinary error
        // rather than an AbortError; the cancellation still owns the outcome.
        pending[0]!.reject(new Error('render failed after cancellation'));
        await scheduler.whenIdle();

        expect(onError).not.toHaveBeenCalled();
        expect(onStateChange).not.toHaveBeenCalled();
        scheduler.dispose();
    });

    it('treats the requested bucket as settled when a provider returns a smaller native raster', async () => {
        const release = vi.fn();
        const provider = cappedLeaseRender(180, 4, release);
        const scheduler = createDocumentThumbnailScheduler({
            maxConcurrency: 1,
            onStateChange: vi.fn(),
            prepareSurface: vi.fn(async () => undefined),
            render: provider.render,
        });

        scheduler.reconcile([demand(3, 256)]);
        await provider.whenIdle(scheduler);
        scheduler.reconcile([demand(3, 256)]);
        await provider.whenIdle(scheduler);

        // Asking again for the width the committed render asked for is settled
        // work, which is what lets a caller park a page it has stopped retrying
        // on its existing surface instead of losing it.
        expect(provider.render).toHaveBeenCalledTimes(1);
        expect(release).not.toHaveBeenCalled();
        expect(scheduler.getSnapshot().committedPages).toEqual([3]);

        // The leased raster width is a different demand from the one that
        // committed, so parking a page there would start a render instead.
        scheduler.reconcile([demand(3, 180)]);
        await provider.whenIdle(scheduler);

        expect(provider.render).toHaveBeenCalledTimes(2);
        scheduler.dispose();
    });
});
