import type {
    IPdfPage,
    IPdfRenderTask,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createPdfPageRasterScheduler,
    type IPdfRasterDemand,
    type IPdfRasterDocumentFence,
    type IPdfRasterRenderTarget,
    type TPdfRasterLane,
} from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import {
    resetCoordinatedPdfPageRendersForTest,
    runCoordinatedPdfPageOperation,
} from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';
import { createWorkspaceSurfaceBudgetController } from '@app/utils/document-viewer/workspaceSurfaceBudget';
import {
    createPdfRenderSupervisor,
    type IPdfRenderSupervisorEvent,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import { PDF_PAGE_RENDER_TIMEOUT_MS } from '@app/constants/timeouts';
import { cast } from '@tests/helpers/cast';

const documentFence = {
    documentRevision: null,
    documentVersion: 1,
    loadToken: 1,
} satisfies IPdfRasterDocumentFence;

function createTask(promise: Promise<unknown> = Promise.resolve()) {
    return cast<IPdfRenderTask>({
        cancel: vi.fn(),
        promise,
    });
}

function createDemand(
    pageNumber: number,
    lane: TPdfRasterLane,
    generation = 1,
): IPdfRasterDemand {
    return {
        consumerGeneration: generation,
        documentFence,
        estimatedPixels: 100,
        lane,
        ordinal: pageNumber,
        pageNumber,
        renderKey: `${String(generation)}:${String(pageNumber)}`,
        retention: 'render-cache',
    };
}

function createHarness(options: {
    maxConcurrency?: number;
    prepare?: IPdfRasterRenderTarget<{pageNumber: number}>['prepare'];
    surfaceBudgetBytes?: number;
} = {}) {
    const pages = new Map<number, IPdfPage>();
    const released: number[] = [];
    const committed: number[] = [];
    const discarded: number[] = [];
    const started: number[] = [];
    const target: IPdfRasterRenderTarget<{pageNumber: number}> = {
        id: 'target',
        prepare: options.prepare ?? (async demand => ({pageNumber: demand.pageNumber})),
        start: prepared => {
            started.push(prepared.pageNumber);
            return createTask();
        },
        commit: (prepared) => {
            committed.push(prepared.pageNumber);
            return true;
        },
        discard: prepared => discarded.push(prepared.pageNumber),
        release: pageNumber => released.push(pageNumber),
    };
    const scheduler = createPdfPageRasterScheduler({
        documentFence,
        leasePage: async (pageNumber) => ({
            page: pages.get(pageNumber) ?? {pageNumber} as IPdfPage,
            release: vi.fn(),
        }),
        maxConcurrency: options.maxConcurrency ?? 1,
        surfaceBudget: createWorkspaceSurfaceBudgetController(options.surfaceBudgetBytes ?? 1_000_000),
    });
    return {
        committed,
        discarded,
        released,
        scheduler,
        started,
        target,
    };
}

function createRetryingOneShotHarness() {
    const budget = createWorkspaceSurfaceBudgetController(1_000);
    const discard = vi.fn();
    const leaseRelease = vi.fn();
    const signals: AbortSignal[] = [];
    const prepare = vi.fn(async (
        _demand: IPdfRasterDemand,
        _page: IPdfPage,
        signal: AbortSignal,
    ) => {
        signals.push(signal);
        return {pageNumber: 1};
    });
    const start = vi.fn(() => createTask());
    const targetRelease = vi.fn();
    let commitAttempts = 0;
    const scheduler = createPdfPageRasterScheduler({
        documentFence,
        leasePage: async pageNumber => ({
            page: {pageNumber} as IPdfPage,
            release: leaseRelease,
        }),
        surfaceBudget: budget,
    });
    const demand = createDemand(1, 'navigation-target');
    const target: IPdfRasterRenderTarget<{pageNumber: number}> = {
        id: 'retry-pending-navigation',
        prepare,
        start,
        commit: () => {
            commitAttempts += 1;
            return commitAttempts > 1;
        },
        discard,
        release: targetRelease,
    };
    return {
        budget,
        discard,
        getCommitAttempts: () => commitAttempts,
        leaseRelease,
        request: () => scheduler.request({
            sourceId: 'navigation',
            demand,
            target,
        }),
        scheduler,
        prepare,
        signals,
        start,
        targetRelease,
    };
}

async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('PdfPageRasterScheduler', () => {
    afterEach(() => {
        vi.useRealTimers();
        resetCoordinatedPdfPageRendersForTest();
    });

    it('orders navigation and viewport demand ahead of thumbnails and prefetch', async () => {
        const harness = createHarness();
        const demands = [
            createDemand(1, 'prefetch'),
            createDemand(2, 'thumbnail-current'),
            createDemand(3, 'viewport-visible'),
            createDemand(4, 'navigation-target'),
        ];
        harness.scheduler.setDemand({
            sourceId: 'all',
            input: demands,
            policy: {
                expand: input => input,
                compareWithinLane: (left, right) => left.ordinal - right.ordinal,
            },
            target: harness.target,
        });

        await flush();
        await vi.waitFor(() => expect(harness.committed).toHaveLength(4));

        expect(harness.started).toEqual([
            4,
            3,
            2,
            1,
        ]);
    });

    it('deduplicates the same target, page, and render key', async () => {
        const harness = createHarness();
        const demand = createDemand(3, 'viewport-visible');
        const policy = {
            expand: () => [demand],
            compareWithinLane: () => 0,
        };

        harness.scheduler.setDemand({
            sourceId: 'viewport',
            input: null,
            policy,
            target: harness.target,
        });
        harness.scheduler.setDemand({
            sourceId: 'viewport',
            input: null,
            policy,
            target: harness.target,
        });
        await vi.waitFor(() => expect(harness.committed).toEqual([3]));
    });

    it('promotes resident demand and its surface priority without rerendering', async () => {
        const budget = createWorkspaceSurfaceBudgetController(800);
        const externalEvict = vi.fn();
        const start = vi.fn(() => createTask());
        const release = vi.fn();
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as IPdfPage,
                release: vi.fn(),
            }),
            maxConcurrency: 1,
            surfaceBudget: budget,
        });
        const target: IPdfRasterRenderTarget<{pageNumber: number}> = {
            id: 'resident-promotion',
            prepare: async demand => ({pageNumber: demand.pageNumber}),
            start,
            commit: () => true,
            discard: vi.fn(),
            release,
        };
        const setDemand = (demand: IPdfRasterDemand) => scheduler.setDemand({
            sourceId: 'viewport',
            input: [demand],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target,
        });

        setDemand(createDemand(1, 'viewport-nearby'));
        await vi.waitFor(() => expect(scheduler.snapshot().residentPages).toEqual([{
            lane: 'viewport-nearby',
            pageNumber: 1,
            sourceId: 'viewport',
            targetId: 'resident-promotion',
        }]));
        budget.reserve({
            scopeId: 'external',
            category: 'native-preview',
            bytes: 400,
            priority: 400,
            evict: externalEvict,
        });

        setDemand(createDemand(1, 'viewport-visible'));
        budget.setPressureLevel('moderate');

        expect(scheduler.snapshot().residentPages).toEqual([{
            lane: 'viewport-visible',
            pageNumber: 1,
            sourceId: 'viewport',
            targetId: 'resident-promotion',
        }]);
        expect(start).toHaveBeenCalledOnce();
        expect(externalEvict).toHaveBeenCalledOnce();
        expect(release).not.toHaveBeenCalled();
        expect(budget.getSnapshot().reservedBytes).toBe(400);
    });

    it('rejects one-shot requests outside navigation-target', async () => {
        const harness = createHarness();

        await expect(harness.scheduler.request({
            sourceId: 'viewport',
            demand: createDemand(1, 'viewport-visible'),
            target: harness.target,
        })).rejects.toThrow('navigation-target');
    });

    it('preempts lower-priority same-page work and waits for its PDF.js task to settle', async () => {
        const page = {pageNumber: 7} as IPdfPage;
        const lowTask = Promise.withResolvers<undefined>();
        const highTask = Promise.withResolvers<undefined>();
        const cancelLow = vi.fn();
        const starts: string[] = [];
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async () => ({
                page,
                release: vi.fn(),
            }),
            maxConcurrency: 2,
            surfaceBudget: createWorkspaceSurfaceBudgetController(1_000),
        });
        const lowTarget: IPdfRasterRenderTarget<{kind: string}> = {
            id: 'low',
            prepare: async () => ({kind: 'low'}),
            start: () => {
                starts.push('low');
                return cast<IPdfRenderTask>({
                    cancel: cancelLow,
                    promise: lowTask.promise,
                });
            },
            commit: () => true,
            discard: vi.fn(),
            release: vi.fn(),
        };
        const highTarget: IPdfRasterRenderTarget<{kind: string}> = {
            id: 'high',
            prepare: async () => ({kind: 'high'}),
            start: () => {
                starts.push('high');
                return createTask(highTask.promise);
            },
            commit: () => true,
            discard: vi.fn(),
            release: vi.fn(),
        };
        const lowDemand = createDemand(7, 'thumbnail-current');
        scheduler.setDemand({
            sourceId: 'thumbnails',
            input: [lowDemand],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: lowTarget,
        });
        await vi.waitFor(() => expect(starts).toEqual(['low']));

        const highRun = scheduler.request({
            sourceId: 'navigation',
            demand: {
                ...createDemand(7, 'navigation-target'),
                renderKey: 'navigation:7',
            },
            target: highTarget,
        });
        await vi.waitFor(() => expect(cancelLow).toHaveBeenCalledOnce());
        expect(starts).toEqual(['low']);

        lowTask.resolve(undefined);
        await vi.waitFor(() => expect(starts).toEqual([
            'low',
            'high',
        ]));
        highTask.resolve(undefined);
        await expect(highRun).resolves.toMatchObject({status: 'committed'});
    });

    it('releases a page lease exactly once and only after render settlement', async () => {
        const render = Promise.withResolvers<undefined>();
        const release = vi.fn();
        const started = vi.fn();
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as IPdfPage,
                release,
            }),
            surfaceBudget: createWorkspaceSurfaceBudgetController(1_000),
        });
        const outcome = scheduler.request({
            sourceId: 'navigation',
            demand: createDemand(1, 'navigation-target'),
            target: {
                id: 'lease-order',
                prepare: async () => ({}),
                start: () => {
                    started();
                    return createTask(render.promise);
                },
                commit: () => true,
                discard: vi.fn(),
                release: vi.fn(),
            },
        });
        await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
        expect(release).not.toHaveBeenCalled();

        render.resolve(undefined);
        await outcome;
        expect(release).toHaveBeenCalledOnce();
    });

    it('cancels active source work and waits for its task before releasing the lease', async () => {
        const render = Promise.withResolvers<undefined>();
        const release = vi.fn();
        const cancel = vi.fn(() => {
            const error = new Error('cancelled');
            error.name = 'RenderingCancelledException';
            render.reject(error);
        });
        const commit = vi.fn(() => true);
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as IPdfPage,
                release,
            }),
            surfaceBudget: createWorkspaceSurfaceBudgetController(1_000),
        });
        scheduler.setDemand({
            sourceId: 'viewport',
            input: [createDemand(1, 'viewport-visible')],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: {
                id: 'cancel',
                prepare: async () => ({}),
                start: () => cast<IPdfRenderTask>({
                    cancel,
                    promise: render.promise,
                }),
                commit,
                discard: vi.fn(),
                release: vi.fn(),
            },
        });
        await vi.waitFor(() => expect(scheduler.snapshot().inFlightPages).toHaveLength(1));

        await scheduler.cancelSource('viewport');

        expect(cancel).toHaveBeenCalledOnce();
        expect(commit).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
    });

    it('retains the page lease and blocks disposal until cancelled preparation settles', async () => {
        const operatorList = Promise.withResolvers<{
            fnArray: number[];
            argsArray: unknown[][];
        }>();
        const release = vi.fn();
        const prepareStarted = vi.fn();
        const disposeSettled = vi.fn();
        const page = cast<IPdfPage>({
            pageNumber: 1,
            getOperatorList: vi.fn(() => operatorList.promise),
        });
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async () => ({
                page,
                release,
            }),
            surfaceBudget: createWorkspaceSurfaceBudgetController(1_000),
        });
        scheduler.setDemand({
            sourceId: 'viewport',
            input: [createDemand(1, 'viewport-visible')],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: {
                id: 'cancelled-prepare',
                prepare: async (_demand, leasedPage, signal, captureSettlement) => runCoordinatedPdfPageOperation({
                    owner: 'cancelled-prepare',
                    pageNumber: leasedPage.pageNumber,
                    pdfPage: leasedPage,
                    priority: 100,
                    signal,
                    captureSettlement,
                    operation: async () => {
                        prepareStarted();
                        return leasedPage.getOperatorList();
                    },
                }).then(() => null, () => null),
                start: () => createTask(),
                commit: () => true,
                discard: vi.fn(),
                release: vi.fn(),
            },
        });
        await vi.waitFor(() => expect(prepareStarted).toHaveBeenCalledOnce());

        const disposal = scheduler.dispose();
        void disposal.then(disposeSettled);
        await flush();

        expect(release).not.toHaveBeenCalled();
        expect(disposeSettled).not.toHaveBeenCalled();

        operatorList.resolve({
            fnArray: [],
            argsArray: [],
        });
        await disposal;

        expect(release).toHaveBeenCalledOnce();
        expect(disposeSettled).toHaveBeenCalledOnce();
    });

    it('cancels source A without waiting for an active same-page successor from source B', async () => {
        const page = cast<IPdfPage>({pageNumber: 1});
        const operationA = Promise.withResolvers<string>();
        const operationB = Promise.withResolvers<string>();
        const operationAStarted = vi.fn();
        const operationBStarted = vi.fn();
        const leaseReleases = [
            vi.fn(),
            vi.fn(),
        ];
        let leaseIndex = 0;
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async () => ({
                page,
                release: leaseReleases[leaseIndex++]!,
            }),
            maxConcurrency: 2,
            surfaceBudget: createWorkspaceSurfaceBudgetController(1_000),
        });
        const createPreparingTarget = (
            id: string,
            started: () => void,
            operation: Promise<string>,
        ): IPdfRasterRenderTarget<Record<string, never>> => ({
            id,
            prepare: async (_demand, leasedPage, signal, captureSettlement) => runCoordinatedPdfPageOperation({
                owner: id,
                pageNumber: leasedPage.pageNumber,
                pdfPage: leasedPage,
                priority: 100,
                signal,
                captureSettlement,
                operation: async () => {
                    started();
                    await operation;
                    return {};
                },
            }).catch(() => null),
            start: () => createTask(),
            commit: () => true,
            discard: vi.fn(),
            release: vi.fn(),
        });
        const targetA = createPreparingTarget('source-a-target', operationAStarted, operationA.promise);
        const targetB = createPreparingTarget('source-b-target', operationBStarted, operationB.promise);
        const policy = {
            expand: (input: readonly IPdfRasterDemand[]) => input,
            compareWithinLane: () => 0,
        };

        scheduler.setDemand({
            sourceId: 'source-a',
            input: [createDemand(1, 'viewport-visible')],
            policy,
            target: targetA,
        });
        await vi.waitFor(() => expect(operationAStarted).toHaveBeenCalledOnce());
        scheduler.setDemand({
            sourceId: 'source-b',
            input: [{
                ...createDemand(1, 'viewport-visible'),
                renderKey: 'source-b:1',
            }],
            policy,
            target: targetB,
        });
        await vi.waitFor(() => expect(scheduler.snapshot().inFlightPages).toHaveLength(2));

        const sourceACancellation = scheduler.cancelSource('source-a');
        operationA.resolve('source-a-settled');
        await vi.waitFor(() => expect(operationBStarted).toHaveBeenCalledOnce());
        await sourceACancellation;

        expect(leaseReleases[0]).toHaveBeenCalledOnce();
        expect(leaseReleases[1]).not.toHaveBeenCalled();

        const disposalSettled = vi.fn();
        const disposal = scheduler.dispose();
        void disposal.then(disposalSettled);
        await flush();
        expect(disposalSettled).not.toHaveBeenCalled();
        expect(leaseReleases[1]).not.toHaveBeenCalled();

        operationB.resolve('source-b-settled');
        await disposal;
        expect(leaseReleases[1]).toHaveBeenCalledOnce();
        expect(disposalSettled).toHaveBeenCalledOnce();
    });

    it('discards a stale consumer generation without committing it', async () => {
        const prepareGate = Promise.withResolvers<{pageNumber: number} | null>();
        const harness = createHarness({prepare: () => prepareGate.promise});
        harness.scheduler.setDemand({
            sourceId: 'viewport',
            input: [createDemand(1, 'viewport-visible', 1)],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: harness.target,
        });
        await flush();
        harness.scheduler.setDemand({
            sourceId: 'viewport',
            input: [createDemand(1, 'viewport-visible', 2)],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: harness.target,
        });
        prepareGate.resolve({pageNumber: 1});
        await flush();

        expect(harness.committed).toEqual([]);
        expect(harness.discarded).toEqual([1]);
    });

    it('releases a reservation when prepare fails and retries the demand', async () => {
        vi.useFakeTimers();
        let attempts = 0;
        const budget = createWorkspaceSurfaceBudgetController(1_000);
        const harness = createHarness({prepare: async demand => {
            attempts += 1;
            if (attempts === 1) {
                throw new Error('prepare failed');
            }
            return {pageNumber: demand.pageNumber};
        }});
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as IPdfPage,
                release: vi.fn(),
            }),
            maxConcurrency: 1,
            surfaceBudget: budget,
        });
        scheduler.setDemand({
            sourceId: 'viewport',
            input: [createDemand(1, 'viewport-visible')],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: harness.target,
        });
        await flush();
        expect(budget.getSnapshot().reservedBytes).toBe(0);

        await vi.advanceTimersByTimeAsync(16);
        await flush();

        expect(attempts).toBe(2);
        expect(budget.getSnapshot().reservedBytes).toBe(400);
    });

    it('gives up on a permanently rejected commit without leaking a lease or reservation', async () => {
        vi.useFakeTimers();
        const budget = createWorkspaceSurfaceBudgetController(1_000);
        const release = vi.fn();
        const discard = vi.fn();
        let commitAttempts = 0;
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as IPdfPage,
                release,
            }),
            surfaceBudget: budget,
        });
        scheduler.setDemand({
            sourceId: 'viewport',
            input: [createDemand(1, 'viewport-visible')],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: {
                id: 'commit-reject',
                prepare: async () => ({pageNumber: 1}),
                start: () => createTask(),
                commit: () => {
                    commitAttempts += 1;
                    return false;
                },
                discard,
                release: vi.fn(),
            },
        });
        // A target that never accepts must settle rather than spin: once the bounded
        // reattempt window has elapsed, the attempt count stops climbing.
        await vi.advanceTimersByTimeAsync(400);
        const settledAttempts = commitAttempts;
        expect(settledAttempts).toBeGreaterThan(1);
        await vi.advanceTimersByTimeAsync(300);
        expect(commitAttempts).toBe(settledAttempts);

        // Every attempt hands back exactly what it took.
        expect(discard).toHaveBeenCalledTimes(settledAttempts);
        expect(release).toHaveBeenCalledTimes(settledAttempts);
        expect(budget.getSnapshot().reservedBytes).toBe(0);
        expect(scheduler.snapshot().residentPages).toEqual([]);
    });

    // A target declines for reasons that pass: a canvas swapped by a re-render, a
    // render key still settling. Settled work sits in neither the queue nor the
    // resident set, so if the scheduler abandons it the surface stays blank until
    // something republishes demand — which a settled pane never does.
    it('rasters a still-current demand whose first commit was transiently rejected', async () => {
        vi.useFakeTimers();
        const budget = createWorkspaceSurfaceBudgetController(1_000);
        let commitAttempts = 0;
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as IPdfPage,
                release: vi.fn(),
            }),
            surfaceBudget: budget,
        });
        scheduler.setDemand({
            sourceId: 'thumbnails',
            input: [createDemand(1, 'thumbnail-current')],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: {
                id: 'transient-reject',
                prepare: async () => ({pageNumber: 1}),
                start: () => createTask(),
                commit: () => {
                    commitAttempts += 1;
                    return commitAttempts > 1;
                },
                discard: vi.fn(),
                release: vi.fn(),
            },
        });
        await flush();
        await vi.advanceTimersByTimeAsync(16);
        await flush();

        expect(commitAttempts).toBe(2);
        expect(scheduler.snapshot().residentPages).toEqual([{
            lane: 'thumbnail-current',
            pageNumber: 1,
            sourceId: 'thumbnails',
            targetId: 'transient-reject',
        }]);
    });

    it('cancels retry-pending one-shot work before it can commit or retain surface budget', async () => {
        vi.useFakeTimers();
        const harness = createRetryingOneShotHarness();
        const outcome = harness.request();
        await flush();
        await flush();
        expect(harness.getCommitAttempts()).toBe(1);
        expect(harness.leaseRelease).toHaveBeenCalledOnce();

        await harness.scheduler.cancelSource('navigation');
        await vi.advanceTimersByTimeAsync(100);

        await expect(outcome).resolves.toMatchObject({status: 'cancelled'});
        expect(harness.getCommitAttempts()).toBe(1);
        expect(harness.discard).toHaveBeenCalledOnce();
        expect(harness.leaseRelease).toHaveBeenCalledOnce();
        expect(harness.signals[0]?.aborted).toBe(true);
        expect(harness.targetRelease).toHaveBeenCalledOnce();
        expect(harness.scheduler.snapshot()).toMatchObject({
            inFlightPages: [],
            queueDepth: 0,
            reservedPixels: 0,
            residentPages: [],
        });
        expect(harness.budget.getSnapshot().reservedBytes).toBe(0);
    });

    it('invalidates retry-pending one-shot work by source and page', async () => {
        vi.useFakeTimers();
        const harness = createRetryingOneShotHarness();
        const outcome = harness.request();
        await flush();
        await flush();

        harness.scheduler.invalidate({
            pages: [1],
            reason: 'page-replaced',
            sourceId: 'navigation',
        });
        await vi.advanceTimersByTimeAsync(100);

        await expect(outcome).resolves.toMatchObject({status: 'cancelled'});
        expect(harness.getCommitAttempts()).toBe(1);
        expect(harness.leaseRelease).toHaveBeenCalledOnce();
        expect(harness.signals[0]?.aborted).toBe(true);
        expect(harness.targetRelease).toHaveBeenCalledOnce();
        expect(harness.scheduler.snapshot()).toMatchObject({
            inFlightPages: [],
            queueDepth: 0,
            reservedPixels: 0,
            residentPages: [],
        });
        expect(harness.budget.getSnapshot().reservedBytes).toBe(0);
    });

    it('disposes retry-pending one-shot work without leaving a timer or allocation', async () => {
        vi.useFakeTimers();
        const harness = createRetryingOneShotHarness();
        const outcome = harness.request();
        await flush();
        await flush();

        await harness.scheduler.dispose();
        await vi.advanceTimersByTimeAsync(100);

        await expect(outcome).resolves.toMatchObject({status: 'cancelled'});
        expect(harness.getCommitAttempts()).toBe(1);
        expect(harness.leaseRelease).toHaveBeenCalledOnce();
        expect(harness.signals[0]?.aborted).toBe(true);
        expect(harness.targetRelease).toHaveBeenCalledOnce();
        expect(harness.scheduler.snapshot()).toMatchObject({
            accepting: false,
            inFlightPages: [],
            queueDepth: 0,
            reservedPixels: 0,
            residentPages: [],
        });
        expect(harness.budget.getSnapshot().reservedBytes).toBe(0);
    });

    it('cancels one-shot work after its retry timer fires but before the queued retry starts', async () => {
        vi.useFakeTimers();
        const harness = createRetryingOneShotHarness();
        const outcome = harness.request();
        await flush();
        await flush();

        vi.advanceTimersByTime(16);
        await harness.scheduler.cancelSource('navigation');
        await flush();

        await expect(outcome).resolves.toMatchObject({status: 'cancelled'});
        expect(harness.getCommitAttempts()).toBe(1);
        expect(harness.prepare).toHaveBeenCalledOnce();
        expect(harness.signals[0]?.aborted).toBe(true);
        expect(harness.start).toHaveBeenCalledOnce();
        expect(harness.scheduler.snapshot()).toMatchObject({
            inFlightPages: [],
            queueDepth: 0,
            reservedPixels: 0,
            residentPages: [],
        });
        expect(harness.budget.getSnapshot().reservedBytes).toBe(0);
    });

    it('does not start a retry before the previous attempt releases its coordinated page work', async () => {
        vi.useFakeTimers();
        const firstSettlement = Promise.withResolvers<undefined>();
        const leaseReleases = [
            vi.fn(),
            vi.fn(),
        ];
        let leaseCalls = 0;
        let prepareCalls = 0;
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async (pageNumber) => ({
                page: {pageNumber} as IPdfPage,
                release: leaseReleases[leaseCalls++]!,
            }),
            maxConcurrency: 2,
            surfaceBudget: createWorkspaceSurfaceBudgetController(1_000),
        });
        const outcome = scheduler.request({
            sourceId: 'navigation',
            demand: createDemand(1, 'navigation-target'),
            target: {
                id: 'retry-after-settlement',
                prepare: async (_demand, _page, _signal, captureSettlement) => {
                    prepareCalls += 1;
                    if (prepareCalls === 1) {
                        captureSettlement(firstSettlement.promise);
                        return null;
                    }
                    return {pageNumber: 1};
                },
                start: () => createTask(),
                commit: () => true,
                discard: vi.fn(),
                release: vi.fn(),
            },
        });
        await flush();
        expect(prepareCalls).toBe(1);

        await vi.advanceTimersByTimeAsync(16);
        await flush();

        expect(leaseCalls).toBe(1);
        expect(prepareCalls).toBe(1);
        expect(leaseReleases[0]).not.toHaveBeenCalled();

        firstSettlement.resolve(undefined);
        await flush();
        expect(leaseReleases[0]).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(16);
        await flush();

        await expect(outcome).resolves.toMatchObject({status: 'committed'});
        expect(leaseCalls).toBe(2);
        expect(prepareCalls).toBe(2);
        expect(leaseReleases[1]).toHaveBeenCalledOnce();
    });

    it.each([
        {
            expectedStallCalls: 1,
            lane: 'viewport-visible' as const,
        },
        {
            expectedStallCalls: 0,
            lane: 'prefetch' as const,
        },
    ])('cancels a wedged $lane task and uses the bounded retry path', async ({
        expectedStallCalls,
        lane,
    }) => {
        vi.useFakeTimers();
        const budget = createWorkspaceSurfaceBudgetController(1_000);
        const events: IPdfRenderSupervisorEvent[] = [];
        const leaseRelease = vi.fn();
        const onRenderStall = vi.fn();
        const firstRender = Promise.withResolvers<undefined>();
        const firstCancel = vi.fn(() => {
            const error = new Error('watchdog cancellation');
            error.name = 'RenderingCancelledException';
            firstRender.reject(error);
        });
        let startCount = 0;
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as IPdfPage,
                release: leaseRelease,
            }),
            renderSupervisor: createPdfRenderSupervisor({onEvent: event => events.push(event)}),
            surfaceBudget: budget,
        });
        const target: IPdfRasterRenderTarget<{pageNumber: number}> = {
            id: `watchdog-${lane}`,
            prepare: async demand => ({pageNumber: demand.pageNumber}),
            start: () => {
                startCount += 1;
                return startCount === 1
                    ? cast<IPdfRenderTask>({
                        cancel: firstCancel,
                        promise: firstRender.promise,
                    })
                    : createTask();
            },
            commit: () => true,
            discard: vi.fn(),
            onRenderStall,
            release: vi.fn(),
        };
        scheduler.setDemand({
            sourceId: 'viewport',
            input: [createDemand(1, lane)],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target,
        });
        await flush();
        expect(startCount).toBe(1);

        await vi.advanceTimersByTimeAsync(PDF_PAGE_RENDER_TIMEOUT_MS);
        await flush();

        expect(firstCancel).toHaveBeenCalledOnce();
        expect(onRenderStall).toHaveBeenCalledTimes(expectedStallCalls);
        expect(leaseRelease).toHaveBeenCalledOnce();
        expect(budget.getSnapshot().reservedBytes).toBe(0);
        expect(events).toContainEqual(expect.objectContaining({
            cause: 'page-stage-timeout',
            metadata: expect.objectContaining({
                lane,
                pageNumber: 1,
                renderKey: '1:1',
                stage: 'canvas-render',
            }),
        }));

        await vi.advanceTimersByTimeAsync(16);
        await flush();
        expect(startCount).toBe(2);
        expect(scheduler.snapshot().residentPages).toHaveLength(1);
        expect(leaseRelease).toHaveBeenCalledTimes(2);

        await scheduler.dispose();
    });

    it('holds lease and reservation through timeout, replacement, and exact task settlement', async () => {
        vi.useFakeTimers();
        const budget = createWorkspaceSurfaceBudgetController(1_000);
        const leaseRelease = vi.fn();
        const render = Promise.withResolvers<undefined>();
        const cancel = vi.fn();
        const onRenderStall = vi.fn();
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as IPdfPage,
                release: leaseRelease,
            }),
            surfaceBudget: budget,
        });
        const target: IPdfRasterRenderTarget<{pageNumber: number}> = {
            id: 'watchdog-resource-ownership',
            prepare: async demand => ({pageNumber: demand.pageNumber}),
            start: () => cast<IPdfRenderTask>({
                cancel,
                promise: render.promise,
            }),
            commit: () => true,
            discard: vi.fn(),
            onRenderStall,
            release: vi.fn(),
        };
        const setDemand = (demands: IPdfRasterDemand[]) => scheduler.setDemand({
            sourceId: 'viewport',
            input: demands,
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target,
        });
        setDemand([createDemand(1, 'viewport-visible')]);
        await flush();

        await vi.advanceTimersByTimeAsync(PDF_PAGE_RENDER_TIMEOUT_MS);
        await flush();
        expect(cancel).toHaveBeenCalledOnce();
        expect(onRenderStall).toHaveBeenCalledOnce();
        expect(leaseRelease).not.toHaveBeenCalled();
        expect(budget.getSnapshot().reservedBytes).toBe(400);

        setDemand([]);
        await flush();
        expect(cancel).toHaveBeenCalledOnce();
        expect(leaseRelease).not.toHaveBeenCalled();
        expect(budget.getSnapshot().reservedBytes).toBe(400);

        const cancellation = new Error('late cancellation settlement');
        cancellation.name = 'RenderingCancelledException';
        render.reject(cancellation);
        await flush();
        expect(leaseRelease).toHaveBeenCalledOnce();
        expect(budget.getSnapshot().reservedBytes).toBe(0);

        await scheduler.dispose();
    });

    it('awaits a retry execution admitted as its timer fires during source cancellation', async () => {
        vi.useFakeTimers();
        const budget = createWorkspaceSurfaceBudgetController(1_000);
        const retryLease = Promise.withResolvers<{
            page: IPdfPage;
            release: () => void;
        }>();
        const firstLeaseRelease = vi.fn();
        const retryLeaseRelease = vi.fn();
        let leaseCalls = 0;
        let commitAttempts = 0;
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: (pageNumber) => {
                leaseCalls += 1;
                if (leaseCalls === 2) {
                    return retryLease.promise;
                }
                return Promise.resolve({
                    page: {pageNumber} as IPdfPage,
                    release: firstLeaseRelease,
                });
            },
            surfaceBudget: budget,
        });
        const outcome = scheduler.request({
            sourceId: 'navigation',
            demand: createDemand(1, 'navigation-target'),
            target: {
                id: 'retry-admission-race',
                prepare: async () => ({pageNumber: 1}),
                start: () => createTask(),
                commit: () => {
                    commitAttempts += 1;
                    return false;
                },
                discard: vi.fn(),
                release: vi.fn(),
            },
        });
        await flush();
        await flush();
        expect(commitAttempts).toBe(1);

        await vi.advanceTimersByTimeAsync(16);
        await flush();
        expect(leaseCalls).toBe(2);
        const cancellationSettled = vi.fn();
        const cancellation = scheduler.cancelSource('navigation');
        void cancellation.then(cancellationSettled, cancellationSettled);
        await flush();
        expect(cancellationSettled).not.toHaveBeenCalled();

        retryLease.resolve({
            page: {pageNumber: 1} as IPdfPage,
            release: retryLeaseRelease,
        });
        await cancellation;

        await expect(outcome).resolves.toMatchObject({status: 'cancelled'});
        expect(commitAttempts).toBe(1);
        expect(firstLeaseRelease).toHaveBeenCalledOnce();
        expect(retryLeaseRelease).toHaveBeenCalledOnce();
        expect(cancellationSettled).toHaveBeenCalledOnce();
        expect(scheduler.snapshot()).toMatchObject({
            inFlightPages: [],
            queueDepth: 0,
            reservedPixels: 0,
            residentPages: [],
        });
        expect(budget.getSnapshot().reservedBytes).toBe(0);
    });

    it('joins duplicate one-shot requests while their shared retry is pending', async () => {
        vi.useFakeTimers();
        const harness = createRetryingOneShotHarness();
        const firstOutcome = harness.request();
        await flush();
        await flush();

        const duplicateOutcome = harness.request();
        await vi.advanceTimersByTimeAsync(16);
        await flush();

        await expect(Promise.all([
            firstOutcome,
            duplicateOutcome,
        ])).resolves.toEqual([
            expect.objectContaining({status: 'committed'}),
            expect.objectContaining({status: 'committed'}),
        ]);
        expect(harness.getCommitAttempts()).toBe(2);
        expect(harness.prepare).toHaveBeenCalledTimes(2);
        expect(harness.start).toHaveBeenCalledTimes(2);
        expect(harness.scheduler.snapshot()).toMatchObject({
            inFlightPages: [],
            queueDepth: 0,
            reservedPixels: 100,
            residentPages: [{
                lane: 'navigation-target',
                pageNumber: 1,
                sourceId: 'navigation',
                targetId: 'retry-pending-navigation',
            }],
        });
        expect(harness.budget.getSnapshot().reservedBytes).toBe(400);

        await harness.scheduler.dispose();
        expect(harness.budget.getSnapshot().reservedBytes).toBe(0);
    });

    it('evicts prefetch residency before required viewport residency', async () => {
        const budget = createWorkspaceSurfaceBudgetController(800);
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as IPdfPage,
                release: vi.fn(),
            }),
            maxConcurrency: 1,
            surfaceBudget: budget,
        });
        const target: IPdfRasterRenderTarget<{pageNumber: number}> = {
            id: 'budget-order',
            prepare: async demand => ({pageNumber: demand.pageNumber}),
            start: () => createTask(),
            commit: () => true,
            discard: vi.fn(),
            release: vi.fn(),
        };
        const setOne = (sourceId: string, demand: IPdfRasterDemand) => {
            scheduler.setDemand({
                sourceId,
                input: [demand],
                policy: {
                    expand: input => input,
                    compareWithinLane: () => 0,
                },
                target,
            });
        };
        setOne('required-1', createDemand(1, 'viewport-visible'));
        await vi.waitFor(() => expect(scheduler.snapshot().residentPages).toHaveLength(1));
        setOne('prefetch-2', createDemand(2, 'prefetch'));
        await vi.waitFor(() => expect(scheduler.snapshot().residentPages).toHaveLength(2));
        setOne('required-3', createDemand(3, 'viewport-visible'));
        await vi.waitFor(() => expect(
            scheduler.snapshot().residentPages.map(entry => entry.pageNumber).sort(),
        ).toEqual([
            1,
            3,
        ]));

        expect(budget.getSnapshot().reservedBytes).toBe(800);
    });

    it('admits every required visible page while releasing overflow when visibility contracts', async () => {
        const budget = createWorkspaceSurfaceBudgetController(800);
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as IPdfPage,
                release: vi.fn(),
            }),
            maxConcurrency: 1,
            surfaceBudget: budget,
        });
        const target: IPdfRasterRenderTarget<{pageNumber: number}> = {
            id: 'required-overflow',
            prepare: async demand => ({pageNumber: demand.pageNumber}),
            start: () => createTask(),
            commit: () => true,
            discard: vi.fn(),
            release: vi.fn(),
        };
        const setVisible = (pages: number[]) => scheduler.setDemand({
            sourceId: 'viewport',
            input: pages.map(page => createDemand(page, 'viewport-visible')),
            policy: {
                expand: input => input,
                compareWithinLane: (left, right) => left.pageNumber - right.pageNumber,
            },
            target,
        });

        setVisible([
            1,
            2,
            3,
        ]);
        await vi.waitFor(() => expect(scheduler.snapshot().residentPages).toHaveLength(3));
        expect(budget.getSnapshot().reservedBytes).toBe(1_200);

        setVisible([3]);
        await vi.waitFor(() => expect(scheduler.snapshot().residentPages).toEqual([{
            lane: 'viewport-visible',
            pageNumber: 3,
            sourceId: 'viewport',
            targetId: 'required-overflow',
        }]));
        expect(budget.getSnapshot().reservedBytes).toBe(400);
    });

    it('cancels viewport and thumbnail work on rapid source replacement', async () => {
        const renders = new Map<number, ReturnType<typeof Promise.withResolvers<undefined>>>();
        const cancelled: number[] = [];
        const committed: number[] = [];
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as IPdfPage,
                release: vi.fn(),
            }),
            maxConcurrency: 2,
            surfaceBudget: createWorkspaceSurfaceBudgetController(2_000),
        });
        const target: IPdfRasterRenderTarget<{pageNumber: number}> = {
            id: 'replacement',
            prepare: async demand => ({pageNumber: demand.pageNumber}),
            start: ({pageNumber}) => {
                if (pageNumber > 2) {
                    return createTask();
                }
                const render = Promise.withResolvers<undefined>();
                renders.set(pageNumber, render);
                return cast<IPdfRenderTask>({
                    cancel: () => {
                        cancelled.push(pageNumber);
                        const error = new Error('replaced');
                        error.name = 'RenderingCancelledException';
                        render.reject(error);
                    },
                    promise: render.promise,
                });
            },
            commit: ({pageNumber}) => {
                committed.push(pageNumber);
                return true;
            },
            discard: vi.fn(),
            release: vi.fn(),
        };
        const setSource = (
            sourceId: string,
            demand: IPdfRasterDemand,
        ) => scheduler.setDemand({
            sourceId,
            input: [demand],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target,
        });
        setSource('viewport', createDemand(1, 'viewport-visible'));
        setSource('thumbnails', createDemand(2, 'thumbnail-visible'));
        await vi.waitFor(() => expect(renders.size).toBe(2));

        setSource('viewport', createDemand(3, 'viewport-visible', 2));
        setSource('thumbnails', createDemand(4, 'thumbnail-current', 2));
        await vi.waitFor(() => expect(committed.sort()).toEqual([
            3,
            4,
        ]));

        expect(cancelled.sort()).toEqual([
            1,
            2,
        ]);
    });

    it('releases its surface scope once across concurrent disposal after a whole-document invalidation', async () => {
        const budget = createWorkspaceSurfaceBudgetController(1_000);
        const releaseScope = vi.spyOn(budget, 'releaseScope');
        const render = Promise.withResolvers<undefined>();
        const cancel = vi.fn();
        const release = vi.fn();
        const started: number[] = [];
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as IPdfPage,
                release,
            }),
            maxConcurrency: 1,
            surfaceBudget: budget,
        });
        scheduler.setDemand({
            sourceId: 'viewport',
            input: [createDemand(1, 'viewport-visible')],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: {
                id: 'wedged-render',
                prepare: async demand => ({pageNumber: demand.pageNumber}),
                start: ({pageNumber}) => {
                    started.push(pageNumber);
                    return cast<IPdfRenderTask>({
                        cancel,
                        promise: render.promise,
                    });
                },
                commit: () => true,
                discard: vi.fn(),
                release: vi.fn(),
            },
        });
        await vi.waitFor(() => expect(started).toEqual([1]));
        expect(budget.getSnapshot().reservedBytes).toBe(400);

        scheduler.invalidate({
            documentFence,
            reason: 'document-reloaded',
        });
        expect(scheduler.snapshot().accepting).toBe(false);

        let disposed = false;
        const disposals = Promise.all([
            scheduler.dispose(),
            scheduler.dispose(),
        ]).then(() => {
            disposed = true;
        });
        await flush();

        expect(disposed).toBe(false);
        expect(cancel).toHaveBeenCalledOnce();
        expect(release).not.toHaveBeenCalled();
        expect(releaseScope).not.toHaveBeenCalled();

        render.resolve(undefined);
        await disposals;
        await scheduler.dispose();

        expect(release).toHaveBeenCalledOnce();
        expect(releaseScope).toHaveBeenCalledOnce();
        expect(budget.getSnapshot()).toMatchObject({
            leaseCount: 0,
            reservedBytes: 0,
        });
    });

    it('reclaims a cancelled preparation budget without releasing its page lease', async () => {
        const budget = createWorkspaceSurfaceBudgetController(800);
        const wedgedPrepare = Promise.withResolvers<{pageNumber: number} | null>();
        const releaseA = vi.fn();
        const schedulerA = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as IPdfPage,
                release: releaseA,
            }),
            maxConcurrency: 1,
            surfaceBudget: budget,
        });
        const targetA: IPdfRasterRenderTarget<{pageNumber: number}> = {
            id: 'a',
            prepare: () => wedgedPrepare.promise,
            start: () => createTask(),
            commit: () => true,
            discard: vi.fn(),
            release: vi.fn(),
        };
        schedulerA.setDemand({
            sourceId: 'viewport-a',
            input: [createDemand(1, 'viewport-visible')],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: targetA,
        });
        await flush();
        expect(budget.getSnapshot().reservedBytes).toBe(400);

        schedulerA.invalidate({
            documentFence,
            reason: 'document-a-invalidated',
        });
        expect(budget.getSnapshot().reservedBytes).toBe(0);
        expect(releaseA).not.toHaveBeenCalled();

        const fenceB = {
            ...documentFence,
            documentVersion: 2,
            loadToken: 2,
        };
        const committedB = vi.fn(() => true);
        const schedulerB = createPdfPageRasterScheduler({
            documentFence: fenceB,
            leasePage: async pageNumber => ({
                page: {pageNumber} as IPdfPage,
                release: vi.fn(),
            }),
            maxConcurrency: 1,
            surfaceBudget: budget,
        });
        const demandB = {
            ...createDemand(2, 'viewport-visible'),
            documentFence: fenceB,
        };
        schedulerB.setDemand({
            sourceId: 'viewport-b',
            input: [demandB],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: {
                ...targetA,
                id: 'b',
                prepare: async () => ({pageNumber: 2}),
                commit: committedB,
            },
        });
        await vi.waitFor(() => expect(committedB).toHaveBeenCalledOnce());

        expect(budget.getSnapshot().reservedBytes).toBe(400);
        expect(schedulerB.snapshot()).toMatchObject({
            queueDepth: 0,
            inFlightPages: [],
            residentPages: [{
                pageNumber: 2,
                sourceId: 'viewport-b',
            }],
        });

        wedgedPrepare.resolve(null);
        await schedulerA.dispose();
        expect(releaseA).toHaveBeenCalledOnce();
        await schedulerB.dispose();
    });
});
