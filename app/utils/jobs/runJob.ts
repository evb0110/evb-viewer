import type { TRequestId } from '@contracts/shared';

export class JobCanceledError extends Error {
    constructor() {
        super('Job canceled');
        this.name = 'JobCanceledError';
    }
}

export class JobTimeoutError extends Error {
    constructor() {
        super('Job timed out');
        this.name = 'JobTimeoutError';
    }
}

interface IJobEvent {readonly requestId: TRequestId;}

export interface IJobChannel<TProgress extends IJobEvent, TResult extends IJobEvent, TCancelResult> {
    onProgress(listener: (progress: TProgress) => void): () => void;
    onComplete(listener: (result: TResult) => void): () => void;
    cancel(requestId: TRequestId): Promise<TCancelResult>;
}

export interface IRunJobOptions<TProgress, TResult> {
    requestId: TRequestId;
    /** Starts the job in main; rejects when main refuses it. */
    start(): Promise<void>;
    onProgress?(progress: TProgress): void;
    /** Cancels the job when no progress arrives for this long. */
    inactivityTimeoutMs?: number;
    /** Receives a terminal result that arrives after the caller stopped waiting. */
    releaseLateResult?(result: TResult): void;
}

export interface IJobRun<TResult, TCancelResult> {
    readonly result: Promise<TResult>;
    /** Rejects `result` now and asks main to stop; resolves with main's answer. */
    cancel(): Promise<TCancelResult | null>;
}

const LATE_RESULT_GRACE_MS = 60_000;

/**
 * One renderer client for every long main-process job: subscribe before
 * start, one inactivity timeout, and one late-result policy. A caller that
 * cancels or times out stops waiting at once; a terminal result that still
 * arrives is released, never applied.
 */
export function runJob<TProgress extends IJobEvent, TResult extends IJobEvent, TCancelResult>(
    channel: IJobChannel<TProgress, TResult, TCancelResult>,
    options: IRunJobOptions<TProgress, TResult>,
): IJobRun<TResult, TCancelResult> {
    let settled = false;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let lateResultTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveResult: (result: TResult) => void = () => {};
    let rejectResult: (error: unknown) => void = () => {};
    const result = new Promise<TResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });
    // Callers that cancel may never await the rejected result.
    result.catch(() => {});

    const stopProgress = channel.onProgress((progress) => {
        if (settled || progress.requestId !== options.requestId) {
            return;
        }
        armInactivityTimer();
        options.onProgress?.(progress);
    });
    const stopComplete = channel.onComplete((terminal) => {
        if (terminal.requestId !== options.requestId) {
            return;
        }
        unsubscribe();
        if (settled) {
            options.releaseLateResult?.(terminal);
            return;
        }
        settled = true;
        resolveResult(terminal);
    });

    function unsubscribe() {
        stopProgress();
        stopComplete();
        clearTimeout(inactivityTimer);
        clearTimeout(lateResultTimer);
    }

    function stopWaiting(error: Error) {
        if (settled) {
            return false;
        }
        settled = true;
        clearTimeout(inactivityTimer);
        lateResultTimer = setTimeout(unsubscribe, LATE_RESULT_GRACE_MS);
        rejectResult(error);
        return true;
    }

    function cancelWith(error: Error) {
        return stopWaiting(error)
            ? channel.cancel(options.requestId)
            : Promise.resolve(null);
    }

    function armInactivityTimer() {
        if (options.inactivityTimeoutMs === undefined) {
            return;
        }
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
            void cancelWith(new JobTimeoutError()).catch(() => {});
        }, options.inactivityTimeoutMs);
    }

    armInactivityTimer();
    options.start().catch((error: unknown) => {
        if (!settled) {
            settled = true;
            unsubscribe();
            rejectResult(error);
        }
    });

    return {
        result,
        cancel: () => cancelWith(new JobCanceledError()),
    };
}
