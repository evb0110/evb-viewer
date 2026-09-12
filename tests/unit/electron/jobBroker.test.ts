import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    JobBroker,
    type IJobBrokerRequest,
    JOB_LEASE_MAX_HOLD_MS,
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

    it('caps low-tier concurrency without changing its memory formula', () => {
        expect(resolveMainJobBrokerCapacity(
            createResourceProfile(8, 8 * GIB, 'low'),
        )).toEqual({
            cpuTokens: 2,
            estimatedResidentBytes: 6.8 * GIB,
            nativeProcesses: 2,
            ioWeight: 4,
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

    it('reclaims expired active leases before dispatching queued work', async () => {
        let now = 0;
        const broker = new JobBroker({
            ...CAPACITY,
            cpuTokens: 1,
        }, {now: () => now});
        const stale = await broker.acquire(createRequest({ownerId: 'stale-owner'}));
        let queuedGranted = false;
        const queued = broker.acquire(createRequest({ownerId: 'next-owner'})).then((lease) => {
            queuedGranted = true;
            return lease;
        });

        await Promise.resolve();
        expect(queuedGranted).toBe(false);
        now = JOB_LEASE_MAX_HOLD_MS;
        const dispatchTrigger = broker.acquire(createRequest({ownerId: 'dispatch-trigger'}));
        const next = await queued;

        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            queued: 1,
            used: next.resources,
        });
        expect(stale.release()).toBe(false);
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
});
