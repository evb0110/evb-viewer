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
    getJobBrokerLeaseForProofSink,
    type IJobBrokerLease,
    type IJobResourceVector,
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
            estimatedResidentBytes: 6 * GIB,
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

    it.each([
        {
            host: '4 GiB, 2 cores',
            cpus: 2,
            ramGiB: 4,
            tier: 'low',
            expected: {
                cpuTokens: 2,
                estimatedResidentBytes: 2 * GIB,
                nativeProcesses: 2,
                ioWeight: 4,
            },
        },
        {
            host: '8 GiB, 4 cores',
            cpus: 4,
            ramGiB: 8,
            tier: 'low',
            expected: {
                cpuTokens: 3,
                estimatedResidentBytes: 6 * GIB,
                nativeProcesses: 2,
                ioWeight: 4,
            },
        },
        {
            host: '16 GiB, 8 cores',
            cpus: 8,
            ramGiB: 16,
            tier: 'high',
            expected: {
                cpuTokens: 6,
                estimatedResidentBytes: 13.6 * GIB,
                nativeProcesses: 4,
                ioWeight: 4,
            },
        },
        {
            host: '32 GiB, 16 cores',
            cpus: 16,
            ramGiB: 32,
            tier: 'high',
            expected: {
                cpuTokens: 12,
                estimatedResidentBytes: 28 * GIB,
                nativeProcesses: 8,
                ioWeight: 8,
            },
        },
        {
            host: '64 GiB, 32 cores',
            cpus: 32,
            ramGiB: 64,
            tier: 'high',
            expected: {
                cpuTokens: 24,
                estimatedResidentBytes: 60 * GIB,
                nativeProcesses: 16,
                ioWeight: 16,
            },
        },
        {
            host: '128 GiB, 64 cores',
            cpus: 64,
            ramGiB: 128,
            tier: 'high',
            expected: {
                cpuTokens: 48,
                estimatedResidentBytes: 124 * GIB,
                nativeProcesses: 32,
                ioWeight: 32,
            },
        },
        {
            host: '16 GiB, 64 cores',
            cpus: 64,
            ramGiB: 16,
            tier: 'high',
            expected: {
                cpuTokens: 48,
                estimatedResidentBytes: 13.6 * GIB,
                nativeProcesses: 27,
                ioWeight: 27,
            },
        },
    ] satisfies Array<{
        host: string;
        cpus: number;
        ramGiB: number;
        tier: THostResourceTier;
        expected: IJobResourceVector;
    }>)('scales the main budget on a $host host', ({
        cpus,
        ramGiB,
        tier,
        expected,
    }) => {
        expect(resolveMainJobBrokerCapacity(createResourceProfile(cpus, ramGiB * GIB, tier))).toEqual(expected);
    });

    it('keeps half of a 4 GiB host for the system and the app', () => {
        const capacity = resolveMainJobBrokerCapacity(createResourceProfile(8, 4 * GIB, 'high'));

        expect(capacity.estimatedResidentBytes).toBe(2 * GIB);
        expect(capacity.nativeProcesses).toBe(4);
    });

    it('admits a leaf inside a lease that holds the whole capacity, one leaf at a time', async () => {
        const broker = new JobBroker({
            cpuTokens: 1,
            estimatedResidentBytes: 100,
            nativeProcesses: 1,
            ioWeight: 1,
        });
        const leaf = createRequest({
            ownerId: 'native-command',
            kind: 'native-command',
            admissionClass: 'leaf',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 10,
                nativeProcesses: 1,
                ioWeight: 1,
            },
        });
        const outer = await broker.acquire(createRequest({
            ownerId: 'outer',
            resources: broker.getSnapshot().capacity,
        }));

        const nested = await broker.acquire(leaf);
        let secondGranted = false;
        const second = broker.acquire(leaf).then((lease) => {
            secondGranted = true;
            return lease;
        });
        const bulk = broker.acquire(createRequest({ownerId: 'bulk'}));
        await Promise.resolve();
        expect(secondGranted).toBe(false);
        expect(broker.getSnapshot()).toMatchObject({
            active: 2,
            queued: 2,
        });

        nested.release();
        (await second).release();
        outer.release();
        (await bulk).release();
        expect(broker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

    function createLeafRequest(signal?: AbortSignal) {
        return createRequest({
            ownerId: 'native-command',
            kind: 'native-command',
            admissionClass: 'leaf',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 1,
                nativeProcesses: 1,
                ioWeight: 1,
            },
            ...(signal ? {signal} : {}),
        });
    }

    async function flushMicrotasks() {
        for (let step = 0; step < 10; step += 1) await Promise.resolve();
    }

    // Sol's probe: each leaf's child is never proven gone, so each stays charged.
    async function runLeavesWithUnprovenChildren(broker: JobBroker, attempts: number) {
        const {markUnprovenNativeTermination} = await import('@electron/utils/nativeTerminationProof');
        const proofs: Array<PromiseWithResolvers<boolean>> = [];
        const queued: AbortController[] = [];
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const controller = new AbortController();
            const proof = Promise.withResolvers<boolean>();
            let admitted = false;
            const run = broker.run(createLeafRequest(controller.signal), async ({onTerminationProof}) => {
                admitted = true;
                proofs.push(proof);
                onTerminationProof(proof.promise);
                throw markUnprovenNativeTermination(new Error('native timeout'), 'still alive');
            }).catch(() => undefined);
            await flushMicrotasks();
            if (!admitted) {
                queued.push(controller);
                // The rest would queue behind it the same way.
                void run;
                break;
            }
        }
        return {
            proofs,
            queued,
        };
    }

    it('stops admitting leaves at the process budget when no child is ever proven gone', async () => {
        const broker = new JobBroker(CAPACITY);

        const {
            proofs,
            queued,
        } = await runLeavesWithUnprovenChildren(broker, 12);
        proofs.forEach(proof => proof.resolve(false));
        await flushMicrotasks();

        expect(proofs).toHaveLength(CAPACITY.nativeProcesses);
        expect(broker.getSnapshot()).toMatchObject({
            active: CAPACITY.nativeProcesses,
            queued: 1,
            used: {nativeProcesses: CAPACITY.nativeProcesses},
        });
        queued.forEach(controller => controller.abort());
    });

    it('lets retained leaves overrun the process budget by one slot at most inside an outer lease', async () => {
        const broker = new JobBroker({
            cpuTokens: 1,
            estimatedResidentBytes: 100,
            nativeProcesses: 1,
            ioWeight: 1,
        });
        const outer = await broker.acquire(createRequest({
            ownerId: 'outer',
            resources: broker.getSnapshot().capacity,
        }));

        const {
            proofs,
            queued,
        } = await runLeavesWithUnprovenChildren(broker, 12);

        // The first leaf escapes the full budget; with it retained, the next waits.
        expect(proofs).toHaveLength(1);
        expect(broker.getSnapshot()).toMatchObject({
            active: 2,
            queued: 1,
            used: {nativeProcesses: 2},
        });
        // Once that child is proven gone, the waiting leaf escapes in turn.
        proofs[0]!.resolve(true);
        await flushMicrotasks();
        expect(broker.getSnapshot()).toMatchObject({
            active: 2,
            queued: 0,
        });
        queued.forEach(controller => controller.abort());
        outer.release();
    });

    it('releases a lease granted as its signal aborts with an unproven reason, before its work starts', async () => {
        const {markUnprovenNativeTermination} = await import('@electron/utils/nativeTerminationProof');
        const broker = new JobBroker(CAPACITY);
        const controller = new AbortController();
        const reason = markUnprovenNativeTermination(new Error('sibling not proven dead'), 'sibling alive');
        let entered = false;

        const scoped = broker.run(createRequest({
            signal: controller.signal,
            resources: CAPACITY,
        }), async () => {
            entered = true;
        });
        controller.abort(reason);

        await expect(scoped).rejects.toBe(reason);
        expect(entered).toBe(false);
        expect(broker.getSnapshot()).toMatchObject({
            active: 0,
            used: {nativeProcesses: 0},
        });
    });

    it('keeps only the lease whose own child is unproven when a shared job signal stops a sibling', async () => {
        const {markUnprovenNativeTermination} = await import('@electron/utils/nativeTerminationProof');
        const broker = new JobBroker(CAPACITY);
        const jobAbort = new AbortController();
        const renderResources = {
            cpuTokens: 1,
            estimatedResidentBytes: 50,
            nativeProcesses: 1,
            ioWeight: 1,
        };
        const engineStarted = Promise.withResolvers<void>();
        // An OCR engine pass: no native child of its own, stopped by the job.
        const enginePass = broker.run(createRequest({
            ownerId: 'ocr-job',
            kind: 'ocr-engine-pass',
            signal: jobAbort.signal,
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 100,
                nativeProcesses: 0,
                ioWeight: 0,
            },
        }), async () => {
            engineStarted.resolve();
            await new Promise((_resolve, reject) => {
                jobAbort.signal.addEventListener('abort', () => reject(jobAbort.signal.reason), {once: true});
            });
        });
        await engineStarted.promise;
        // The page render whose child outlived its kill stops the whole job.
        const render = broker.run(createRequest({
            ownerId: 'ocr-job',
            kind: 'ocr-render',
            resources: renderResources,
        }), async ({onTerminationProof}) => {
            onTerminationProof(Promise.resolve(false));
            const failure = markUnprovenNativeTermination(new Error('pdftoppm timed out'), 'pdftoppm alive');
            jobAbort.abort(failure);
            throw failure;
        });

        await expect(render).rejects.toThrow('pdftoppm timed out');
        await expect(enginePass).rejects.toThrow('pdftoppm timed out');
        await flushMicrotasks();
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            used: renderResources,
        });
    });

    it('admits an aged full-I/O job behind a continuous stream of one-I/O leaves', async () => {
        let now = 0;
        const broker = new JobBroker({
            cpuTokens: 8,
            estimatedResidentBytes: 1_000,
            nativeProcesses: 2,
            ioWeight: 4,
        }, {now: () => now});
        const running: IJobBrokerLease[] = [];
        const admit = (request: Promise<IJobBrokerLease>) => {
            void request.then(lease => running.push(lease));
        };
        admit(broker.acquire(createLeafRequest()));
        admit(broker.acquire(createLeafRequest()));
        await flushMicrotasks();
        let saveLease: IJobBrokerLease | undefined;
        void broker.acquire(createRequest({
            ownerId: 'save',
            kind: 'save',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 1,
                nativeProcesses: 0,
                ioWeight: 4,
            },
        })).then((lease) => {
            saveLease = lease;
        });

        let replacements = 0;
        while (saveLease === undefined && replacements < 50) {
            // Each finished leaf is replaced by a new one a second later.
            now += 1_000;
            running.shift()?.release();
            admit(broker.acquire(createLeafRequest()));
            replacements += 1;
            await flushMicrotasks();
        }

        // Aged after five replacements; the two leaves then running drain first.
        expect(saveLease).toBeDefined();
        expect(replacements).toBeLessThanOrEqual(7);
        // Beside it, at most the one leaf that may escape a running lease.
        expect(broker.getSnapshot().used.ioWeight).toBeLessThanOrEqual(4 + 1);
        saveLease!.release();
        await flushMicrotasks();
        running.splice(0).forEach(lease => lease.release());
        await flushMicrotasks();
        running.splice(0).forEach(lease => lease.release());
        expect(broker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

    it('lets an escaping leaf ask for one process at most and charge the budget plus one', async () => {
        const broker = new JobBroker(CAPACITY);
        const outer = await broker.acquire(createRequest({
            ownerId: 'outer',
            resources: CAPACITY,
        }));
        let wideGranted = false;
        const wide = broker.acquire(createRequest({
            ownerId: 'wide-leaf',
            kind: 'native-command',
            admissionClass: 'leaf',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 1,
                nativeProcesses: 2,
                ioWeight: 1,
            },
        })).then((lease) => {
            wideGranted = true;
            return lease;
        });
        await flushMicrotasks();
        // Sol's probe: a two-process leaf would have raised the charge to 4.
        expect(wideGranted).toBe(false);
        expect(broker.getSnapshot().used.nativeProcesses).toBe(2);

        const narrow = await broker.acquire(createLeafRequest());
        expect(broker.getSnapshot().used.nativeProcesses).toBe(3);
        narrow.release();
        outer.release();
        (await wide).release();
    });

    it.each([
        'abort',
        'cancelOwner',
    ] as const)('runs work a blocked head held back once that head leaves by %s', async (leave) => {
        let now = 0;
        const broker = new JobBroker(CAPACITY, {now: () => now});
        const small = {
            cpuTokens: 1,
            estimatedResidentBytes: 100,
            nativeProcesses: 1,
            ioWeight: 1,
        };
        const occupant = await broker.acquire(createRequest({
            ownerId: 'occupant',
            resources: small,
        }));
        const headAbort = new AbortController();
        const head = broker.acquire(createRequest({
            ownerId: 'head',
            resources: CAPACITY,
            signal: headAbort.signal,
        }));
        void head.catch(() => undefined);
        // The head ages, so smaller work may not take what it needs.
        now += 5_000;
        let behindGranted = false;
        const behind = broker.acquire(createRequest({
            ownerId: 'behind',
            resources: small,
        })).then((lease) => {
            behindGranted = true;
            return lease;
        });
        await flushMicrotasks();
        expect(behindGranted).toBe(false);

        if (leave === 'abort') headAbort.abort();
        else broker.cancelOwner('head');
        await flushMicrotasks();

        // Granted as the head leaves, without waiting for another broker event.
        expect(behindGranted).toBe(true);
        (await behind).release();
        occupant.release();
    });

    it('admits an aged full-I/O save behind a continuous stream of one-I/O interactive jobs', async () => {
        let now = 0;
        const broker = new JobBroker({
            cpuTokens: 8,
            estimatedResidentBytes: 1_000,
            nativeProcesses: 8,
            ioWeight: 4,
        }, {
            now: () => now,
            maxInteractiveJobResources: {
                cpuTokens: 1,
                estimatedResidentBytes: 10,
                nativeProcesses: 1,
                ioWeight: 1,
            },
            interactiveReserve: {
                cpuTokens: 2,
                estimatedResidentBytes: 20,
                nativeProcesses: 2,
                ioWeight: 2,
            },
        });
        const interactiveRequest = () => createRequest({
            ownerId: 'visible-pages',
            kind: 'render',
            priority: 'visible',
            admissionClass: 'interactive',
            resources: {
                cpuTokens: 0,
                estimatedResidentBytes: 1,
                nativeProcesses: 0,
                ioWeight: 1,
            },
        });
        const running: IJobBrokerLease[] = [];
        const admit = (request: Promise<IJobBrokerLease>) => {
            void request.then(lease => running.push(lease));
        };
        for (let index = 0; index < 4; index += 1) admit(broker.acquire(interactiveRequest()));
        await flushMicrotasks();
        expect(running).toHaveLength(4);
        let saveLease: IJobBrokerLease | undefined;
        void broker.acquire(createRequest({
            ownerId: 'save',
            kind: 'save',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 1,
                nativeProcesses: 1,
                ioWeight: 4,
            },
        })).then((lease) => {
            saveLease = lease;
        });

        let replacements = 0;
        while (saveLease === undefined && replacements < 30) {
            now += 1_000;
            running.shift()?.release();
            admit(broker.acquire(interactiveRequest()));
            replacements += 1;
            await flushMicrotasks();
        }

        // Its priority catches up after ten seconds; the jobs then running drain.
        expect(saveLease).toBeDefined();
        expect(replacements).toBeLessThanOrEqual(14);
        saveLease!.release();
        await flushMicrotasks();
        running.splice(0).forEach(lease => lease.release());
        await flushMicrotasks();
        running.splice(0).forEach(lease => lease.release());
    });

    it('names the lease a run holds through its proof sink only while it is held', async () => {
        const broker = new JobBroker(CAPACITY);
        let sink: ((proof: Promise<boolean>) => void) | undefined;

        await broker.run(createRequest(), async ({
            lease,
            onTerminationProof,
        }) => {
            sink = onTerminationProof;
            expect(getJobBrokerLeaseForProofSink(onTerminationProof)).toBe(lease);
        });

        expect(getJobBrokerLeaseForProofSink(sink)).toBeUndefined();
        expect(getJobBrokerLeaseForProofSink(() => undefined)).toBeUndefined();
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

    it('cancels queued owner work in cancelOwner while holding active charges until release', async () => {
        const broker = new JobBroker({
            ...CAPACITY,
            cpuTokens: 1,
        });
        const active = await broker.acquire(createRequest({ownerId: 'closing-owner'}));
        const ownerQueued = broker.acquire(createRequest({ownerId: 'closing-owner'}));
        let competitorGranted = false;
        const competitorQueued = broker.acquire(createRequest({ownerId: 'next-owner'})).then((lease) => {
            competitorGranted = true;
            return lease;
        });

        broker.cancelOwner('closing-owner', 'native cleanup is still pending');

        await expect(ownerQueued).rejects.toThrow('native cleanup is still pending');
        await Promise.resolve();
        expect(competitorGranted).toBe(false);
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            queued: 1,
            used: active.resources,
            usedBulk: active.resources,
        });

        expect(active.release()).toBe(true);
        const next = await competitorQueued;
        expect(competitorGranted).toBe(true);
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            queued: 0,
            used: next.resources,
        });
        expect(next.release()).toBe(true);
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

    it('reserves the whole single-job vector on an unconfigured host', () => {
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

    it('retains the exact paid vector after a marked failure even if cancelOwner is called', async () => {
        const {markUnprovenNativeTermination} = await import('@electron/utils/nativeTerminationProof');
        const broker = new JobBroker(CAPACITY);
        const error = markUnprovenNativeTermination(new Error('native timeout'), 'native descendant still alive');
        await expect(broker.run(createRequest({
            ownerId: 'unproven-owner',
            resources: CAPACITY,
        }), async ({onTerminationProof}) => {
            onTerminationProof(new Promise<boolean>(() => {}));
            throw error;
        })).rejects.toBe(error);
        const ownerQueued = broker.acquire(createRequest({ownerId: 'unproven-owner'}));
        const controller = new AbortController();
        let competitorGranted = false;
        const competitor = broker.acquire(createRequest({
            ownerId: 'competitor',
            signal: controller.signal,
        })).then((lease) => {
            competitorGranted = true;
            return lease;
        });

        broker.cancelOwner('unproven-owner', 'owner canceled after unproven termination');
        await expect(ownerQueued).rejects.toThrow('owner canceled after unproven termination');
        await Promise.resolve();
        expect(competitorGranted).toBe(false);
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

    it('releases a retained lease when delayed termination proof resolves true and keeps it on false', async () => {
        const {markUnprovenNativeTermination} = await import('@electron/utils/nativeTerminationProof');
        const broker = new JobBroker(CAPACITY);

        const positiveProof = Promise.withResolvers<boolean>();
        const timeoutError = markUnprovenNativeTermination(new Error('watchdog expired'), 'still exiting');
        await expect(broker.run(createRequest({
            ownerId: 'delayed-proof-owner',
            resources: CAPACITY,
        }), async ({onTerminationProof}) => {
            onTerminationProof(positiveProof.promise);
            throw timeoutError;
        })).rejects.toBe(timeoutError);

        let competitorGranted = false;
        const competitor = broker.acquire(createRequest({ownerId: 'competitor'})).then((lease) => {
            competitorGranted = true;
            return lease;
        });
        await Promise.resolve();
        expect(competitorGranted).toBe(false);
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            queued: 1,
            used: CAPACITY,
        });

        positiveProof.resolve(true);
        const competitorLease = await competitor;
        expect(competitorGranted).toBe(true);
        expect(competitorLease.release()).toBe(true);
        expect(broker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });

        const negativeProof = Promise.withResolvers<boolean>();
        await expect(broker.run(createRequest({
            ownerId: 'unproven-survivor',
            resources: CAPACITY,
        }), async ({onTerminationProof}) => {
            onTerminationProof(negativeProof.promise);
            throw timeoutError;
        })).rejects.toBe(timeoutError);

        negativeProof.resolve(false);
        await Promise.resolve();
        await Promise.resolve();
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            queued: 0,
            used: CAPACITY,
        });
    });

    it('retains a lease across normal return when a registered termination proof is still pending or false', async () => {
        const broker = new JobBroker(CAPACITY);

        const delayedProof = Promise.withResolvers<boolean>();
        await expect(broker.run(createRequest({
            ownerId: 'fallback-after-delayed-proof',
            resources: CAPACITY,
        }), async ({onTerminationProof}) => {
            onTerminationProof(delayedProof.promise);
            return 'fallback-ok';
        })).resolves.toBe('fallback-ok');

        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            queued: 0,
            used: CAPACITY,
        });

        delayedProof.resolve(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(broker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });

        await expect(broker.run(createRequest({
            ownerId: 'fallback-after-false-proof',
            resources: CAPACITY,
        }), async ({onTerminationProof}) => {
            onTerminationProof(Promise.resolve(false));
            return 'fallback-unproven';
        })).resolves.toBe('fallback-unproven');

        await Promise.resolve();
        await Promise.resolve();
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            queued: 0,
            used: CAPACITY,
        });
    });

    it('isolates throwing memory reclaimers and lets later reclaimers free memory', async () => {
        const broker = new JobBroker(CAPACITY);
        const blocker = await broker.acquire(createRequest({
            ownerId: 'memory-holder',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 150,
                nativeProcesses: 1,
                ioWeight: 1,
            },
        }));

        broker.registerMemoryReclaimer(() => {
            throw new Error('reclaimer boom');
        });
        broker.registerMemoryReclaimer(() => {
            throw Object.create(null);
        });
        broker.registerMemoryReclaimer(() => {
            blocker.release();
        });

        const waiting = await broker.acquire(createRequest({
            ownerId: 'queued-requester',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 150,
                nativeProcesses: 1,
                ioWeight: 1,
            },
        }));
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            queued: 0,
        });
        waiting.release();
        expect(broker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

    it('admits an escaping leaf even when bulk capacity and interactive reserve processes are both occupied', async () => {
        const broker = new JobBroker({
            cpuTokens: 4,
            estimatedResidentBytes: 1_000,
            nativeProcesses: 2,
            ioWeight: 8,
        }, {
            maxInteractiveJobResources: {
                cpuTokens: 1,
                estimatedResidentBytes: 100,
                nativeProcesses: 2,
                ioWeight: 1,
            },
            interactiveReserve: {
                cpuTokens: 2,
                estimatedResidentBytes: 200,
                nativeProcesses: 2,
                ioWeight: 2,
            },
        });

        const bulk = await broker.acquire(createRequest({
            ownerId: 'bulk-owner',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 100,
                nativeProcesses: 2,
                ioWeight: 1,
            },
        }));
        const interactive = await broker.acquire(createRequest({
            ownerId: 'interactive-owner',
            admissionClass: 'interactive',
            priority: 'visible',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 100,
                nativeProcesses: 2,
                ioWeight: 1,
            },
        }));

        const leaf = await broker.acquire(createRequest({
            ownerId: 'leaf-owner',
            admissionClass: 'leaf',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 100,
                nativeProcesses: 1,
                ioWeight: 1,
            },
        }));
        expect(broker.getSnapshot().used.nativeProcesses).toBe(5);
        leaf.release();
        interactive.release();
        bulk.release();
    });

    it('does not let a parked memory-only lease trigger native leaf escape and reclaims it instead', async () => {
        const broker = new JobBroker(CAPACITY);
        const parked = await broker.acquire(createRequest({
            ownerId: 'parked-ocr-worker',
            kind: 'ocr-engine-pass',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: CAPACITY.estimatedResidentBytes,
                nativeProcesses: 0,
                ioWeight: 0,
            },
        }));
        expect(parked.shrink({
            cpuTokens: 0,
            estimatedResidentBytes: CAPACITY.estimatedResidentBytes,
            nativeProcesses: 0,
            ioWeight: 0,
        })).toBe(true);

        let reclaimedCount = 0;
        broker.registerMemoryReclaimer(() => {
            reclaimedCount += 1;
            parked.release();
        });

        const leaf = await broker.acquire(createRequest({
            ownerId: 'leaf-owner',
            admissionClass: 'leaf',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 128,
                nativeProcesses: 1,
                ioWeight: 1,
            },
        }));
        expect(reclaimedCount).toBe(1);
        expect(broker.getSnapshot().used.estimatedResidentBytes).toBe(128);
        leaf.release();
        expect(broker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

});
