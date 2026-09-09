import type { BrowserWindow } from 'electron';
import type { Worker } from 'worker_threads';
import {
    delay,
    withTimeout,
} from 'es-toolkit/promise';
import {
    OCR_JOB_IDLE_TIMEOUT_MS,
    OCR_WORKER_TERMINATE_TIMEOUT_MS,
} from '@electron/features/ocr/main/jobManager.config';
import type {
    IOcrActiveJob,
    IOcrPreparingJob,
    IOcrQueuedJob,
} from '@electron/features/ocr/main/jobManager.types';
import type { createPendingResultFileStore } from '@electron/features/ocr/main/createPendingResultFileStore';
import { ocrResourceGovernor } from '@electron/features/ocr/main/ocrResourceGovernor';
import { OCR_COMPLETE_EVENT_CHANNEL } from '@contracts/electronApiOcr';
import {
    buildOcrErrorEnvelope,
    getOcrPageSelectionCount,
} from '@electron/features/ocr/contracts';
import type { ILogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { runDetached } from '@electron/utils/runDetached';
import type {
    IOcrCompleteResult,
    IOcrErrorEnvelope,
    IOcrProgress,
    TOcrErrorCode,
} from '@contracts/electronApiOcr';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';

function requireOcrDocumentRef(value: unknown): TDocumentRef {
    const parsed = parseDocumentRef(value);
    if (parsed === null) {
        throw new Error('OCR worker returned an invalid document ref');
    }
    return parsed;
}


const OCR_WORKER_COOPERATIVE_CANCEL_DELAY_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_WORKER_COOPERATIVE_CANCEL_DELAY_MS ?? '250', 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 250;
    }
    return Math.min(parsed, 2_000);
})();
const OCR_WORKER_CLEANUP_GRACE_MS = (() => {
    const parsed = Number.parseInt(
        process.env.EVB_OCR_WORKER_CLEANUP_GRACE_MS ?? String(OCR_WORKER_TERMINATE_TIMEOUT_MS),
        10,
    );
    if (!Number.isFinite(parsed) || parsed < 0) {
        return OCR_WORKER_TERMINATE_TIMEOUT_MS;
    }
    return Math.min(parsed, 60_000);
})();

type TOcrPendingResultFileStore = ReturnType<typeof createPendingResultFileStore>;

interface IOcrJobWorkerLifecycleControllerOptions {
    activeJobs: Map<string, IOcrActiveJob>;
    workerCleanupTimersByScopedJobId: Map<string, NodeJS.Timeout>;
    pendingResultFileStore: TOcrPendingResultFileStore;
    logger: ILogger;
    publishProgress: (job: IOcrQueuedJob, progress: IOcrProgress) => void;
    getJobWindow: (webContentsId: number) => BrowserWindow | null | undefined;
    onFinalizeActiveJob?: (scopedJobId: string, job: IOcrActiveJob | null) => void;
    removeResultFile: (path: string) => Promise<boolean>;
    safeSendToWindow: (
        window: BrowserWindow | null | undefined,
        channel: typeof OCR_COMPLETE_EVENT_CHANNEL,
        payload: IOcrCompleteResult,
    ) => void;
}

export interface IOcrTerminalErrorEnvelopeOptions {
    code?: TOcrErrorCode;
    details?: string;
    retryable?: boolean;
}

export interface IOcrTerminateActiveJobOptions {
    markCancelled?: boolean;
    reason: string;
}

export interface IOcrJobWorkerLifecycleController {
    clearJobWatchdog(scopedJobId: string): void;
    createTerminalOcrErrorEnvelope(error: string, envelopeOptions?: IOcrTerminalErrorEnvelopeOptions): IOcrErrorEnvelope;
    finalizeActiveJob(scopedJobId: string): void;
    isCurrentActiveWorker(scopedJobId: string, worker: Worker): boolean;
    removePendingCompletionResultFile(job: IOcrActiveJob): void;
    resetJobWatchdog(job: IOcrQueuedJob): void;
    sendJobFailure(job: IOcrQueuedJob, error: string, failureOptions?: IOcrTerminalErrorEnvelopeOptions): IOcrCompleteResult;
    sendJobCancellation(job: Pick<IOcrQueuedJob | IOcrPreparingJob, 'requestId' | 'webContentsId' | 'registry' | 'terminalResult'>, reason: string): IOcrCompleteResult;
    sendPendingCompletionResult(job: IOcrActiveJob): boolean;
    terminateAndFinalizeActiveJob(scopedJobId: string, terminateOptions: IOcrTerminateActiveJobOptions): void;
    terminateWorkerSafely(scopedJobId: string, worker: Worker, reason: string, requestId?: string): Promise<void>;
}

