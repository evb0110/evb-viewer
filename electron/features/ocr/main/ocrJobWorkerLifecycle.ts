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
    IOcrNativeChildRecord,
    IOcrPreparingJob,
    IOcrQueuedJob,
} from '@electron/features/ocr/main/jobManager.types';
import type { IOcrNativeChildProcessIdentity } from '@electron/ocr/worker/types';
import type { IOcrNativeChildTerminationController } from '@electron/features/ocr/main/ocrNativeChildProcessIdentity';
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
const OCR_NATIVE_CHILD_CLEANUP_RETRY_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_NATIVE_CHILD_CLEANUP_RETRY_MS ?? '1000', 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 1_000;
    }
    return Math.min(parsed, 60_000);
})();

type TOcrPendingResultFileStore = ReturnType<typeof createPendingResultFileStore>;

interface IOcrJobWorkerLifecycleControllerOptions {
    activeJobs: Map<string, IOcrActiveJob>;
    workerCleanupTimersByScopedJobId: Map<string, NodeJS.Timeout>;
    nativeChildCleanupTimersByScopedJobId?: Map<string, NodeJS.Timeout>;
    nativeChildTermination?: IOcrNativeChildTerminationController;
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
    markWorkerExit(scopedJobId: string, worker: Worker, code: number | null): void;
    markWorkerTerminationProven(scopedJobId: string, worker: Worker): void;
    markWorkerCleanupComplete(scopedJobId: string, worker: Worker): void;
    handleNativeChildIntent(scopedJobId: string, worker: Worker, jobId: string, childId: string, commandLabel: string): void;
    handleNativeChildRegister(scopedJobId: string, worker: Worker, jobId: string, childId: string, pid: number, processIdentity: IOcrNativeChildProcessIdentity): void;
    handleNativeChildNoSpawn(scopedJobId: string, worker: Worker, jobId: string, childId: string): void;
    handleNativeChildExit(scopedJobId: string, worker: Worker, jobId: string, childId: string, pid: number, processIdentity: IOcrNativeChildProcessIdentity): void;
    handleNativeChildUnproven(scopedJobId: string, worker: Worker, jobId: string, childId: string, detail: string): void;
}

