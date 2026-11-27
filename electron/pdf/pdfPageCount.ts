import {runDesktopQpdfWasm} from '@electron/native-tools/qpdfWasmWorkerClient';
import type {TTerminationProofSink} from '@electron/resources/jobBroker';
import {
    getQpdfPageCountArgs,
    parseQpdfPageCount,
    QPDF_SUCCESS_EXIT_CODES,
} from '@pdf-core/qpdfCommands';

export const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
export const QPDF_OUTPUT_SUCCESS_EXIT_CODES = QPDF_SUCCESS_EXIT_CODES;

export interface IPdfPageCountOptions {
    signal?: AbortSignal;
    cancelGroup?: string;
    onTerminationProof?: TTerminationProofSink;
}

export async function getPdfPageCount(pdfPath: string, options: IPdfPageCountOptions = {}) {
    const result = await runDesktopQpdfWasm(getQpdfPageCountArgs(pdfPath), {
        timeoutMs: QPDF_TIMEOUT_MS,
        allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
        commandLabel: 'qpdf(page-count)',
        ...(options.signal ? {signal: options.signal} : {}),
        ...(options.cancelGroup ? {cancelGroup: options.cancelGroup} : {}),
        ...(options.onTerminationProof ? {onTerminationProof: options.onTerminationProof} : {}),
    });
    const pageCount = parseQpdfPageCount(result.stdout);
    if (pageCount === null) {
        throw new Error('Failed to read PDF page count');
    }

    return pageCount;
}
