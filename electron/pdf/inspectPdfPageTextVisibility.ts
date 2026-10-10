import {randomUUID} from 'node:crypto';
import {
    rm,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {isAbortError} from '@electron/utils/abort';
import {getErrorMessage} from '@electron/utils/error';
import {
    decodePdfOcrTextVisibilityReport,
    PDF_OCR_TEXT_VISIBILITY_REPORT_MAX_BYTES,
    type IPdfOcrPageTextVisibility,
} from '@contracts/pdfOcrTextVisibility';

const OCR_TEXT_VISIBILITY_TIMEOUT_MS = 2 * 60 * 1000;
// A request batch holds at most a few thousand pages of fixed-size records.
const OCR_TEXT_VISIBILITY_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
// With the layers' text, a record carries the page's recognized text too.
const OCR_TEXT_VISIBILITY_WITH_TEXT_MAX_STDOUT_BYTES = PDF_OCR_TEXT_VISIBILITY_REPORT_MAX_BYTES;

export type TOcrPdfTextVisibilityAnalysis =
    | {
        status: 'available';
        visibility: Map<number, IPdfOcrPageTextVisibility>;
    }
    | {
        status: 'degraded';
        reason: 'native-tool-unavailable' | 'native-tool-failed';
        message: string;
        visibility: Map<number, IPdfOcrPageTextVisibility>;
    };

/**
 * Reads the existing text of the requested pages with the scan the OCR writer
 * replaces text through, in one pass over the document.
 */
export async function inspectPdfPageTextVisibility(input: {
    pdfPath: string;
    pageNumbers: readonly number[];
    pdfPageOpsBinary?: string | undefined;
    qpdfBinary?: string | undefined;
    tempDir: string;
    signal?: AbortSignal;
    withEvbOcrText?: boolean;
}): Promise<TOcrPdfTextVisibilityAnalysis> {
    if (input.pdfPageOpsBinary === undefined) {
        return {
            status: 'degraded',
            reason: 'native-tool-unavailable',
            message: 'evb-pdf-page-ops is unavailable; existing OCR layers could not be inspected',
            visibility: new Map(),
        };
    }
    if (input.pageNumbers.length === 0) {
        return {
            status: 'available',
            visibility: new Map(),
        };
    }
    const pagesPath = join(input.tempDir, `ocr-text-visibility-${randomUUID()}.txt`);
    try {
        await writeFile(pagesPath, `${[...new Set(input.pageNumbers)].join('\n')}\n`);
        const result = await runNativeToolCommand(input.pdfPageOpsBinary, [
            'ocr-text-visibility',
            '--input',
            input.pdfPath,
            '--pages-file',
            pagesPath,
            ...(input.qpdfBinary === undefined ? [] : [
                '--qpdf',
                input.qpdfBinary,
            ]),
            ...(input.withEvbOcrText === true ? ['--with-evb-ocr-text'] : []),
        ], {
            commandLabel: 'evb-pdf-page-ops(ocr-text-visibility)',
            timeoutMs: OCR_TEXT_VISIBILITY_TIMEOUT_MS,
            maxStdoutBytes: input.withEvbOcrText === true
                ? OCR_TEXT_VISIBILITY_WITH_TEXT_MAX_STDOUT_BYTES
                : OCR_TEXT_VISIBILITY_MAX_STDOUT_BYTES,
            rejectOnStdoutTruncation: true,
            ...(input.signal ? {signal: input.signal} : {}),
        });
        const report = decodePdfOcrTextVisibilityReport(JSON.parse(result.stdout));
        return {
            status: 'available',
            visibility: new Map(report.pages.map(page => [
                page.pageNumber,
                page,
            ])),
        };
    } catch (error) {
        if (isAbortError(error) || input.signal?.aborted) {
            throw error;
        }
        return {
            status: 'degraded',
            reason: 'native-tool-failed',
            message: `Existing OCR layers could not be inspected: ${getErrorMessage(error)}`,
            visibility: new Map(),
        };
    } finally {
        await rm(pagesPath, {force: true}).catch(() => undefined);
    }
}
