import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    runCoordinatedPdfPageOperation,
    runCoordinatedPdfPageRender,
} from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';
import {
    createPdfRenderSupervisor,
    type IPdfRenderSupervisorEvent,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import { cast } from '@tests/helpers/cast';

async function flushAsync() {
    await new Promise<void>(resolve => setImmediate(resolve));
}

async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

function createCancelledRenderError() {
    const error = new Error('Rendering cancelled');
    error.name = 'RenderingCancelledException';
    return error;
}

function createRenderTask(options: { settleOnCancel?: boolean } = {}) {
    let resolveTask!: () => void;
    let rejectTask!: (error: unknown) => void;
    let settled = false;
    const promise = new Promise<void>((resolve, reject) => {
        resolveTask = () => {
            settled = true;
            resolve();
        };
        rejectTask = (error: unknown) => {
            settled = true;
            reject(error);
        };
    });
    return {
        promise,
        cancel: vi.fn(() => {
            if (!settled && options.settleOnCancel !== false) {
                rejectTask(createCancelledRenderError());
            }
        }),
        reject: rejectTask,
        resolve: resolveTask,
    };
}

function createDeferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });

    return {
        promise,
        reject,
        resolve,
    };
}

describe('runCoordinatedPdfPageRender', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it.each([
        {
            waitingPriority: 100,
            priorityRelationship: 'equal',
        },
        {
            waitingPriority: 10,
            priorityRelationship: 'lower',
        },
    ])('claims same-page render ownership before a $priorityRelationship-priority synchronous caller can overlap', async ({ waitingPriority }) => {
        const page = cast<IPdfPage>({ pageNumber: 1 });
        const events: string[] = [];
        const firstTask = createRenderTask();
        const secondTask = createRenderTask();

        const firstRun = runCoordinatedPdfPageRender({
            owner: 'first',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            startRender: () => {
                events.push('start first');
                return firstTask;
            },
        });
        const secondRun = runCoordinatedPdfPageRender({
            owner: 'second',
            pageNumber: 1,
            pdfPage: page,
            priority: waitingPriority,
            startRender: () => {
                events.push('start second');
                return secondTask;
            },
        });

        await flushAsync();
        expect(events).toEqual(['start first']);
        expect(firstTask.cancel).not.toHaveBeenCalled();

        firstTask.resolve();
        await firstRun;
        await flushAsync();
        expect(events).toEqual([
            'start first',
            'start second',
        ]);

        secondTask.resolve();
        await secondRun;
    });

    it('claims same-page operation ownership before synchronous callers can overlap', async () => {
        const page = cast<IPdfPage>({ pageNumber: 1 });
        const events: string[] = [];
        const firstOperation = createDeferred<string>();
        const secondOperation = createDeferred<string>();

        const firstRun = runCoordinatedPdfPageOperation({
            owner: 'first-filter',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            operation: async () => {
                events.push('start first');
                return firstOperation.promise;
            },
        });
        const secondRun = runCoordinatedPdfPageOperation({
            owner: 'second-filter',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            operation: async () => {
                events.push('start second');
                return secondOperation.promise;
            },
        });

        await flushAsync();
        expect(events).toEqual(['start first']);

        firstOperation.resolve('first');
        expect(await firstRun).toBe('first');
        await flushAsync();
        expect(events).toEqual([
            'start first',
            'start second',
        ]);

        secondOperation.resolve('second');
        expect(await secondRun).toBe('second');
    });

    it('preempts a synchronously queued lower-priority render but waits for settlement', async () => {
        const page = cast<IPdfPage>({ pageNumber: 1 });
        const events: string[] = [];
        const thumbnailTask = createRenderTask({ settleOnCancel: false });
        const viewerTask = createRenderTask();

        const thumbnailRun = runCoordinatedPdfPageRender({
            owner: 'thumbnail',
            pageNumber: 1,
            pdfPage: page,
            priority: 10,
            startRender: () => {
                events.push('start thumbnail');
                return thumbnailTask;
            },
        });
        const viewerRun = runCoordinatedPdfPageRender({
            owner: 'viewer',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            startRender: () => {
                events.push('start viewer');
                return viewerTask;
            },
        });

        await flushAsync();
        expect(thumbnailTask.cancel).toHaveBeenCalledOnce();
        expect(events).toEqual(['start thumbnail']);

        thumbnailTask.resolve();
        await thumbnailRun;
        await flushAsync();
        expect(events).toEqual([
            'start thumbnail',
            'start viewer',
        ]);

        viewerTask.resolve();
        await viewerRun;
    });

    it('allows synchronous renders for different page proxies to overlap', async () => {
        const firstPage = cast<IPdfPage>({ pageNumber: 1 });
        const secondPage = cast<IPdfPage>({ pageNumber: 1 });
        const events: string[] = [];
        const firstTask = createRenderTask();
        const secondTask = createRenderTask();

        const firstRun = runCoordinatedPdfPageRender({
            owner: 'first',
            pageNumber: 1,
            pdfPage: firstPage,
            priority: 100,
            startRender: () => {
                events.push('start first');
                return firstTask;
            },
        });
        const secondRun = runCoordinatedPdfPageRender({
            owner: 'second',
            pageNumber: 1,
            pdfPage: secondPage,
            priority: 100,
            startRender: () => {
                events.push('start second');
                return secondTask;
            },
        });

        await flushAsync();
        expect(events).toEqual([
            'start first',
            'start second',
        ]);

        firstTask.resolve();
        secondTask.resolve();
        await Promise.all([
            firstRun,
            secondRun,
        ]);
    });

    it('reports and cancels a wedged canvas task without releasing its page ownership', async () => {
        vi.useFakeTimers();
        const page = cast<IPdfPage>({pageNumber: 7});
        const task = createRenderTask({settleOnCancel: false});
        const nextTask = createRenderTask();
        const events: IPdfRenderSupervisorEvent[] = [];
        const onRenderStall = vi.fn();
        const capturedSettlements: Array<Promise<void>> = [];
        const capturedSettlementResolved = vi.fn();
        const supervisor = createPdfRenderSupervisor({onEvent: event => events.push(event)});
        const run = runCoordinatedPdfPageRender({
            owner: 'viewport',
            pageNumber: 7,
            pdfPage: page,
            priority: 100,
            startRender: () => task,
            captureSettlement: settlement => capturedSettlements.push(settlement),
            watchdog: {
                key: 'canvas:7:attempt-1',
                metadata: {renderKey: '7:1'},
                onRenderStall,
                payload: {
                    pageNumber: 7,
                    stage: 'canvas-render',
                    timeoutMs: 15_000,
                },
                renderSupervisor: supervisor,
            },
        }).catch(error => error as Error);
        await flushMicrotasks();
        expect(capturedSettlements).toHaveLength(1);
        void capturedSettlements[0]!.then(capturedSettlementResolved);

        await vi.advanceTimersByTimeAsync(15_000);

        expect(task.cancel).toHaveBeenCalledOnce();
        expect(onRenderStall).toHaveBeenCalledExactlyOnceWith({
            pageNumber: 7,
            stage: 'canvas-render',
            timeoutMs: 15_000,
        });
        expect(events).toEqual([expect.objectContaining({
            cause: 'page-stage-timeout',
            delayMs: 15_000,
            elapsedMs: 15_000,
            metadata: expect.objectContaining({
                pageNumber: 7,
                renderKey: '7:1',
                stage: 'canvas-render',
            }),
        })]);
        expect(capturedSettlementResolved).not.toHaveBeenCalled();

        const nextStart = vi.fn(() => nextTask);
        const nextRun = runCoordinatedPdfPageRender({
            owner: 'next',
            pageNumber: 7,
            pdfPage: page,
            priority: 100,
            startRender: nextStart,
        });
        await flushMicrotasks();
        expect(nextStart).not.toHaveBeenCalled();

        task.reject(createCancelledRenderError());
        const error = await run;
        expect(error).toMatchObject({
            name: 'PdfPageRenderTimeoutError',
            pageNumber: 7,
            stage: 'canvas-render',
        });
        await capturedSettlements[0];
        expect(capturedSettlementResolved).toHaveBeenCalledOnce();
        await flushMicrotasks();
        expect(nextStart).toHaveBeenCalledOnce();

        nextTask.resolve();
        await nextRun;
    });

    it.each([
        'resolve',
        'reject',
    ] as const)('clears the canvas watchdog when the task settles by %s', async (settlement) => {
        vi.useFakeTimers();
        const task = createRenderTask({settleOnCancel: false});
        const events: IPdfRenderSupervisorEvent[] = [];
        const run = runCoordinatedPdfPageRender({
            owner: 'viewport',
            pageNumber: 1,
            pdfPage: cast<IPdfPage>({pageNumber: 1}),
            priority: 100,
            startRender: () => task,
            watchdog: {
                key: `canvas-settle:${settlement}`,
                payload: {
                    pageNumber: 1,
                    stage: 'canvas-render',
                    timeoutMs: 15_000,
                },
                renderSupervisor: createPdfRenderSupervisor({onEvent: event => events.push(event)}),
            },
        }).catch(error => error as Error);
        await flushMicrotasks();

        if (settlement === 'resolve') {
            task.resolve();
            expect(await run).toBeUndefined();
        } else {
            const rejection = new Error('render failed');
            task.reject(rejection);
            expect(await run).toBe(rejection);
        }
        await vi.advanceTimersByTimeAsync(15_000);

        expect(events).toEqual([]);
        expect(task.cancel).not.toHaveBeenCalled();
    });

    it('clears an armed watchdog when the render is aborted and keeps ownership until settlement', async () => {
        vi.useFakeTimers();
        const task = createRenderTask({settleOnCancel: false});
        const controller = new AbortController();
        const events: IPdfRenderSupervisorEvent[] = [];
        const run = runCoordinatedPdfPageRender({
            owner: 'stale-viewport',
            pageNumber: 1,
            pdfPage: cast<IPdfPage>({pageNumber: 1}),
            priority: 100,
            signal: controller.signal,
            startRender: () => task,
            watchdog: {
                key: 'canvas-abort',
                payload: {
                    pageNumber: 1,
                    stage: 'canvas-render',
                    timeoutMs: 15_000,
                },
                renderSupervisor: createPdfRenderSupervisor({onEvent: event => events.push(event)}),
            },
        }).catch(error => error as Error);
        await flushMicrotasks();

        controller.abort();
        expect(task.cancel).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(events).toEqual([]);

        task.resolve();
        expect(await run).toMatchObject({name: 'RenderingCancelledException'});
    });

    it('does not arm a watchdog after synchronous preemption already cancelled the captured task', async () => {
        vi.useFakeTimers();
        const page = cast<IPdfPage>({pageNumber: 1});
        const firstTask = createRenderTask({settleOnCancel: false});
        const secondTask = createRenderTask();
        const events: IPdfRenderSupervisorEvent[] = [];
        const secondStart = vi.fn(() => secondTask);
        let secondRun: Promise<void> | null = null;
        const firstRun = runCoordinatedPdfPageRender({
            owner: 'thumbnail',
            pageNumber: 1,
            pdfPage: page,
            priority: 10,
            startRender: () => {
                secondRun = runCoordinatedPdfPageRender({
                    owner: 'viewport',
                    pageNumber: 1,
                    pdfPage: page,
                    priority: 100,
                    startRender: secondStart,
                });
                return firstTask;
            },
            watchdog: {
                key: 'canvas-preempted-before-arm',
                payload: {
                    pageNumber: 1,
                    stage: 'canvas-render',
                    timeoutMs: 15_000,
                },
                renderSupervisor: createPdfRenderSupervisor({onEvent: event => events.push(event)}),
            },
        });
        await flushMicrotasks();
        expect(firstTask.cancel).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(15_000);
        expect(events).toEqual([]);
        expect(firstTask.cancel).toHaveBeenCalledOnce();
        expect(secondStart).not.toHaveBeenCalled();

        firstTask.resolve();
        await firstRun;
        await flushMicrotasks();
        expect(secondStart).toHaveBeenCalledOnce();
        secondTask.resolve();
        await secondRun;
    });

    it('lets a task timer registered before the watchdog win when both share a deadline', async () => {
        vi.useFakeTimers();
        const task = createRenderTask({settleOnCancel: false});
        const events: IPdfRenderSupervisorEvent[] = [];
        setTimeout(task.resolve, 15_000);
        const run = runCoordinatedPdfPageRender({
            owner: 'viewport',
            pageNumber: 1,
            pdfPage: cast<IPdfPage>({pageNumber: 1}),
            priority: 100,
            startRender: () => task,
            watchdog: {
                key: 'canvas-settlement-race',
                payload: {
                    pageNumber: 1,
                    stage: 'canvas-render',
                    timeoutMs: 15_000,
                },
                renderSupervisor: createPdfRenderSupervisor({onEvent: event => events.push(event)}),
            },
        });
        await flushMicrotasks();

        await vi.advanceTimersByTimeAsync(15_000);
        await run;

        expect(events).toEqual([]);
        expect(task.cancel).not.toHaveBeenCalled();
    });

    it('keeps cancellation authoritative when stall recovery throws and buffers the callback failure', async () => {
        vi.useFakeTimers();
        const traceWindow: {
            __pdfRenderTrace: boolean;
            __getPdfRenderTrace?: (() => Array<{event: string}>) | undefined;
        } = {__pdfRenderTrace: true};
        vi.stubGlobal('window', traceWindow);
        const task = createRenderTask();
        const run = runCoordinatedPdfPageRender({
            owner: 'viewport',
            pageNumber: 4,
            pdfPage: cast<IPdfPage>({pageNumber: 4}),
            priority: 100,
            startRender: () => task,
            watchdog: {
                key: 'canvas-recovery-throws',
                onRenderStall: () => {
                    throw new Error('recovery failed');
                },
                payload: {
                    pageNumber: 4,
                    stage: 'canvas-render',
                    timeoutMs: 15_000,
                },
                renderSupervisor: createPdfRenderSupervisor(),
            },
        }).catch(error => error as Error);
        await flushMicrotasks();

        await vi.advanceTimersByTimeAsync(15_000);
        await run;

        expect(task.cancel).toHaveBeenCalledOnce();
        expect(traceWindow.__getPdfRenderTrace?.()).toEqual(expect.arrayContaining([
            expect.objectContaining({event: 'pdf-render-supervisor-watchdog'}),
            expect.objectContaining({event: 'pdf-page-stage-deadline-callback-failed'}),
        ]));
    });

    it('releases same-page ownership when shouldStart rejects a render', async () => {
        const page = cast<IPdfPage>({ pageNumber: 1 });
        const rejectedStart = vi.fn(() => createRenderTask());

        await expect(runCoordinatedPdfPageRender({
            owner: 'stale-viewer',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            shouldStart: () => false,
            startRender: rejectedStart,
        })).rejects.toMatchObject({ name: 'RenderingCancelledException' });
        expect(rejectedStart).not.toHaveBeenCalled();

        const nextTask = createRenderTask();
        const nextStart = vi.fn(() => nextTask);
        const nextRun = runCoordinatedPdfPageRender({
            owner: 'current-viewer',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            startRender: nextStart,
        });

        await flushAsync();
        expect(nextStart).toHaveBeenCalledOnce();

        nextTask.resolve();
        await nextRun;
    });

    it('preempts a lower-priority thumbnail render when the viewer needs the same page', async () => {
        const page = cast<IPdfPage>({ pageNumber: 1 });
        const events: string[] = [];
        const thumbnailTask = createRenderTask();
        const viewerTask = createRenderTask();

        const thumbnailRun = runCoordinatedPdfPageRender({
            owner: 'thumbnail',
            pageNumber: 1,
            pdfPage: page,
            priority: 10,
            startRender: () => {
                events.push('start thumbnail');
                return thumbnailTask;
            },
        }).catch(error => error as Error);

        await flushAsync();
        expect(events).toEqual(['start thumbnail']);

        const viewerRun = runCoordinatedPdfPageRender({
            owner: 'viewer',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            startRender: () => {
                events.push('start viewer');
                return viewerTask;
            },
        });

        await flushAsync();
        expect(thumbnailTask.cancel).toHaveBeenCalledOnce();
        expect(events).toEqual([
            'start thumbnail',
            'start viewer',
        ]);

        viewerTask.resolve();
        await viewerRun;
        const thumbnailError = await thumbnailRun;
        expect(thumbnailError).toBeInstanceOf(Error);
        expect((thumbnailError as Error).name).toBe('RenderingCancelledException');
    });

    it('keeps a lower-priority thumbnail render waiting while a viewer render is active', async () => {
        const page = cast<IPdfPage>({ pageNumber: 1 });
        const events: string[] = [];
        const viewerTask = createRenderTask();
        const thumbnailTask = createRenderTask();

        const viewerRun = runCoordinatedPdfPageRender({
            owner: 'viewer',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            startRender: () => {
                events.push('start viewer');
                return viewerTask;
            },
        });
        await flushAsync();

        const thumbnailRun = runCoordinatedPdfPageRender({
            owner: 'thumbnail',
            pageNumber: 1,
            pdfPage: page,
            priority: 10,
            startRender: () => {
                events.push('start thumbnail');
                return thumbnailTask;
            },
        });
        await flushAsync();
        expect(events).toEqual(['start viewer']);
        expect(thumbnailTask.cancel).not.toHaveBeenCalled();

        viewerTask.resolve();
        await viewerRun;
        await flushAsync();
        expect(events).toEqual([
            'start viewer',
            'start thumbnail',
        ]);

        thumbnailTask.resolve();
        await thumbnailRun;
    });

    it('aborts a queued render while it waits for the coordinated page turn', async () => {
        const page = cast<IPdfPage>({ pageNumber: 1 });
        const events: string[] = [];
        const viewerTask = createRenderTask();
        const queuedTask = createRenderTask();
        const queuedAbortController = new AbortController();

        const viewerRun = runCoordinatedPdfPageRender({
            owner: 'viewer',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            startRender: () => {
                events.push('start viewer');
                return viewerTask;
            },
        });
        await flushAsync();

        const queuedRun = runCoordinatedPdfPageRender({
            owner: 'thumbnail',
            pageNumber: 1,
            pdfPage: page,
            priority: 10,
            signal: queuedAbortController.signal,
            startRender: () => {
                events.push('start queued');
                return queuedTask;
            },
        }).catch(error => error as Error);
        await flushAsync();

        queuedAbortController.abort();

        const queuedError = await queuedRun;
        expect(queuedError).toBeInstanceOf(Error);
        if (!(queuedError instanceof Error)) {
            throw new Error('Expected queued render to reject with an Error');
        }
        expect(queuedError.name).toBe('RenderingCancelledException');
        expect(events).toEqual(['start viewer']);
        expect(queuedTask.cancel).not.toHaveBeenCalled();

        viewerTask.resolve();
        await viewerRun;
    });

    it('lets viewer preparation preempt a lower-priority thumbnail render', async () => {
        const page = cast<IPdfPage>({ pageNumber: 1 });
        const events: string[] = [];
        const thumbnailTask = createRenderTask();

        const thumbnailRun = runCoordinatedPdfPageRender({
            owner: 'thumbnail',
            pageNumber: 1,
            pdfPage: page,
            priority: 10,
            startRender: () => {
                events.push('start thumbnail');
                return thumbnailTask;
            },
        }).catch(error => error as Error);
        await flushAsync();

        const operationRun = runCoordinatedPdfPageOperation({
            owner: 'viewer-filter',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            operation: async () => {
                events.push('run viewer filter');
                return 'ok';
            },
        });
        await flushAsync();

        expect(thumbnailTask.cancel).toHaveBeenCalledOnce();
        expect(await operationRun).toBe('ok');
        expect(events).toEqual([
            'start thumbnail',
            'run viewer filter',
        ]);
        const thumbnailError = await thumbnailRun;
        expect(thumbnailError).toBeInstanceOf(Error);
        expect((thumbnailError as Error).name).toBe('RenderingCancelledException');
    });

    it('keeps coordinated operation ownership after abort until the operation settles', async () => {
        const page = cast<IPdfPage>({ pageNumber: 1 });
        const events: string[] = [];
        const operation = createDeferred<string>();
        const operationAbortController = new AbortController();
        const viewerTask = createRenderTask();

        const operationRun = runCoordinatedPdfPageOperation({
            owner: 'viewer-filter',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            signal: operationAbortController.signal,
            operation: async () => {
                events.push('start filter');
                return operation.promise;
            },
        }).catch(error => error as Error);
        await flushAsync();
        expect(events).toEqual(['start filter']);

        operationAbortController.abort();
        const operationError = await operationRun;
        if (!(operationError instanceof Error)) {
            throw new Error('Expected operation abort to reject');
        }
        expect(operationError.name).toBe('RenderingCancelledException');

        const renderRun = runCoordinatedPdfPageRender({
            owner: 'viewer',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            startRender: () => {
                events.push('start viewer');
                return viewerTask;
            },
        });
        await flushAsync();

        expect(events).toEqual(['start filter']);

        operation.resolve('late');
        await flushAsync();
        expect(events).toEqual([
            'start filter',
            'start viewer',
        ]);
        viewerTask.resolve();
        await renderRun;
        await flushAsync();
    });

    it('exposes the exact operation settlement independently of its aborted caller', async () => {
        const page = cast<IPdfPage>({pageNumber: 1});
        const operation = createDeferred<string>();
        const controller = new AbortController();
        const capturedSettlements: Array<Promise<void>> = [];
        const settled = vi.fn();

        const operationRun = runCoordinatedPdfPageOperation({
            owner: 'captured-filter',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            signal: controller.signal,
            captureSettlement: settlement => capturedSettlements.push(settlement),
            operation: () => operation.promise,
        }).catch(error => error as Error);
        await flushAsync();

        expect(capturedSettlements).toHaveLength(1);
        void capturedSettlements[0]!.then(settled);
        controller.abort();
        const operationError = await operationRun;
        expect(operationError).toBeInstanceOf(Error);
        expect((operationError as Error).name).toBe('RenderingCancelledException');
        await flushAsync();
        expect(settled).not.toHaveBeenCalled();

        operation.resolve('late');
        await capturedSettlements[0];
        expect(settled).toHaveBeenCalledOnce();
    });
});
