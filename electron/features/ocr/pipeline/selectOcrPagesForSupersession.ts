import type {TOcrTextSupersessionPolicy} from '@contracts/electronApiOcr';
import type {
    IOcrPdfPageRequest,
    TWorkerLog,
} from '@electron/features/ocr/pipeline/types';
import { iterateOcrPageRanges } from '@ocr-core/ocrPageSelection';
import {
    OCR_TEXT_PROBE_UNAVAILABLE,
    selectOcrPagesByExistingText,
} from '@ocr-core/selectOcrPagesByExistingText';
import {inspectPdfPageTextVisibility} from '@electron/pdf/inspectPdfPageTextVisibility';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {
    groupContiguousPages,
    splitPdfTextOutput,
} from '@electron/pdf/pdfTextPageBatching';
import { isAbortError } from '@electron/utils/abort';
import { getErrorMessage } from '@electron/utils/error';

const TEXT_PROBE_TIMEOUT_MS = 2 * 60 * 1000;
const TEXT_PROBE_MAX_STDOUT_BYTES = 64 * 1024 * 1024;

async function extractPageTextForClassification(input: {
    sourcePdfPath: string;
    pageNumbers: readonly number[];
    pdftotextBinary: string | undefined;
    log: TWorkerLog;
    signal: AbortSignal;
}) {
    const texts = new Map<number, string>();
    const warnings: string[] = [];
    // Probe failures fail closed so OCR cannot be appended beside text that
    // the worker was unable to inspect.
    const failClosed = (firstPage: number, lastPage: number, reason: string) => {
        for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
            texts.set(pageNumber, OCR_TEXT_PROBE_UNAVAILABLE);
        }
        const message = `Existing-text probe failed for pages ${firstPage}-${lastPage}; they were left untouched: ${reason}`;
        input.log('warn', message);
        warnings.push(message);
    };

    const orderedPages = Array.from(new Set(input.pageNumbers)).sort((left, right) => left - right);
    for (const range of groupContiguousPages(orderedPages)) {
        const rangeLength = range.lastPage - range.firstPage + 1;
        for (const pageBatch of iterateOcrPageRanges(rangeLength)) {
            const firstPage = range.firstPage + pageBatch.firstPage - 1;
            const lastPage = range.firstPage + pageBatch.lastPage - 1;
            if (input.pdftotextBinary === undefined) {
                failClosed(firstPage, lastPage, 'pdftotext is unavailable');
                continue;
            }

            const batchLength = lastPage - firstPage + 1;
            try {
                const probe = await runNativeToolCommand(input.pdftotextBinary, [
                    '-f',
                    String(firstPage),
                    '-l',
                    String(lastPage),
                    input.sourcePdfPath,
                    '-',
                ], {
                    commandLabel: 'pdftotext(ocr-supersession-probe)',
                    timeoutMs: TEXT_PROBE_TIMEOUT_MS,
                    maxStdoutBytes: TEXT_PROBE_MAX_STDOUT_BYTES,
                    rejectOnStdoutTruncation: true,
                    signal: input.signal,
                });
                const rangeTexts = splitPdfTextOutput(probe.stdout, batchLength);
                for (let index = 0; index < batchLength; index += 1) {
                    texts.set(firstPage + index, rangeTexts[index] ?? '');
                }
            } catch (err) {
                if (isAbortError(err)) {
                    throw err;
                }
                failClosed(firstPage, lastPage, getErrorMessage(err));
            }
        }
    }
    return {
        texts,
        warnings,
    };
}

export async function selectOcrPagesForSupersession(input: {
    sourcePdfPath: string;
    pages: readonly IOcrPdfPageRequest[];
    supersessionPolicy: TOcrTextSupersessionPolicy;
    pdftotextBinary?: string;
    pdfPageOpsBinary?: string;
    qpdfBinary?: string;
    tempDir: string;
    log: TWorkerLog;
    signal: AbortSignal;
}) {
    const warnings: string[] = [];
    const requestedPageNumbers = input.pages.map(page => page.pageNumber);
    const visibilityAnalysis = await inspectPdfPageTextVisibility({
        pdfPath: input.sourcePdfPath,
        pageNumbers: requestedPageNumbers,
        pdfPageOpsBinary: input.pdfPageOpsBinary,
        qpdfBinary: input.qpdfBinary,
        tempDir: input.tempDir,
        signal: input.signal,
    });
    if (visibilityAnalysis.status === 'degraded') {
        input.log('warn', visibilityAnalysis.message);
        warnings.push(visibilityAnalysis.message);
    }
    const textProbe = await extractPageTextForClassification({
        sourcePdfPath: input.sourcePdfPath,
        pageNumbers: requestedPageNumbers,
        pdftotextBinary: input.pdftotextBinary,
        log: input.log,
        signal: input.signal,
    });
    warnings.push(...textProbe.warnings);

    const selection = selectOcrPagesByExistingText({
        pages: input.pages,
        supersessionPolicy: input.supersessionPolicy,
        visibility: visibilityAnalysis.visibility,
        texts: textProbe.texts,
        log: input.log,
    });
    return {
        pages: selection.pages,
        warnings: [
            ...warnings,
            ...selection.warnings,
        ],
        diagnostics: selection.diagnostics,
    };
}
