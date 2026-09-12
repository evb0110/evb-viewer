import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type {
    IDjvuPdfWorkerProgressMessage,
    TDjvuPdfWorkerTask,
} from '@electron/features/djvu/main/pdfWorkerProtocol';
import {
    isFiniteWorkerMessageNumber,
    isWorkerMessageRecord,
} from '@electron/utils/workerMessage';
import {
    type IStreamingWorkerTaskHandle,
    resolveUnpackedWorkerPath,
    startStreamingWorkerTask,
} from '@electron/utils/workerTask';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DJVU_PDF_WORKER_FILENAME = WORKER_BUNDLES_BY_ID['djvu-pdf'].fileName;
const DJVU_PDF_WORKER_TIMEOUT_MS = 2 * 60 * 1000;
const DJVU_PDF_WORKER_RESOURCE_LIMITS = {
    maxOldGenerationSizeMb: 256,
    maxYoungGenerationSizeMb: 64,
    stackSizeMb: 4,
};

export class DjvuPdfWorkerStartupError extends Error {
    readonly subsystem = 'djvu';

    constructor(message: string) {
        super(message);
        this.name = 'DjvuPdfWorkerStartupError';
    }
}

function parseProgressMessage(message: unknown): IDjvuPdfWorkerProgressMessage | null {
    if (!isWorkerMessageRecord(message) || message.type !== 'progress') {
        return null;
    }
    if (
        message.phase !== 'buildPdf'
        || !isFiniteWorkerMessageNumber(message.page)
        || !isFiniteWorkerMessageNumber(message.total)
    ) {
        return null;
    }
    return {
        type: 'progress',
        phase: 'buildPdf',
        page: message.page,
        total: message.total,
    };
}

function isPdfWorkerResultData(value: unknown): value is number | Uint8Array | ArrayBuffer {
    return typeof value === 'number'
        || value instanceof Uint8Array
        || value instanceof ArrayBuffer;
}

function createDjvuPdfWorkerTask<T>(
    task: TDjvuPdfWorkerTask,
    options: {
        onProgress?: (message: IDjvuPdfWorkerProgressMessage) => void;
        decodeResult: (data: unknown) => T | null;
        signal?: AbortSignal;
    },
): IStreamingWorkerTaskHandle<T> {
    return startStreamingWorkerTask<T>({
        workerPath: resolveUnpackedWorkerPath(__dirname, DJVU_PDF_WORKER_FILENAME),
        workerData: task,
        invalidPayloadMessage: 'DjVu PDF worker returned an invalid payload',
        invalidResultMessage: 'DjVu PDF worker returned an invalid result',
        createStartupError: (message) => new DjvuPdfWorkerStartupError(`DjVu PDF worker startup failed: ${message}`),
        createWorkerExitError: (code) => new Error(`DjVu PDF worker exited with code ${code}`),
        timeoutMs: DJVU_PDF_WORKER_TIMEOUT_MS,
        resourceLimits: DJVU_PDF_WORKER_RESOURCE_LIMITS,
        ...(options.signal ? { signal: options.signal } : {}),
        createCancelMessage: () => ({ type: 'cancel' }),
        cooperativeCancelDelayMs: 5_000,
        onProgressMessage: (payload) => {
            const progress = parseProgressMessage(payload);
            if (!progress) {
                return false;
            }
            options.onProgress?.(progress);
            return true;
        },
        decodeResult: (data) => {
            if (!isPdfWorkerResultData(data)) {
                return null;
            }
            return options.decodeResult(data);
        },
    });
}

function normalizeWorkerTaskOptions(options: { signal?: AbortSignal } | AbortSignal = {}) {
    return options instanceof AbortSignal ? {signal: options} : options;
}

export function createDjvuPdfEstimateTask(
    imagePath: string,
    dpi: number,
    options: { signal?: AbortSignal } = {},
): IStreamingWorkerTaskHandle<number> {
    return createDjvuPdfWorkerTask({
        type: 'estimatePdfSize',
        imagePath,
        dpi,
    }, {
        ...(options.signal ? { signal: options.signal } : {}),
        decodeResult: (data) => (typeof data === 'number' && Number.isFinite(data) ? data : null),
    });
}

export function createDjvuPdfBookmarkTask(
    inputPdfPath: string,
    outputPdfPath: string,
    bookmarks: IPdfBookmarkEntry[],
    options: { signal?: AbortSignal } | AbortSignal = {},
): IStreamingWorkerTaskHandle<void> {
    const normalizedOptions = normalizeWorkerTaskOptions(options);
    return createDjvuPdfWorkerTask({
        type: 'embedBookmarksInFile',
        inputPdfPath,
        outputPdfPath,
        bookmarks,
    }, {
        ...(normalizedOptions.signal ? { signal: normalizedOptions.signal } : {}),
        decodeResult: (data) => (typeof data === 'number' && Number.isFinite(data) ? undefined : null),
    });
}
