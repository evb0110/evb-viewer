import type { Worker } from 'worker_threads';
import type { WebContents } from 'electron';
import {
    OCR_MODEL_PREP_TIMEOUT_MS,
    OCR_QUEUE_MAX_AGE_MS,
    OCR_QUEUE_MAX_SIZE,
    OCR_RESULT_FILE_ACK_TTL_MS,
    getOcrWorkerPoolSize,
} from '@electron/features/ocr/main/jobManager.config';
import { prepareLanguageModelsForJob } from '@electron/features/ocr/main/prepareLanguageModelsForJob.modelPrep';
import {
    isAbortError,
    parseWorkerMessage,
    type TOcrWorkerManagerMessage,
    toScopedOcrJobId,
} from '@electron/features/ocr/main/jobManagerProtocol';
import { getOcrWorkerMessageDisposition } from '@electron/features/ocr/main/getOcrWorkerMessageDisposition';
import { createPendingResultFileStore } from '@electron/features/ocr/main/createPendingResultFileStore';
import { createOcrWorker } from '@electron/features/ocr/main/createOcrWorker.worker';
import { createOcrJobWorkerLifecycleController } from '@electron/features/ocr/main/ocrJobWorkerLifecycle';
import { createOcrNativeChildTerminationController } from '@electron/features/ocr/main/ocrNativeChildProcessIdentity';
import { ocrResourceGovernor } from '@electron/features/ocr/main/ocrResourceGovernor';
import {
    handleWorkerResourceMessage,
    isWorkerResourceMessage,
} from '@electron/features/ocr/main/ocrWorkerResourceMessages';
import { createOcrWorkingCopyInvalidationController } from '@electron/features/ocr/main/createOcrWorkingCopyInvalidationController';
import {
    createOcrQueueFailure,
    type IOcrQueueStartResult,
} from '@electron/features/ocr/main/createOcrQueueFailure';
import type {
    IOcrActiveJob,
    IOcrPreparingJob,
    IOcrQueuedJob,
    IOcrRegistryProgress,
} from '@electron/features/ocr/main/jobManager.types';
import type {
    TOcrPdfPageSelection,
    TOcrWorkerInboundMessage,
} from '@electron/ocr/worker/types';
import {
    getJobWindow,
    safeSendToWindow,
} from '@electron/features/ocr/main/ocrProgressDispatch';
import type {
    IOcrCancelResult,
    IOcrCompleteResult,
    IOcrErrorEnvelope,
    IOcrJobProjectionState,
    IOcrProgress,
    IOcrSearchablePdfOptions,
    TOcrErrorCode,
    TOcrJobProjectionPhase,
} from '@contracts/electronApiOcr';
import {
    OCR_ERROR_CODES,
    OCR_PROGRESS_EVENT_CHANNEL,
} from '@contracts/electronApiOcr';
import { assertNever } from '@contracts/assertNever';
import {
    parseRequestId,
    requireJobId,
    requireRequestId,
    type TRequestId,
} from '@contracts/shared';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { getWorkingCopyRevision } from '@electron/file-access/documentRevisionStore';
import {
    getWorkingCopyBackingEntry, normalizePathForLookup,
} from '@electron/file-access/workingCopyStore';
import {parseDocumentRef} from '@contracts/documentRef';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import { estimateOcrRequestBytes } from '@electron/features/ocr/main/estimateOcrRequestBytes';
import {
    ensureOcrQueueCapacity,
    getBufferedOcrBytes,
} from '@electron/features/ocr/main/ocrQueueCapacity';
import {
    mainJobBroker,
    type IJobBrokerLease,
} from '@electron/resources/jobBroker';
import { removeOcrResultArtifacts } from '@electron/features/ocr/main/removeOcrResultArtifacts';
import {
    createMainJobRegistry,
    type TMainJobErrorKind,
    type TMainJobSnapshot,
} from '@electron/operation-lifecycle/createMainJobRegistry';
import {
    buildOcrErrorEnvelope,
    getOcrPageSelectionCount,
    mapStartFailureCode,
} from '@electron/features/ocr/contracts';
const log = createLogger('ocr-ipc');
const activeJobs = new Map<string, IOcrActiveJob>();
const preparingJobs = new Map<string, IOcrPreparingJob>();
const scopedJobIdsByDocumentJobKey = new Map<string, string>();
const workerCleanupTimersByScopedJobId = new Map<string, NodeJS.Timeout>();
const nativeChildCleanupTimersByScopedJobId = new Map<string, NodeJS.Timeout>();
const OCR_TERMINAL_EVENT_RETENTION_MS = 30_000;
const OCR_TERMINAL_RECORD_RETENTION_MS = 60 * 60 * 1_000;
const OCR_WORKER_BROKER_OWNER_ID = 'ocr-worker-pool';
const OCR_WORKER_ADMISSION_RESOURCES = {
    cpuTokens: 0.25,
    estimatedResidentBytes: 64 * 1024 * 1024,
    nativeProcesses: 0,
    ioWeight: 0.25,
};
type TOcrJobSnapshot = TMainJobSnapshot<IOcrRegistryProgress, IOcrCompleteResult, IOcrErrorEnvelope>;
interface IOcrManagerContext {
    sender: Pick<WebContents, 'id' | 'isDestroyed' | 'once' | 'on' | 'removeListener'>;
    senderId: number;
}

