import type { IpcMainInvokeEvent } from 'electron';
import {
    BrowserWindow,
    ipcMain,
    app,
} from 'electron';
import { randomUUID } from 'crypto';
import {
    readFile,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    availableParallelism,
    cpus,
} from 'os';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { runOcr } from '@electron/ocr/tesseract';
import {
    getOcrToolPaths,
    validateOcrTools,
} from '@electron/ocr/paths';
import type { IOcrLanguage } from '@app/types/shared';
import {
    preprocessPageForOcr,
    validatePreprocessingSetup,
} from '@electron/ocr/preprocessing';
import { createLogger } from '@electron/utils/logger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = createLogger('ocr-ipc');

// Worker thread management for non-blocking OCR
interface IOcrJob {
    jobId: string;
    worker: Worker;
    webContentsId: number;
    completed: boolean;
    terminatedByUs: boolean;
}

const activeJobs = new Map<string, IOcrJob>();

function safeSendToWindow(
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
    // Worker is compiled to dist-electron alongside main.js
    // __dirname resolves to dist-electron (where main.js is)
    return join(__dirname, 'ocr-worker.js');
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
        // Forward worker logs to main logger
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
        // Forward progress to renderer
        safeSendToWindow(window, 'ocr:progress', message.progress);
        return;
    }

    if (message.type === 'complete' && message.result) {
        // Forward completion to renderer
        safeSendToWindow(window, 'ocr:complete', {
            requestId: jobId,
            ...message.result,
        });

        // Clean up the job - mark as completed before terminating to prevent
        // the exit handler from sending a duplicate failure completion
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

function parsePositiveInt(value: string | undefined): number | null {
    if (!value) {
        return null;
    }

    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
}

function getCpuCount(): number {
    const count = typeof availableParallelism === 'function'
        ? availableParallelism()
        : cpus().length;
    return Math.max(1, count);
}

function getOcrConcurrency(targetCount: number): number {
    const configured = parsePositiveInt(process.env.OCR_CONCURRENCY);
    if (configured) {
        return Math.max(1, Math.min(configured, targetCount));
    }

    const cpuCount = getCpuCount();
    // Bound concurrency to avoid spawning too many heavy OCR processes (tessdata_best is memory-hungry).
    const defaultConcurrency = Math.min(cpuCount, 8);
    return Math.max(1, Math.min(defaultConcurrency, targetCount));
}

function getTesseractThreadLimit(concurrency: number): number {
    const configured = parsePositiveInt(process.env.OCR_TESSERACT_THREADS);
    if (configured) {
        return configured;
    }

    const cpuCount = getCpuCount();
    return Math.max(1, Math.floor(cpuCount / Math.max(1, concurrency)));
}

async function forEachConcurrent<T>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    let nextIndex = 0;

    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) {
                return;
            }

            await fn(items[index]!, index);
        }
    });

    await Promise.all(workers);
}

function getSequentialProgressPage(
    pages: Array<{ pageNumber: number }>,
    processedCount: number,
): number {
    if (pages.length === 0) {
        return 0;
    }

    // Keep UI page numbers monotonic even when work is done in parallel.
    const index = Math.min(Math.max(processedCount, 0), pages.length - 1);
    return pages[index]?.pageNumber ?? 0;
}

interface IOcrPageRequest {
    pageNumber: number;
    imageData: number[];
    languages: string[];
}

interface IOcrPdfPageRequest {
    pageNumber: number;
    languages: string[];
}

const AVAILABLE_LANGUAGES: IOcrLanguage[] = [
    {
        code: 'eng',
        name: 'English',
        script: 'latin', 
    },
    {
        code: 'fra',
        name: 'French',
        script: 'latin', 
    },
    {
        code: 'deu',
        name: 'German',
        script: 'latin', 
    },
    {
        code: 'tur',
        name: 'Turkish',
        script: 'latin', 
    },
    {
        code: 'kmr',
        name: 'Kurdish (Kurmanji)',
        script: 'latin', 
    },
    {
        code: 'rus',
        name: 'Russian',
        script: 'cyrillic', 
    },
    {
        code: 'ara',
        name: 'Arabic',
        script: 'rtl', 
    },
    {
        code: 'heb',
        name: 'Hebrew',
        script: 'rtl', 
    },
    {
        code: 'syr',
        name: 'Syriac',
        script: 'rtl', 
    },
];

async function handleOcrRecognize(
    _event: IpcMainInvokeEvent,
    request: IOcrPageRequest,
) {
    const imageBuffer = Buffer.from(request.imageData);
    const result = await runOcr(imageBuffer, request.languages);

    return {
        pageNumber: request.pageNumber,
        success: result.success,
        text: result.text,
        error: result.error,
    };
}

