import {EventEmitter} from 'node:events';
import type * as TFsModule from 'node:fs';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {TPdfSearchWorkerCommand} from '@electron/features/search/pdfSearchWorkerOps';

interface IMockWorkerMessage {
    id: number;
    command: TPdfSearchWorkerCommand;
}

class FakeSearchWorker extends EventEmitter {
    readonly posted: IMockWorkerMessage[] = [];
    terminateCalls = 0;
    exited = false;

    constructor(
        private readonly onPost: (worker: FakeSearchWorker, message: IMockWorkerMessage) => void,
        private readonly onTerminate: (worker: FakeSearchWorker) => Promise<number>,
    ) {
        super();
    }

    postMessage(message: IMockWorkerMessage) {
        this.posted.push(message);
        this.onPost(this, message);
    }

    terminate(): Promise<number> {
        this.terminateCalls += 1;
        return this.onTerminate(this);
    }
}

const mockState = vi.hoisted(() => ({
    loadWasmImpl: null as (() => Promise<WebAssembly.Module>) | null,
    onPost: null as ((worker: FakeSearchWorker, message: IMockWorkerMessage) => void) | null,
    onTerminate: null as ((worker: FakeSearchWorker) => Promise<number>) | null,
    workers: [] as FakeSearchWorker[],
    liveWorkers: 0,
    peakLiveWorkers: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof TFsModule>();
    return {
        ...actual,
        existsSync: (path: TFsModule.PathLike) => String(path).includes('pdf-search') || actual.existsSync(path),
    };
});

vi.mock('node:worker_threads', () => ({
    Worker: class MockWorker extends FakeSearchWorker {
        constructor() {
            super(
                (worker, message) => {
                    mockState.onPost?.(worker, message);
                },
                (worker) => mockState.onTerminate?.(worker) ?? Promise.resolve(0),
            );
            mockState.workers.push(this);
            mockState.liveWorkers += 1;
            mockState.peakLiveWorkers = Math.max(mockState.peakLiveWorkers, mockState.liveWorkers);
        }
    },
}));

vi.mock('@electron/features/search/pdfSearchWasmRunner', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@electron/features/search/pdfSearchWasmRunner')>();
    return {
        ...actual,
        loadPdfSearchWasmModule: () => (mockState.loadWasmImpl ? mockState.loadWasmImpl() : Promise.resolve({} as WebAssembly.Module)),
    };
});

const {runPdfSearchWorkerCommand, shutdownPdfSearchWorkers} = await import('@electron/features/search/pdfSearchWorkerClient');

function makeStatCommand(indexPath: string): TPdfSearchWorkerCommand {
    return {
        op: 'stat',
        indexPath,
        documentRevision: 'rev-1',
    };
}

