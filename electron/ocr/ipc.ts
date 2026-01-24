import type { IpcMainInvokeEvent } from 'electron';
import {
    BrowserWindow,
    ipcMain,
    app,
} from 'electron';
import {
    readFile,
    stat,
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
import {
    runOcr,
    runOcrWithBoundingBoxes,
} from '@electron/ocr/tesseract';
import { createSearchablePdfWithSpaces } from '@electron/ocr/pdf-text-layer';
import { getOcrPaths } from '@electron/ocr/paths';
import type {
    IOcrLanguage,
    IOcrWord,
} from '@app/types/shared';
import {
    preprocessPageForOcr,
    validatePreprocessingSetup,
} from '@electron/ocr/preprocessing';
import { saveOcrIndex } from '@electron/search/ipc';
import { runCommand } from '@electron/utils/exec';
import { createLogger } from '@electron/utils/logger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = createLogger('ocr-ipc');

// Worker thread management for non-blocking OCR
interface IOcrJob {
    jobId: string;
    worker: Worker;
    webContentsId: number;
}

const activeJobs = new Map<string, IOcrJob>();

function getWorkerPath(): string {
    // Worker is compiled to dist-electron alongside main.js
    // __dirname resolves to dist-electron (where main.js is)
    return join(__dirname, 'ocr-worker.js');
}

function createOcrWorker(): Worker {
    const { binary, tessdata } = getOcrPaths();
    const workerPath = getWorkerPath();

    log.debug(`Creating OCR worker: ${workerPath}`);
    log.debug(`Tesseract binary: ${binary}, tessdata: ${tessdata}`);

    return new Worker(workerPath, {
        workerData: {
            tesseractBinary: binary,
            tessdataPath: tessdata,
            tempDir: app.getPath('temp'),
        },
    });
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
        window?.webContents.send('ocr:progress', message.progress);
        return;
    }

    if (message.type === 'complete' && message.result) {
        // Forward completion to renderer
        window?.webContents.send('ocr:complete', {
            requestId: jobId,
            ...message.result,
        });

        // Clean up the job
        const job = activeJobs.get(jobId);
        if (job) {
            job.worker.terminate();
            activeJobs.delete(jobId);
        }
        return;
    }
}

const PNG_SIGNATURE = Buffer.from([
    0x89,
    0x50,
    0x4E,
    0x47,
    0x0D,
    0x0A,
    0x1A,
    0x0A,
]);

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

function getPngDimensions(imageBuffer: Buffer): {
    width: number;
    height: number;
} | null {
    // PNG header is always 8 bytes, followed by IHDR (length+type+data...).
    // IHDR width/height are big-endian uint32 at byte offsets 16 and 20.
    if (imageBuffer.length < 24) {
        return null;
    }

    if (!imageBuffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return null;
    }

    const width = imageBuffer.readUInt32BE(16);
    const height = imageBuffer.readUInt32BE(20);
    if (width <= 0 || height <= 0) {
        return null;
    }

    return {
        width,
        height,
    };
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

interface IOcrPageWithWords {
    pageNumber: number;
    words: IOcrWord[];
    text: string;
    imageWidth: number;
    imageHeight: number;
    imageBuffer?: Buffer;
    languages?: string[];
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
    window?.webContents.send('ocr:progress', {
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
            window?.webContents.send('ocr:progress', {
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
): { started: boolean; jobId: string; error?: string } {
    log.debug(`handleOcrCreateSearchablePdfAsync called: pdfLen=${originalPdfData.length}, pages=${pages.length}, reqId=${requestId}`);

    try {
        const worker = createOcrWorker();
        const webContentsId = event.sender.id;

        // Track the job
        activeJobs.set(requestId, {
            jobId: requestId,
            worker,
            webContentsId,
        });

        // Handle messages from worker
        worker.on('message', (message) => {
            handleWorkerMessage(requestId, webContentsId, message);
        });

        // Handle worker errors
        worker.on('error', (err: Error) => {
            log.debug(`Worker error for job ${requestId}: ${err.message}`);
            const window = BrowserWindow.getAllWindows().find(w => w.webContents.id === webContentsId);
            window?.webContents.send('ocr:complete', {
                requestId,
                success: false,
                pdfData: null,
                errors: [`Worker error: ${err.message}`],
            });
            activeJobs.delete(requestId);
        });

        // Handle worker exit
        worker.on('exit', (code) => {
            if (code !== 0) {
                log.debug(`Worker exited with code ${code} for job ${requestId}`);
                const window = BrowserWindow.getAllWindows().find(w => w.webContents.id === webContentsId);
                window?.webContents.send('ocr:complete', {
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
                error: `Preprocessing tools not available: ${validation.missing.join(', ')}`,
            };
        }

        // Write image to temp file
        const tempDir = app.getPath('temp');
        const inputPath = join(tempDir, `preprocess-input-${Date.now()}.png`);
        const outputPath = join(tempDir, `preprocess-output-${Date.now()}.png`);

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
    ipcMain.handle('preprocessing:validate', handlePreprocessingValidate);
    ipcMain.handle('preprocessing:preprocessPage', handlePreprocessPage);
}