function toOcrActor(context: IOcrManagerContext) {
    return {sender: context.sender as WebContents};
}

function isOcrErrorEnvelope(cause: unknown): cause is IOcrErrorEnvelope {
    return typeof cause === 'object'
        && cause !== null
        && 'code' in cause
        && OCR_ERROR_CODES.includes(cause.code as TOcrErrorCode)
        && 'message' in cause
        && typeof cause.message === 'string'
        && 'retryable' in cause
        && typeof cause.retryable === 'boolean'
        && 'timestamp' in cause
        && typeof cause.timestamp === 'number';
}

function toOcrRegistryError(cause: unknown, kind: TMainJobErrorKind) {
    if (isOcrErrorEnvelope(cause)) {
        return cause;
    }
    const message = getErrorMessage(cause);
    if (kind === 'duplicate-job-id') {
        return buildOcrErrorEnvelope('OCR_QUEUE_BACKPRESSURE', message, {retryable: true});
    }
    return buildOcrErrorEnvelope('OCR_INTERNAL_ERROR', message || 'OCR job failed');
}

function toPublicOcrProgress(progress: IOcrRegistryProgress): IOcrProgress {
    const {
        projection: _projection,
        ...publicProgress
    } = progress;
    return publicProgress;
}

const ocrJobs = createMainJobRegistry<IOcrRegistryProgress, IOcrCompleteResult, IOcrErrorEnvelope>({
    retention: {
        eventReplayTtlMs: OCR_TERMINAL_EVENT_RETENTION_MS,
        terminalRecordTtlMs: OCR_TERMINAL_RECORD_RETENTION_MS,
    },
    progress: {
        channel: OCR_PROGRESS_EVENT_CHANNEL,
        getEventKey: progress => progress.requestId,
        send: (sender, _channel, progress) => {
            safeSendToWindow(
                getJobWindow(sender.id),
                OCR_PROGRESS_EVENT_CHANNEL,
                toPublicOcrProgress(progress),
            );
        },
    },
    toError: toOcrRegistryError,
    terminalProgress: {
        completed: latest => ({
            ...latest,
            processedCount: latest.totalPages,
            phaseProgress: 100,
            status: 'success',
        }),
        canceled: (latest, error) => ({
            ...latest,
            status: 'canceled',
            error: error.message,
        }),
        failed: (latest, error) => ({
            ...latest,
            status: 'failed',
            error: error.message,
        }),
    },
});
function getOcrSourcePathKey(sourcePdfPath: string) {
    return normalizePathForLookup(sourcePdfPath) || sourcePdfPath;
}
function getOcrDocumentJobKey(sourcePdfPath: string, documentRevision: IOcrQueuedJob['documentRevision']) {
    return `${getOcrSourcePathKey(sourcePdfPath)}\0${documentRevision.token}`;
}

function reserveOcrDocumentJob(documentJobKey: string, scopedJobId: string) {
    const existingScopedJobId = scopedJobIdsByDocumentJobKey.get(documentJobKey);
    if (existingScopedJobId && existingScopedJobId !== scopedJobId) {
        return existingScopedJobId;
    }
    scopedJobIdsByDocumentJobKey.set(documentJobKey, scopedJobId);
    return null;
}
function releaseOcrDocumentJobReservation(scopedJobId: string, documentJobKey?: string) {
    if (documentJobKey !== undefined) {
        if (scopedJobIdsByDocumentJobKey.get(documentJobKey) === scopedJobId) {
            scopedJobIdsByDocumentJobKey.delete(documentJobKey);
        }
        return;
    }

    for (const [
        candidateDocumentJobKey,
        candidateScopedJobId,
    ] of scopedJobIdsByDocumentJobKey.entries()) {
        if (candidateScopedJobId === scopedJobId) {
            scopedJobIdsByDocumentJobKey.delete(candidateDocumentJobKey);
        }
    }
}

const pendingResultFileStore = createPendingResultFileStore({
    logger: log,
    ttlMs: OCR_RESULT_FILE_ACK_TTL_MS,
    removeResultFile: path => removeOcrResultArtifacts(path, log),
});

function publishOcrProgress(job: IOcrQueuedJob, progress: IOcrProgress) {
    job.registry.publish({
        ...progress,
        projection: {
            supersessionPolicy: job.options.supersessionPolicy ?? 'missing-only',
            replaceAllAcknowledged: job.options.replaceAllAcknowledged === true,
        },
    });
}

