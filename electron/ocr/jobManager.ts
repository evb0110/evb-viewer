import type { IpcMainInvokeEvent } from 'electron';
import {
    BrowserWindow,
    app,
} from 'electron';
import {
    dirname,
    join,
} from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { ensureTessdataLanguages } from '@electron/ocr/language-models';
import { getOcrToolPaths } from '@electron/ocr/paths';
import { createLogger } from '@electron/utils/logger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = createLogger('ocr-ipc');
const OCR_WORKER_POOL_SIZE = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_WORKER_POOL_SIZE ?? '2', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 2;
    }
    return parsed;
})();

interface IOcrPdfPageRequest {
    pageNumber: number;
    languages: string[];
}

interface IOcrQueuedJob {
    jobId: string;
    webContentsId: number;
    originalPdfData: Uint8Array;
    pages: IOcrPdfPageRequest[];
    workingCopyPath?: string;
    renderDpi?: number;
}

interface IOcrActiveJob extends IOcrQueuedJob {
    worker: Worker;
    completed: boolean;
    terminatedByUs: boolean;
}

type TWorkerMessage = {
    type: 'progress' | 'complete' | 'log';
    jobId?: string;
    progress?: {
        requestId: string;
        currentPage: number;
        processedCount: number;
        totalPages: number;
    };
    result?: {
        success: boolean;
        pdfData: Uint8Array | null;
        pdfPath?: string;
        errors: string[];
    };
    level?: string;
    message?: string;
};

const activeJobs = new Map<string, IOcrActiveJob>();
const queuedJobs: IOcrQueuedJob[] = [];
const queuedJobIds = new Set<string>();
const cancelledJobs = new Set<string>();

function asTransferableBytes(bytes: Uint8Array) {
    if (
        bytes.buffer instanceof ArrayBuffer
        && bytes.byteOffset === 0
        && bytes.byteLength === bytes.buffer.byteLength
    ) {
        return bytes;
    }
    return bytes.slice();
}

export function safeSendToWindow(
    window: BrowserWindow | null | undefined,
    channel: string,
    ...args: unknown[]
) {
    if (!window) {
        return;
    }
    if (window.isDestroyed()) {
        return;
    }
    if (window.webContents.isDestroyed()) {
        return;
    }

    try {
        window.webContents.send(channel, ...args);
    } catch (err) {
        log.debug(`Failed to send IPC message to channel "${channel}": ${err instanceof Error ? err.message : String(err)}`);
    }
}

function getJobWindow(webContentsId: number) {
    return BrowserWindow.getAllWindows().find(
        window => window.webContents.id === webContentsId,
    );
}

function getWorkerPath(): string {
    const defaultPath = join(__dirname, 'ocr-worker.js');
    if (!app?.isPackaged) {
        return defaultPath;
    }

    const unpackedPath = defaultPath.replace('app.asar', 'app.asar.unpacked');
    if (unpackedPath !== defaultPath && existsSync(unpackedPath)) {
        return unpackedPath;
    }

    return defaultPath;
}

function createOcrWorker(): Worker {
    const paths = getOcrToolPaths();
    const workerPath = getWorkerPath();

    log.debug(`Creating OCR worker: ${workerPath}`);
    log.debug(`Tool paths: tesseract=${paths.tesseract}, pdftoppm=${paths.pdftoppm}, qpdf=${paths.qpdf}`);

    return new Worker(workerPath, {workerData: {
        tesseractBinary: paths.tesseract,
        tessdataPath: paths.tessdata,
        pdftoppmBinary: paths.pdftoppm,
        pdftotextBinary: paths.pdftotext,
        pdfimagesBinary: paths.pdfimages,
        qpdfBinary: paths.qpdf,
        unpaperBinary: paths.unpaper,
        tempDir: app.getPath('temp'),
    }});
}

function removeQueuedJob(jobId: string) {
    const index = queuedJobs.findIndex(job => job.jobId === jobId);
    if (index === -1) {
        return null;
    }

    const [job] = queuedJobs.splice(index, 1);
    queuedJobIds.delete(jobId);
    return job ?? null;
}

function sendJobFailure(job: IOcrQueuedJob, error: string) {
    const window = getJobWindow(job.webContentsId);
    safeSendToWindow(window, 'ocr:complete', {
        requestId: job.jobId,
        success: false,
        pdfData: null,
        errors: [error],
    });
}

function finalizeActiveJob(jobId: string) {
    activeJobs.delete(jobId);
    dispatchQueuedJobs();
}

function handleWorkerMessage(
    jobId: string,
    webContentsId: number,
    message: TWorkerMessage,
) {
    const window = getJobWindow(webContentsId);

    if (message.type === 'log') {
        const logLevel = message.level || 'debug';
        if (logLevel === 'warn') {
            log.warn(message.message || '');
        } else if (logLevel === 'error') {
            log.debug(`[worker-error] ${message.message || ''}`);
        } else {
            log.debug(`[worker] ${message.message || ''}`);
        }
        return;
    }

    if (message.type === 'progress' && message.progress) {
        safeSendToWindow(window, 'ocr:progress', message.progress);
        return;
    }

    if (message.type === 'complete' && message.result) {
        safeSendToWindow(window, 'ocr:complete', {
            requestId: jobId,
            ...message.result,
        });

        const job = activeJobs.get(jobId);
        if (job) {
            job.completed = true;
            job.terminatedByUs = true;
            void job.worker.terminate();
        }
        return;
    }
}

