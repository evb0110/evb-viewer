import type { Worker } from 'worker_threads';
import { isRecord } from '@contracts/runtimeGuards';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { getOcrWorkerMessageDisposition } from '@electron/features/ocr/main/getOcrWorkerMessageDisposition';
import type { IOcrActiveJob } from '@electron/features/ocr/main/jobManager.types';
import {
    ocrResourceGovernor,
    type IOcrResourceRequest,
} from '@electron/features/ocr/main/ocrResourceGovernor';
import type {
    TOcrWorkerInboundMessage,
    TOcrWorkerOutboundMessage,
} from '@electron/ocr/worker/types';

const log = createLogger('ocr-ipc');

export type TOcrWorkerResourceMessage = Extract<
    TOcrWorkerOutboundMessage,
    { type: 'resource-acquire' } | { type: 'resource-release' }
>;

export function isWorkerResourceMessage(message: unknown): message is TOcrWorkerResourceMessage {
    if (!isRecord(message) || typeof message.type !== 'string') {
        return false;
    }

    if (message.type === 'resource-release') {
        return typeof message.jobId === 'string' && typeof message.token === 'string';
    }

    return message.type === 'resource-acquire'
        && typeof message.jobId === 'string'
        && typeof message.requestId === 'string'
        && typeof message.pageNumber === 'number'
        && Number.isFinite(message.pageNumber)
        && typeof message.requestedDpi === 'number'
        && Number.isFinite(message.requestedDpi)
        && (message.pageWidthIn === undefined || (typeof message.pageWidthIn === 'number' && Number.isFinite(message.pageWidthIn)))
        && (message.pageHeightIn === undefined || (typeof message.pageHeightIn === 'number' && Number.isFinite(message.pageHeightIn)));
}

function sendOcrResourceDenied(
    scopedJobId: string,
    worker: Worker,
    message: Extract<TOcrWorkerResourceMessage, { type: 'resource-acquire' }>,
    reason: string,
) {
    const response: TOcrWorkerInboundMessage = {
        type: 'resource-denied',
        jobId: message.jobId,
        requestId: message.requestId,
        reason,
    };
    try {
        worker.postMessage(response);
    } catch (error) {
        log.debug(`[${scopedJobId}] Failed to send OCR resource denial: ${getErrorMessage(error)}`);
    }
}

function isCurrentActiveResourceWorker(
    activeJob: IOcrActiveJob | undefined,
    worker: Worker,
) {
    return Boolean(
        activeJob
        && activeJob.worker === worker
        && !activeJob.completed
        && !activeJob.terminatedByUs
        && !activeJob.workerExitProven,
    );
}

function isOwnedResourceWorker(
    activeJob: IOcrActiveJob | undefined,
    worker: Worker,
) {
    return Boolean(
        activeJob
        && activeJob.worker === worker
        && !activeJob.physicalFinalized,
    );
}

function createOcrResourceRequest(
    scopedJobId: string,
    message: Extract<TOcrWorkerResourceMessage, { type: 'resource-acquire' }>,
    signal: AbortSignal,
): IOcrResourceRequest {
    const resourceRequest: IOcrResourceRequest = {
        jobId: scopedJobId,
        pageNumber: message.pageNumber,
        requestedDpi: message.requestedDpi,
        signal,
    };
    if (message.pageWidthIn !== undefined) {
        resourceRequest.pageWidthIn = message.pageWidthIn;
    }
    if (message.pageHeightIn !== undefined) {
        resourceRequest.pageHeightIn = message.pageHeightIn;
    }
    return resourceRequest;
}

export function handleWorkerResourceMessage(
    scopedJobId: string,
    worker: Worker,
    message: TOcrWorkerResourceMessage,
    activeJobs: ReadonlyMap<string, IOcrActiveJob>,
) {
    const activeJob = activeJobs.get(scopedJobId);
    if (message.type === 'resource-release') {
        const releaseDisposition = getOcrWorkerMessageDisposition({
            incomingJobId: message.jobId,
            expectedRequestId: activeJob?.requestId ?? scopedJobId,
            isCurrentWorker: isOwnedResourceWorker(activeJob, worker),
        });
        if (!releaseDisposition.accepted) {
            log.debug(`[${scopedJobId}] Ignoring OCR resource release: ${releaseDisposition.reason ?? '<unknown>'}`);
            return;
        }
        if (!ocrResourceGovernor.releaseForJob(message.token, scopedJobId)) {
            log.debug(`[${scopedJobId}] Ignoring OCR resource release for unowned token`);
        }
        return;
    }

    const sendResourceDenied = (reason: string) => {
        sendOcrResourceDenied(scopedJobId, worker, message, reason);
    };
    const disposition = getOcrWorkerMessageDisposition({
        incomingJobId: message.jobId,
        expectedRequestId: activeJob?.requestId ?? scopedJobId,
        isCurrentWorker: isCurrentActiveResourceWorker(activeJob, worker),
        terminalResultSent: activeJob?.terminalResultSent === true,
        rejectAfterTerminalResult: true,
    });
    // An accepted disposition already requires `activeJob` to be the current
    // worker's job; the second half of the test is what narrows the type.
    if (!disposition.accepted || !activeJob) {
        log.debug(`[${scopedJobId}] Ignoring OCR resource ${message.type}: ${disposition.reason ?? '<unknown>'}`);
        sendResourceDenied(`OCR resource request denied because job ${message.jobId} is no longer active`);
        return;
    }

    void ocrResourceGovernor.acquire(
        createOcrResourceRequest(scopedJobId, message, activeJob.registry.signal),
    ).then((lease) => {
        const active = activeJobs.get(scopedJobId);
        const leaseDisposition = getOcrWorkerMessageDisposition({
            incomingJobId: message.jobId,
            expectedRequestId: active?.requestId ?? scopedJobId,
            isCurrentWorker: isCurrentActiveResourceWorker(active, worker),
            terminalResultSent: active?.terminalResultSent === true,
            rejectAfterTerminalResult: true,
        });
        if (!leaseDisposition.accepted) {
            ocrResourceGovernor.releaseForJob(lease.token, scopedJobId);
            sendResourceDenied(`OCR resource request denied because job ${message.jobId} is no longer active`);
            return;
        }

        const response: TOcrWorkerInboundMessage = {
            type: 'resource-acquired',
            jobId: message.jobId,
            requestId: message.requestId,
            token: lease.token,
            effectiveDpi: lease.effectiveDpi,
        };
        try {
            worker.postMessage(response);
        } catch (error) {
            // The lease is held by the governor from `acquire` onwards, but the worker
            // only learns its token from this message. A delivery failure leaves nobody
            // able to release it, so the slot has to go back here.
            ocrResourceGovernor.releaseForJob(lease.token, scopedJobId);
            throw error;
        }
    }).catch((error: unknown) => {
        const messageText = getErrorMessage(error);
        sendResourceDenied(messageText);
        log.warn(`[${scopedJobId}] Failed to grant OCR resource slot: ${messageText}`);
    });
}