const {
    isCurrentActiveWorker,
    resetJobWatchdog,
    sendJobFailure,
    sendJobCancellation,
    sendPendingCompletionResult,
    terminateAndFinalizeActiveJob,
    markWorkerExit,
    markWorkerCleanupComplete,
    handleNativeChildIntent,
    handleNativeChildRegister,
    handleNativeChildNoSpawn,
    handleNativeChildExit,
    handleNativeChildUnproven,
} = createOcrJobWorkerLifecycleController({
    activeJobs,
    workerCleanupTimersByScopedJobId,
    nativeChildCleanupTimersByScopedJobId,
    nativeChildTermination: createOcrNativeChildTerminationController(),
    pendingResultFileStore,
    logger: log,
    publishProgress: publishOcrProgress,
    getJobWindow,
    onFinalizeActiveJob: (scopedJobId, job) => {
        releaseOcrDocumentJobReservation(scopedJobId, job?.documentJobKey);
    },
    removeResultFile: path => removeOcrResultArtifacts(path, log),
    safeSendToWindow,
});

function ensureQueueCapacity(
    additionalBytes: number,
    options: { excludePreparingJobId?: string } = {},
){
    return ensureOcrQueueCapacity({
        activeJobs: activeJobs.values(),
        preparingJobs,
    }, additionalBytes, options);
}

function logQueueDepth(context: string) {
    const workerPoolSize = getOcrWorkerPoolSize();
    log.debug(
        `${context}: active=${activeJobs.size}/${workerPoolSize}, broker-pending=${preparingJobs.size}/${OCR_QUEUE_MAX_SIZE}, bufferedMB=${(getBufferedOcrBytes({
            activeJobs: activeJobs.values(),
            preparingJobs,
        }) / (1024 * 1024)).toFixed(1)}`,
    );
}

export const { cancelOcrJobsForWorkingCopy } = createOcrWorkingCopyInvalidationController({
    activeJobs,
    cancelJob: (scopedJobId, reason) =>
        preparingJobs.get(scopedJobId)?.cancel(reason)
        ?? activeJobs.get(scopedJobId)?.cancel(reason)
        ?? false,
    logger: log,
    preparingJobs,
});

function handleWorkerMessage(
    scopedJobId: string,
    requestId: TRequestId,
    webContentsId: number,
    worker: Worker,
    message: TOcrWorkerManagerMessage,
) {
    const acceptWorkerMessage = (incomingJobId: string, label: string) => {
        const disposition = getOcrWorkerMessageDisposition({
            incomingJobId,
            expectedRequestId: requestId,
            isCurrentWorker: isCurrentActiveWorker(scopedJobId, worker),
        });
        if (!disposition.accepted) {
            if (disposition.reason === 'mismatched-job-id') {
                log.warn(`Ignoring OCR ${label} for mismatched job id "${incomingJobId}" (expected "${requestId}")`);
            } else {
                log.debug(`Ignoring late OCR ${label} for inactive job "${requestId}"`);
            }
        }
        return disposition.accepted;
    };
    switch (message.type) {
        case 'log':
            if (message.level === 'warn') {
                log.warn(message.message);
            } else if (message.level === 'error') {
                log.error(`[worker-error] ${message.message}`, {
                    code: 'MAIN_OCR_OPERATION_FAILED',
                    context: {},
                });
            } else {
                log.debug(`[worker] ${message.message}`);
            }
            return;
        case 'progress': {
            if (!acceptWorkerMessage(message.jobId, 'progress')) {
                return;
            }
            const activeJob = activeJobs.get(scopedJobId);
            if (activeJob) {
                publishOcrProgress(activeJob, message.progress);
            }
            return;
        }
        case 'complete': {
            const activeJob = activeJobs.get(scopedJobId);
            const disposition = getOcrWorkerMessageDisposition({
                incomingJobId: message.jobId,
                expectedRequestId: requestId,
                isCurrentWorker: isCurrentActiveWorker(scopedJobId, worker),
                terminalResultSent: activeJob?.terminalResultSent === true,
                rejectAfterTerminalResult: true,
            });
            if (!disposition.accepted) {
                if (disposition.reason === 'mismatched-job-id') {
                    log.warn(`Ignoring OCR completion for mismatched job id "${message.jobId}" (expected "${requestId}")`);
                } else if (disposition.reason === 'terminal-result-already-sent') {
                    log.debug(`Ignoring duplicate OCR completion for job "${requestId}" after terminal result`);
                } else {
                    log.debug(`Ignoring late OCR completion for inactive job "${requestId}"`);
                }
                return;
            }
            if (activeJob) {
                activeJob.pendingCompletionResult = message.result;
                sendPendingCompletionResult(activeJob);
            }
            return;
        }
        case 'native-child-intent':
            handleNativeChildIntent(
                scopedJobId,
                worker,
                message.jobId,
                message.childId,
                message.commandLabel,
            );
            return;
        case 'native-child-register':
            handleNativeChildRegister(
                scopedJobId,
                worker,
                message.jobId,
                message.childId,
                message.pid,
                message.processIdentity,
            );
            return;
        case 'native-child-no-spawn':
            handleNativeChildNoSpawn(scopedJobId, worker, message.jobId, message.childId);
            return;
        case 'native-child-exit':
            handleNativeChildExit(
                scopedJobId,
                worker,
                message.jobId,
                message.childId,
                message.pid,
                message.processIdentity,
            );
            return;
        case 'native-child-unproven':
            handleNativeChildUnproven(
                scopedJobId,
                worker,
                message.jobId,
                message.childId,
                message.detail,
            );
            return;
        case 'cleanup-complete': {
            const activeJob = activeJobs.get(scopedJobId);
            if (
                !activeJob
                || activeJob.worker !== worker
                || activeJob.physicalFinalized
                || String(message.jobId) !== String(requestId)
            ) {
                log.debug(`Ignoring late OCR cleanup completion for job "${requestId}"`);
                return;
            }

            const result = activeJob?.pendingCompletionResult ?? null;
            if (!result) {
                if (!activeJob?.terminalResultSent) {
                    log.warn(`OCR cleanup completed before result for job "${requestId}"`);
                    const error = 'OCR worker completed cleanup before sending a result';
                    if (activeJob) {
                        sendJobFailure(activeJob, error);
                        activeJob.terminalResultSent = true;
                    }
                }
                terminateAndFinalizeActiveJob(scopedJobId, { reason: 'worker cleanup completed without result' });
                return;
            }

            if (activeJob) {
                sendPendingCompletionResult(activeJob);
            }

            markWorkerCleanupComplete(scopedJobId, worker);
            return;
        }
    }
    return assertNever(message);
}

