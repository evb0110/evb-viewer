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

interface IOcrJob {
    jobId: string;
    worker: Worker;
    webContentsId: number;
    completed: boolean;
    terminatedByUs: boolean;
}

const activeJobs = new Map<string, IOcrJob>();

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

function handleWorkerMessage(
    jobId: string,
    webContentsId: number,
    message: {
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
            pdfData: number[] | null;
            pdfPath?: string;
            errors: string[];
        };
        level?: string;
        message?: string;
    },
) {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.id === webContentsId);

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
            job.worker.terminate();
            activeJobs.delete(jobId);
        }
        return;
    }
}

interface IOcrPdfPageRequest {
    pageNumber: number;
    languages: string[];
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
        const languages = Array.from(new Set(pages.flatMap(page => page.languages)));
        await ensureTessdataLanguages(languages);

        const worker = createOcrWorker();
        const webContentsId = event.sender.id;

        activeJobs.set(requestId, {
            jobId: requestId,
            worker,
            webContentsId,
            completed: false,
            terminatedByUs: false,
        });

        worker.on('message', (message) => {
            handleWorkerMessage(requestId, webContentsId, message);
        });

        worker.on('error', (err: Error) => {
            log.debug(`Worker error for job ${requestId}: ${err.message}`);
            const job = activeJobs.get(requestId);
            if (job) {
                job.completed = true;
            }
            const window = BrowserWindow.getAllWindows().find(w => w.webContents.id === webContentsId);
            safeSendToWindow(window, 'ocr:complete', {
                requestId,
                success: false,
                pdfData: null,
                errors: [`Worker error: ${err.message}`],
            });
            activeJobs.delete(requestId);
        });

        worker.on('exit', (code) => {
            const job = activeJobs.get(requestId);
            const wasCompletedOrTerminated = job?.completed || job?.terminatedByUs;

            if (code !== 0 && !wasCompletedOrTerminated) {
                log.debug(`Worker exited with code ${code} for job ${requestId}`);
                const window = BrowserWindow.getAllWindows().find(w => w.webContents.id === webContentsId);
                safeSendToWindow(window, 'ocr:complete', {
                    requestId,
                    success: false,
                    pdfData: null,
                    errors: [`Worker exited unexpectedly with code ${code}`],
                });
            }
            activeJobs.delete(requestId);
        });

        worker.postMessage({
            type: 'start',
            jobId: requestId,
            data: {
                originalPdfData,
                pages,
                workingCopyPath,
                renderDpi,
            },
        });

        log.debug(`OCR job ${requestId} started in worker thread`);

        return {
            started: true,
            jobId: requestId,
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to start OCR worker: ${errMsg}`);
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
    const job = activeJobs.get(requestId);
    if (!job) {
        log.info(`[${requestId}] No active job found for cancel`);
        return { canceled: false };
    }

    job.completed = true;
    job.terminatedByUs = true;
    job.worker.terminate();
    activeJobs.delete(requestId);
    log.info(`[${requestId}] Job cancelled and worker terminated`);
    return { canceled: true };
}
