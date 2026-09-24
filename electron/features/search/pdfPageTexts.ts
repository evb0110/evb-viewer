import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { isRecord } from '@contracts/runtimeGuards';
import { groupContiguousPages } from '@electron/pdf/pdfTextPageBatching';
import {
    resolveUnpackedWorkerPath,
    runResultWorkerTask,
} from '@electron/utils/workerTask';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import type { IPageText } from '@electron/features/search/pageText';
import type { IPdfPageRange } from '@electron/features/search/pdfjsPageTexts';
import { streamItems } from '@electron/features/search/streamItems';

const PDF_TEXT_WORKER_FILENAME = WORKER_BUNDLES_BY_ID['pdf-text'].fileName;

function decodePageMessage(message: unknown): IPageText | null {
    if (!isRecord(message) || message.type !== 'page' || !isRecord(message.page)) {
        return null;
    }
    const {
        pageNumber,
        text,
    } = message.page;
    return typeof pageNumber === 'number' && typeof text === 'string'
        ? {
            pageNumber,
            text,
        }
        : null;
}

/**
 * Streams the PDF text layer page by page, in reading order. PDF.js reads it
 * in a worker thread with its bundled CMaps and standard fonts, so text in
 * non-embedded fonts reads the same on every platform as in the viewer.
 */
export function streamPdfPageTexts(
    pdfPath: string,
    options: IPdfPageRange & {signal?: AbortSignal | undefined} = {},
): AsyncGenerator<IPageText> {
    return streamItems<IPageText>((emit, signal) => runResultWorkerTask({
        workerPath: resolveUnpackedWorkerPath(dirname(fileURLToPath(import.meta.url)), PDF_TEXT_WORKER_FILENAME),
        workerData: {
            pdfPath,
            firstPage: options.firstPage,
            lastPage: options.lastPage,
        },
        invalidPayloadMessage: 'PDF text worker returned an invalid payload',
        createWorkerExitError: code => new Error(`PDF text worker exited with code ${code}`),
        onProgressMessage(message) {
            const page = decodePageMessage(message);
            if (page === null) {
                return false;
            }
            emit(page);
            return true;
        },
        signal,
    }), options.signal);
}

/** Reads the text of the requested pages, one pass per contiguous range. */
export async function readPdfPageTexts(
    pdfPath: string,
    pageNumbers: readonly number[],
    signal?: AbortSignal,
): Promise<IPageText[]> {
    const texts: IPageText[] = [];
    for (const range of groupContiguousPages([...pageNumbers])) {
        for await (const page of streamPdfPageTexts(pdfPath, {
            ...range,
            signal,
        })) {
            texts.push(page);
        }
    }
    return texts;
}