function startBrokerAdmittedJob(job: IOcrQueuedJob, workerAdmissionLease: IJobBrokerLease) {
    let worker: Worker;
    try {
        worker = createOcrWorker();
    } catch (error) {
        const message = getErrorMessage(error);
        const result = sendJobFailure(job, `OCR worker unavailable: ${message}`, {
            code: 'OCR_WORKER_UNAVAILABLE',
            retryable: true,
        });
        workerAdmissionLease.release();
        releaseOcrDocumentJobReservation(job.scopedJobId, job.documentJobKey);
        job.resolveWorkerSettlement(result);
        log.error(`Failed to start OCR worker for job ${job.requestId}: ${message}`, {
            code: 'MAIN_OCR_OPERATION_FAILED',
            context: {},
        });
        return job.workerSettlement;
    }

    const activeJob: IOcrActiveJob = {
        ...job,
        workerAdmissionLease,
        worker,
        completed: false,
        terminatedByUs: false,
        pendingCompletionResult: null,
        terminalResult: null,
        terminalResultSent: false,
        startedAtMs: Date.now(),
        watchdogTimer: null,
        workerExitProven: false,
        workerExitCode: null,
        cleanupCompleteReceived: false,
        nativeChildren: new Map(),
        nativeChildProtocolUnsafe: false,
        physicalFinalized: false,
        brokeredResourcesReleased: false,
        discardPendingCompletionResult: false,
    };
    activeJobs.set(job.scopedJobId, activeJob);
    resetJobWatchdog(job);
    logQueueDepth(`OCR job ${job.requestId} activated`);

    worker.on('message', (message: unknown) => {
        if (isWorkerResourceMessage(message)) {
            resetJobWatchdog(job);
            handleWorkerResourceMessage(job.scopedJobId, worker, message, activeJobs);
            return;
        }
        const parsedMessage = parseWorkerMessage(message);
        if (!parsedMessage) {
            log.warn(`Ignoring malformed OCR worker message for job ${job.requestId}`);
            return;
        }
        resetJobWatchdog(job);
        handleWorkerMessage(job.scopedJobId, job.requestId, job.webContentsId, worker, parsedMessage);
    });

    worker.on('error', (err: Error) => {
        log.error(`Worker error for job ${job.requestId}: ${err.message}`, {
            code: 'MAIN_OCR_OPERATION_FAILED',
            context: {},
            cause: err,
        });
        const active = activeJobs.get(job.scopedJobId);
        if (!active) {
            return;
        }
        if (active.completed || active.terminatedByUs || active.terminalResultSent) {
            // Error is not exit proof. The exit event or a resolved terminate()
            // promise still owns admission, resources, and artifacts.
            return;
        }
        sendJobFailure(active, `Worker error: ${err.message}`);
        active.terminalResultSent = true;
        terminateAndFinalizeActiveJob(job.scopedJobId, { reason: 'worker error' });
    });

    worker.on('exit', (code) => {
        const active = activeJobs.get(job.scopedJobId);
        if (!active) {
            if (code !== 0) {
                log.error(`Worker exited with code ${code} after OCR job ${job.requestId} was no longer active`, {
                    code: 'MAIN_OCR_OPERATION_FAILED',
                    context: {},
                });
            }
            return;
        }
        const wasCompletedOrTerminated = job.registry.signal.aborted
            || active.completed
            || active.terminatedByUs
            || active.terminalResultSent;

        if (!wasCompletedOrTerminated && !active.pendingCompletionResult) {
            const error = code === 0
                ? 'Worker exited without returning an OCR result'
                : `Worker exited unexpectedly with code ${code}`;
            log.error(`Worker exited without a result for job ${job.requestId}`, {
                code: 'MAIN_OCR_OPERATION_FAILED',
                context: {},
            });
            sendJobFailure(active, error);
            active.terminalResultSent = true;
        } else if (active.pendingCompletionResult && !active.terminalResultSent) {
            sendPendingCompletionResult(active);
        }

        markWorkerExit(job.scopedJobId, worker, code);
    });

    try {
        const data: Extract<TOcrWorkerInboundMessage, { type: 'start' }>['data'] = {
            sourcePdfPath: job.sourcePdfPath,
            documentRevision: job.documentRevision,
            pages: job.pages,
            options: job.options,
        };
        if (job.options.renderDpi !== undefined) {
            data.renderDpi = job.options.renderDpi;
        }
        const startMessage: TOcrWorkerInboundMessage = {
            type: 'start',
            // Keep worker-visible job ids sender-agnostic so renderer callbacks
            // continue matching the requestId generated in the UI.
            jobId: requireJobId(job.requestId),
            data,
        };
        worker.postMessage(startMessage);
    } catch (error) {
        const errMsg = getErrorMessage(error);
        sendJobFailure(activeJob, `Failed to post OCR job to worker: ${errMsg}`);
        activeJob.terminalResultSent = true;
        terminateAndFinalizeActiveJob(job.scopedJobId, { reason: 'failed to post worker start message' });
        return job.workerSettlement;
    }

    log.debug(`OCR job ${job.requestId} started in worker thread`);
    return job.workerSettlement;
}

