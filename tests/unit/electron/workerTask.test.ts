import type * as TFsModule from 'fs';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted<{
    existsSync: ReturnType<typeof vi.fn<() => boolean>>;
    logged: Array<{
        level: 'debug' | 'info' | 'warn' | 'error';
        message: string;
        data?: unknown;
    }>;
    workerCtor: ReturnType<typeof vi.fn<(workerPath: string, options: unknown) => void>>;
    workerRecords: Array<{
        emit: (event: string, payload: unknown) => void;
        postMessageCalls: unknown[];
        terminateCalls: number;
    }>;
    throwConstructorError: boolean;
    nextMessage: unknown | null;
    failureReceipt: {
        eventId: string;
        code: 'UNCLASSIFIED_MAIN_ERROR';
        occurredAt: number;
        severity: 'error';
    };
    // A worker wedged in native code never acknowledges terminate(); tests that
    // need that shape hand back a promise they control.
    terminateResult: (() => Promise<number>) | null;
}>(() => ({
    existsSync: vi.fn(() => true),
    logged: [],
    workerCtor: vi.fn(),
    workerRecords: [],
    throwConstructorError: true,
    nextMessage: null,
    failureReceipt: {
        eventId: '0123456789abcdef0123456789abcdef',
        code: 'UNCLASSIFIED_MAIN_ERROR',
        occurredAt: 1,
        severity: 'error',
    },
    terminateResult: null,
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: (message: string, data?: unknown) => mocks.logged.push({
        level: 'debug',
        message,
        data,
    }),
    info: (message: string, data?: unknown) => mocks.logged.push({
        level: 'info',
        message,
        data,
    }),
    warn: (message: string, data?: unknown) => mocks.logged.push({
        level: 'warn',
        message,
        data,
    }),
    error: (message: string, _failure: unknown, data?: unknown) => {
        mocks.logged.push({
            level: 'error',
            message,
            data,
        });
        return mocks.failureReceipt;
    },
})}));

vi.mock('fs', async importOriginal => ({
    ...await importOriginal<typeof TFsModule>(),
    existsSync: mocks.existsSync,
}));
vi.mock('worker_threads', () => ({
    isMainThread: true,
    Worker: class {
        private readonly onceHandlers = new Map<string, Array<(payload: unknown) => void>>();
        private readonly onHandlers = new Map<string, Array<(payload: unknown) => void>>();
        private readonly postMessageCalls: unknown[] = [];
        private record: {
            emit: (event: string, payload: unknown) => void;
            postMessageCalls: unknown[];
            terminateCalls: number;
        } | null = null;

        constructor(workerPath: string, options: unknown) {
            mocks.workerCtor(workerPath, options);
            if (mocks.throwConstructorError) {
                throw new Error('constructor failed');
            }
            this.record = {
                emit: (event: string, payload: unknown) => {
                    this.emit(event, payload);
                },
                postMessageCalls: this.postMessageCalls,
                terminateCalls: 0,
            };
            mocks.workerRecords.push(this.record);
            void Promise.resolve().then(() => {
                this.emit('online', undefined);
                if (mocks.nextMessage !== null) {
                    this.emit('message', mocks.nextMessage);
                }
            });
        }

        once(event: string, handler: (payload: unknown) => void) {
            const handlers = this.onceHandlers.get(event) ?? [];
            handlers.push(handler);
            this.onceHandlers.set(event, handlers);
            return this;
        }

        on(event: string, handler: (payload: unknown) => void) {
            const handlers = this.onHandlers.get(event) ?? [];
            handlers.push(handler);
            this.onHandlers.set(event, handlers);
            return this;
        }

        removeAllListeners(event: string) {
            this.onceHandlers.delete(event);
            this.onHandlers.delete(event);
            return this;
        }

        removeListener(event: string, handler: (payload: unknown) => void) {
            this.onceHandlers.set(event, (this.onceHandlers.get(event) ?? []).filter(item => item !== handler));
            this.onHandlers.set(event, (this.onHandlers.get(event) ?? []).filter(item => item !== handler));
            return this;
        }

        postMessage(message: unknown) {
            this.postMessageCalls.push(message);
            return undefined;
        }

        private emit(event: string, payload: unknown) {
            const persistentHandlers = this.onHandlers.get(event) ?? [];
            const onceHandlers = this.onceHandlers.get(event) ?? [];
            if (event === 'error' && persistentHandlers.length === 0 && onceHandlers.length === 0) {
                // `Worker` is an `EventEmitter`, and an 'error' event nothing is
                // listening for is rethrown by Node into the main process. The
                // mock reproduces that so a task that stops listening too early
                // fails here instead of in production.
                throw payload instanceof Error ? payload : new Error(String(payload));
            }
            for (const handler of persistentHandlers) {
                handler(payload);
            }
            this.onceHandlers.delete(event);
            for (const handler of onceHandlers) {
                handler(payload);
            }
        }

        terminate() {
            if (this.record) {
                this.record.terminateCalls += 1;
            }
            return mocks.terminateResult?.() ?? Promise.resolve(0);
        }
    },
}));

