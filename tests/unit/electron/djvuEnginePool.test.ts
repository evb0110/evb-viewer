import {EventEmitter} from 'node:events';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';
import type {IJobBrokerRunContext} from '@electron/resources/jobBroker';

interface IFakeWorkerControl {
    worker: FakeWorker;
    posted: unknown[];
    terminateDeferred: PromiseWithResolvers<number>;
    emitExit: (code?: number) => void;
    emitError: (error: Error) => void;
    replyOk: (id: number, result: unknown, heapBytes?: number) => void;
}

const workerControls = vi.hoisted(() => ({
    spawned: [] as IFakeWorkerControl[],
    autoExitOnTerminate: true,
}));

class FakeWorker extends EventEmitter {
    public readonly control: IFakeWorkerControl;

    public constructor() {
        super();
        const terminateDeferred = Promise.withResolvers<number>();
        const control: IFakeWorkerControl = {
            worker: this,
            posted: [],
            terminateDeferred,
            emitExit: (code = 0) => {
                this.emit('exit', code);
            },
            emitError: (error: Error) => {
                this.emit('error', error);
            },
            replyOk: (id: number, result: unknown, heapBytes = 1024) => {
                this.emit('message', {id, ok: true, heapBytes, result});
            },
        };
        this.control = control;
        workerControls.spawned.push(control);
    }

    public postMessage(message: unknown) {
        this.control.posted.push(message);
    }

    public terminate() {
        return this.control.terminateDeferred.promise.then((code) => {
            if (workerControls.autoExitOnTerminate) {
                this.emit('exit', code);
            }
            return code;
        });
    }
}

vi.mock('node:worker_threads', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:worker_threads')>();
    return {
        ...actual,
        Worker: FakeWorker,
    };
});

vi.mock('@electron/resources/hostResourceProfile', () => ({
    getHostResourceProfileSnapshot: () => ({
        logicalCpus: 2,
        totalRamBytes: 4 * 1024 * 1024 * 1024,
        safeMode: false,
        detectedTier: 'low',
        performanceMode: 'auto',
        tier: 'low',
    }),
}));