export function createOcrJobWorkerLifecycleController(
    options: IOcrJobWorkerLifecycleControllerOptions,
): IOcrJobWorkerLifecycleController {
    const {
        activeJobs,
        workerCleanupTimersByScopedJobId,
        nativeChildCleanupTimersByScopedJobId = new Map<string, NodeJS.Timeout>(),
        nativeChildTermination = {terminate: () => Promise.resolve(false)},
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

    function clearNativeChildCleanupTimer(scopedJobId: string) {
        const timer = nativeChildCleanupTimersByScopedJobId.get(scopedJobId);
        if (!timer) {
            return;
        }
        clearTimeout(timer);
        nativeChildCleanupTimersByScopedJobId.delete(scopedJobId);
    }

    /**
     * Worker admission ends at proven worker exit. OCR page leases stay with
     * the quarantined job until its native children are proven dead, because
     * those children can still own native capacity and output artifacts.
     */
    function releaseWorkerAdmission(activeJob: IOcrActiveJob) {
        if (activeJob.workerAdmissionReleased) {
            return;
        }
        activeJob.workerAdmissionReleased = true;
        activeJob.workerAdmissionLease.release();
    }

    function releaseBrokeredResources(activeJob: IOcrActiveJob) {
        releaseWorkerAdmission(activeJob);
        ocrResourceGovernor.releaseJob(activeJob.scopedJobId);
    }

    function markNativeChildProtocolUnsafe(activeJob: IOcrActiveJob, reason: string) {
        if (activeJob.nativeChildProtocolUnsafe) {
            return;
        }
        activeJob.nativeChildProtocolUnsafe = true;
        logger.warn(`[${activeJob.scopedJobId}] Retaining OCR job because native-child proof is unsafe: ${reason}`);
    }

    function postNativeChildAck(
        activeJob: IOcrActiveJob,
        worker: Worker,
        type: 'native-child-intent-ack' | 'native-child-register-ack' | 'native-child-exit-ack',
        childId: string,
        accepted: boolean,
        reason?: string,
    ) {
        try {
            worker.postMessage({
                type,
                jobId: activeJob.requestId,
                childId,
                accepted,
                ...(reason === undefined ? {} : {reason}),
            });
        } catch (error) {
            markNativeChildProtocolUnsafe(activeJob, `could not send ${type}: ${getErrorMessage(error)}`);
        }
    }

    function getNativeChildJob(
        scopedJobId: string,
        worker: Worker,
        jobId: string,
        label: string,
    ) {
        const activeJob = activeJobs.get(scopedJobId);
        if (!activeJob || activeJob.worker !== worker || activeJob.physicalFinalized) {
            return null;
        }
        if (activeJob.requestId !== jobId) {
            markNativeChildProtocolUnsafe(activeJob, `${label} used job id ${jobId} instead of ${activeJob.requestId}`);
            return null;
        }
        return activeJob;
    }

    function identitiesMatch(
        left: IOcrNativeChildProcessIdentity | null,
        right: IOcrNativeChildProcessIdentity | null,
    ) {
        return left !== null
            && right !== null
            && left.kind === right.kind
            && left.value === right.value;
    }

    function scheduleNativeChildCleanupRetry(activeJob: IOcrActiveJob) {
        if (nativeChildCleanupTimersByScopedJobId.has(activeJob.scopedJobId)) {
            return;
        }
        const timer = setTimeout(() => {
            nativeChildCleanupTimersByScopedJobId.delete(activeJob.scopedJobId);
            const current = activeJobs.get(activeJob.scopedJobId);
            if (!current || current !== activeJob || !current.workerExitProven || current.physicalFinalized) {
                return;
            }
            for (const child of current.nativeChildren.values()) {
                beginNativeChildCleanup(current, child, 'retry after unproven native-child cleanup');
            }
            tryPhysicalFinalize(current.scopedJobId);
        }, OCR_NATIVE_CHILD_CLEANUP_RETRY_MS);
        timer.unref();
        nativeChildCleanupTimersByScopedJobId.set(activeJob.scopedJobId, timer);
    }

    function beginNativeChildCleanup(
        activeJob: IOcrActiveJob,
        child: IOcrNativeChildRecord,
        reason: string,
    ) {
        if (
            activeJob.physicalFinalized
            || !activeJob.workerExitProven
            || (child.state !== 'registered' && child.state !== 'unproven')
            || child.cleanupAttemptInFlight
        ) {
            return;
        }
        child.cleanupAttemptInFlight = true;
        void Promise.resolve()
            .then(() => nativeChildTermination.terminate(child, reason))
            .then((proven) => {
                const current = activeJobs.get(activeJob.scopedJobId);
                if (!current || current !== activeJob || current.physicalFinalized) {
                    return;
                }
                child.cleanupAttemptInFlight = false;
                if (proven === true) {
                    child.state = 'exited';
                    clearNativeChildCleanupTimer(activeJob.scopedJobId);
                } else {
                    child.state = 'unproven';
                    scheduleNativeChildCleanupRetry(activeJob);
                }
                tryPhysicalFinalize(activeJob.scopedJobId);
            }, (error: unknown) => {
                const current = activeJobs.get(activeJob.scopedJobId);
                if (!current || current !== activeJob || current.physicalFinalized) {
                    return;
                }
                child.cleanupAttemptInFlight = false;
                child.state = 'unproven';
                logger.warn(`[${activeJob.scopedJobId}] Native-child cleanup failed: ${getErrorMessage(error)}`);
                scheduleNativeChildCleanupRetry(activeJob);
            });
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
            job.documentRevision.documentRef,
            job.documentRevision.token,
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

        // Keep the artifact owned by the active job until the worker and all
        // registered native children have proven exit. The cancellation result
        // may already be visible, but cleanup still belongs to this job.
        job.discardPendingCompletionResult = true;
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
        } catch (error) {
            logger.warn(`[${scopedJobId}] Failed to send OCR worker cancellation (${reason}): ${getErrorMessage(error)}`);
        }

        if (OCR_WORKER_COOPERATIVE_CANCEL_DELAY_MS > 0) {
            await delay(OCR_WORKER_COOPERATIVE_CANCEL_DELAY_MS);
        }

        let terminatePromise: Promise<number>;
        try {
            terminatePromise = Promise.resolve(worker.terminate());
        } catch (error) {
            logger.warn(`[${scopedJobId}] Failed to terminate OCR worker (${reason}): ${getErrorMessage(error)}`);
            return;
        }

        void terminatePromise.then(
            () => markWorkerTerminationProven(scopedJobId, worker),
            () => undefined,
        );
        try {
            await withTimeout(() => terminatePromise, OCR_WORKER_TERMINATE_TIMEOUT_MS);
        } catch (error) {
            logger.warn(`[${scopedJobId}] Failed to terminate OCR worker (${reason}): ${getErrorMessage(error)}`);
        }
    }

    function finalizeActiveJob(scopedJobId: string) {
        const activeJob = activeJobs.get(scopedJobId);
        if (!activeJob || activeJob.physicalFinalized || !activeJob.workerExitProven) {
            return;
        }
        for (const child of activeJob.nativeChildren.values()) {
            if (child.state === 'registered' || child.state === 'unproven') {
                beginNativeChildCleanup(activeJob, child, 'worker exited before native child proof');
            }
        }
        if (activeJob.nativeChildProtocolUnsafe || [...activeJob.nativeChildren.values()].some(child => (
            child.state !== 'exited' && child.state !== 'no-child'
        ))) {
            return;
        }

        activeJob.physicalFinalized = true;
        clearJobWatchdog(scopedJobId);
        clearWorkerCleanupTimer(scopedJobId);
        clearNativeChildCleanupTimer(scopedJobId);
        releaseBrokeredResources(activeJob);
        if (activeJob.discardPendingCompletionResult) {
            const result = activeJob.pendingCompletionResult;
            activeJob.pendingCompletionResult = null;
            if (result?.success) {
                runDetached(
                    () => removeResultFile(result.pdfPath),
                    {
                        label: `remove incomplete OCR result ${activeJob.requestId}`,
                        logger,
                    },
                );
            }
        } else {
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
        ocrResourceGovernor.cancelPendingForJob(
            scopedJobId,
            `OCR worker termination became uncertain: ${terminateOptions.reason}`,
        );
        if (terminateOptions.markCancelled) {
            if (!activeJob.terminalResultSent) {
                removePendingCompletionResultFile(activeJob);
                activeJob.terminalResultSent = true;
                sendJobCancellation(activeJob, terminateOptions.reason);
            }
        }
        clearJobWatchdog(scopedJobId);
        clearWorkerCleanupTimer(scopedJobId);
        void terminateWorkerSafely(scopedJobId, activeJob.worker, terminateOptions.reason, activeJob.requestId);
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
        startWorkerCleanupGraceTimer(job);
        return true;
    }

    function tryPhysicalFinalize(scopedJobId: string) {
        finalizeActiveJob(scopedJobId);
    }

    function markWorkerExit(scopedJobId: string, worker: Worker, code: number | null) {
        const activeJob = activeJobs.get(scopedJobId);
        if (!activeJob || activeJob.worker !== worker || activeJob.physicalFinalized) {
            return;
        }
        if (!activeJob.workerExitProven) {
            activeJob.workerExitProven = true;
            activeJob.workerExitCode = code;
        }
        releaseWorkerAdmission(activeJob);
        ocrResourceGovernor.cancelPendingForJob(
            scopedJobId,
            'OCR worker exit stopped pending page resource requests',
        );
        for (const child of activeJob.nativeChildren.values()) {
            beginNativeChildCleanup(activeJob, child, 'worker exit cleanup handoff');
        }
        tryPhysicalFinalize(scopedJobId);
    }

    function markWorkerTerminationProven(scopedJobId: string, worker: Worker) {
        markWorkerExit(scopedJobId, worker, null);
    }

    function markWorkerCleanupComplete(scopedJobId: string, worker: Worker) {
        const activeJob = activeJobs.get(scopedJobId);
        if (!activeJob || activeJob.worker !== worker || activeJob.physicalFinalized) {
            return;
        }
        activeJob.cleanupCompleteReceived = true;
        tryPhysicalFinalize(scopedJobId);
    }

    function handleNativeChildIntent(
        scopedJobId: string,
        worker: Worker,
        jobId: string,
        childId: string,
        commandLabel: string,
    ) {
        const activeJob = getNativeChildJob(scopedJobId, worker, jobId, 'native-child intent');
        if (!activeJob) {
            return;
        }
        const existing = activeJob.nativeChildren.get(childId);
        if (existing) {
            if (existing.commandLabel === commandLabel && existing.state === 'intent') {
                postNativeChildAck(activeJob, worker, 'native-child-intent-ack', childId, true);
                return;
            }
            markNativeChildProtocolUnsafe(activeJob, `reused native child id ${childId}`);
            postNativeChildAck(activeJob, worker, 'native-child-intent-ack', childId, false, 'native child id was already used');
            return;
        }
        if (activeJob.workerExitProven || activeJob.nativeChildProtocolUnsafe) {
            markNativeChildProtocolUnsafe(activeJob, `native child intent arrived after worker proof for ${childId}`);
            postNativeChildAck(activeJob, worker, 'native-child-intent-ack', childId, false, 'worker cleanup handoff is closed');
            return;
        }
        activeJob.nativeChildren.set(childId, {
            childId,
            commandLabel,
            pid: null,
            processIdentity: null,
            state: 'intent',
            cleanupAttemptInFlight: false,
        });
        postNativeChildAck(activeJob, worker, 'native-child-intent-ack', childId, true);
    }

    function handleNativeChildRegister(
        scopedJobId: string,
        worker: Worker,
        jobId: string,
        childId: string,
        pid: number,
        processIdentity: IOcrNativeChildProcessIdentity,
    ) {
        const activeJob = getNativeChildJob(scopedJobId, worker, jobId, 'native-child registration');
        if (!activeJob) {
            return;
        }
        const child = activeJob.nativeChildren.get(childId);
        if (!child) {
            markNativeChildProtocolUnsafe(activeJob, `registration arrived for unknown child ${childId}`);
            postNativeChildAck(activeJob, worker, 'native-child-register-ack', childId, false, 'native child intent was not accepted');
            return;
        }
        if (
            child.state === 'registered'
            && child.pid === pid
            && identitiesMatch(child.processIdentity, processIdentity)
        ) {
            postNativeChildAck(activeJob, worker, 'native-child-register-ack', childId, true);
            return;
        }
        if (child.state !== 'intent' || activeJob.workerExitProven || activeJob.nativeChildProtocolUnsafe) {
            markNativeChildProtocolUnsafe(activeJob, `registration was late or reused for ${childId}`);
            postNativeChildAck(activeJob, worker, 'native-child-register-ack', childId, false, 'native child registration was not current');
            return;
        }
        child.pid = pid;
        child.processIdentity = processIdentity;
        child.state = 'registered';
        postNativeChildAck(activeJob, worker, 'native-child-register-ack', childId, true);
    }

    function handleNativeChildNoSpawn(
        scopedJobId: string,
        worker: Worker,
        jobId: string,
        childId: string,
    ) {
        const activeJob = getNativeChildJob(scopedJobId, worker, jobId, 'native-child no-spawn');
        if (!activeJob) {
            return;
        }
        const child = activeJob.nativeChildren.get(childId);
        if (!child) {
            markNativeChildProtocolUnsafe(activeJob, `no-spawn arrived for unknown child ${childId}`);
            return;
        }
        if (child.state === 'no-child') {
            return;
        }
        if (child.state !== 'intent') {
            markNativeChildProtocolUnsafe(activeJob, `no-spawn contradicted registration for ${childId}`);
            return;
        }
        child.state = 'no-child';
        tryPhysicalFinalize(scopedJobId);
    }

    function handleNativeChildExit(
        scopedJobId: string,
        worker: Worker,
        jobId: string,
        childId: string,
        pid: number,
        processIdentity: IOcrNativeChildProcessIdentity,
    ) {
        const activeJob = getNativeChildJob(scopedJobId, worker, jobId, 'native-child exit');
        if (!activeJob) {
            return;
        }
        const child = activeJob.nativeChildren.get(childId);
        if (!child) {
            markNativeChildProtocolUnsafe(activeJob, `exit arrived for unknown child ${childId}`);
            postNativeChildAck(activeJob, worker, 'native-child-exit-ack', childId, false, 'native child was not registered');
            return;
        }
        if (child.state === 'exited' && child.pid === pid && identitiesMatch(child.processIdentity, processIdentity)) {
            postNativeChildAck(activeJob, worker, 'native-child-exit-ack', childId, true);
            return;
        }
        if (
            (child.state !== 'registered' && child.state !== 'unproven')
            || child.pid !== pid
            || !identitiesMatch(child.processIdentity, processIdentity)
        ) {
            markNativeChildProtocolUnsafe(activeJob, `exit proof did not match registered child ${childId}`);
            postNativeChildAck(activeJob, worker, 'native-child-exit-ack', childId, false, 'native child identity did not match');
            return;
        }
        child.state = 'exited';
        child.cleanupAttemptInFlight = false;
        clearNativeChildCleanupTimer(scopedJobId);
        postNativeChildAck(activeJob, worker, 'native-child-exit-ack', childId, true);
        tryPhysicalFinalize(scopedJobId);
    }

    function handleNativeChildUnproven(
        scopedJobId: string,
        worker: Worker,
        jobId: string,
        childId: string,
        detail: string,
    ) {
        const activeJob = getNativeChildJob(scopedJobId, worker, jobId, 'native-child unproven');
        if (!activeJob) {
            return;
        }
        const child = activeJob.nativeChildren.get(childId);
        if (!child) {
            markNativeChildProtocolUnsafe(activeJob, `unproven proof arrived for unknown child ${childId}`);
            return;
        }
        if (child.state === 'exited') {
            return;
        }
        if (child.state === 'intent' || child.state === 'no-child') {
            markNativeChildProtocolUnsafe(activeJob, `unproven proof contradicted child state for ${childId}`);
            return;
        }
        child.state = 'unproven';
        logger.warn(`[${scopedJobId}] OCR native child ${childId} termination is unproven: ${detail}`);
        if (activeJob.workerExitProven) {
            beginNativeChildCleanup(activeJob, child, 'worker cleanup handoff after unproven child termination');
        }
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
        markWorkerExit,
        markWorkerTerminationProven,
        markWorkerCleanupComplete,
        handleNativeChildIntent,
        handleNativeChildRegister,
        handleNativeChildNoSpawn,
        handleNativeChildExit,
        handleNativeChildUnproven,
    };
}