function findQueueBlockingResult(
    context: IOcrManagerContext,
    scopedJobId: string,
    requestId: TRequestId,
    options: {
        includePreparing: boolean;
        documentJobKey?: string
    },
): IOcrQueueStartResult | null {
    if (context.sender.isDestroyed()) {
        return createOcrQueueFailure(requestId, 'Renderer disconnected before OCR request could be queued');
    }

    const isExistingJob = activeJobs.has(scopedJobId)
        || (options.includePreparing && preparingJobs.has(scopedJobId));
    if (isExistingJob) {
        return createOcrQueueFailure(
            requestId,
            `OCR job with id "${requestId}" already exists`,
            'OCR_QUEUE_BACKPRESSURE',
        );
    }

    if (options.documentJobKey) {
        const existingScopedJobId = scopedJobIdsByDocumentJobKey.get(options.documentJobKey);
        if (existingScopedJobId && existingScopedJobId !== scopedJobId) {
            return createOcrQueueFailure(
                requestId,
                'OCR job for this document revision is already in progress',
                'OCR_QUEUE_BACKPRESSURE',
            );
        }
    }

    if (pendingResultFileStore.find(context.senderId, requestId)) {
        return createOcrQueueFailure(
            requestId,
            `OCR job with id "${requestId}" is waiting for result-file acknowledgement`,
            'OCR_QUEUE_BACKPRESSURE',
        );
    }

    return null;
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {
        promise,
        resolve,
    };
}

function toTerminalResult(requestId: TRequestId, failure: IOcrQueueStartResult): IOcrCompleteResult {
    const error = failure.error ?? 'OCR job failed before it started';
    return {
        requestId,
        success: false,
        errors: [error],
        errorEnvelope: buildOcrErrorEnvelope(
            failure.errorCode ?? mapStartFailureCode(error),
            error,
            {retryable: failure.errorCode === 'OCR_QUEUE_BACKPRESSURE'},
        ),
    };
}

function finishPreparationFailure(job: IOcrPreparingJob, failure: IOcrQueueStartResult) {
    const result = job.terminalResult ?? toTerminalResult(job.requestId, failure);
    job.terminalResult = result;
    if (job.registry.signal.aborted) {
        job.registry.terminal.cancel(result.errorEnvelope);
    } else {
        job.registry.terminal.fail(result.errorEnvelope);
    }
    job.resolveWorkerSettlement(result);
    return result;
}

async function prepareLanguageModelsForQueueJob(
    preparingJob: IOcrPreparingJob,
    pages: TOcrPdfPageSelection,
) {
    try {
        await prepareLanguageModelsForJob(preparingJob, pages, OCR_MODEL_PREP_TIMEOUT_MS);
        return null;
    } catch (error) {
        const reason: unknown = preparingJob.registry.signal.reason;
        if (reason instanceof Error && reason.name === 'TimeoutError') {
            throw reason;
        }
        if (preparingJob.registry.signal.aborted) {
            return createOcrQueueFailure(
                preparingJob.requestId,
                'OCR job was cancelled before it started',
            );
        }
        throw error;
    }
}