export function createOcrJobWorkerLifecycleController(
    options: IOcrJobWorkerLifecycleControllerOptions,
): IOcrJobWorkerLifecycleController {
    const {
        activeJobs,
        workerCleanupTimersByScopedJobId,
        pendingResultFileStore,
        logger,
        publishProgress,
        getJobWindow,
        onFinalizeActiveJob,
        removeResultFile,
        safeSendToWindow,
    } = options;

    function clearJobWatchdog(scopedJobId: string) {
        const activeJob = activeJobs.get(scopedJobId);
        if (!activeJob?.watchdogTimer) {
            return;
        }
        clearTimeout(activeJob.watchdogTimer);
        activeJob.watchdogTimer = null;
    }

    function clearWorkerCleanupTimer(scopedJobId: string) {
        const timer = workerCleanupTimersByScopedJobId.get(scopedJobId);
        if (!timer) {
            return;
        }
        clearTimeout(timer);
        workerCleanupTimersByScopedJobId.delete(scopedJobId);
    }

    function createTerminalOcrErrorEnvelope(
        error: string,
        envelopeOptions: IOcrTerminalErrorEnvelopeOptions = {},
    ): IOcrErrorEnvelope {
        return buildOcrErrorEnvelope(
            envelopeOptions.code ?? 'OCR_INTERNAL_ERROR',
            error,
            {
                retryable: envelopeOptions.retryable ?? false,
                ...(envelopeOptions.details ? { details: envelopeOptions.details } : {}),
            },
        );
    }

    function sendJobFailure(
        job: IOcrQueuedJob,
        error: string,
        failureOptions: IOcrTerminalErrorEnvelopeOptions = {},
    ) {
        if (job.terminalResult) {
            return job.terminalResult;
        }
        const window = getJobWindow(job.webContentsId);
        const errorEnvelope = createTerminalOcrErrorEnvelope(error, failureOptions);
        const result: IOcrCompleteResult = {
            requestId: job.requestId,
            success: false,
            errors: [error],
            errorEnvelope,
        };
        job.registry.terminal.fail(errorEnvelope);
        job.terminalResult = result;
        safeSendToWindow(window, OCR_COMPLETE_EVENT_CHANNEL, result);
        return result;
    }

    function sendJobCancellation(
        job: Pick<IOcrQueuedJob | IOcrPreparingJob, 'requestId' | 'webContentsId' | 'registry' | 'terminalResult'>,
        reason: string,
    ) {
        if (job.terminalResult) {
            return job.terminalResult;
        }
        const message = 'OCR job was cancelled';
        const window = getJobWindow(job.webContentsId);
        const errorEnvelope = createTerminalOcrErrorEnvelope(message, { details: reason });
        const result: IOcrCompleteResult = {
            requestId: job.requestId,
            success: false,
            errors: [message],
            errorEnvelope,
        };
        job.registry.terminal.cancel(errorEnvelope);
        job.terminalResult = result;
        safeSendToWindow(window, OCR_COMPLETE_EVENT_CHANNEL, result);
        return result;
    }

    function trackPendingCompletionResultFile(job: IOcrActiveJob) {
        const result = job.pendingCompletionResult;
        if (!result?.success) {
            return false;
        }

        pendingResultFileStore.track(
            job.scopedJobId,
            job.requestId,
            job.webContentsId,
            result.pdfPath,
            result.resultSha256,
            result.requiresCleanupAck,
        );
        runDetached(
            () => pendingResultFileStore.evictStale(),
            {
                label: 'evict stale OCR result files',
                logger,
            },
        );
        job.pendingCompletionResult = null;
        return true;
    }

    function removePendingCompletionResultFile(job: IOcrActiveJob) {
        const result = job.pendingCompletionResult;
        if (!result?.success) {
            return;
        }

        job.pendingCompletionResult = null;
        runDetached(
            () => removeResultFile(result.pdfPath),
            {
                label: `remove incomplete OCR result ${job.requestId}`,
                logger,
            },
        );
    }

    async function terminateWorkerSafely(
        scopedJobId: string,
        worker: Worker,
        reason: string,
        requestId?: string,
    ) {
        try {
            worker.postMessage({
                type: 'cancel',
                jobId: requestId ?? activeJobs.get(scopedJobId)?.requestId ?? scopedJobId,
            });
            if (OCR_WORKER_COOPERATIVE_CANCEL_DELAY_MS > 0) {
                await delay(OCR_WORKER_COOPERATIVE_CANCEL_DELAY_MS);
            }
            const terminatePromise = worker.terminate();
            void terminatePromise.catch(() => undefined);
            await withTimeout(() => terminatePromise, OCR_WORKER_TERMINATE_TIMEOUT_MS);
        } catch (error) {
            logger.warn(`[${scopedJobId}] Failed to terminate OCR worker (${reason}): ${getErrorMessage(error)}`);
        }
    }

    function finalizeActiveJob(scopedJobId: string) {
        clearJobWatchdog(scopedJobId);
        clearWorkerCleanupTimer(scopedJobId);
        ocrResourceGovernor.releaseJob(scopedJobId);
        const activeJob = activeJobs.get(scopedJobId);
        if (activeJob) {
            trackPendingCompletionResultFile(activeJob);
        }
        activeJobs.delete(scopedJobId);
        onFinalizeActiveJob?.(scopedJobId, activeJob ?? null);
        if (activeJob) {
            activeJob.resolveWorkerSettlement(activeJob.terminalResult ?? {
                requestId: activeJob.requestId,
                success: false,
                errors: ['OCR worker settled without a terminal result'],
                errorEnvelope: createTerminalOcrErrorEnvelope(
                    'OCR worker settled without a terminal result',
                ),
            });
        }
    }

    function terminateAndFinalizeActiveJob(
        scopedJobId: string,
        terminateOptions: IOcrTerminateActiveJobOptions,
    ) {
        const activeJob = activeJobs.get(scopedJobId);
        if (!activeJob) {
            return;
        }
        if (activeJob.completed || activeJob.terminatedByUs) {
            return;
        }

        activeJob.completed = true;
        activeJob.terminatedByUs = true;
        if (terminateOptions.markCancelled) {
            if (!activeJob.terminalResultSent) {
                removePendingCompletionResultFile(activeJob);
                activeJob.terminalResultSent = true;
                sendJobCancellation(activeJob, terminateOptions.reason);
            }
        }
        clearJobWatchdog(scopedJobId);
        clearWorkerCleanupTimer(scopedJobId);
        void terminateWorkerSafely(scopedJobId, activeJob.worker, terminateOptions.reason, activeJob.requestId).finally(() => {
            finalizeActiveJob(scopedJobId);
        });
    }

    function startWorkerCleanupGraceTimer(job: IOcrActiveJob) {
        clearWorkerCleanupTimer(job.scopedJobId);
        if (OCR_WORKER_CLEANUP_GRACE_MS === 0) {
            terminateAndFinalizeActiveJob(job.scopedJobId, { reason: 'worker cleanup grace disabled after terminal result' });
            return;
        }

        const timer = setTimeout(() => {
            const activeJob = activeJobs.get(job.scopedJobId);
            if (!activeJob || activeJob.worker !== job.worker || !activeJob.terminalResultSent) {
                return;
            }

            logger.warn(`[${job.scopedJobId}] OCR worker cleanup did not complete within ${OCR_WORKER_CLEANUP_GRACE_MS}ms after terminal result`);
            terminateAndFinalizeActiveJob(job.scopedJobId, { reason: 'worker cleanup timed out after terminal result' });
        }, OCR_WORKER_CLEANUP_GRACE_MS);
        timer.unref();
        workerCleanupTimersByScopedJobId.set(job.scopedJobId, timer);
    }

    function sendPendingCompletionResult(job: IOcrActiveJob) {
        const result = job.pendingCompletionResult;
        if (!result || job.terminalResultSent) {
            return false;
        }

        if (result.success) {
            publishProgress(job, {
                requestId: job.requestId,
                currentPage: 0,
                processedCount: getOcrPageSelectionCount(job.pages),
                totalPages: getOcrPageSelectionCount(job.pages),
                phase: 'indexing',
                phaseProgress: 99,
            });
            trackPendingCompletionResultFile(job);
        } else {
            job.pendingCompletionResult = null;
        }
        job.terminalResultSent = true;
        clearJobWatchdog(job.scopedJobId);
        startWorkerCleanupGraceTimer(job);
        const completeResult: IOcrCompleteResult = result.success
            ? {
                requestId: job.requestId,
                success: true,
                pdfPath: requireOcrDocumentRef(result.pdfPath),
                sourceDocumentRevisionToken: result.sourceDocumentRevisionToken,
                resultSha256: result.resultSha256,
                requiresCleanupAck: result.requiresCleanupAck,
                errors: result.errors,
                ...(result.diagnostics === undefined ? {} : {diagnostics: result.diagnostics}),
            }
            : {
                requestId: job.requestId,
                success: false,
                errors: result.errors,
                ...(result.diagnostics === undefined ? {} : {diagnostics: result.diagnostics}),
                errorEnvelope: result.errorEnvelope
                    ?? createTerminalOcrErrorEnvelope(
                        result.errors[0] ?? 'OCR worker failed without an error message',
                    ),
            };
        job.terminalResult = completeResult;
        if (completeResult.success) {
            job.registry.terminal.complete(completeResult);
        } else {
            job.registry.terminal.fail(
                completeResult.errorEnvelope
                    ?? createTerminalOcrErrorEnvelope(
                        completeResult.errors[0] ?? 'OCR worker failed without an error message',
                    ),
            );
        }
        safeSendToWindow(
            getJobWindow(job.webContentsId),
            OCR_COMPLETE_EVENT_CHANNEL,
            completeResult,
        );
        return true;
    }

    function resetJobWatchdog(job: IOcrQueuedJob) {
        const activeJob = activeJobs.get(job.scopedJobId);
        if (!activeJob || activeJob.completed || activeJob.terminalResultSent) {
            return;
        }

        clearJobWatchdog(job.scopedJobId);
        const watchdog = setTimeout(() => {
            const pendingActiveJob = activeJobs.get(job.scopedJobId);
            if (!pendingActiveJob || pendingActiveJob.completed) {
                return;
            }

            sendJobFailure(job, `OCR job idle timed out after ${OCR_JOB_IDLE_TIMEOUT_MS}ms without worker activity`);
            pendingActiveJob.terminalResultSent = true;
            terminateAndFinalizeActiveJob(job.scopedJobId, {reason: `watchdog idle timeout (${OCR_JOB_IDLE_TIMEOUT_MS}ms)`});
            logger.error(`OCR watchdog idle timed out job ${job.requestId}`, {
                code: 'MAIN_OCR_OPERATION_FAILED',
                context: {},
            });
        }, OCR_JOB_IDLE_TIMEOUT_MS);
        watchdog.unref();
        activeJob.watchdogTimer = watchdog;
    }

    function isCurrentActiveWorker(scopedJobId: string, worker: Worker) {
        const activeJob = activeJobs.get(scopedJobId);
        return Boolean(activeJob && activeJob.worker === worker && !activeJob.completed && !activeJob.terminatedByUs);
    }

    return {
        clearJobWatchdog,
        createTerminalOcrErrorEnvelope,
        finalizeActiveJob,
        isCurrentActiveWorker,
        removePendingCompletionResultFile,
        resetJobWatchdog,
        sendJobFailure,
        sendJobCancellation,
        sendPendingCompletionResult,
        terminateAndFinalizeActiveJob,
        terminateWorkerSafely,
    };
}
