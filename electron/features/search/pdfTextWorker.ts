import {
    parentPort,
    workerData,
} from 'worker_threads';
import { isRecord } from '@contracts/runtimeGuards';
import { getErrorMessage } from '@electron/utils/error';
import { createWorkerTaskErrorFrame } from '@electron/utils/workerTask';
import { extractPdfjsPageTexts } from '@electron/features/search/pdfjsPageTexts';

function optionalPage(value: unknown) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

async function run() {
    if (!parentPort || !isRecord(workerData) || typeof workerData.pdfPath !== 'string') {
        throw new Error('Invalid PDF text worker payload');
    }
    const port = parentPort;
    const firstPage = optionalPage(workerData.firstPage);
    const lastPage = optionalPage(workerData.lastPage);
    try {
        await extractPdfjsPageTexts(workerData.pdfPath, {
            ...(firstPage === undefined ? {} : {firstPage}),
            ...(lastPage === undefined ? {} : {lastPage}),
        }, page => port.postMessage({
            type: 'page',
            page,
        }));
        port.postMessage({
            type: 'result',
            ok: true,
        });
    } catch (error) {
        port.postMessage({
            type: 'result',
            ok: false,
            error: getErrorMessage(error),
            errorFrame: createWorkerTaskErrorFrame(error, {source: 'search:pdf-text-worker'}),
        });
    }
}

await run();