async function admitPreparedOcrJob(
    preparingJob: IOcrPreparingJob,
    queuedJob: IOcrQueuedJob,
) {
    const workerPoolSize = getOcrWorkerPoolSize();
    const timeoutController = new AbortController();
    const queueTimeout = setTimeout(() => {
        timeoutController.abort(new DOMException(
            'OCR queue item expired before JobBroker admission',
            'TimeoutError',
        ));
    }, OCR_QUEUE_MAX_AGE_MS);
    queueTimeout.unref();
    const admissionSignal = AbortSignal.any([
        preparingJob.registry.signal,
        timeoutController.signal,
    ]);

    let workerAdmissionLease: IJobBrokerLease | null = null;
    try {
        workerAdmissionLease = await mainJobBroker.acquire({
            ownerId: OCR_WORKER_BROKER_OWNER_ID,
            kind: 'ocr-worker',
            priority: 'user',
            resources: OCR_WORKER_ADMISSION_RESOURCES,
            perOwnerLimit: workerPoolSize,
            signal: admissionSignal,
        });
        if (
            admissionSignal.aborted
            || preparingJobs.get(queuedJob.scopedJobId) !== preparingJob
        ) {
            workerAdmissionLease.release();
            return finishPreparationFailure(
                preparingJob,
                createOcrQueueFailure(
                    queuedJob.requestId,
                    'OCR job was cancelled before it started',
                ),
            );
        }

        preparingJobs.delete(queuedJob.scopedJobId);
        const result = await startBrokerAdmittedJob(queuedJob, workerAdmissionLease);
        workerAdmissionLease = null;
        return result;
    } catch (error) {
        const canceled = preparingJob.registry.signal.aborted;
        const message = canceled
            ? 'OCR job was cancelled before it started'
            : error instanceof Error && error.name === 'TimeoutError'
                ? 'OCR queue item expired before processing'
                : `OCR worker admission failed: ${getErrorMessage(error)}`;
        return finishPreparationFailure(
            preparingJob,
            createOcrQueueFailure(
                queuedJob.requestId,
                message,
                canceled ? 'OCR_INTERNAL_ERROR' : 'OCR_QUEUE_BACKPRESSURE',
            ),
        );
    } finally {
        clearTimeout(queueTimeout);
        workerAdmissionLease?.release();
        if (!activeJobs.has(queuedJob.scopedJobId)) {
            preparingJobs.delete(queuedJob.scopedJobId);
            releaseOcrDocumentJobReservation(queuedJob.scopedJobId, queuedJob.documentJobKey);
        }
    }
}