async function handleOcrRecognizeBatch(
    event: IpcMainInvokeEvent,
    pages: IOcrPageRequest[],
    requestId: string,
) {
    const window = BrowserWindow.fromWebContents(event.sender);
    const results: Record<number, string> = {};
    const errors: string[] = [];

    const targetPages = pages.filter((p): p is IOcrPageRequest => !!p);
    const concurrency = getOcrConcurrency(targetPages.length);
    const tesseractThreads = getTesseractThreadLimit(concurrency);

    log.debug(`OCR batch: pages=${targetPages.length}, concurrency=${concurrency}, threads=${tesseractThreads}`);

    let processedCount = 0;

    // Send immediate progress update so UI shows feedback right away
    safeSendToWindow(window, 'ocr:progress', {
        requestId,
        currentPage: targetPages[0]?.pageNumber ?? 0,
        processedCount,
        totalPages: targetPages.length,
    });

    await forEachConcurrent(targetPages, concurrency, async (page) => {
        const imageBuffer = Buffer.from(page.imageData);

        try {
            const result = await runOcr(imageBuffer, page.languages, {threads: tesseractThreads});

            if (result.success) {
                results[page.pageNumber] = result.text;
            } else {
                errors.push(`Page ${page.pageNumber}: ${result.error}`);
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            errors.push(`Page ${page.pageNumber}: ${errMsg}`);
        } finally {
            processedCount += 1;
            safeSendToWindow(window, 'ocr:progress', {
                requestId,
                currentPage: getSequentialProgressPage(targetPages, processedCount),
                processedCount,
                totalPages: targetPages.length,
            });
        }
    });

    return {
        results,
        errors, 
    };
}

/**
 * Non-blocking OCR handler using Worker Threads.
 *
 * This function returns immediately with the job ID. The actual OCR processing
 * happens in a separate worker thread, and results are sent via 'ocr:complete'
 * IPC message when done.
 */
function handleOcrCreateSearchablePdfAsync(
    event: IpcMainInvokeEvent,
    originalPdfData: Uint8Array,
    pages: IOcrPdfPageRequest[],
    requestId: string,
    workingCopyPath?: string,
    renderDpi?: number,
): {
    started: boolean;
    jobId: string;
    error?: string 
} {
    log.debug(`handleOcrCreateSearchablePdfAsync called: pdfLen=${originalPdfData.length}, pages=${pages.length}, reqId=${requestId}, dpi=${renderDpi}`);

    try {
        const worker = createOcrWorker();
        const webContentsId = event.sender.id;

        // Track the job
        activeJobs.set(requestId, {
            jobId: requestId,
            worker,
            webContentsId,
            completed: false,
            terminatedByUs: false,
        });

        // Handle messages from worker
        worker.on('message', (message) => {
            handleWorkerMessage(requestId, webContentsId, message);
        });

        // Handle worker errors - mark as completed to prevent exit handler from also sending failure
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

        // Handle worker exit - only send failure if job wasn't already completed
        // Worker.terminate() causes exit code 1, so we need to check if we terminated it intentionally
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

        // Start the OCR job in the worker
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

        // Return immediately - results will be sent via 'ocr:complete' event
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

function handleOcrGetLanguages() {
    return AVAILABLE_LANGUAGES;
}

async function handleOcrValidateTools() {
    return validateOcrTools();
}

function handlePreprocessingValidate() {
    const validation = validatePreprocessingSetup();
    return {
        valid: validation.valid,
        available: validation.available,
        missing: validation.missing,
    };
}

async function handlePreprocessPage(
    _event: IpcMainInvokeEvent,
    imageData: number[],
    usePreprocessing: boolean,
) {
    try {
        if (!usePreprocessing) {
            return {
                success: true,
                imageData,
                message: 'Preprocessing disabled',
            };
        }

        const validation = validatePreprocessingSetup();
        if (!validation.valid) {
            return {
                success: false,
                imageData,
                error: 'Preprocessing requires unpaper binary. Build with: ./scripts/bundle-leptonica-unpaper-macos.sh',
            };
        }

        // Write image to temp file using UUID to prevent collisions under concurrency
        const tempDir = app.getPath('temp');
        const uuid = randomUUID();
        const inputPath = join(tempDir, `preprocess-input-${uuid}.png`);
        const outputPath = join(tempDir, `preprocess-output-${uuid}.png`);

        try {
            const imageBuffer = Buffer.from(imageData);
            await writeFile(inputPath, imageBuffer);

            log.debug(`Preprocessing image: ${inputPath}`);
            const result = await preprocessPageForOcr(inputPath, outputPath);

            if (!result.success) {
                log.debug(`Preprocessing failed: ${result.error}`);
                return {
                    success: false,
                    imageData,
                    error: result.error || 'Preprocessing failed',
                };
            }

            // Read preprocessed image
            const preprocessedBuffer = await readFile(outputPath);
            const preprocessedData = Array.from(preprocessedBuffer);

            log.debug(`Preprocessing successful: ${inputPath} -> ${outputPath}`);

            return {
                success: true,
                imageData: preprocessedData,
                message: 'Preprocessing complete',
            };
        } finally {
            try {
                await unlink(inputPath);
            } catch (cleanupErr) {
                log.warn(`Cleanup warning (inputPath): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
            }
            try {
                await unlink(outputPath);
            } catch (cleanupErr) {
                log.warn(`Cleanup warning (outputPath): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
            }
        }
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Preprocessing error: ${errMsg}`);
        return {
            success: false,
            imageData,
            error: errMsg,
        };
    }
}

export function registerOcrHandlers() {
    ipcMain.handle('ocr:recognize', handleOcrRecognize);
    ipcMain.handle('ocr:recognizeBatch', handleOcrRecognizeBatch);
    // Use async worker-based handler that returns immediately
    ipcMain.handle('ocr:createSearchablePdf', handleOcrCreateSearchablePdfAsync);
    ipcMain.handle('ocr:getLanguages', handleOcrGetLanguages);
    ipcMain.handle('ocr:validateTools', handleOcrValidateTools);
    ipcMain.handle('preprocessing:validate', handlePreprocessingValidate);
    ipcMain.handle('preprocessing:preprocessPage', handlePreprocessPage);
}