describe('djvuEnginePool termination settlement and broker admission (P0-2 / G-0b)', () => {
    beforeEach(() => {
        vi.resetModules();
        workerControls.spawned.length = 0;
        workerControls.autoExitOnTerminate = true;
    });

    afterEach(async () => {
        const {shutdownDjvuEnginePool} = await import('@electron/features/djvu/main/djvuEnginePool');
        shutdownDjvuEnginePool();
    });

    it('does not settle callers on abort or worker error until worker termination completes', async () => {
        const {runDjvuEngine} = await import('@electron/features/djvu/main/djvuEnginePool');
        const controller = new AbortController();
        const proofs: Array<Promise<boolean>> = [];

        const pending = (
            runDjvuEngine as (
                payload: {type: 'hasText'; djvuPath: string},
                options?: {signal?: AbortSignal; onTerminationProof?: (proof: Promise<boolean>) => void},
            ) => Promise<boolean>
        )({type: 'hasText', djvuPath: '/tmp/sample.djvu'}, {signal: controller.signal, onTerminationProof: (proof) => proofs.push(proof)});

        await vi.waitFor(() => expect(workerControls.spawned).toHaveLength(1));
        const first = workerControls.spawned[0]!;
        let settled = false;
        void pending.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );

        controller.abort(new DOMException('Canceled', 'AbortError'));
        await Promise.resolve();
        await Promise.resolve();
        // Caller MUST NOT settle before worker.terminate() resolves / worker exits.
        expect(settled).toBe(false);

        first.terminateDeferred.resolve(1);
        await expect(pending).rejects.toThrow('Canceled');
        expect(proofs).toHaveLength(1);
        await expect(proofs[0]).resolves.toBe(true);

        // Timeout must also await worker termination before settling the caller.
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        try {
            const timeoutPending = runDjvuEngine({type: 'hasText', djvuPath: '/tmp/slow.djvu'}, {timeoutMs: 20});
            await vi.waitFor(() => expect(workerControls.spawned).toHaveLength(2));
            const second = workerControls.spawned[1]!;
            let timeoutSettled = false;
            void timeoutPending.then(
                () => {
                    timeoutSettled = true;
                },
                () => {
                    timeoutSettled = true;
                },
            );
            await vi.advanceTimersByTimeAsync(25);
            expect(timeoutSettled).toBe(false);
            second.terminateDeferred.resolve(1);
            await expect(timeoutPending).rejects.toThrow('DjVuLibre engine timed out');
        } finally {
            vi.useRealTimers();
        }
    });

    it('surfaces unproven termination instead of swallowing worker.terminate() rejections, holds pool and broker capacity until late exit, and releases both on exit', async () => {
        workerControls.autoExitOnTerminate = false;
        const jobBrokerModule = await import('@electron/resources/jobBroker');
        const {JobBroker} = jobBrokerModule;
        const testBroker = new JobBroker({
            cpuTokens: 1,
            estimatedResidentBytes: 512 * 1024 * 1024,
            nativeProcesses: 1,
            ioWeight: 1,
        });
        vi.spyOn(jobBrokerModule, 'getConfiguredMainJobBroker').mockReturnValue(testBroker);

        const {runDjvuEngine} = await import('@electron/features/djvu/main/djvuEnginePool');

        // Repeat twice to prove late exits after rejected terminate() never strand broker leases on a low-tier broker.
        for (let round = 0; round < 2; round += 1) {
            const controller = new AbortController();
            const proofs: Array<Promise<boolean>> = [];

            const failedRequest = runDjvuEngine(
                {type: 'hasText', djvuPath: `/tmp/stuck-${round}.djvu`},
                {signal: controller.signal, onTerminationProof: (proof) => proofs.push(proof)},
            );

            await vi.waitFor(() => expect(workerControls.spawned).toHaveLength(round + 1));
            const stuckWorker = workerControls.spawned[round]!;
            controller.abort(new DOMException('Canceled', 'AbortError'));
            stuckWorker.terminateDeferred.reject(new Error('terminate failed'));

            const error = await failedRequest.catch((err: unknown) => err);
            expect(error).toBeInstanceOf(Error);
            expect(getUnprovenNativeTerminationDetail(error)).toBeDefined();
            expect(proofs).toHaveLength(1);
            // Both the broker lease and the worker slot MUST remain occupied while the zombie worker is alive.
            expect(testBroker.getSnapshot().active).toBe(1);

            const queuedRequest = runDjvuEngine({type: 'hasText', djvuPath: `/tmp/next-${round}.djvu`});
            await Promise.resolve();
            await Promise.resolve();
            expect(workerControls.spawned).toHaveLength(round + 1);

            // Once the zombie worker finally exits, BOTH the broker lease and the pool slot release cleanly.
            stuckWorker.emitExit(1);
            await expect(proofs[0]).resolves.toBe(true);
            await vi.waitFor(() => expect(workerControls.spawned).toHaveLength(round + 2));
            const nextWorker = workerControls.spawned[round + 1]!;
            const posted = nextWorker.posted[0] as {id: number};
            nextWorker.replyOk(posted.id, true);
            await expect(queuedRequest).resolves.toBe(true);
            expect(testBroker.getSnapshot().active).toBe(0);

            nextWorker.emitExit(0);
            workerControls.spawned.pop();
        }
    });

    it('G-0b: acquires a leaf broker lease before taking a worker slot when unleased, and reuses caller brokerRun without nesting', async () => {
        const jobBrokerModule = await import('@electron/resources/jobBroker');
        const {JobBroker} = jobBrokerModule;
        const testBroker = new JobBroker({
            cpuTokens: 1,
            estimatedResidentBytes: 512 * 1024 * 1024,
            nativeProcesses: 1,
            ioWeight: 1,
        });
        const acquireSpy = vi.spyOn(testBroker, 'acquire');
        vi.spyOn(jobBrokerModule, 'getConfiguredMainJobBroker').mockReturnValue(testBroker);

        const {runDjvuEngine} = await import('@electron/features/djvu/main/djvuEnginePool');

        // Hold both a running non-leaf lease and a running leaf lease so another leaf MUST queue in the broker.
        const blockerNonLeaf = await testBroker.acquire({
            ownerId: 'blocker-1',
            kind: 'bulk-job',
            priority: 'user',
            admissionClass: 'bulk',
            resources: {cpuTokens: 1, estimatedResidentBytes: 128 * 1024 * 1024, nativeProcesses: 1, ioWeight: 1},
        });
        const blockerLeaf = await testBroker.acquire({
            ownerId: 'blocker-2',
            kind: 'other-leaf',
            priority: 'user',
            admissionClass: 'leaf',
            resources: {cpuTokens: 1, estimatedResidentBytes: 128 * 1024 * 1024, nativeProcesses: 1, ioWeight: 1},
        });

        // Unleased call must queue in the broker as a leaf BEFORE spawning any worker.
        const queuedAbort = new AbortController();
        const queuedCall = runDjvuEngine({type: 'hasText', djvuPath: '/tmp/queued.djvu'}, {signal: queuedAbort.signal});
        await Promise.resolve();
        await Promise.resolve();
        expect(workerControls.spawned).toHaveLength(0);
        expect(acquireSpy).toHaveBeenLastCalledWith(expect.objectContaining({admissionClass: 'leaf'}));

        // Aborting while queued in the broker never spawns a worker.
        queuedAbort.abort(new DOMException('Queued abort', 'AbortError'));
        await expect(queuedCall).rejects.toThrow('Queued abort');
        expect(workerControls.spawned).toHaveLength(0);

        blockerLeaf.release();
        blockerNonLeaf.release();

        // Leased call with active brokerRun must NOT acquire a nested broker lease and must forward termination proofs.
        const callsBeforeLeased = acquireSpy.mock.calls.length;
        const leasedProofs: Array<Promise<boolean>> = [];
        await testBroker.run(
            {
                ownerId: 'djvu-preview:1',
                kind: 'djvu-preview',
                priority: 'visible',
                admissionClass: 'bulk',
                resources: {cpuTokens: 1, estimatedResidentBytes: 128 * 1024 * 1024, nativeProcesses: 1, ioWeight: 1},
            },
            async (brokerRun: IJobBrokerRunContext) => {
                const abortController = new AbortController();
                const req = (
                    runDjvuEngine as (
                        payload: {type: 'hasText'; djvuPath: string},
                        options?: {signal?: AbortSignal; brokerRun?: IJobBrokerRunContext},
                    ) => Promise<boolean>
                )(
                    {type: 'hasText', djvuPath: '/tmp/leased.djvu'},
                    {
                        signal: abortController.signal,
                        brokerRun: {
                            ...brokerRun,
                            onTerminationProof: (proof) => {
                                leasedProofs.push(proof);
                                brokerRun.onTerminationProof(proof);
                            },
                        },
                    },
                );
                await vi.waitFor(() => expect(workerControls.spawned).toHaveLength(1));
                // Only the outer testBroker.run acquired a lease (1 call), no nested acquire from runDjvuEngine.
                expect(acquireSpy.mock.calls.length).toBe(callsBeforeLeased + 1);
                abortController.abort(new DOMException('Leased cancel', 'AbortError'));
                workerControls.spawned[0]!.terminateDeferred.resolve(1);
                await expect(req).rejects.toThrow('Leased cancel');
            },
        );
        expect(leasedProofs).toHaveLength(1);
        await expect(leasedProofs[0]).resolves.toBe(true);
    });
});