export async function handleOcrCreateSearchablePdfAsync(
    context: IOcrManagerContext,
    sourcePdfPath: string,
    pages: TOcrPdfPageSelection,
    requestId: TRequestId,
    options: IOcrSearchablePdfOptions = {},
): Promise<IOcrQueueStartResult> {
    log.debug(`handleOcrCreateSearchablePdfAsync called: sourcePdfPath=${sourcePdfPath}, pages=${getOcrPageSelectionCount(pages)}, reqId=${requestId}, dpi=${options.renderDpi ?? 'default'}, profile=${options.qualityProfile ?? 'balanced'}, preprocessing=${options.preprocessingMode ?? 'off'}`);
    const scopedJobId = toScopedOcrJobId(context.senderId, requestId);
    let reservedDocumentJobKey: string | null = null;

    try {
        await pendingResultFileStore.evictStale();
        const initialBlock = findQueueBlockingResult(context, scopedJobId, requestId, {includePreparing: true});
        if (initialBlock) {
            return initialBlock;
        }

        const documentRevision = await getWorkingCopyRevision(sourcePdfPath, context.senderId);
        const documentJobKey = getOcrDocumentJobKey(sourcePdfPath, documentRevision);
        const documentBlock = findQueueBlockingResult(context, scopedJobId, requestId, {
            includePreparing: true,
            documentJobKey,
        });
        if (documentBlock) {
            return documentBlock;
        }
        if (reserveOcrDocumentJob(documentJobKey, scopedJobId)) {
            return createOcrQueueFailure(
                requestId,
                'OCR job for this document revision is already in progress',
                'OCR_QUEUE_BACKPRESSURE',
            );
        }
        reservedDocumentJobKey = documentJobKey;

        const requestedBytes = estimateOcrRequestBytes(pages, options);
        const startResult = createDeferred<IOcrQueueStartResult>();
        const handle = ocrJobs.start({
            jobId: requestId,
            owner: toOcrActor(context),
            operation: {
                kind: 'abortable-work',
                workingCopyPath: sourcePdfPath,
            },
            ownerLifecycle: {
                destroyed: 'detach',
                renderProcessGone: 'detach',
                mainFrameNavigation: 'detach',
            },
            initialProgress: {
                requestId,
                currentPage: Array.isArray(pages)
                    ? pages[0]?.pageNumber ?? 0
                    : pages.kind === 'all'
                        ? 1
                        : pages.kind === 'range'
                            ? pages.firstPage
                            : pages.kind === 'ranges'
                                ? pages.ranges[0]?.firstPage ?? 0
                                : pages.pages[0]?.pageNumber ?? 0,
                processedCount: 0,
                totalPages: getOcrPageSelectionCount(pages),
                phase: 'model-prep',
                projection: {
                    supersessionPolicy: options.supersessionPolicy ?? 'missing-only',
                    replaceAllAcknowledged: options.replaceAllAcknowledged === true,
                },
            },
            onCancel: (reason) => {
                const preparingJob = preparingJobs.get(scopedJobId);
                if (preparingJob) {
                    sendJobCancellation(preparingJob, reason);
                } else if (activeJobs.has(scopedJobId)) {
                    terminateAndFinalizeActiveJob(scopedJobId, {
                        markCancelled: true,
                        reason,
                    });
                }
            },
            run: async (registry) => {
                const workerSettlement = createDeferred<IOcrCompleteResult>();
                const preparingJob: IOcrPreparingJob = {
                    registry,
                    cancel: reason => handle.cancel(reason),
                    settled: handle.settled,
                    workerSettlement: workerSettlement.promise,
                    resolveWorkerSettlement: workerSettlement.resolve,
                    terminalResult: null,
                    scopedJobId,
                    documentJobKey,
                    requestId,
                    webContentsId: context.senderId,
                    sourcePdfPath,
                    documentRevision,
                    requestedBytes,
                    startedAtMs: Date.now(),
                };
                preparingJobs.set(scopedJobId, preparingJob);
                let startResolved = false;
                const resolveStart = (result: IOcrQueueStartResult) => {
                    if (!startResolved) {
                        startResolved = true;
                        startResult.resolve(result);
                    }
                };

                try {
                    const capacityResult = ensureQueueCapacity(requestedBytes, {excludePreparingJobId: scopedJobId});
                    if (!capacityResult.ok) {
                        const failure = createOcrQueueFailure(
                            requestId,
                            capacityResult.error,
                            'OCR_QUEUE_BACKPRESSURE',
                        );
                        resolveStart(failure);
                        return finishPreparationFailure(preparingJob, failure);
                    }

                    const modelPrepResult = await prepareLanguageModelsForQueueJob(preparingJob, pages);
                    if (modelPrepResult) {
                        resolveStart(modelPrepResult);
                        return finishPreparationFailure(preparingJob, modelPrepResult);
                    }

                    const recheckBlock = findQueueBlockingResult(context, scopedJobId, requestId, {
                        includePreparing: false,
                        documentJobKey,
                    });
                    if (recheckBlock) {
                        resolveStart(recheckBlock);
                        return finishPreparationFailure(preparingJob, recheckBlock);
                    }
                    const capacityRecheck = ensureQueueCapacity(requestedBytes, {excludePreparingJobId: scopedJobId});
                    if (!capacityRecheck.ok) {
                        const failure = createOcrQueueFailure(
                            requestId,
                            capacityRecheck.error,
                            'OCR_QUEUE_BACKPRESSURE',
                        );
                        resolveStart(failure);
                        return finishPreparationFailure(preparingJob, failure);
                    }
                    if (registry.signal.aborted) {
                        const failure = createOcrQueueFailure(
                            requestId,
                            'OCR job was cancelled before it started',
                        );
                        resolveStart(failure);
                        return finishPreparationFailure(preparingJob, failure);
                    }

                    const queuedJob: IOcrQueuedJob = {
                        ...preparingJob,
                        pages,
                        options,
                        queuedAtMs: Date.now(),
                    };
                    logQueueDepth(`OCR job ${requestId} submitted to JobBroker`);
                    resolveStart({
                        started: true,
                        jobId: requireJobId(requestId),
                    });
                    return await admitPreparedOcrJob(preparingJob, queuedJob);
                } catch (error) {
                    const message = isAbortError(error) && registry.signal.aborted
                        ? 'OCR job was cancelled before it started'
                        : getErrorMessage(error);
                    const failure = createOcrQueueFailure(requestId, message);
                    resolveStart(failure);
                    return finishPreparationFailure(preparingJob, failure);
                } finally {
                    if (!activeJobs.has(scopedJobId)) {
                        preparingJobs.delete(scopedJobId);
                        releaseOcrDocumentJobReservation(scopedJobId, documentJobKey);
                    }
                }
            },
        });
        reservedDocumentJobKey = null;
        return await startResult.promise;
    } catch (error) {
        const message = getErrorMessage(error);
        log.error(`Failed to queue OCR worker job: ${message}`, {
            code: 'MAIN_OCR_OPERATION_FAILED',
            context: {},
            cause: error,
        });
        return createOcrQueueFailure(
            requestId,
            message,
            isOcrErrorEnvelope(error) ? error.code : 'OCR_INTERNAL_ERROR',
        );
    } finally {
        if (reservedDocumentJobKey !== null) {
            releaseOcrDocumentJobReservation(scopedJobId, reservedDocumentJobKey);
        }
    }
}

export async function handleOcrAcknowledgeResultFile(
    context: IOcrManagerContext,
    requestIdPayload: unknown,
    pdfPathPayload?: unknown,
    documentRefPayload?: unknown,
    sourceDocumentRevisionTokenPayload?: unknown,
): Promise<{
    cleaned: boolean;
    error?: string
}> {
    await pendingResultFileStore.evictStale();
    const requestId = typeof requestIdPayload === 'string'
        ? parseRequestId(requestIdPayload)
        : null;
    if (requestId === null) {
        return {
            cleaned: false,
            error: 'requestId must be a non-empty string',
        };
    }
    const documentRef = documentRefPayload === undefined ? undefined : parseDocumentRef(documentRefPayload);
    const sourceDocumentRevisionToken = sourceDocumentRevisionTokenPayload === undefined
        ? undefined
        : parseDocumentRevisionToken(sourceDocumentRevisionTokenPayload);
    if (documentRefPayload !== undefined && documentRef === null) {
        return {
            cleaned: false,
            error: 'documentRef must be an absolute document path',
        };
    }
    if (sourceDocumentRevisionTokenPayload !== undefined && sourceDocumentRevisionToken === null) {
        return {
            cleaned: false,
            error: 'sourceDocumentRevisionToken must be a non-empty string',
        };
    }
    if (documentRef && sourceDocumentRevisionToken && !getWorkingCopyBackingEntry(documentRef, context.senderId)) {
        return {
            cleaned: false,
            error: 'Document owner is not authorized to discard this OCR result',
        };
    }
    return pendingResultFileStore.acknowledge(
        context.senderId,
        requestId,
        typeof pdfPathPayload === 'string' ? pdfPathPayload : undefined,
        documentRef ?? undefined,
        sourceDocumentRevisionToken ?? undefined,
    );
}