function startQueuedJob(job: IOcrQueuedJob) {
    queuedJobIds.delete(job.jobId);

    const worker = createOcrWorker();
    const activeJob: IOcrActiveJob = {
        ...job,
        worker,
        completed: false,
        terminatedByUs: false,
    };
    activeJobs.set(job.jobId, activeJob);

    worker.on('message', (message: TWorkerMessage) => {
        handleWorkerMessage(job.jobId, job.webContentsId, message);
    });

    worker.on('error', (err: Error) => {
        if (cancelledJobs.has(job.jobId)) {
            cancelledJobs.delete(job.jobId);
            finalizeActiveJob(job.jobId);
            return;
        }

        log.debug(`Worker error for job ${job.jobId}: ${err.message}`);
        const active = activeJobs.get(job.jobId);
        if (active) {
            active.completed = true;
        }
        sendJobFailure(job, `Worker error: ${err.message}`);
        finalizeActiveJob(job.jobId);
    });

    worker.on('exit', (code) => {
        const wasCanceled = cancelledJobs.has(job.jobId);
        if (wasCanceled) {
            cancelledJobs.delete(job.jobId);
        }

        const active = activeJobs.get(job.jobId);
        const wasCompletedOrTerminated = wasCanceled || active?.completed || active?.terminatedByUs;

        if (code !== 0 && !wasCompletedOrTerminated) {
            log.debug(`Worker exited with code ${code} for job ${job.jobId}`);
            sendJobFailure(job, `Worker exited unexpectedly with code ${code}`);
        }

        finalizeActiveJob(job.jobId);
    });

    try {
        const transferPdfData = asTransferableBytes(job.originalPdfData);
        worker.postMessage({
            type: 'start',
            jobId: job.jobId,
            data: {
                originalPdfData: transferPdfData,
                pages: job.pages,
                workingCopyPath: job.workingCopyPath,
                renderDpi: job.renderDpi,
            },
        }, [transferPdfData.buffer as ArrayBuffer]);
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        sendJobFailure(job, `Failed to post OCR job to worker: ${errMsg}`);
        const active = activeJobs.get(job.jobId);
        if (active) {
            active.completed = true;
            active.terminatedByUs = true;
            void active.worker.terminate();
        }
        finalizeActiveJob(job.jobId);
        return;
    }

    log.debug(`OCR job ${job.jobId} started in worker thread`);
}

function dispatchQueuedJobs() {
    while (activeJobs.size < OCR_WORKER_POOL_SIZE && queuedJobs.length > 0) {
        const nextJob = queuedJobs.shift();
        if (!nextJob) {
            return;
        }
        startQueuedJob(nextJob);
    }
}

export async function handleOcrCreateSearchablePdfAsync(
    event: IpcMainInvokeEvent,
    originalPdfData: Uint8Array,
    pages: IOcrPdfPageRequest[],
    requestId: string,
    workingCopyPath?: string,
    renderDpi?: number,
): Promise<{
    started: boolean;
    jobId: string;
    error?: string;
}> {
    log.debug(`handleOcrCreateSearchablePdfAsync called: pdfLen=${originalPdfData.length}, pages=${pages.length}, reqId=${requestId}, dpi=${renderDpi}`);

    try {
        if (activeJobs.has(requestId) || queuedJobIds.has(requestId)) {
            return {
                started: false,
                jobId: requestId,
                error: `OCR job with id "${requestId}" already exists`,
            };
        }

        const languages = Array.from(new Set(pages.flatMap(page => page.languages)));
        await ensureTessdataLanguages(languages);

        const queuedJob: IOcrQueuedJob = {
            jobId: requestId,
            webContentsId: event.sender.id,
            originalPdfData,
            pages,
            workingCopyPath,
            renderDpi,
        };
        queuedJobs.push(queuedJob);
        queuedJobIds.add(requestId);
        dispatchQueuedJobs();

        return {
            started: true,
            jobId: requestId,
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to queue OCR worker job: ${errMsg}`);
        return {
            started: false,
            jobId: requestId,
            error: errMsg,
        };
    }
}

export function handleOcrCancel(
    _event: IpcMainInvokeEvent,
    requestId: string,
): { canceled: boolean } {
    log.info(`[${requestId}] Cancel requested`);

    const queued = removeQueuedJob(requestId);
    if (queued) {
        log.info(`[${requestId}] Queued OCR job cancelled`);
        return { canceled: true };
    }

    const activeJob = activeJobs.get(requestId);
    if (!activeJob) {
        log.info(`[${requestId}] No active OCR job found for cancel`);
        return { canceled: false };
    }

    activeJob.completed = true;
    activeJob.terminatedByUs = true;
    cancelledJobs.add(requestId);
    void activeJob.worker.terminate();
    finalizeActiveJob(requestId);
    log.info(`[${requestId}] Active OCR job cancelled`);
    return { canceled: true };
}
