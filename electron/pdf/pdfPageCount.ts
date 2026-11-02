import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
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
}

export async function getPdfPageCount(pdfPath: string, options: IPdfPageCountOptions = {}) {
    const result = await runNativeToolCommand(getPdfNativeToolPaths().qpdf, getQpdfPageCountArgs(pdfPath), {
        timeoutMs: QPDF_TIMEOUT_MS,
        allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
        commandLabel: 'qpdf(page-count)',
        ...(options.signal ? {signal: options.signal} : {}),
        ...(options.cancelGroup ? {cancelGroup: options.cancelGroup} : {}),
    });
    const pageCount = parseQpdfPageCount(result.stdout);
    if (pageCount === null) {
        throw new Error('Failed to read PDF page count');
    }

    return pageCount;
}
