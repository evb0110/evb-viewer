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
    debug: (message: string) => mocks.logged.push({
        level: 'debug',
        message,
    }),
    info: (message: string) => mocks.logged.push({
        level: 'info',
        message,
    }),
    warn: (message: string) => mocks.logged.push({
        level: 'warn',
        message,
    }),
    error: (message: string) => {
        mocks.logged.push({
            level: 'error',
            message,
        });
        return mocks.failureReceipt;
    },
})}));

vi.mock('fs', () => ({existsSync: mocks.existsSync}));
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

    it('does not mark a canceled worker after a terminal acknowledgement', async () => {
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
        });

        await expect(taskPromise).rejects.toBe(abortReason);
        expect(getUnprovenNativeTerminationDetail(abortReason)).toBeUndefined();
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
            entry.level === 'warn' && entry.message.includes('re-issuing terminate')
        ))).toHaveLength(WORKER_TERMINATION_ESCALATION_LIMIT - 1);
        // A wedged worker is a contained outcome the working-copy owner turns
        // into a quarantine, so it stays below the level the renderer reports.
        expect(mocks.logged.some(entry => (
            entry.level === 'warn' && entry.message.includes('has not stopped after')
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
                && entry.message.includes('Worker termination request did not complete')
                && entry.message.includes('terminate threw')
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
            message: expect.stringContaining('Worker reported failure'),
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
            entry.level === 'warn' && entry.message.includes('did not acknowledge cancellation within 5000ms')
        ))).toBe(true);
        expect(mocks.logged.filter(entry => entry.level === 'error')).toEqual([]);
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

        // A frame that fails validation falls back to the plain message rather
        // than letting an untyped value reach the quarantine decision.
        const error = await runResultWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
        }).catch((cause: unknown) => cause);

        expect((error as Error).message).toBe('pdftoppm failed');
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
});
