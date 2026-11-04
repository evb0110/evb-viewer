import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    JobBroker,
    type IJobBrokerRequest,
    MAIN_JOB_BROKER_INTERACTIVE_RESERVE,
    MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES,
    MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES,
    resolveMainJobBrokerCapacity,
} from '@electron/resources/jobBroker';
import type {
    IHostResourceProfileSnapshot,
    THostResourceTier,
} from '@contracts/hostResourceProfile';

const CAPACITY = {
    cpuTokens: 2,
    estimatedResidentBytes: 200,
    nativeProcesses: 2,
    ioWeight: 2,
};
const GIB = 1024 ** 3;

function createResourceProfile(
    logicalCpus: number,
    totalRamBytes: number,
    tier: THostResourceTier,
): IHostResourceProfileSnapshot {
    return {
        logicalCpus,
        totalRamBytes,
        safeMode: false,
        detectedTier: tier,
        performanceMode: 'auto',
        tier,
    };
}

function createRequest(overrides: Partial<IJobBrokerRequest> = {}): IJobBrokerRequest {
    return {
        ownerId: 'renderer-1',
        kind: 'preview',
        priority: 'user',
        resources: {
            cpuTokens: 1,
            estimatedResidentBytes: 100,
            nativeProcesses: 1,
            ioWeight: 1,
        },
        ...overrides,
    };
}

