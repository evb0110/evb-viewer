import {
    parentPort,
    workerData,
} from 'worker_threads';
import {
    createCombinedPdf as createCombinedPdfShared,
    type ICreateCombinedPdfProgress,
} from '@electron/image/pdfCombineShared';
import { getErrorMessage } from '@electron/utils/error';

interface ICombineWorkerData {inputPaths?: unknown;}
interface ICombineWorkerProgressPayload extends ICreateCombinedPdfProgress {type: 'progress';}

interface ICombineWorkerResultPayload {
    type: 'result';
    ok: boolean;
    error?: string;
    data?: ArrayBuffer;
}

async function createCombinedPdf(
    inputPaths: string[],
    onProgress?: (progress: ICreateCombinedPdfProgress) => void,
) {
    return createCombinedPdfShared(inputPaths, {
        ...(onProgress ? { onProgress } : {}),
        unsupportedFileError: (sourcePath) => `Unsupported file type for worker combine: ${sourcePath}`,
    });
}

function resolveWorkerInputPaths(): string[] {
    const currentWorkerData = workerData as ICombineWorkerData | undefined;
    if (!Array.isArray(currentWorkerData?.inputPaths)) {
        return [];
    }
    const inputPaths: string[] = [];
    for (const path of currentWorkerData.inputPaths) {
        if (typeof path === 'string') {
            inputPaths.push(path);
        }
    }
    return inputPaths;
}

function toTransferableBuffer(data: Uint8Array) {
    if (
        data.buffer instanceof ArrayBuffer
        && data.byteOffset === 0
        && data.byteLength === data.buffer.byteLength
    ) {
        return data.buffer;
    }

    const cloned = new Uint8Array(data.byteLength);
    cloned.set(data);
    return cloned.buffer;
}

async function runCombineWorker() {
    if (!parentPort) {
        throw new Error('Image combine worker started without a parentPort');
    }
    const port = parentPort;

    try {
        const inputPaths = resolveWorkerInputPaths();
        const output = await createCombinedPdf(inputPaths, (progress) => {
            const progressPayload: ICombineWorkerProgressPayload = {
                type: 'progress',
                ...progress,
            };
            port.postMessage(progressPayload);
        });
        const transferablePdfBuffer = toTransferableBuffer(output);
        const payload: ICombineWorkerResultPayload = {
            type: 'result',
            ok: true,
            data: transferablePdfBuffer,
        };
        port.postMessage(payload, [transferablePdfBuffer]);
    } catch (error) {
        const payload: ICombineWorkerResultPayload = {
            type: 'result',
            ok: false,
            error: getErrorMessage(error),
        };
        port.postMessage(payload);
    }
}

await runCombineWorker();
