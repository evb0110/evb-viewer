import type {
    IPdfPage,
    IPdfRenderTask,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import {
    pdfRenderContinuationScheduler,
    type TPdfRenderContinuationPriority,
} from '@app/modules/pdf-viewer/engine/pdf-render-continuation-scheduler/pdfRenderContinuationScheduler';
import type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';
import type { IPdfRenderSupervisor } from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import { armPageStageDeadline } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/withPageStageTimeout';

interface ICoordinatedPdfPageRenderTask {
    promise: Promise<unknown>;
    cancel: () => void;
    onContinue?: IPdfRenderTask['onContinue'];
}

interface IActivePdfPageOperation {
    id: number;
    owner: string;
    pageNumber: number;
    priority: number;
    cancel?: (() => void) | undefined;
    settled: Promise<void>;
}

interface IRunCoordinatedPdfPageRenderOptions<TTask extends ICoordinatedPdfPageRenderTask> {
    owner: string;
    pageNumber: number;
    pdfPage: IPdfPage;
    priority: number;
    signal?: AbortSignal | undefined;
    shouldStart?: (() => boolean) | undefined;
    startRender: () => TTask;
    onTask?: ((task: TTask) => void) | undefined;
    continuation?: {
        key: string;
        priority: TPdfRenderContinuationPriority;
    } | undefined;
    watchdog?: {
        key: string;
        metadata?: Record<string, unknown> | undefined;
        onRenderStall?: ((payload: IPageRenderStallPayload) => void) | undefined;
        payload: IPageRenderStallPayload;
        renderSupervisor: IPdfRenderSupervisor;
        shouldNotify?: (() => boolean) | undefined;
    } | undefined;
    captureSettlement?: TPdfPageOperationSettlementCapture | undefined;
}

interface IRunCoordinatedPdfPageOperationOptions<TResult> {
    owner: string;
    pageNumber: number;
    pdfPage: IPdfPage;
    priority: number;
    signal?: AbortSignal | undefined;
    shouldStart?: (() => boolean) | undefined;
    shouldContinue?: (() => boolean) | undefined;
    operation: () => Promise<TResult>;
    captureSettlement?: TPdfPageOperationSettlementCapture | undefined;
}

export type TPdfPageOperationSettlementCapture = (settlement: Promise<void>) => void;

const activePageOperations = new WeakMap<IPdfPage, IActivePdfPageOperation>();
let nextRenderId = 0;

function createCoordinatedRenderCancelledError(pageNumber: number, owner: string) {
    const error = new Error(`Rendering cancelled before coordinated PDF page render for page ${pageNumber} (${owner})`);
    error.name = 'RenderingCancelledException';
    return error;
}

function throwIfCoordinatedOperationCancelled(
    signal: AbortSignal | undefined,
    pageNumber: number,
    owner: string,
) {
    if (signal?.aborted) {
        throw createCoordinatedRenderCancelledError(pageNumber, owner);
    }
}

function createAbortWaiter(
    signal: AbortSignal | undefined,
    pageNumber: number,
    owner: string,
    onAbort?: (() => void) | undefined,
) {
    if (!signal) {
        return null;
    }

    let remove = () => {};
    const promise = new Promise<never>((_resolve, reject) => {
        const abort = () => {
            onAbort?.();
            reject(createCoordinatedRenderCancelledError(pageNumber, owner));
        };
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener('abort', abort, {once: true});
        remove = () => signal.removeEventListener('abort', abort);
    });

    return {
        promise,
        remove,
    };
}

function cancelPdfPageRender(cancel: (() => void) | undefined) {
    if (!cancel) {
        return;
    }

    try {
        cancel();
    } catch {
        // PDF.js cancellation is best-effort and the render promise still settles.
    }
}

async function waitForActiveOperation(
    pdfPage: IPdfPage,
    activeOperation: IActivePdfPageOperation,
    owner: string,
    priority: number,
    signal?: AbortSignal | undefined,
) {
    if (priority > activeOperation.priority && activeOperation.cancel) {
        logPdfRenderTrace('pdf-page-render-coordinator-preempt', {
            pageNumber: activeOperation.pageNumber,
            waitingOwner: owner,
            waitingPriority: priority,
            activeOwner: activeOperation.owner,
            activePriority: activeOperation.priority,
            activeRenderId: activeOperation.id,
        });
        cancelPdfPageRender(activeOperation.cancel);
    } else {
        logPdfRenderTrace('pdf-page-render-coordinator-wait', {
            pageNumber: activeOperation.pageNumber,
            waitingOwner: owner,
            waitingPriority: priority,
            activeOwner: activeOperation.owner,
            activePriority: activeOperation.priority,
            activeRenderId: activeOperation.id,
        });
    }

    const abortWaiter = createAbortWaiter(
        signal,
        activeOperation.pageNumber,
        owner,
    );
    try {
        await (abortWaiter
            ? Promise.race([
                activeOperation.settled,
                abortWaiter.promise,
            ])
            : activeOperation.settled);
    } finally {
        abortWaiter?.remove();
    }

    if (activePageOperations.get(pdfPage)?.id === activeOperation.id) {
        activePageOperations.delete(pdfPage);
    }
}

async function waitForCoordinatedTurn(
    pdfPage: IPdfPage,
    owner: string,
    pageNumber: number,
    priority: number,
    signal?: AbortSignal | undefined,
    cancel?: (() => void) | undefined,
) {
    while (true) {
        throwIfCoordinatedOperationCancelled(signal, pageNumber, owner);
        const activeOperation = activePageOperations.get(pdfPage);
        if (!activeOperation) {
            const id = ++nextRenderId;
            let markSettled!: () => void;
            const settled = new Promise<void>((resolve) => {
                markSettled = resolve;
            });
            const operation: IActivePdfPageOperation = {
                cancel,
                id,
                owner,
                pageNumber,
                priority,
                settled,
            };
            activePageOperations.set(pdfPage, operation);

            let released = false;
            const release = () => {
                if (released) {
                    return;
                }
                released = true;
                markSettled();
                if (activePageOperations.get(pdfPage)?.id === id) {
                    activePageOperations.delete(pdfPage);
                }
            };
            return {
                release,
                settled,
            };
        }

        await waitForActiveOperation(pdfPage, activeOperation, owner, priority, signal);
    }
}

export async function runCoordinatedPdfPageOperation<TResult>(
    options: IRunCoordinatedPdfPageOperationOptions<TResult>,
) {
    const {
        operation,
        owner,
        pageNumber,
        pdfPage,
        priority,
        signal,
        shouldContinue,
        shouldStart,
        captureSettlement,
    } = options;

    const ownership = await waitForCoordinatedTurn(
        pdfPage,
        owner,
        pageNumber,
        priority,
        signal,
    );
    const releaseOwnership = ownership.release;
    try {
        captureSettlement?.(ownership.settled);
        throwIfCoordinatedOperationCancelled(signal, pageNumber, owner);

        if (shouldStart?.() === false) {
            throw createCoordinatedRenderCancelledError(pageNumber, owner);
        }
    } catch (error) {
        releaseOwnership();
        throw error;
    }

    const abortWaiter = createAbortWaiter(signal, pageNumber, owner);
    let operationPromise: Promise<TResult>;
    try {
        operationPromise = operation();
    } catch (error) {
        abortWaiter?.remove();
        releaseOwnership();
        throw error;
    }
    void operationPromise
        .catch(() => {})
        .then(releaseOwnership);
    try {
        const result = await (abortWaiter
            ? Promise.race([
                operationPromise,
                abortWaiter.promise,
            ])
            : operationPromise);
        if (shouldContinue?.() === false) {
            throw createCoordinatedRenderCancelledError(pageNumber, owner);
        }
        return result;
    } finally {
        abortWaiter?.remove();
    }
}

export async function runCoordinatedPdfPageRender<TTask extends ICoordinatedPdfPageRenderTask>(
    options: IRunCoordinatedPdfPageRenderOptions<TTask>,
) {
    const {
        onTask,
        owner,
        pageNumber,
        pdfPage,
        priority,
        signal,
        shouldStart,
        startRender,
        continuation,
        watchdog,
        captureSettlement,
    } = options;

    let cancelTask: (() => void) | undefined = undefined;
    let cancelRequested = false;
    let taskCancelIssued = false;
    let watchdogDeadline: ReturnType<typeof armPageStageDeadline> | null = null;
    const requestCancel = () => {
        watchdogDeadline?.clear();
        if (!cancelTask) {
            cancelRequested = true;
            return;
        }
        cancelTask();
    };
    const ownership = await waitForCoordinatedTurn(
        pdfPage,
        owner,
        pageNumber,
        priority,
        signal,
        requestCancel,
    );
    const releaseOwnership = ownership.release;
    let task: TTask;
    try {
        captureSettlement?.(ownership.settled);
        throwIfCoordinatedOperationCancelled(signal, pageNumber, owner);

        if (shouldStart?.() === false) {
            throw createCoordinatedRenderCancelledError(pageNumber, owner);
        }

        task = startRender();
    } catch (error) {
        releaseOwnership();
        throw error;
    }
    const disposeContinuation = continuation
        ? bindRenderTaskContinuation(task, continuation, signal)
        : () => {};
    const settled = task.promise
        .catch(() => {})
        .then(releaseOwnership);

    cancelTask = () => {
        if (taskCancelIssued) {
            return;
        }
        taskCancelIssued = true;
        task.cancel();
    };
    if (cancelRequested) {
        cancelRequested = false;
        cancelPdfPageRender(cancelTask);
    }
    onTask?.(task);

    watchdogDeadline = watchdog && !taskCancelIssued
        ? armPageStageDeadline({
            key: watchdog.key,
            metadata: watchdog.metadata,
            onRenderStall: watchdog.onRenderStall,
            onTimeout: () => cancelPdfPageRender(cancelTask),
            payload: watchdog.payload,
            renderSupervisor: watchdog.renderSupervisor,
            shouldNotify: () => watchdog.shouldNotify?.() !== false,
        })
        : null;
    void task.promise.then(
        () => watchdogDeadline?.clear(),
        () => watchdogDeadline?.clear(),
    );

    const abortWaiter = createAbortWaiter(
        signal,
        pageNumber,
        owner,
        () => {
            watchdogDeadline?.clear();
            cancelPdfPageRender(cancelTask);
        },
    );

    try {
        await Promise.race([
            task.promise,
            ...(abortWaiter ? [abortWaiter.promise] : []),
            ...(watchdogDeadline ? [watchdogDeadline.promise] : []),
        ]);
    } finally {
        abortWaiter?.remove();
        watchdogDeadline?.clear();
        disposeContinuation();
        await settled;
    }
}

function bindRenderTaskContinuation(
    task: ICoordinatedPdfPageRenderTask,
    continuation: {
        key: string;
        priority: TPdfRenderContinuationPriority;
    },
    signal?: AbortSignal,
) {
    let disposePending = () => {};
    const previousOnContinue = task.onContinue;
    task.onContinue = (continueRender: () => void) => {
        disposePending();
        disposePending = pdfRenderContinuationScheduler.schedule({
            ...continuation,
            continueRender,
            signal,
        });
    };
    return () => {
        disposePending();
        if (previousOnContinue) {
            task.onContinue = previousOnContinue;
        } else {
            delete task.onContinue;
        }
    };
}

export function resetCoordinatedPdfPageRendersForTest() {
    nextRenderId = 0;
}