describe('pdfSearchWorkerClient pool limits and execution deadline', () => {
    beforeEach(() => {
        mockState.workers = [];
        mockState.liveWorkers = 0;
        mockState.peakLiveWorkers = 0;
        mockState.loadWasmImpl = () => Promise.resolve({} as WebAssembly.Module);
        mockState.onPost = (worker, message) => {
            queueMicrotask(() => {
                worker.emit('message', {
                    id: message.id,
                    ok: true,
                    data: {
                        echo: message.command.op === 'stat' ? message.command.indexPath : message.command.op,
                    },
                });
            });
        };
        mockState.onTerminate = (worker) => {
            if (!worker.exited) {
                worker.exited = true;
                mockState.liveWorkers = Math.max(0, mockState.liveWorkers - 1);
            }
            return Promise.resolve(0);
        };
    });

    afterEach(async () => {
        await shutdownPdfSearchWorkers();
        vi.useRealTimers();
    });

    it('caps six concurrent cold-start requests at two workers while WASM compilation is pending', async () => {
        const wasmGate = Promise.withResolvers<WebAssembly.Module>();
        mockState.loadWasmImpl = () => wasmGate.promise;

        const requests = Array.from({length: 6}, (_, index) => runPdfSearchWorkerCommand(makeStatCommand(`/tmp/doc-${index}.idx`)));

        await Promise.resolve();
        expect(mockState.workers).toHaveLength(0);

        wasmGate.resolve({} as WebAssembly.Module);
        const results = await Promise.all(requests);

        expect(results).toEqual(
            Array.from({length: 6}, (_, index) => ({
                echo: `/tmp/doc-${index}.idx`,
            })),
        );
        expect(mockState.workers.length).toBeLessThanOrEqual(2);
        expect(mockState.peakLiveWorkers).toBeLessThanOrEqual(2);
    });

    it('releases reserved startup slots when WASM compilation fails or a cold request aborts', async () => {
        const firstGate = Promise.withResolvers<WebAssembly.Module>();
        const secondGate = Promise.withResolvers<WebAssembly.Module>();
        let loadCalls = 0;
        mockState.loadWasmImpl = () => {
            loadCalls += 1;
            if (loadCalls === 1) {
                return firstGate.promise;
            }
            if (loadCalls === 2) {
                return secondGate.promise;
            }
            return Promise.resolve({} as WebAssembly.Module);
        };

        const abortController = new AbortController();
        const first = runPdfSearchWorkerCommand(makeStatCommand('/tmp/fail.idx'));
        const second = runPdfSearchWorkerCommand(makeStatCommand('/tmp/abort.idx'), abortController.signal);
        const third = runPdfSearchWorkerCommand(makeStatCommand('/tmp/queued-1.idx'));
        const fourth = runPdfSearchWorkerCommand(makeStatCommand('/tmp/queued-2.idx'));

        await Promise.resolve();
        expect(loadCalls).toBe(2);

        const abortError = new Error('aborted during startup');
        abortController.abort(abortError);
        firstGate.reject(new Error('wasm compile failed'));

        await expect(first).rejects.toThrow('wasm compile failed');
        await expect(second).rejects.toBe(abortError);
        await expect(Promise.all([third, fourth])).resolves.toEqual([{echo: '/tmp/queued-1.idx'}, {echo: '/tmp/queued-2.idx'}]);
        expect(mockState.workers.length).toBeLessThanOrEqual(2);
        expect(mockState.peakLiveWorkers).toBeLessThanOrEqual(2);
    });

    it('enforces the 15-minute execution deadline promptly, terminates stalled workers, and releases slots only after exit', async () => {
        vi.useFakeTimers();

        const stalledWorkers = new Set<FakeSearchWorker>();
        const terminateGates = new Map<FakeSearchWorker, PromiseWithResolvers<number>>();
        mockState.onPost = (worker, message) => {
            if (message.command.op === 'stat' && message.command.indexPath.includes('stall')) {
                stalledWorkers.add(worker);
                return;
            }
            queueMicrotask(() => {
                worker.emit('message', {
                    id: message.id,
                    ok: true,
                    data: {
                        echo: message.command.op === 'stat' ? message.command.indexPath : message.command.op,
                    },
                });
            });
        };
        mockState.onTerminate = (worker) => {
            if (!stalledWorkers.has(worker)) {
                if (!worker.exited) {
                    worker.exited = true;
                    mockState.liveWorkers = Math.max(0, mockState.liveWorkers - 1);
                }
                return Promise.resolve(0);
            }
            const gate = Promise.withResolvers<number>();
            terminateGates.set(worker, gate);
            return gate.promise.then((code) => {
                if (!worker.exited) {
                    worker.exited = true;
                    mockState.liveWorkers = Math.max(0, mockState.liveWorkers - 1);
                }
                return code;
            });
        };

        try {
            const stalledOne = runPdfSearchWorkerCommand(makeStatCommand('/tmp/stall-1.idx'));
            const stalledTwo = runPdfSearchWorkerCommand(makeStatCommand('/tmp/stall-2.idx'));
            const queuedThree = runPdfSearchWorkerCommand(makeStatCommand('/tmp/recovery-3.idx'));

            const stalledOneOutcome = stalledOne.then(
                (value) => ({
                    ok: true as const,
                    value,
                }),
                (error: unknown) => ({
                    ok: false as const,
                    error,
                }),
            );
            const stalledTwoOutcome = stalledTwo.then(
                (value) => ({
                    ok: true as const,
                    value,
                }),
                (error: unknown) => ({
                    ok: false as const,
                    error,
                }),
            );

            // Flush startup microtasks so both stalled workers are dispatched at t = 0.
            await Promise.resolve();
            await Promise.resolve();
            expect(mockState.workers).toHaveLength(2);
            expect(mockState.liveWorkers).toBe(2);

            // 1 ms before the 15-minute deadline: neither worker may be terminated yet.
            await vi.advanceTimersByTimeAsync(15 * 60 * 1_000 - 1);
            expect(mockState.workers[0]!.terminateCalls).toBe(0);
            expect(mockState.workers[1]!.terminateCalls).toBe(0);

            // Cross the exact 15-minute boundary.
            await vi.advanceTimersByTimeAsync(1);
            expect(mockState.workers[0]!.terminateCalls).toBe(1);
            expect(mockState.workers[1]!.terminateCalls).toBe(1);

            // Callers reject promptly at the deadline even while worker exit is pending.
            const [firstResult, secondResult] = await Promise.all([stalledOneOutcome, stalledTwoOutcome]);
            expect(firstResult.ok).toBe(false);
            expect(firstResult.ok ? '' : (firstResult.error as Error).message).toMatch(/timed out after 900000ms/u);
            expect(secondResult.ok).toBe(false);
            expect(secondResult.ok ? '' : (secondResult.error as Error).message).toMatch(/timed out after 900000ms/u);

            // Neither stalled worker has exited yet, so no third worker may be spawned.
            await Promise.resolve();
            await Promise.resolve();
            expect(mockState.workers).toHaveLength(2);
            expect(mockState.peakLiveWorkers).toBe(2);

            // Now let the timed-out workers exit; slots are released and the queued request runs.
            terminateGates.get(mockState.workers[0]!)!.resolve(0);
            terminateGates.get(mockState.workers[1]!)!.resolve(0);

            const thirdResult = await queuedThree;
            expect(thirdResult).toEqual({echo: '/tmp/recovery-3.idx'});
            expect(mockState.peakLiveWorkers).toBeLessThanOrEqual(2);
        } finally {
            for (const gate of terminateGates.values()) {
                gate.resolve(0);
            }
        }
    });

    it('keeps the slot reserved if terminate() rejects until exit fires, and cleans up staged index temp files after exit', async () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'evb-search-worker-stage-'));
        let createdStagedPath: string | null = null;
        const secondWorkerGate = Promise.withResolvers<void>();
        try {
            let rejectTerminateOnce = true;
            mockState.onPost = (worker, message) => {
                if (message.command.op === 'index') {
                    const stagedCandidate = (message.command as {stagedIndexPath?: unknown}).stagedIndexPath;
                    createdStagedPath = typeof stagedCandidate === 'string' ? stagedCandidate : null;
                    if (createdStagedPath) {
                        writeFileSync(createdStagedPath, Buffer.from('partial-index'));
                    }
                    // Stall so timeout terminates this worker after staging a temp file.
                    return;
                }
                if (message.command.op === 'stat' && message.command.indexPath.includes('hold-slot')) {
                    void secondWorkerGate.promise.then(() => {
                        worker.emit('message', {
                            id: message.id,
                            ok: true,
                            data: {echo: '/tmp/hold-slot.idx'},
                        });
                    });
                    return;
                }
                queueMicrotask(() => {
                    worker.emit('message', {
                        id: message.id,
                        ok: true,
                        data: {
                            echo: message.command.op === 'stat' ? message.command.indexPath : message.command.op,
                        },
                    });
                });
            };
            mockState.onTerminate = (worker) => {
                if (rejectTerminateOnce) {
                    rejectTerminateOnce = false;
                    return Promise.reject(new Error('terminate rpc failed'));
                }
                if (!worker.exited) {
                    worker.exited = true;
                    mockState.liveWorkers = Math.max(0, mockState.liveWorkers - 1);
                }
                return Promise.resolve(0);
            };

            const indexPath = join(tempDir, 'doc.evb-search-index');
            const stalledIndex = runPdfSearchWorkerCommand(
                {
                    op: 'index',
                    indexPath,
                    documentRevision: 'rev-1',
                    maxPageTextBytes: 1024,
                    maxTotalTextBytes: 4096,
                    pagesBuffer: new Uint8Array([1, 2, 3]),
                },
                undefined,
                {timeoutMs: 30},
            );
            const secondBusy = runPdfSearchWorkerCommand(makeStatCommand('/tmp/hold-slot.idx'));
            const queuedThird = runPdfSearchWorkerCommand(makeStatCommand('/tmp/after-rejected-terminate.idx'));

            await expect(stalledIndex).rejects.toThrow(/timed out after 30ms/u);

            expect(createdStagedPath).not.toBeNull();
            expect(createdStagedPath).not.toBe(indexPath);
            // Worker 0's terminate() rejected without exit and worker 1 is still busy:
            // no third worker may spawn yet and the staged file must remain untouched.
            await Promise.resolve();
            await Promise.resolve();
            expect(mockState.workers).toHaveLength(2);
            expect(mockState.peakLiveWorkers).toBe(2);
            expect(existsSync(createdStagedPath!)).toBe(true);

            // Once worker 0 actually emits exit, its slot is freed, the queued third
            // command runs on a replacement worker, and the staged temp file is removed.
            mockState.workers[0]!.exited = true;
            mockState.liveWorkers = Math.max(0, mockState.liveWorkers - 1);
            mockState.workers[0]!.emit('exit', 1);

            await expect(queuedThird).resolves.toEqual({echo: '/tmp/after-rejected-terminate.idx'});
            expect(mockState.peakLiveWorkers).toBeLessThanOrEqual(2);
            await vi.waitFor(() => {
                expect(existsSync(createdStagedPath!)).toBe(false);
            });

            secondWorkerGate.resolve();
            await expect(secondBusy).resolves.toEqual({echo: '/tmp/hold-slot.idx'});
        } finally {
            secondWorkerGate.resolve();
            rmSync(tempDir, {
                force: true,
                recursive: true,
            });
        }
    });

    it('awaits pending worker exit and staged index cleanup during shutdownPdfSearchWorkers()', async () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'evb-search-worker-shutdown-'));
        const terminateGate = Promise.withResolvers<number>();
        let createdStagedPath: string | null = null;
        try {
            mockState.onPost = (_worker, message) => {
                if (message.command.op === 'index') {
                    const stagedCandidate = (message.command as {stagedIndexPath?: unknown}).stagedIndexPath;
                    createdStagedPath = typeof stagedCandidate === 'string' ? stagedCandidate : null;
                    if (createdStagedPath) {
                        writeFileSync(createdStagedPath, Buffer.from('shutdown-partial'));
                    }
                }
            };
            mockState.onTerminate = (worker) =>
                terminateGate.promise.then((code) => {
                    if (!worker.exited) {
                        worker.exited = true;
                        mockState.liveWorkers = Math.max(0, mockState.liveWorkers - 1);
                    }
                    return code;
                });

            const indexPath = join(tempDir, 'doc.evb-search-index');
            const activeIndex = runPdfSearchWorkerCommand({
                op: 'index',
                indexPath,
                documentRevision: 'rev-1',
                maxPageTextBytes: 1024,
                maxTotalTextBytes: 4096,
                pagesBuffer: new Uint8Array([4, 5, 6]),
            });

            await vi.waitFor(() => {
                expect(createdStagedPath).not.toBeNull();
            });

            let shutdownSettled = false;
            const shutdownPromise = shutdownPdfSearchWorkers().then(() => {
                shutdownSettled = true;
            });
            await expect(activeIndex).rejects.toThrow('Search worker pool shut down');
            await Promise.resolve();
            expect(shutdownSettled).toBe(false);
            expect(existsSync(createdStagedPath!)).toBe(true);

            terminateGate.resolve(0);
            await shutdownPromise;
            expect(shutdownSettled).toBe(true);
            expect(existsSync(createdStagedPath!)).toBe(false);
        } finally {
            terminateGate.resolve(0);
            rmSync(tempDir, {
                force: true,
                recursive: true,
            });
        }
    });

    it('supports a configurable execution timeout and recovers with a fresh worker', async () => {
        mockState.onPost = (worker, message) => {
            if (message.command.op === 'stat' && message.command.indexPath.includes('stall')) {
                return;
            }
            queueMicrotask(() => {
                worker.emit('message', {
                    id: message.id,
                    ok: true,
                    data: {
                        echo: message.command.op === 'stat' ? message.command.indexPath : message.command.op,
                    },
                });
            });
        };

        await expect(runPdfSearchWorkerCommand(makeStatCommand('/tmp/stall-short.idx'), undefined, {timeoutMs: 40})).rejects.toThrow(
            /timed out after 40ms/u,
        );

        await expect(runPdfSearchWorkerCommand(makeStatCommand('/tmp/after-timeout.idx'), undefined, {timeoutMs: 500})).resolves.toEqual({
            echo: '/tmp/after-timeout.idx',
        });
        expect(mockState.peakLiveWorkers).toBeLessThanOrEqual(2);
    });
});