export function handleOcrCancel(
    context: IOcrManagerContext,
    requestId: TRequestId,
): IOcrCancelResult {
    log.info(`[${requestId}] Cancel requested`);
    const scopedJobId = toScopedOcrJobId(context.senderId, requestId);
    const canceled = ocrJobs.cancel(
        requestId,
        toOcrActor(context),
        'explicit cancel request',
    );
    const preparingJob = preparingJobs.get(scopedJobId);
    if (preparingJob) {
        sendJobCancellation(preparingJob, 'explicit cancel request');
    }
    const activeJob = activeJobs.get(scopedJobId);
    if (activeJob) {
        terminateAndFinalizeActiveJob(scopedJobId, {
            markCancelled: true,
            reason: 'explicit cancel request',
        });
    }
    if (canceled || preparingJob || activeJob) {
        return {canceled: true};
    }
    return {
        canceled: false,
        reason: 'not-found',
    };
}

async function stopOcrJobManager(options: {shutdownResultStore: boolean}) {
    const settlements = new Set<Promise<void>>();
    for (const preparingJob of preparingJobs.values()) {
        settlements.add(preparingJob.settled);
        preparingJob.cancel('OCR job manager shutdown');
    }
    for (const [
        scopedJobId,
        activeJob,
    ] of activeJobs) {
        settlements.add(activeJob.settled);
        if (!activeJob.cancel('OCR job manager shutdown')) {
            terminateAndFinalizeActiveJob(scopedJobId, {reason: 'app shutdown'});
        }
    }
    await Promise.allSettled(settlements);
    preparingJobs.clear();
    if (options.shutdownResultStore) {
        await pendingResultFileStore.shutdown();
    }
    ocrResourceGovernor.reset();
    scopedJobIdsByDocumentJobKey.clear();
}

export function recoverOcrJobManager() {
    return stopOcrJobManager({shutdownResultStore: false});
}

export function shutdownOcrJobManager() {
    return stopOcrJobManager({shutdownResultStore: true});
}

function toOcrJobPhase(phase: string | undefined): TOcrJobProjectionPhase {
    return phase === 'queued'
        || phase === 'recognizing'
        || phase === 'applying'
        || phase === 'cancel-requested'
        || phase === 'preparing'
        || phase === 'model-prep'
        || phase === 'pdf-prep'
        || phase === 'dpi-inspection'
        || phase === 'page-size-probing'
        || phase === 'processing'
        || phase === 'merging'
        || phase === 'indexing'
        ? phase
        : 'recognizing';
}

function projectOcrJob(snapshot: TOcrJobSnapshot): IOcrJobProjectionState {
    const progress = snapshot.progress;
    const percent = progress.phaseProgress
        ?? (progress.totalPages > 0 ? (progress.processedCount / progress.totalPages) * 100 : 0);
    return {
        jobId: toScopedOcrJobId(snapshot.owner.webContentsId, requireRequestId(snapshot.jobId)),
        requestId: requireRequestId(snapshot.jobId),
        status: snapshot.status === 'canceling' || snapshot.status === 'committing'
            ? 'running'
            : snapshot.status,
        phase: snapshot.status === 'canceling'
            ? 'cancel-requested'
            : toOcrJobPhase(progress.phase),
        percent,
        current: progress.processedCount,
        total: progress.totalPages,
        ...(progress.error ? {error: progress.error} : {}),
        updatedAtMs: snapshot.updatedAtMs,
        ...progress.projection,
    };
}

export function getOcrJobProjection(context: IOcrManagerContext, requestId: TRequestId) {
    const snapshot = ocrJobs.get(requestId, toOcrActor(context));
    return snapshot ? projectOcrJob(snapshot) : null;
}

export function subscribeOcrJobProjection(
    context: IOcrManagerContext,
    requestId: TRequestId,
    listener: (state: IOcrJobProjectionState) => void,
) {
    return ocrJobs.subscribe(
        requestId,
        toOcrActor(context),
        snapshot => listener(projectOcrJob(snapshot)),
    ) ?? (() => {});
}

export function subscribeManagedOcrProgress(context: IOcrManagerContext) {
    return ocrJobs.subscribeOwner(toOcrActor(context));
}