describe('workerTask', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.existsSync.mockReturnValue(true);
        mocks.throwConstructorError = true;
        mocks.nextMessage = null;
        mocks.workerRecords.length = 0;
        mocks.terminateResult = null;
        mocks.logged.length = 0;
    });

    it('normalizes streaming worker constructor errors as startup errors', async () => {
        const { startStreamingWorkerTask } = await import('@electron/utils/workerTask');

        expect(() => startStreamingWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createStartupError: message => new Error(`startup: ${message}`),
            createWorkerExitError: code => new Error(`exit: ${code}`),
        })).toThrow('startup: constructor failed');
    });

    it('keeps missing streaming worker paths on the startup error path', async () => {
        mocks.existsSync.mockReturnValue(false);
        const { startStreamingWorkerTask } = await import('@electron/utils/workerTask');

        expect(() => startStreamingWorkerTask({
            workerPath: '/tmp/missing-worker.js',
            workerData: null,
            invalidPayloadMessage: 'invalid payload',
            createStartupError: message => new Error(`startup: ${message}`),
            createWorkerExitError: code => new Error(`exit: ${code}`),
        })).toThrow('startup: Worker unavailable at path: /tmp/missing-worker.js');
        expect(mocks.workerCtor).not.toHaveBeenCalled();
    });

    it('rejects already aborted streaming tasks before constructing a worker', async () => {
        const abortController = new AbortController();
        const abortReason = new Error('stream canceled before start');
        abortController.abort(abortReason);
        const { startStreamingWorkerTask } = await import('@electron/utils/workerTask');

        expect(() => startStreamingWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createStartupError: message => new Error(`startup: ${message}`),
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: abortController.signal,
        })).toThrow(abortReason);
        expect(mocks.workerCtor).not.toHaveBeenCalled();
    });

    it('rejects already aborted result tasks before constructing a worker', async () => {
        const abortController = new AbortController();
        const abortReason = new Error('canceled before start');
        abortController.abort(abortReason);
        const { runResultWorkerTask } = await import('@electron/utils/workerTask');

        await expect(runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: abortController.signal,
        })).rejects.toBe(abortReason);
        expect(mocks.workerCtor).not.toHaveBeenCalled();
    });

    it('preserves structured worker task error frames', async () => {
        mocks.throwConstructorError = false;
        mocks.nextMessage = {
            type: 'result',
            ok: false,
            error: 'Crop worker canceled',
            errorFrame: {
                message: 'Crop worker canceled',
                name: 'AbortError',
                code: 'ABORT_ERR',
                canceled: true,
                retryable: false,
                source: 'page-ops:crop-worker',
            },
        };
        const {
            runResultWorkerTask,
            WorkerTaskError,
        } = await import('@electron/utils/workerTask');

        try {
            await runResultWorkerTask({
                workerPath: '/tmp/worker.js',
                workerData: { ok: true },
                invalidPayloadMessage: 'invalid payload',
                createWorkerExitError: code => new Error(`exit: ${code}`),
            });
            throw new Error('Expected worker task to reject');
        } catch (error) {
            expect(error).toBeInstanceOf(WorkerTaskError);
            expect(error).toMatchObject({
                message: 'Crop worker canceled',
                name: 'AbortError',
                code: 'ABORT_ERR',
                canceled: true,
                retryable: false,
                source: 'page-ops:crop-worker',
            });
        }
    });

    it('preserves generic structured details across the worker result frame', async () => {
        mocks.throwConstructorError = false;
        const {
            createWorkerTaskErrorFrame,
            runResultWorkerTask,
            WorkerTaskError,
        } = await import('@electron/utils/workerTask');
        const workerError = Object.assign(new Error('not enough scratch'), {
            name: 'ScanCleanupInsufficientScratchError',
            code: 'insufficient-scratch',
            details: {
                scratchShortfall: {
                    availableBytes: 700 * 1024 * 1024,
                    requiredBytes: 2_304 * 1024 * 1024,
                },
            },
        });
        const workerFrame = createWorkerTaskErrorFrame(workerError, {source: 'scan-cleanup'});
        expect(workerFrame.details).toEqual({
            scratchShortfall: {
                availableBytes: 700 * 1024 * 1024,
                requiredBytes: 2_304 * 1024 * 1024,
            },
        });
        mocks.nextMessage = {
            type: 'result',
            ok: false,
            error: workerFrame.message,
            errorFrame: JSON.parse(JSON.stringify(workerFrame)) as unknown,
        };

        const error = await runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: {ok: true},
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
        }).catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(WorkerTaskError);
        expect(error).toMatchObject({
            code: 'insufficient-scratch',
            details: {
                scratchShortfall: {
                    availableBytes: 700 * 1024 * 1024,
                    requiredBytes: 2_304 * 1024 * 1024,
                },
            },
        });
    });

    it('passes opt-in resource limits to result workers', async () => {
        mocks.throwConstructorError = false;
        mocks.nextMessage = {
            type: 'result',
            ok: true,
            data: 'ok',
        };
        const { runResultWorkerTask } = await import('@electron/utils/workerTask');

        await expect(runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            resourceLimits: {
                maxOldGenerationSizeMb: 256,
                maxYoungGenerationSizeMb: 32,
                stackSizeMb: 8,
            },
        })).resolves.toBe('ok');

        expect(mocks.workerCtor).toHaveBeenCalledWith('/tmp/worker.js', {
            workerData: { ok: true },
            resourceLimits: {
                maxOldGenerationSizeMb: 256,
                maxYoungGenerationSizeMb: 32,
                stackSizeMb: 8,
            },
        });
    });

    it('preserves the pending abort reason when a cooperatively canceled worker errors', async () => {
        mocks.throwConstructorError = false;
        const abortController = new AbortController();
        const abortReason = new Error('user canceled task');
        const {runResultWorkerTask} = await import('@electron/utils/workerTask');
        const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');

        const taskPromise = runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: abortController.signal,
            createCancelMessage: reason => ({
                type: 'cancel',
                reason,
            }),
        });

        await Promise.resolve();
        abortController.abort(abortReason);
        expect(mocks.workerRecords[0]?.postMessageCalls).toContainEqual({
            type: 'cancel',
            reason: 'abort',
        });

        mocks.workerRecords[0]?.emit('error', new Error('generic worker failure'));

        await expect(taskPromise).rejects.toBe(abortReason);
        expect(getUnprovenNativeTerminationDetail(abortReason)).toContain(
            'ended before acknowledging cancellation',
        );
    });

    it.each([
        0,
        1,
    ])('marks a canceled worker exit as unproven before acknowledgement (code %i)', async code => {
        mocks.throwConstructorError = false;
        const abortController = new AbortController();
        const abortReason = new Error('navigation canceled task');
        const {runResultWorkerTask} = await import('@electron/utils/workerTask');
        const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');

        const taskPromise = runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: abortController.signal,
            createCancelMessage: reason => ({
                type: 'cancel',
                reason,
            }),
        });

        await Promise.resolve();
        abortController.abort(abortReason);

        mocks.workerRecords[0]?.emit('exit', code);

        await expect(taskPromise).rejects.toBe(abortReason);
        expect(getUnprovenNativeTerminationDetail(abortReason)).toContain(
            'ended before acknowledging cancellation',
        );
    });

    it('classifies a cooperatively canceled worker below error level after acknowledgement', async () => {
        mocks.throwConstructorError = false;
        const abortController = new AbortController();
        const abortReason = new Error('acknowledged cancellation');
        const {runResultWorkerTask} = await import('@electron/utils/workerTask');
        const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');

        const taskPromise = runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: abortController.signal,
            createCancelMessage: reason => ({
                type: 'cancel',
                reason,
            }),
        });

        await Promise.resolve();
        abortController.abort(abortReason);
        mocks.workerRecords[0]?.emit('message', {
            type: 'result',
            ok: false,
            error: 'canceled',
            errorFrame: {
                message: 'canceled',
                canceled: true,
                retryable: false,
            },
        });

        await expect(taskPromise).rejects.toBe(abortReason);
        expect(getUnprovenNativeTerminationDetail(abortReason)).toBeUndefined();
        expect(mocks.logged).toContainEqual(expect.objectContaining({
            level: 'info',
            message: 'Worker reported cancellation',
        }));
        expect(mocks.logged.some(entry => entry.level === 'error')).toBe(false);
    });

    it('waits for force termination of a non-cooperative worker before settling', async () => {
        mocks.throwConstructorError = false;
        const terminated = Promise.withResolvers<number>();
        mocks.terminateResult = () => terminated.promise;
        const abortController = new AbortController();
        const abortReason = new Error('working copy is closing');
        const { runResultWorkerTask } = await import('@electron/utils/workerTask');

        const taskPromise = runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: abortController.signal,
            createCancelMessage: reason => ({
                type: 'cancel',
                reason,
            }),
            cooperativeCancelDelayMs: 5,
        });
        let settled = false;
        void taskPromise.catch(() => undefined).finally(() => {
            settled = true;
        });

        await Promise.resolve();
        abortController.abort(abortReason);
        // The worker ignored the cooperative cancel, so the harness force
        // terminates it. Until that termination arrives the caller must not be
        // told the task is over: its native children still hold the input.
        await vi.waitFor(() => {
            expect(mocks.workerRecords[0]?.terminateCalls).toBe(1);
        });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(settled).toBe(false);

        terminated.resolve(1);

        await expect(taskPromise).rejects.toBe(abortReason);
    });

    it('never reports a wedged worker as stopped, however long force termination takes', async () => {
        vi.useFakeTimers();
        mocks.throwConstructorError = false;
        // A worker stuck in native code acknowledges nothing: terminate() never
        // resolves and no exit ever arrives.
        mocks.terminateResult = () => new Promise<number>(() => {});
        const abortController = new AbortController();
        const abortReason = new Error('working copy is closing');
        const {
            runResultWorkerTask,
            WORKER_TERMINATION_ESCALATION_INTERVAL_MS,
            WORKER_TERMINATION_ESCALATION_LIMIT,
        } = await import('@electron/utils/workerTask');

        const taskPromise = runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: abortController.signal,
            createCancelMessage: () => ({type: 'cancel'}),
            cooperativeCancelDelayMs: 5,
        });
        let settled = false;
        const rejection = expect(taskPromise).rejects.toBe(abortReason);
        void taskPromise.catch(() => undefined).finally(() => {
            settled = true;
        });

        await Promise.resolve();
        abortController.abort(abortReason);
        await vi.advanceTimersByTimeAsync(5);
        expect(mocks.workerRecords[0]?.terminateCalls).toBe(1);

        await vi.advanceTimersByTimeAsync(
            WORKER_TERMINATION_ESCALATION_INTERVAL_MS * (WORKER_TERMINATION_ESCALATION_LIMIT + 2),
        );
        // Settling here would tell the close path that the working copy is free
        // while the worker's Poppler children are still reading it.
        expect(settled).toBe(false);
        expect(mocks.workerRecords[0]?.terminateCalls).toBe(WORKER_TERMINATION_ESCALATION_LIMIT);
        expect(mocks.logged.filter(entry => (
            entry.level === 'warn' && entry.message === 'Worker remains unsettled after termination request'
        ))).toHaveLength(WORKER_TERMINATION_ESCALATION_LIMIT - 1);
        // A wedged worker is a contained outcome the working-copy owner turns
        // into a quarantine, so it stays below the level the renderer reports.
        expect(mocks.logged.some(entry => (
            entry.level === 'warn' && entry.message === 'Worker remains unsettled after termination escalation'
        ))).toBe(true);
        expect(mocks.logged.some(entry => entry.level === 'error')).toBe(false);

        // Only the thread actually going away releases the task.
        mocks.workerRecords[0]?.emit('exit', 1);
        await rejection;
        expect(settled).toBe(true);
    });

    it('does not treat a rejected termination request as a stopped worker', async () => {
        mocks.throwConstructorError = false;
        mocks.terminateResult = () => Promise.reject(new Error('terminate failed'));
        const abortController = new AbortController();
        const abortReason = new Error('working copy is closing');
        const { runResultWorkerTask } = await import('@electron/utils/workerTask');

        const taskPromise = runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: abortController.signal,
            createCancelMessage: () => ({type: 'cancel'}),
            cooperativeCancelDelayMs: 5,
        });
        let settled = false;
        const rejection = expect(taskPromise).rejects.toBe(abortReason);
        void taskPromise.catch(() => undefined).finally(() => {
            settled = true;
        });

        await Promise.resolve();
        abortController.abort(abortReason);
        await vi.waitFor(() => {
            expect(mocks.logged.some(entry => (
                entry.level === 'warn'
                && entry.message.includes('Worker termination request did not complete')
            ))).toBe(true);
        });
        // A rejected request says nothing about the thread, so it is not proof.
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(settled).toBe(false);

        mocks.workerRecords[0]?.emit('exit', 1);
        await rejection;
        expect(settled).toBe(true);
    });

    it('does not treat a synchronously throwing terminate() as a stopped worker', async () => {
        mocks.throwConstructorError = false;
        // `worker.terminate()` can throw rather than reject. Left unhandled that
        // throw would unwind the finalize path and settle the task while the
        // thread is still running, which is the same lie a rejection would be.
        mocks.terminateResult = () => {
            throw new Error('terminate threw');
        };
        const abortController = new AbortController();
        const abortReason = new Error('working copy is closing');
        const { runResultWorkerTask } = await import('@electron/utils/workerTask');

        const taskPromise = runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: abortController.signal,
            createCancelMessage: () => ({type: 'cancel'}),
            cooperativeCancelDelayMs: 5,
        });
        let settled = false;
        const rejection = expect(taskPromise).rejects.toBe(abortReason);
        void taskPromise.catch(() => undefined).finally(() => {
            settled = true;
        });

        await Promise.resolve();
        abortController.abort(abortReason);
        await vi.waitFor(() => {
            expect(mocks.logged.some(entry => (
                entry.level === 'warn'
                && entry.message === 'Worker termination request did not complete'
                && (entry.data as {error?: string} | undefined)?.error === 'terminate threw'
            ))).toBe(true);
        });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(settled).toBe(false);

        mocks.workerRecords[0]?.emit('exit', 1);
        await rejection;
        expect(settled).toBe(true);
    });

    it('handles a worker error emitted after its task settled', async () => {
        mocks.throwConstructorError = false;
        mocks.nextMessage = {
            type: 'result',
            ok: true,
            data: {done: true},
        };
        const { runResultWorkerTask } = await import('@electron/utils/workerTask');

        await expect(runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
        })).resolves.toEqual({done: true});

        // The task stopped listening, but the worker is still unwinding. An
        // 'error' with no listener is rethrown by Node into the main process.
        expect(() => {
            mocks.workerRecords[0]?.emit('error', new Error('late worker error'));
        }).not.toThrow();
        expect(mocks.logged.some(entry => (
            entry.level === 'info' && entry.message.includes('after its task settled')
        ))).toBe(true);
        expect(mocks.logged.filter(entry => entry.level === 'error')).toEqual([]);
    });

    it('keeps an expected cancellation out of the application error stream', async () => {
        mocks.throwConstructorError = false;
        const abortController = new AbortController();
        const abortReason = new Error('working copy is closing');
        const { runResultWorkerTask } = await import('@electron/utils/workerTask');

        const taskPromise = runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: abortController.signal,
            createCancelMessage: () => ({type: 'cancel'}),
            cooperativeCancelDelayMs: 5_000,
        });

        await Promise.resolve();
        abortController.abort(abortReason);
        mocks.workerRecords[0]?.emit('exit', 1);

        await expect(taskPromise).rejects.toBe(abortReason);
        expect(mocks.logged.filter(entry => entry.level === 'error')).toEqual([]);
        expect(mocks.logged.some(entry => (
            entry.level === 'info' && entry.message.startsWith('Worker exited while cancelling')
        ))).toBe(true);
    });

    it('reports a genuine worker failure once and marks it as already reported', async () => {
        mocks.throwConstructorError = false;
        mocks.nextMessage = {
            type: 'result',
            ok: false,
            error: 'pdftoppm failed',
            errorFrame: {
                message: 'pdftoppm failed',
                name: 'Error',
                canceled: false,
                source: 'scan-cleanup',
            },
        };
        const {
            getWorkerTaskFailureReceipt,
            runResultWorkerTask,
        } = await import('@electron/utils/workerTask');

        const error = await runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
        }).catch((cause: unknown) => cause);

        expect(getWorkerTaskFailureReceipt(error)).toEqual(mocks.failureReceipt);
        expect(mocks.logged.filter(entry => entry.level === 'error')).toEqual([{
            level: 'error',
            message: 'Worker reported failure',
            data: expect.objectContaining({error: 'pdftoppm failed'}),
        }]);
    });

    it('treats a worker-reported abort as a cancellation rather than a failure', async () => {
        mocks.throwConstructorError = false;
        mocks.nextMessage = {
            type: 'result',
            ok: false,
            error: 'Scan cleanup canceled',
            errorFrame: {
                message: 'Scan cleanup canceled',
                name: 'AbortError',
                code: 'ABORT_ERR',
                canceled: true,
                source: 'scan-cleanup',
            },
        };
        const {
            getWorkerTaskFailureReceipt,
            runResultWorkerTask,
        } = await import('@electron/utils/workerTask');

        const error = await runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
        }).catch((cause: unknown) => cause);

        expect(getWorkerTaskFailureReceipt(error)).toBeUndefined();
        expect(mocks.logged.filter(entry => entry.level === 'error')).toEqual([]);
    });

    // The quarantine decision is made in main but observed in the worker, and a
    // symbol-tagged error cannot survive the structured clone between them. This
    // is the only link that carries it across, so it is asserted on both sides.
    it('carries an unproven native termination across the worker result frame', async () => {
        mocks.throwConstructorError = false;
        const {
            createWorkerTaskErrorFrame,
            runResultWorkerTask,
        } = await import('@electron/utils/workerTask');
        const {
            getUnprovenNativeTerminationDetail,
            markUnprovenNativeTermination,
        } = await import('@electron/utils/nativeTerminationProof');

        const detail = 'evb-scan-cleanup process tree (pid=4242) was not proven dead within 3500ms of termination';
        // What the worker thread posts after its sidecar could not confirm the
        // death of the Poppler tree it spawned.
        const workerFrame = createWorkerTaskErrorFrame(
            markUnprovenNativeTermination(
                new DOMException('Canceled scan cleanup detection', 'AbortError'),
                detail,
            ),
            {source: 'scan-cleanup'},
        );
        expect(workerFrame.terminationUnproven).toBe(detail);
        mocks.nextMessage = {
            type: 'result',
            ok: false,
            error: workerFrame.message,
            // Structured clone drops everything that is not plain data, so the
            // frame is round-tripped rather than handed over by reference.
            errorFrame: JSON.parse(JSON.stringify(workerFrame)) as unknown,
        };

        const error = await runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
        }).catch((cause: unknown) => cause);

        // Main re-attaches the mark, which is what makes the close path retain
        // the source bytes instead of deleting them under a surviving child.
        expect(getUnprovenNativeTerminationDetail(error)).toBe(detail);
        // An unproven stop of a cancelled run is still a cancellation, so it
        // must not become an application error report.
        expect(mocks.logged.filter(entry => entry.level === 'error')).toEqual([]);
    });

    it('carries domain details supplied via frame options so domain code decodes them', async () => {
        mocks.throwConstructorError = false;
        const {
            createWorkerTaskErrorFrame,
            runResultWorkerTask,
        } = await import('@electron/utils/workerTask');
        const {ScanCleanupInsufficientScratchError} = await import('@evb/scan-cleanup/core/errors');
        const {scanCleanupScratchShortfall} = await import('@electron/features/scan-cleanup/scanCleanupPreviewPolicy');
        const scratchError = new ScanCleanupInsufficientScratchError(512, 1_024);
        const workerFrame = createWorkerTaskErrorFrame(
            scratchError,
            {
                source: 'scan-cleanup',
                details: {scratchShortfall: scratchError.scratchShortfall},
            },
        );
        expect(workerFrame).toMatchObject({
            code: 'insufficient-scratch',
            details: {
                scratchShortfall: {
                    availableBytes: 512,
                    requiredBytes: 1_024,
                },
            },
        });
        mocks.nextMessage = {
            type: 'result',
            ok: false,
            error: workerFrame.message,
            errorFrame: JSON.parse(JSON.stringify(workerFrame)) as unknown,
        };

        const error = await runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: {ok: true},
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
        }).catch((cause: unknown) => cause);

        expect(scanCleanupScratchShortfall(error)).toEqual({
            details: {
                scratchShortfall: {
                    availableBytes: 512,
                    requiredBytes: 1_024,
                },
            },
        });
    });

    it('carries the cancelled worker\'s unproven termination onto the abort rejection', async () => {
        mocks.throwConstructorError = false;
        const abortController = new AbortController();
        const abortReason = new Error('working copy is closing');
        const detail = 'evb-scan-cleanup process tree (pid=4242) was not proven dead within 3500ms of termination';
        const { runResultWorkerTask } = await import('@electron/utils/workerTask');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');

        const taskPromise = runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: abortController.signal,
            createCancelMessage: () => ({type: 'cancel'}),
            cooperativeCancelDelayMs: 5_000,
        });

        await Promise.resolve();
        abortController.abort(abortReason);
        // The worker cooperated: it stopped, and it reported that its native
        // tree was never confirmed dead. The rejection stays the abort reason so
        // the job still ends as canceled, but the evidence has to survive.
        mocks.workerRecords[0]?.emit('message', {
            type: 'result',
            ok: false,
            error: 'Scan cleanup canceled',
            errorFrame: {
                message: 'Scan cleanup canceled',
                name: 'AbortError',
                code: 'ABORT_ERR',
                canceled: true,
                terminationUnproven: detail,
            },
        });

        const error = await taskPromise.catch((cause: unknown) => cause);

        expect(error).toBe(abortReason);
        expect(getUnprovenNativeTerminationDetail(error)).toBe(detail);
        expect(mocks.logged.filter(entry => entry.level === 'error')).toEqual([]);
    });

    it('leaves a cancelled worker that proved its termination unmarked', async () => {
        mocks.throwConstructorError = false;
        const abortController = new AbortController();
        const abortReason = new Error('working copy is closing');
        const { runResultWorkerTask } = await import('@electron/utils/workerTask');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');

        const taskPromise = runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: abortController.signal,
            createCancelMessage: () => ({type: 'cancel'}),
            cooperativeCancelDelayMs: 5_000,
        });

        await Promise.resolve();
        abortController.abort(abortReason);
        mocks.workerRecords[0]?.emit('message', {
            type: 'result',
            ok: false,
            error: 'Scan cleanup canceled',
            errorFrame: {
                message: 'Scan cleanup canceled',
                name: 'AbortError',
                code: 'ABORT_ERR',
                canceled: true,
            },
        });

        const error = await taskPromise.catch((cause: unknown) => cause);

        // Quarantining an ordinary cancellation would retain a temp directory
        // for the rest of the session every time a document tab is closed.
        expect(getUnprovenNativeTerminationDetail(error)).toBeUndefined();
    });

    it('marks a force-terminated worker as leaving its native children unaccounted for', async () => {
        vi.useFakeTimers();
        mocks.throwConstructorError = false;
        const abortController = new AbortController();
        const abortReason = new Error('working copy is closing');
        const { runResultWorkerTask } = await import('@electron/utils/workerTask');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');

        const taskPromise = runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: abortController.signal,
            createCancelMessage: () => ({type: 'cancel'}),
            cooperativeCancelDelayMs: 5_000,
        });
        const settled = taskPromise.catch((cause: unknown) => cause);

        await Promise.resolve();
        abortController.abort(abortReason);
        // The worker never answers. terminate() ends the thread, but the
        // detached Poppler group that thread spawned is nobody's to stop, so the
        // bytes it was reading cannot be reclaimed on this evidence.
        await vi.advanceTimersByTimeAsync(5_000);
        vi.useRealTimers();

        const error = await settled;

        expect(error).toBe(abortReason);
        expect(getUnprovenNativeTerminationDetail(error))
            .toContain('native processes it spawned were never confirmed stopped');
        expect(mocks.logged.some(entry => (
            entry.level === 'warn' && entry.message === 'Worker did not acknowledge cancellation before force termination'
        ))).toBe(true);
        expect(mocks.logged.filter(entry => entry.level === 'error')).toEqual([]);
    });

    describe('owner lease', () => {
        const LEASE = {
            cpuTokens: 1,
            estimatedResidentBytes: 1,
            nativeProcesses: 1,
            ioWeight: 1,
        };

        async function runUnderLease(
            task: (onTerminationProof: (proof: Promise<boolean>) => void) => Promise<unknown>,
        ) {
            const {JobBroker} = await import('@electron/resources/jobBroker');
            const broker = new JobBroker(LEASE);
            const outcome = broker.run({
                ownerId: 'conformance',
                kind: 'conformance',
                priority: 'user',
                resources: LEASE,
            }, ({onTerminationProof}) => task(onTerminationProof)).catch((cause: unknown) => cause);
            return {
                broker,
                outcome,
            };
        }

        it('keeps the lease of a force-terminated worker even when the abort reason was already unproven', async () => {
            vi.useFakeTimers();
            mocks.throwConstructorError = false;
            const {runResultWorkerTask} = await import('@electron/utils/workerTask');
            const {
                getUnprovenNativeTerminationDetail,
                markUnprovenNativeTermination,
            } = await import('@electron/utils/nativeTerminationProof');
            const jobAbort = new AbortController();
            // A sibling's child outlived its kill and stopped the shared job.
            const siblingReason = markUnprovenNativeTermination(new Error('sibling not proven dead'), 'sibling alive');

            const {
                broker,
                outcome,
            } = await runUnderLease(onTerminationProof => runResultWorkerTask({
                workerPath: '/tmp/worker.js',
                workerData: {ok: true},
                invalidPayloadMessage: 'invalid payload',
                createWorkerExitError: code => new Error(`exit: ${code}`),
                signal: jobAbort.signal,
                createCancelMessage: () => ({type: 'cancel'}),
                cooperativeCancelDelayMs: 5_000,
                onTerminationProof,
            }));
            await vi.advanceTimersByTimeAsync(0);
            jobAbort.abort(siblingReason);
            // This worker ignores the cancel and is force terminated; its own
            // native children were never stopped.
            await vi.advanceTimersByTimeAsync(5_000);
            vi.useRealTimers();

            expect(getUnprovenNativeTerminationDetail(await outcome)).toBeDefined();
            expect(broker.getSnapshot()).toMatchObject({
                active: 1,
                used: {nativeProcesses: 1},
            });
        });

        it('releases the lease of a worker that acknowledged a cancel whose reason was already unproven', async () => {
            mocks.throwConstructorError = false;
            const {runResultWorkerTask} = await import('@electron/utils/workerTask');
            const {markUnprovenNativeTermination} = await import('@electron/utils/nativeTerminationProof');
            const jobAbort = new AbortController();
            const siblingReason = markUnprovenNativeTermination(new Error('sibling not proven dead'), 'sibling alive');

            const {
                broker,
                outcome,
            } = await runUnderLease(onTerminationProof => runResultWorkerTask({
                workerPath: '/tmp/worker.js',
                workerData: {ok: true},
                invalidPayloadMessage: 'invalid payload',
                createWorkerExitError: code => new Error(`exit: ${code}`),
                signal: jobAbort.signal,
                createCancelMessage: () => ({type: 'cancel'}),
                cooperativeCancelDelayMs: 5_000,
                onTerminationProof,
            }));
            await vi.waitFor(() => expect(mocks.workerRecords).toHaveLength(1));
            jobAbort.abort(siblingReason);
            mocks.workerRecords[0]!.emit('message', {
                type: 'result',
                ok: false,
                error: 'canceled',
                errorFrame: {
                    message: 'canceled',
                    name: 'AbortError',
                    canceled: true,
                },
            });

            expect(await outcome).toBe(siblingReason);
            expect(broker.getSnapshot()).toMatchObject({
                active: 0,
                used: {nativeProcesses: 0},
            });
        });

        it.each([
            {
                reply: 'an invalid envelope',
                payload: {type: 'unexpected'},
            },
            {
                reply: 'a success envelope with invalid data',
                payload: {
                    type: 'result',
                    ok: true,
                    data: {notAProfile: true},
                },
            },
        ])('keeps the lease of a worker that answers a cancel with $reply', async ({payload}) => {
            mocks.throwConstructorError = false;
            const {runResultWorkerTask} = await import('@electron/utils/workerTask');
            const {
                getUnprovenNativeTerminationDetail,
                markUnprovenNativeTermination,
            } = await import('@electron/utils/nativeTerminationProof');
            const jobAbort = new AbortController();
            const siblingReason = markUnprovenNativeTermination(new Error('sibling not proven dead'), 'sibling alive');

            const {
                broker,
                outcome,
            } = await runUnderLease(onTerminationProof => runResultWorkerTask({
                workerPath: '/tmp/worker.js',
                workerData: {ok: true},
                invalidPayloadMessage: 'invalid payload',
                createWorkerExitError: code => new Error(`exit: ${code}`),
                decodeResult: data => (typeof data === 'object' && data !== null && 'profile' in data ? data : null),
                signal: jobAbort.signal,
                createCancelMessage: () => ({type: 'cancel'}),
                cooperativeCancelDelayMs: 5_000,
                onTerminationProof,
            }));
            await vi.waitFor(() => expect(mocks.workerRecords).toHaveLength(1));
            jobAbort.abort(siblingReason);
            // Not a cancel acknowledgement: the worker's children may still run.
            mocks.workerRecords[0]!.emit('message', payload);

            expect(getUnprovenNativeTerminationDetail(await outcome)).toBeDefined();
            expect(broker.getSnapshot()).toMatchObject({
                active: 1,
                used: {nativeProcesses: 1},
            });
        });

        it('keeps the lease of a worker whose cancel reply makes the decoder throw', async () => {
            mocks.throwConstructorError = false;
            const {runResultWorkerTask} = await import('@electron/utils/workerTask');
            const {
                getUnprovenNativeTerminationDetail,
                markUnprovenNativeTermination,
            } = await import('@electron/utils/nativeTerminationProof');
            const jobAbort = new AbortController();
            const siblingReason = markUnprovenNativeTermination(new Error('sibling not proven dead'), 'sibling alive');

            const {
                broker,
                outcome,
            } = await runUnderLease(onTerminationProof => runResultWorkerTask({
                workerPath: '/tmp/worker.js',
                workerData: {ok: true},
                invalidPayloadMessage: 'invalid payload',
                createWorkerExitError: code => new Error(`exit: ${code}`),
                // As the conformance decoder does on a cloned reply whose
                // `saveRestrictions` is not an array.
                decodeResult: data => ((data as {saveRestrictions: {every: () => boolean}}).saveRestrictions.every() ? data : null),
                signal: jobAbort.signal,
                createCancelMessage: () => ({type: 'cancel'}),
                cooperativeCancelDelayMs: 5_000,
                onTerminationProof,
            }));
            await vi.waitFor(() => expect(mocks.workerRecords).toHaveLength(1));
            jobAbort.abort(siblingReason);
            mocks.workerRecords[0]!.emit('message', {
                type: 'result',
                ok: true,
                data: {saveRestrictions: {every: 'not callable'}},
            });

            expect(getUnprovenNativeTerminationDetail(await outcome)).toBeDefined();
            expect(mocks.workerRecords[0]!.terminateCalls).toBe(1);
            expect(broker.getSnapshot()).toMatchObject({
                active: 1,
                used: {nativeProcesses: 1},
            });
        });

        it('keeps the lease of a worker whose decoder throws on the cancel reply when the abort reason is frozen', async () => {
            mocks.throwConstructorError = false;
            const {runResultWorkerTask} = await import('@electron/utils/workerTask');
            const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');
            const jobAbort = new AbortController();
            const frozenReason = new Error('frozen cancel', {cause: 'owner closed'});
            frozenReason.name = 'AbortError';
            Object.freeze(frozenReason);

            const {
                broker,
                outcome,
            } = await runUnderLease(onTerminationProof => runResultWorkerTask({
                workerPath: '/tmp/worker.js',
                workerData: {ok: true},
                invalidPayloadMessage: 'invalid payload',
                createWorkerExitError: code => new Error(`exit: ${code}`),
                decodeResult: () => {
                    throw new TypeError('decoder failed');
                },
                signal: jobAbort.signal,
                createCancelMessage: () => ({type: 'cancel'}),
                cooperativeCancelDelayMs: 5_000,
                onTerminationProof,
            }));
            await vi.waitFor(() => expect(mocks.workerRecords).toHaveLength(1));
            jobAbort.abort(frozenReason);
            mocks.workerRecords[0]!.emit('message', {
                type: 'result',
                ok: true,
                data: {},
            });

            const error = await outcome;
            // A frozen reason cannot carry the mark, so the rejection wraps it.
            expect(error).toMatchObject({
                name: 'AbortError',
                message: 'frozen cancel',
                cause: frozenReason,
            });
            expect(getUnprovenNativeTerminationDetail(error)).toContain('ended before acknowledging cancellation');
            expect(broker.getSnapshot()).toMatchObject({
                active: 1,
                used: {nativeProcesses: 1},
            });
        });

        it('rejects a reply that makes the decoder throw as an invalid result', async () => {
            mocks.throwConstructorError = false;
            const {runResultWorkerTask} = await import('@electron/utils/workerTask');

            const {
                broker,
                outcome,
            } = await runUnderLease(onTerminationProof => runResultWorkerTask({
                workerPath: '/tmp/worker.js',
                workerData: {ok: true},
                invalidPayloadMessage: 'invalid payload',
                invalidResultMessage: 'invalid conformance result',
                createWorkerExitError: code => new Error(`exit: ${code}`),
                decodeResult: () => {
                    throw new TypeError('saveRestrictions.every is not a function');
                },
                onTerminationProof,
            }));
            await vi.waitFor(() => expect(mocks.workerRecords).toHaveLength(1));
            mocks.workerRecords[0]!.emit('message', {
                type: 'result',
                ok: true,
                data: {},
            });

            expect(await outcome).toMatchObject({message: 'invalid conformance result'});
            expect(broker.getSnapshot().active).toBe(1);
        });

        it('keeps the lease of a force-terminated worker whose abort reason is a string', async () => {
            vi.useFakeTimers();
            mocks.throwConstructorError = false;
            const {runResultWorkerTask} = await import('@electron/utils/workerTask');
            const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');
            const controller = new AbortController();

            const {
                broker,
                outcome,
            } = await runUnderLease(onTerminationProof => runResultWorkerTask({
                workerPath: '/tmp/worker.js',
                workerData: {ok: true},
                invalidPayloadMessage: 'invalid payload',
                createWorkerExitError: code => new Error(`exit: ${code}`),
                signal: controller.signal,
                createCancelMessage: () => ({type: 'cancel'}),
                cooperativeCancelDelayMs: 5_000,
                onTerminationProof,
            }));
            await vi.advanceTimersByTimeAsync(0);
            controller.abort('cancel');
            await vi.advanceTimersByTimeAsync(5_000);
            vi.useRealTimers();

            const error = await outcome;
            // The string cannot carry the mark, so the rejection wraps it.
            expect(error).toMatchObject({
                name: 'AbortError',
                message: 'cancel',
                cause: 'cancel',
            });
            expect(getUnprovenNativeTerminationDetail(error)).toContain('force terminated');
            expect(broker.getSnapshot()).toMatchObject({
                active: 1,
                used: {nativeProcesses: 1},
            });
        });

        it('keeps the lease of a worker that crashed after starting, whatever its exit error says', async () => {
            mocks.throwConstructorError = false;
            const {runResultWorkerTask} = await import('@electron/utils/workerTask');
            const {getUnprovenNativeTerminationDetail} = await import('@electron/utils/nativeTerminationProof');

            const {
                broker,
                outcome,
            } = await runUnderLease(onTerminationProof => runResultWorkerTask({
                workerPath: '/tmp/worker.js',
                workerData: {ok: true},
                invalidPayloadMessage: 'invalid payload',
                // A plain factory, as a generic owner writes it.
                createWorkerExitError: code => new Error(`exit: ${code}`),
                onTerminationProof,
            }));
            await vi.waitFor(() => expect(mocks.workerRecords).toHaveLength(1));
            await Promise.resolve();
            mocks.workerRecords[0]!.emit('exit', 3);

            const error = await outcome;
            expect(error).toMatchObject({message: 'exit: 3'});
            expect(getUnprovenNativeTerminationDetail(error)).toContain('stopped without settling');
            expect(broker.getSnapshot()).toMatchObject({
                active: 1,
                used: {nativeProcesses: 1},
            });
        });
    });

    it('leaves a worker failure that proved its native termination unmarked', async () => {
        mocks.throwConstructorError = false;
        mocks.nextMessage = {
            type: 'result',
            ok: false,
            error: 'pdftoppm failed',
            errorFrame: {
                message: 'pdftoppm failed',
                name: 'Error',
                canceled: false,
                source: 'scan-cleanup',
            },
        };
        const { runResultWorkerTask } = await import('@electron/utils/workerTask');
        const { getUnprovenNativeTerminationDetail } = await import('@electron/utils/nativeTerminationProof');

        const error = await runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
        }).catch((cause: unknown) => cause);

        // Quarantining every ordinary failure would retain a temp directory for
        // the rest of the session on each one.
        expect(getUnprovenNativeTerminationDetail(error)).toBeUndefined();
    });

    it('rejects a result frame whose termination proof is not a string', async () => {
        mocks.throwConstructorError = false;
        mocks.nextMessage = {
            type: 'result',
            ok: false,
            error: 'pdftoppm failed',
            errorFrame: {
                message: 'pdftoppm failed',
                terminationUnproven: {detail: 'not a string'},
            },
        };
        const { runResultWorkerTask } = await import('@electron/utils/workerTask');

        // A frame that fails validation invalidates the complete result rather
        // than letting the untyped fallback message hide a protocol error.
        const error = await runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
        }).catch((cause: unknown) => cause);

        expect((error as Error).message).toBe('invalid payload');
    });

    it('omits uncloneable details so the error frame still survives structured clone', async () => {
        const {createWorkerTaskErrorFrame} = await import('@electron/utils/workerTask');
        const {markUnprovenNativeTermination} = await import('@electron/utils/nativeTerminationProof');
        const workerError = markUnprovenNativeTermination(
            Object.assign(new Error('disk error'), {
                code: 'EIO',
                details: {describe: () => 'disk error'},
            }),
            'child pid 99 still alive',
        );

        const frame = createWorkerTaskErrorFrame(workerError, {source: 'image-export:tiff-combine-worker'});
        expect(frame).toEqual({
            message: 'disk error',
            name: 'Error',
            code: 'EIO',
            canceled: false,
            retryable: false,
            source: 'image-export:tiff-combine-worker',
            terminationUnproven: 'child pid 99 still alive',
        });
        expect(() => structuredClone(frame)).not.toThrow();
    });

    it('rejects a result frame with an invalid error code field', async () => {
        mocks.throwConstructorError = false;
        mocks.nextMessage = {
            type: 'result',
            ok: false,
            error: 'not enough scratch',
            errorFrame: {
                message: 'not enough scratch',
                code: '',
            },
        };
        const {runResultWorkerTask} = await import('@electron/utils/workerTask');

        await expect(runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: {ok: true},
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
        })).rejects.toThrow('invalid payload');
    });

    it('rejects an array error frame with expando properties instead of acknowledging cancellation', async () => {
        mocks.throwConstructorError = false;
        mocks.nextMessage = {
            type: 'result',
            ok: false,
            error: 'failed',
            errorFrame: Object.assign([], {
                message: 'failed',
                canceled: true,
            }),
        };
        const {runResultWorkerTask} = await import('@electron/utils/workerTask');

        await expect(runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: {ok: true},
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
        })).rejects.toThrow('invalid payload');
    });

    it('restarts inactivity timeouts when a streaming worker reports progress', async () => {
        vi.useFakeTimers();
        mocks.throwConstructorError = false;
        const { startStreamingWorkerTask } = await import('@electron/utils/workerTask');

        const task = startStreamingWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createStartupError: message => new Error(`startup: ${message}`),
            createWorkerExitError: code => new Error(`exit: ${code}`),
            inactivityTimeoutMs: 1_000,
            createCancelMessage: reason => ({
                type: 'cancel',
                reason,
            }),
            onProgressMessage: payload => payload === 'progress',
        });
        const rejection = expect(task.promise).rejects.toThrow(
            'Worker task timed out after 1000ms without progress',
        );

        await vi.advanceTimersByTimeAsync(900);
        mocks.workerRecords[0]?.emit('message', 'progress');
        await vi.advanceTimersByTimeAsync(999);

        expect(mocks.workerRecords[0]?.postMessageCalls).toEqual([]);

        await vi.advanceTimersByTimeAsync(1);
        expect(mocks.workerRecords[0]?.postMessageCalls).toContainEqual({
            type: 'cancel',
            reason: 'timeout',
        });
        mocks.workerRecords[0]?.emit('message', {
            type: 'result',
            ok: false,
            error: 'canceled',
        });

        await rejection;
    });

    it('unrefs overall and inactivity timers while a worker is running', async () => {
        vi.useFakeTimers();
        mocks.throwConstructorError = false;
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const {startStreamingWorkerTask} = await import('@electron/utils/workerTask');

        const task = startStreamingWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: {ok: true},
            invalidPayloadMessage: 'invalid payload',
            createStartupError: message => new Error(`startup: ${message}`),
            createWorkerExitError: code => new Error(`exit: ${code}`),
            timeoutMs: 10_000,
            inactivityTimeoutMs: 20_000,
        });

        const timers = setTimeoutSpy.mock.results.map(result => result.value as NodeJS.Timeout);
        expect(timers).toHaveLength(2);
        expect(timers.every(timer => timer.hasRef() === false)).toBe(true);

        mocks.workerRecords[0]?.emit('message', {
            type: 'result',
            ok: true,
            data: 'done',
        });
        await expect(task.promise).resolves.toBe('done');
    });

    it.each([
        'runtime-error',
        'empty-clean-exit',
        'invalid-payload',
        'invalid-result',
    ] as const)('surfaces the native owner runtime hook on %s', async mode => {
        mocks.throwConstructorError = false;
        const {
            markUnprovenNativeTermination, getUnprovenNativeTerminationDetail,
        } = await import('@electron/utils/nativeTerminationProof');
        const {runResultWorkerTask} = await import('@electron/utils/workerTask');
        const marked = markUnprovenNativeTermination(new Error('native owner crashed'), 'native descendants unknown');
        const task = runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: {},
            invalidPayloadMessage: 'invalid result',
            createWorkerExitError: code => new Error(`exit ${code}`),
            createWorkerError: () => marked,
            decodeResult: data => typeof data === 'string' ? data : null,
        });
        const observed = task.catch((error: unknown) => error);
        await Promise.resolve();
        const worker = mocks.workerRecords[0]!;
        if (mode === 'invalid-payload') worker.emit('message', {type: 'unexpected'});
        else if (mode === 'invalid-result') worker.emit('message', {
            type: 'result',
            ok: true,
            data: 42,
        });
        else worker.emit(mode === 'runtime-error' ? 'error' : 'exit', mode === 'runtime-error' ? new Error('runtime crash') : 0);
        expect(await observed).toBe(marked);
        expect(getUnprovenNativeTerminationDetail(await observed)).toBe('native descendants unknown');
    });

});
