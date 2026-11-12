import { requirePageNumber } from '@contracts/pageNumbers';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createPdfRenderSupervisor,
    type IPdfRenderSupervisorEvent,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import {
    armPageStageDeadline,
    withPageStageTimeout,
} from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/withPageStageTimeout';

interface ITestPdfRenderTraceWindow {
    __pdfRenderTrace: boolean;
    __getPdfRenderTrace?: (() => Array<{
        event: string;
        payload: Record<string, unknown>;
    }>) | undefined;
}

describe('pdf render supervisor', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('classifies page-stage timeout causes without changing the stall payload', async () => {
        vi.useFakeTimers();
        const events: IPdfRenderSupervisorEvent[] = [];
        const supervisor = createPdfRenderSupervisor({
            now: () => 123,
            onEvent: event => events.push(event),
        });
        const onRenderStall = vi.fn();
        const stalledPromise = withPageStageTimeout(
            new Promise<never>(() => {}),
            {
                pageNumber: requirePageNumber(7),
                stage: 'canvas-render',
                timeoutMs: 25,
            },
            () => true,
            undefined,
            onRenderStall,
            supervisor,
        );

        const rejection = expect(stalledPromise).rejects.toMatchObject({
            pageNumber: 7,
            stage: 'canvas-render',
            timeoutMs: 25,
        });

        await vi.advanceTimersByTimeAsync(25);
        await rejection;

        expect(onRenderStall).toHaveBeenCalledExactlyOnceWith({
            pageNumber: 7,
            stage: 'canvas-render',
            timeoutMs: 25,
        });
        expect(events).toContainEqual(expect.objectContaining({
            cause: 'page-stage-timeout',
            delayMs: 25,
            metadata: {
                pageNumber: 7,
                stage: 'canvas-render',
                timeoutMs: 25,
            },
        }));
    });

    it('clears a page-stage watchdog when its render lifecycle is aborted', async () => {
        vi.useFakeTimers();
        const events: IPdfRenderSupervisorEvent[] = [];
        const supervisor = createPdfRenderSupervisor({onEvent: event => events.push(event)});
        const controller = new AbortController();
        const stalledPromise = withPageStageTimeout(
            new Promise<never>(() => {}),
            {
                pageNumber: requirePageNumber(1),
                stage: 'text-layer',
                timeoutMs: 15_000,
            },
            () => true,
            undefined,
            undefined,
            supervisor,
            controller.signal,
        );

        controller.abort();
        await expect(stalledPromise).rejects.toMatchObject({name: 'AbortError'});
        await vi.advanceTimersByTimeAsync(15_000);

        expect(events).toEqual([]);
    });

    it('keeps timeout classification when timeout cleanup aborts the stage signal', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const abortedStage = new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener('abort', () => {
                const error = new Error('underlying render aborted');
                error.name = 'AbortError';
                reject(error);
            }, {once: true});
        });
        const stalledPromise = withPageStageTimeout(
            abortedStage,
            {
                pageNumber: requirePageNumber(2),
                stage: 'annotation-layer',
                timeoutMs: 25,
            },
            () => true,
            () => controller.abort(),
            undefined,
            createPdfRenderSupervisor(),
            controller.signal,
        );
        const rejection = expect(stalledPromise).rejects.toMatchObject({
            name: 'PdfPageRenderTimeoutError',
            pageNumber: 2,
            stage: 'annotation-layer',
        });

        await vi.advanceTimersByTimeAsync(25);
        await rejection;
    });

    it('drops superseded watchdog callbacks before they can run recovery', () => {
        const callbacks: Array<() => void> = [];
        const events: IPdfRenderSupervisorEvent[] = [];
        const handles: Array<ReturnType<typeof setTimeout>> = [];
        const firstRecovery = vi.fn();
        const secondRecovery = vi.fn();
        const supervisor = createPdfRenderSupervisor({
            clearTimeoutFn: handle => clearTimeout(handle),
            now: () => 456,
            onEvent: event => events.push(event),
            setTimeoutFn: (callback, delayMs) => {
                callbacks.push(callback);
                const handle = setTimeout(() => {}, delayMs);
                handles.push(handle);
                return handle;
            },
        });

        supervisor.armTimer({
            cause: 'page-stage-timeout',
            delayMs: 10,
            key: 'canvas-render',
            onFire: firstRecovery,
        });
        supervisor.armTimer({
            cause: 'page-stage-timeout',
            delayMs: 20,
            key: 'canvas-render',
            onFire: secondRecovery,
        });

        callbacks[0]?.();

        expect(firstRecovery).not.toHaveBeenCalled();
        expect(secondRecovery).not.toHaveBeenCalled();
        expect(events).toEqual([]);

        callbacks[1]?.();

        expect(firstRecovery).not.toHaveBeenCalled();
        expect(secondRecovery).toHaveBeenCalledOnce();
        expect(events).toEqual([expect.objectContaining({
            delayMs: 20,
            ownerKey: 'canvas-render',
        })]);
        handles.forEach(handle => clearTimeout(handle));
    });

    it('records actual elapsed time when the event loop fires a watchdog late', () => {
        let now = 100;
        let callback = () => {};
        const events: IPdfRenderSupervisorEvent[] = [];
        const traceWindow: ITestPdfRenderTraceWindow = {__pdfRenderTrace: true};
        vi.stubGlobal('window', traceWindow);
        const supervisor = createPdfRenderSupervisor({
            clearTimeoutFn: () => {},
            now: () => now,
            onEvent: event => events.push(event),
            setTimeoutFn: nextCallback => {
                callback = nextCallback;
                // The supervisor treats this handle as opaque. A real zero
                // delay handle keeps the timer type honest while the test
                // manually drives the captured callback.
                return setTimeout(() => undefined, 0);
            },
        });
        supervisor.armTimer({
            cause: 'page-stage-timeout',
            delayMs: 15_000,
            key: 'late-canvas-render',
            onFire: vi.fn(),
        });

        now = 15_275;
        callback();

        expect(events).toEqual([expect.objectContaining({
            delayMs: 15_000,
            elapsedMs: 15_175,
            firedAtMs: 15_275,
        })]);
        expect(traceWindow.__getPdfRenderTrace?.()).toEqual([expect.objectContaining({
            event: 'pdf-render-supervisor-watchdog',
            payload: expect.objectContaining({
                cause: 'page-stage-timeout',
                elapsedMs: 15_175,
                ownerKey: 'late-canvas-render',
            }),
        })]);
    });

    it('runs timeout work before notification and diagnoses callback failures', async () => {
        vi.useFakeTimers();
        const order: string[] = [];
        const traceWindow: ITestPdfRenderTraceWindow = {__pdfRenderTrace: true};
        vi.stubGlobal('window', traceWindow);
        const deadline = armPageStageDeadline({
            key: 'shared-canvas-deadline',
            onRenderStall: () => {
                order.push('notify');
                throw new Error('notify failed');
            },
            onTimeout: () => {
                order.push('timeout');
                throw new Error('timeout failed');
            },
            payload: {
                pageNumber: requirePageNumber(9),
                stage: 'canvas-render',
                timeoutMs: 25,
            },
            renderSupervisor: createPdfRenderSupervisor(),
            shouldNotify: () => true,
        });
        const rejection = expect(deadline.promise).rejects.toMatchObject({
            name: 'PdfPageRenderTimeoutError',
            pageNumber: 9,
            stage: 'canvas-render',
        });

        await vi.advanceTimersByTimeAsync(25);
        await rejection;

        expect(order).toEqual([
            'timeout',
            'notify',
        ]);
        expect(traceWindow.__getPdfRenderTrace?.()).toEqual(expect.arrayContaining([
            expect.objectContaining({event: 'pdf-render-supervisor-watchdog'}),
            expect.objectContaining({
                event: 'pdf-page-stage-deadline-callback-failed',
                payload: expect.objectContaining({callback: 'on-timeout'}),
            }),
            expect.objectContaining({
                event: 'pdf-page-stage-deadline-callback-failed',
                payload: expect.objectContaining({callback: 'render-stall-recovery'}),
            }),
        ]));
    });
});