describe('JobBroker', () => {
    it.each([
        1,
        2,
        4,
        6,
        8,
    ])('admits the largest supported single job on a %i-CPU host', async (cpuCount) => {
        const capacity = resolveMainJobBrokerCapacity(
            createResourceProfile(cpuCount, 8 * GIB, 'low'),
        );
        const broker = new JobBroker(capacity);
        const lease = await broker.acquire(createRequest({resources: {...MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES}}));

        expect(capacity.cpuTokens).toBeGreaterThanOrEqual(MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.cpuTokens);
        expect(capacity.estimatedResidentBytes).toBeGreaterThanOrEqual(MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.estimatedResidentBytes);
        expect(capacity.nativeProcesses).toBeGreaterThanOrEqual(MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.nativeProcesses);
        expect(capacity.ioWeight).toBeGreaterThanOrEqual(MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.ioWeight);
        expect(lease.release()).toBe(true);
    });

    it('preserves medium and high capacity formulas while applying tier floors', () => {
        expect(resolveMainJobBrokerCapacity(
            createResourceProfile(3, 16 * GIB, 'medium'),
        )).toEqual({
            cpuTokens: 2,
            estimatedResidentBytes: 13.6 * GIB,
            nativeProcesses: 2,
            ioWeight: 4,
        });
        expect(resolveMainJobBrokerCapacity(
            createResourceProfile(8, 16 * GIB, 'high'),
        )).toEqual({
            cpuTokens: 6,
            estimatedResidentBytes: 13.6 * GIB,
            nativeProcesses: 4,
            ioWeight: 4,
        });
    });

    it.each([
        [
            'auto',
            6,
        ],
        [
            'low',
            2,
        ],
    ] as const)('uses the %s CPU budget on a RAM-limited host without changing other budgets', async (performanceMode, cpuTokens) => {
        const capacity = resolveMainJobBrokerCapacity({
            ...createResourceProfile(8, 8 * GIB, 'low'),
            performanceMode,
        });
        expect(capacity).toEqual({
            cpuTokens,
            estimatedResidentBytes: 6.8 * GIB,
            nativeProcesses: 2,
            ioWeight: 4,
        });
        const broker = new JobBroker(capacity, {
            maxInteractiveJobResources: MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES,
            interactiveReserve: MAIN_JOB_BROKER_INTERACTIVE_RESERVE,
        });
        const page = await broker.acquire(createRequest({resources: capacity}));
        const queuedPage = broker.acquire(createRequest({ownerId: 'second-page'}));
        const interactive = await broker.acquire(createRequest({
            ownerId: 'visible-page',
            admissionClass: 'interactive',
            resources: MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES,
        }));
        expect(broker.getSnapshot()).toMatchObject({
            active: 2,
            queued: 1,
            usedBulk: capacity,
        });
        interactive.release();
        page.release();
        (await queuedPage).release();
        expect(broker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

    it('keeps nested native-process leases admissible on the low tier', async () => {
        const broker = new JobBroker(resolveMainJobBrokerCapacity(
            createResourceProfile(2, 4 * GIB, 'low'),
        ));
        const outer = await broker.acquire({
            ownerId: 'djvu-job',
            kind: 'djvu-output',
            priority: 'user',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 1,
                nativeProcesses: 1,
                ioWeight: 1,
            },
        });
        const inner = await broker.acquire({
            ownerId: 'djvu-job',
            kind: 'djvu-conversion',
            priority: 'user',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 1,
                nativeProcesses: 1,
                ioWeight: 1,
            },
        });
        inner.release();
        outer.release();
    });

    it('reconfigures capacity only before work is admitted', async () => {
        const broker = new JobBroker(CAPACITY);
        broker.reconfigureCapacity({
            ...CAPACITY,
            cpuTokens: 1,
        });
        expect(broker.getSnapshot().capacity.cpuTokens).toBe(1);

        const lease = await broker.acquire(createRequest());
        expect(() => broker.reconfigureCapacity(CAPACITY))
            .toThrow('cannot be reconfigured after work is admitted');
        lease.release();
    });

    it('holds work until the full resource vector is available', async () => {
        const broker = new JobBroker(CAPACITY);
        const first = await broker.acquire(createRequest({resources: CAPACITY}));
        let secondGranted = false;
        const secondPromise = broker.acquire(createRequest()).then((lease) => {
            secondGranted = true;
            return lease;
        });

        await Promise.resolve();
        expect(secondGranted).toBe(false);
        expect(first.release()).toBe(true);
        const second = await secondPromise;
        expect(secondGranted).toBe(true);
        expect(second.release()).toBe(true);
    });

    it.each([
        [
            2,
            'low',
        ],
        [
            4,
            'low',
        ],
        [
            8,
            'medium',
        ],
        [
            11,
            'high',
        ],
        [
            16,
            'high',
        ],
    ] as const)('preserves the interactive document lifecycle above full bulk capacity on %i-CPU %s hosts', async (
        logicalCpus,
        tier,
    ) => {
        const capacity = resolveMainJobBrokerCapacity(createResourceProfile(
            logicalCpus,
            16 * GIB,
            tier,
        ));
        const broker = new JobBroker(capacity, {
            maxInteractiveJobResources: MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES,
            interactiveReserve: MAIN_JOB_BROKER_INTERACTIVE_RESERVE,
        });
        const bulk = await broker.acquire(createRequest({
            ownerId: 'bulk-tab',
            kind: 'bulk-operation',
            resources: capacity,
        }));

        const workingCopy = await broker.acquire(createRequest({
            ownerId: 'document-tab',
            kind: 'pdf-working-copy',
            priority: 'foreground',
            admissionClass: 'interactive',
            resources: {
                cpuTokens: 0,
                estimatedResidentBytes: 64 * 1024 * 1024,
                nativeProcesses: 0,
                ioWeight: 1,
            },
        }));
        const fingerprint = await broker.acquire(createRequest({
            ownerId: 'document-tab',
            kind: 'document-save-utility',
            priority: 'foreground',
            admissionClass: 'interactive',
            resources: MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES,
        }));
        expect(broker.getSnapshot()).toMatchObject({
            active: 3,
            queued: 0,
            usedBulk: capacity,
        });
        fingerprint.release();
        workingCopy.release();
        bulk.release();
    });

    it('keeps the interactive burst bounded to two reserved slots', async () => {
        const interactiveSlot = {
            cpuTokens: 1,
            estimatedResidentBytes: 100,
            nativeProcesses: 1,
            ioWeight: 1,
        };
        const broker = new JobBroker(CAPACITY, {
            maxInteractiveJobResources: interactiveSlot,
            interactiveReserve: {
                cpuTokens: 2,
                estimatedResidentBytes: 200,
                nativeProcesses: 2,
                ioWeight: 2,
            },
        });
        const bulk = await broker.acquire(createRequest({
            ownerId: 'bulk-tab',
            resources: CAPACITY,
        }));
        const first = await broker.acquire(createRequest({
            ownerId: 'interactive-1',
            admissionClass: 'interactive',
        }));
        const second = await broker.acquire(createRequest({
            ownerId: 'interactive-2',
            admissionClass: 'interactive',
        }));
        let thirdGranted = false;
        const thirdPromise = broker.acquire(createRequest({
            ownerId: 'interactive-3',
            admissionClass: 'interactive',
        })).then((lease) => {
            thirdGranted = true;
            return lease;
        });

        await Promise.resolve();
        expect(thirdGranted).toBe(false);
        first.release();
        const third = await thirdPromise;
        expect(thirdGranted).toBe(true);
        third.release();
        second.release();
        bulk.release();
    });

    it('rejects an interactive request larger than the reserved slot', async () => {
        const broker = new JobBroker(CAPACITY, {
            maxInteractiveJobResources: {
                cpuTokens: 1,
                estimatedResidentBytes: 100,
                nativeProcesses: 1,
                ioWeight: 1,
            },
            interactiveReserve: {
                cpuTokens: 2,
                estimatedResidentBytes: 200,
                nativeProcesses: 2,
                ioWeight: 2,
            },
        });

        await expect(broker.acquire(createRequest({
            admissionClass: 'interactive',
            resources: {
                ...CAPACITY,
                cpuTokens: 2,
            },
        }))).rejects.toThrow('exceeds broker interactive job limit');
        expect(broker.getSnapshot().queued).toBe(0);
    });

    it('admits a new PDF through its first page while scan cleanup stays visible', async () => {
        const capacity = resolveMainJobBrokerCapacity(createResourceProfile(
            11,
            32 * GIB,
            'high',
        ));
        const broker = new JobBroker(capacity, {
            maxInteractiveJobResources: MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES,
            interactiveReserve: MAIN_JOB_BROKER_INTERACTIVE_RESERVE,
        });
        const rasterConcurrency = Math.min(
            capacity.cpuTokens,
            capacity.nativeProcesses - 2,
            Math.floor(capacity.estimatedResidentBytes / (128 * 1024 * 1024)),
        );
        const detection = await broker.acquire(createRequest({
            ownerId: 'scan-cleanup-tab',
            kind: 'scan-cleanup-detect-all',
            resources: {
                cpuTokens: rasterConcurrency,
                estimatedResidentBytes: rasterConcurrency * 128 * 1024 * 1024,
                nativeProcesses: rasterConcurrency + 1,
                ioWeight: 2,
            },
        }));
        const cleanupPreview = await broker.acquire(createRequest({
            ownerId: 'scan-cleanup-tab-1',
            kind: 'scan-cleanup-preview',
            priority: 'visible',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 128 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 1,
            },
        }));
        let secondCleanupGranted = false;
        const secondCleanupPromise = broker.acquire(createRequest({
            ownerId: 'scan-cleanup-tab-2',
            kind: 'scan-cleanup-preview',
            priority: 'visible',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 128 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 1,
            },
        })).then((lease) => {
            secondCleanupGranted = true;
            return lease;
        });
        const workingCopy = await broker.acquire(createRequest({
            ownerId: 'pdf-tab',
            kind: 'pdf-working-copy',
            priority: 'foreground',
            admissionClass: 'interactive',
            resources: {
                cpuTokens: 0,
                estimatedResidentBytes: 64 * 1024 * 1024,
                nativeProcesses: 0,
                ioWeight: 1,
            },
        }));
        const firstPage = await broker.acquire(createRequest({
            ownerId: 'pdf-tab',
            kind: 'native-pdf-preview',
            priority: 'visible',
            admissionClass: 'interactive',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 128 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 1,
            },
        }));

        expect(broker.getSnapshot()).toMatchObject({
            active: 4,
            queued: 1,
        });
        expect(secondCleanupGranted).toBe(false);
        cleanupPreview.release();
        const secondCleanupPreview = await secondCleanupPromise;
        expect(secondCleanupGranted).toBe(true);
        secondCleanupPreview.release();
        firstPage.release();
        workingCopy.release();
        detection.release();
    });

    it('prioritizes visible work while preserving FIFO within a priority', async () => {
        const broker = new JobBroker({
            ...CAPACITY,
            cpuTokens: 1,
        });
        const blocker = await broker.acquire(createRequest());
        const order: string[] = [];
        const background = broker.acquire(createRequest({
            ownerId: 'background-owner',
            priority: 'background',
        })).then((lease) => {
            order.push('background');
            return lease;
        });
        const visible = broker.acquire(createRequest({
            ownerId: 'visible-owner',
            priority: 'visible',
        })).then((lease) => {
            order.push('visible');
            return lease;
        });

        blocker.release();
        const visibleLease = await visible;
        expect(order).toEqual(['visible']);
        visibleLease.release();
        const backgroundLease = await background;
        expect(order).toEqual([
            'visible',
            'background',
        ]);
        backgroundLease.release();
    });

    it('uses cached resource totals while releasing a burst of queued work', async () => {
        const broker = new JobBroker({
            cpuTokens: 4,
            estimatedResidentBytes: 400,
            nativeProcesses: 4,
            ioWeight: 4,
        });
        const blocker = await broker.acquire(createRequest({resources: {
            cpuTokens: 4,
            estimatedResidentBytes: 400,
            nativeProcesses: 4,
            ioWeight: 4,
        }}));
        const queued = Array.from({length: 4}, (_, index) => broker.acquire(createRequest({ownerId: `queued-owner-${String(index)}`})));
        const reduce = vi.spyOn(Array.prototype, 'reduce');

        blocker.release();

        expect(broker.getSnapshot().active).toBe(4);
        expect(reduce).not.toHaveBeenCalled();
        const leases = await Promise.all(queued);
        leases.forEach(lease => lease.release());
        reduce.mockRestore();
    });

    it('enforces per-owner feature caps while allowing another renderer through', async () => {
        const broker = new JobBroker(CAPACITY);
        const first = await broker.acquire(createRequest({perOwnerLimit: 1}));
        let sameOwnerGranted = false;
        const sameOwner = broker.acquire(createRequest({perOwnerLimit: 1})).then((lease) => {
            sameOwnerGranted = true;
            return lease;
        });
        const otherOwner = await broker.acquire(createRequest({
            ownerId: 'renderer-2',
            perOwnerLimit: 1,
        }));

        expect(sameOwnerGranted).toBe(false);
        otherOwner.release();
        first.release();
        const sameOwnerLease = await sameOwner;
        sameOwnerLease.release();
    });

    it('drops the active leases of a cancelled owner and dispatches queued work', async () => {
        const broker = new JobBroker({
            ...CAPACITY,
            cpuTokens: 1,
        });
        const first = await broker.acquire(createRequest({ownerId: 'closing-owner'}));
        const queued = broker.acquire(createRequest({ownerId: 'next-owner'}));

        broker.cancelOwner('closing-owner');
        const next = await queued;
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            queued: 0,
        });
        expect(first.release()).toBe(false);
        expect(next.release()).toBe(true);
    });

    it('cancels queued owner work without dropping its active leases', async () => {
        const broker = new JobBroker({
            ...CAPACITY,
            cpuTokens: 1,
        });
        const active = await broker.acquire(createRequest({ownerId: 'retained-owner'}));
        const queued = broker.acquire(createRequest({ownerId: 'retained-owner'}));

        broker.cancelPendingOwner('retained-owner', 'native cleanup is still pending');

        await expect(queued).rejects.toThrow('native cleanup is still pending');
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            queued: 0,
        });
        expect(active.release()).toBe(true);
    });

    it('keeps a long-held lease accounted until its holder releases it', async () => {
        const HOUR_MS = 60 * 60 * 1_000;
        let now = 0;
        const broker = new JobBroker({
            ...CAPACITY,
            cpuTokens: 1,
        }, {now: () => now});
        const longRun = await broker.acquire(createRequest({ownerId: 'long-run'}));
        let queuedGranted = false;
        const queued = broker.acquire(createRequest({ownerId: 'next-owner'})).then((lease) => {
            queuedGranted = true;
            return lease;
        });

        now = 2 * HOUR_MS;
        const dispatchTrigger = broker.acquire(createRequest({ownerId: 'dispatch-trigger'}));
        await Promise.resolve();

        expect(queuedGranted).toBe(false);
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            queued: 2,
            used: longRun.resources,
        });

        expect(longRun.release()).toBe(true);
        const next = await queued;
        expect(next.release()).toBe(true);
        const triggerLease = await dispatchTrigger;
        expect(triggerLease.release()).toBe(true);
    });

    it('enforces an admission-only owner cap without consuming nested-work resources', async () => {
        const broker = new JobBroker(CAPACITY);
        const admissionResources = {
            cpuTokens: 0,
            estimatedResidentBytes: 0,
            nativeProcesses: 0,
            ioWeight: 0,
        };
        const first = await broker.acquire(createRequest({
            kind: 'combine-pdf',
            perOwnerLimit: 1,
            resources: admissionResources,
        }));
        let secondGranted = false;
        const secondPromise = broker.acquire(createRequest({
            kind: 'combine-pdf',
            perOwnerLimit: 1,
            resources: admissionResources,
        })).then((lease) => {
            secondGranted = true;
            return lease;
        });

        await Promise.resolve();
        expect(secondGranted).toBe(false);
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            queued: 1,
            used: admissionResources,
        });

        first.release();
        const second = await secondPromise;
        expect(secondGranted).toBe(true);
        second.release();
    });

    it('removes aborted queued requests', async () => {
        const broker = new JobBroker({
            ...CAPACITY,
            cpuTokens: 1,
        });
        const blocker = await broker.acquire(createRequest());
        const controller = new AbortController();
        const queued = broker.acquire(createRequest({signal: controller.signal}));

        controller.abort(new Error('navigation ended'));
        await expect(queued).rejects.toThrow('navigation ended');
        expect(broker.getSnapshot().queued).toBe(0);
        blocker.release();
    });

    it('ages background work so sustained newer foreground work cannot starve it', async () => {
        let now = 0;
        const broker = new JobBroker({
            ...CAPACITY,
            cpuTokens: 1,
        }, {
            agingIntervalMs: 100,
            now: () => now,
        });
        const blocker = await broker.acquire(createRequest());
        const order: string[] = [];
        const background = broker.acquire(createRequest({
            ownerId: 'background-owner',
            priority: 'background',
        })).then((lease) => {
            order.push('background');
            return lease;
        });

        now = 400;
        const foreground = broker.acquire(createRequest({
            ownerId: 'foreground-owner',
            priority: 'foreground',
        })).then((lease) => {
            order.push('foreground');
            return lease;
        });

        blocker.release();
        const backgroundLease = await background;
        expect(order).toEqual(['background']);
        backgroundLease.release();
        const foregroundLease = await foreground;
        foregroundLease.release();
    });

    it('rejects jobs that can never fit without occupying the queue', async () => {
        const broker = new JobBroker(CAPACITY);

        await expect(broker.acquire(createRequest({resources: {
            ...CAPACITY,
            estimatedResidentBytes: CAPACITY.estimatedResidentBytes + 1,
        }}))).rejects.toThrow('exceeds broker capacity');
        expect(broker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

    it('bounds queued jobs globally before allocating more queue metadata', async () => {
        const broker = new JobBroker({
            ...CAPACITY,
            cpuTokens: 1,
        }, {
            maxQueuedJobs: 2,
            maxQueuedJobsPerOwner: 2,
        });
        const blocker = await broker.acquire(createRequest());
        const firstQueued = broker.acquire(createRequest({ownerId: 'owner-1'}));
        const secondQueued = broker.acquire(createRequest({ownerId: 'owner-2'}));

        await expect(broker.acquire(createRequest({ownerId: 'owner-3'})))
            .rejects.toThrow('queue is full (2 jobs)');
        expect(broker.getSnapshot().queued).toBe(2);

        blocker.release();
        const firstLease = await firstQueued;
        firstLease.release();
        const secondLease = await secondQueued;
        secondLease.release();
    });

    it('bounds queued jobs per owner without blocking other owners', async () => {
        const broker = new JobBroker({
            ...CAPACITY,
            cpuTokens: 1,
        }, {
            maxQueuedJobs: 4,
            maxQueuedJobsPerOwner: 1,
        });
        const blocker = await broker.acquire(createRequest());
        const queued = broker.acquire(createRequest({ownerId: 'owner-1'}));

        await expect(broker.acquire(createRequest({ownerId: 'owner-1'})))
            .rejects.toThrow('owner queue is full (1 jobs for owner-1)');
        const otherOwner = broker.acquire(createRequest({ownerId: 'owner-2'}));

        blocker.release();
        const queuedLease = await queued;
        queuedLease.release();
        const otherLease = await otherOwner;
        otherLease.release();
    });

    it('reserves the whole supported conformance vector even on an unconfigured host', () => {
        expect(MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES).toEqual({
            cpuTokens: 2,
            estimatedResidentBytes: 512 * 1024 * 1024,
            nativeProcesses: 2,
            ioWeight: 4,
        });
        expect(resolveMainJobBrokerCapacity(createResourceProfile(1, 1, 'low'))).toMatchObject({
            cpuTokens: 2,
            estimatedResidentBytes: 512 * 1024 * 1024,
            nativeProcesses: 2,
        });
    });

    it.each([
        'success',
        'ordinary-failure',
    ] as const)('holds the scoped vector until work settles: %s', async outcome => {
        const broker = new JobBroker(CAPACITY);
        const work = Promise.withResolvers<number>();
        const request = createRequest({resources: CAPACITY});
        const error = new Error('confirmed ordinary failure');
        const scoped = broker.run(request, () => work.promise);
        const observed = scoped.catch((failure: unknown) => failure);
        const competitor = broker.acquire(createRequest({ownerId: 'competitor'}));
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            queued: 1,
            used: CAPACITY,
        });
        if (outcome === 'success') work.resolve(42); else work.reject(error);
        expect(await observed).toBe(outcome === 'success' ? 42 : error);
        const lease = await competitor;
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            queued: 0,
            used: lease.resources,
        });
        lease.release();
        expect(broker.getSnapshot().active).toBe(0);
    });

    it('does not invoke queued scoped work after its caller aborts', async () => {
        const broker = new JobBroker(CAPACITY);
        const blocker = await broker.acquire(createRequest({resources: CAPACITY}));
        const controller = new AbortController();
        let entered = false;
        const scoped = broker.run(createRequest({signal: controller.signal}), async () => { entered = true; });
        controller.abort(new Error('queued operation closed'));
        await expect(scoped).rejects.toThrow('queued operation closed');
        blocker.release();
        expect(entered).toBe(false);
        expect(broker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

    it('rechecks cancellation between a synchronous grant and the work callback', async () => {
        const broker = new JobBroker(CAPACITY);
        const controller = new AbortController();
        let entered = false;
        const scoped = broker.run(createRequest({
            signal: controller.signal,
            resources: CAPACITY,
        }), async () => { entered = true; });
        controller.abort(new Error('aborted just after grant'));
        await expect(scoped).rejects.toThrow('aborted just after grant');
        expect(entered).toBe(false);
        const next = await broker.acquire(createRequest({resources: CAPACITY}));
        expect(next.release()).toBe(true);
    });

    it('retains the exact paid vector after a marked failure without releasing it for cleanup', async () => {
        const {markUnprovenNativeTermination} = await import('@electron/utils/nativeTerminationProof');
        const broker = new JobBroker(CAPACITY);
        const error = markUnprovenNativeTermination(new Error('native timeout'), 'native descendant still alive');
        await expect(broker.run(createRequest({resources: CAPACITY}), async () => { throw error; })).rejects.toBe(error);
        const controller = new AbortController();
        const competitor = broker.acquire(createRequest({
            ownerId: 'competitor',
            signal: controller.signal,
        }));
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            queued: 1,
            used: CAPACITY,
            usedBulk: CAPACITY,
        });
        controller.abort(new Error('remove test competitor'));
        await expect(competitor).rejects.toThrow('remove test competitor');
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            queued: 0,
            used: CAPACITY,
        });
    });

});
