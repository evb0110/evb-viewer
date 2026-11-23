import {
    parentPort,
    workerData,
} from 'worker_threads';
import { buildOptimizedPdf } from '@electron/features/djvu/main/buildOptimizedPdf';
import { embedBookmarksIntoPdfFile } from '@electron/features/djvu/main/embedBookmarksIntoPdfFile';
import type {
    TDjvuPdfWorkerMessage,
    TDjvuPdfWorkerTask,
} from '@electron/features/djvu/main/pdfWorkerProtocol';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import {
    isFiniteNumber,
    isRecord,
    isStringArray,
} from '@contracts/runtimeGuards';
import { createWorkerTaskErrorFrame } from '@electron/utils/workerTask';
import { getErrorMessage } from '@electron/utils/error';

interface IDjvuPdfWorkerCancelMessage {type: 'cancel';}


function isPdfBookmarkEntry(value: unknown): value is IPdfBookmarkEntry {
    return isRecord(value)
        && typeof value.title === 'string'
        && (typeof value.pageIndex === 'number' || value.pageIndex === null)
        && (
            value.pageYRatio === undefined
            || value.pageYRatio === null
            || (
                isFiniteNumber(value.pageYRatio)
                && value.pageYRatio >= 0
                && value.pageYRatio <= 1
            )
        )
        && (typeof value.namedDest === 'string' || value.namedDest === null)
        && typeof value.bold === 'boolean'
        && typeof value.italic === 'boolean'
        && (typeof value.color === 'string' || value.color === null)
        && Array.isArray(value.items)
        && value.items.every(isPdfBookmarkEntry);
}

function getTask(): TDjvuPdfWorkerTask {
    const task: unknown = workerData;
    if (!isRecord(task) || typeof task.type !== 'string') {
        throw new Error('Invalid DjVu PDF worker payload');
    }
    switch (task.type) {
        case 'buildPdf':
            if (!isStringArray(task.imagePaths) || !isFiniteNumber(task.dpi)) {
                throw new Error('Invalid DjVu PDF build task payload');
            }
            return {
                type: 'buildPdf',
                imagePaths: task.imagePaths,
                dpi: task.dpi,
            };
        case 'estimatePdfSize':
            if (typeof task.imagePath !== 'string' || !isFiniteNumber(task.dpi)) {
                throw new Error('Invalid DjVu PDF estimate task payload');
            }
            return {
                type: 'estimatePdfSize',
                imagePath: task.imagePath,
                dpi: task.dpi,
                ...(isFiniteNumber(task.combineThreads) && task.combineThreads > 0
                    ? { combineThreads: Math.floor(task.combineThreads) }
                    : {}),
            };
        case 'embedBookmarksInFile':
            if (
                typeof task.inputPdfPath !== 'string'
                || typeof task.outputPdfPath !== 'string'
                || !Array.isArray(task.bookmarks)
                || !task.bookmarks.every(isPdfBookmarkEntry)
            ) {
                throw new Error('Invalid DjVu PDF bookmark task payload');
            }
            return {
                type: 'embedBookmarksInFile',
                inputPdfPath: task.inputPdfPath,
                outputPdfPath: task.outputPdfPath,
                bookmarks: task.bookmarks,
            };
        default:
            throw new Error(`Unsupported DjVu PDF worker task: ${task.type}`);
    }
}

function toTransferableBuffer(data: Uint8Array) {
    if (
        data.buffer instanceof ArrayBuffer
        && data.byteOffset === 0
        && data.byteLength === data.buffer.byteLength
    ) {
        return data.buffer;
    }

    const clone = new Uint8Array(data.byteLength);
    clone.set(data);
    return clone.buffer;
}

async function runTask(
    task: Exclude<TDjvuPdfWorkerTask, {type: 'embedBookmarksInFile';}>,
    signal: AbortSignal,
) {
    switch (task.type) {
        case 'buildPdf':
            return buildOptimizedPdf(task.imagePaths, task.dpi, (page, total) => {
                parentPort?.postMessage({
                    type: 'progress',
                    phase: 'buildPdf',
                    page,
                    total,
                } satisfies TDjvuPdfWorkerMessage);
            }, {signal});
        case 'estimatePdfSize': {
            const pdfBytes = await buildOptimizedPdf([task.imagePath], task.dpi, undefined, {
                signal,
                ...(task.combineThreads === undefined ? {} : { combineThreads: task.combineThreads }),
            });
            return pdfBytes.length;
        }
    }
}

function isCancelMessage(message: unknown): message is IDjvuPdfWorkerCancelMessage {
    return Boolean(message)
        && typeof message === 'object'
        && (message as {type?: unknown}).type === 'cancel';
}

async function run() {
    if (!parentPort) {
        throw new Error('DjVu PDF worker started without a parentPort');
    }

    const abortController = new AbortController();
    parentPort.on('message', (message: unknown) => {
        if (isCancelMessage(message)) {
            abortController.abort(new DOMException('DjVu PDF worker canceled', 'AbortError'));
        }
    });

    try {
        const task = getTask();
        const result = task.type === 'embedBookmarksInFile'
            ? await embedBookmarksIntoPdfFile(
                task.inputPdfPath,
                task.outputPdfPath,
                task.bookmarks,
                abortController.signal,
            )
            : await runTask(task, abortController.signal);
        if (typeof result === 'number') {
            parentPort.postMessage({
                type: 'result',
                ok: true,
                data: result,
            } satisfies TDjvuPdfWorkerMessage);
            return;
        }

        const transferableBuffer = toTransferableBuffer(result);
        parentPort.postMessage({
            type: 'result',
            ok: true,
            data: transferableBuffer,
        } satisfies TDjvuPdfWorkerMessage, [transferableBuffer]);
    } catch (error) {
        parentPort.postMessage({
            type: 'result',
            ok: false,
            error: getErrorMessage(error),
            errorFrame: createWorkerTaskErrorFrame(error, {source: 'djvu:pdf-worker'}),
        } satisfies TDjvuPdfWorkerMessage);
    }
}

await run();
