import type {
    IOcrDiagnostic,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';
import type {
    IOcrPdfPageRequest,
    TWorkerLog,
} from '@electron/features/ocr/pipeline/types';
import { iterateOcrPageRanges } from '@electron/features/ocr/contracts';
import {
    classifyOcrPageText,
    inspectPdfPageTextVisibility,
    shouldOcrClassifiedPage,
} from '@electron/features/ocr/pipeline/pageTextClassifier';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {
    groupContiguousPages,
    splitPdfTextOutput,
} from '@electron/pdf/pdfTextPageBatching';
import { isAbortError } from '@electron/utils/abort';
import { getErrorMessage } from '@electron/utils/error';
import { requirePageNumber } from '@contracts/pageNumbers';

const TEXT_PROBE_TIMEOUT_MS = 2 * 60 * 1000;
const TEXT_PROBE_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const TEXT_PROBE_UNAVAILABLE = '[text-probe-unavailable]';

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
            texts.set(pageNumber, TEXT_PROBE_UNAVAILABLE);
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
    qpdfBinary?: string;
    log: TWorkerLog;
    signal: AbortSignal;
}) {
    const pages: IOcrPdfPageRequest[] = [];
    const warnings: string[] = [];
    const diagnostics: IOcrDiagnostic[] = [];
    const requestedPageNumbers = input.pages.map(page => page.pageNumber);
    const visibilityAnalysis = await inspectPdfPageTextVisibility(
        input.sourcePdfPath,
        requestedPageNumbers,
        input.qpdfBinary,
        input.signal,
    );
    if (visibilityAnalysis.status === 'degraded') {
        input.log('warn', visibilityAnalysis.message);
        warnings.push(visibilityAnalysis.message);
    }
    const visibility = visibilityAnalysis.visibility;
    const textProbe = await extractPageTextForClassification({
        sourcePdfPath: input.sourcePdfPath,
        pageNumbers: requestedPageNumbers,
        pdftotextBinary: input.pdftotextBinary,
        log: input.log,
        signal: input.signal,
    });
    warnings.push(...textProbe.warnings);

    for (const page of input.pages) {
        const pageVisibility = visibility.get(page.pageNumber);
        const extractedText = textProbe.texts.get(page.pageNumber) ?? TEXT_PROBE_UNAVAILABLE;
        if (extractedText === TEXT_PROBE_UNAVAILABLE) {
            const canReplaceWithoutTextProbe = input.supersessionPolicy === 'replace-all'
                || input.supersessionPolicy === 'replace-evb' && pageVisibility?.hasEvbOcrLayer === true;
            if (canReplaceWithoutTextProbe) {
                const message = `Scheduled page ${page.pageNumber}: existing-text probe was unavailable under ${input.supersessionPolicy} policy`;
                input.log('warn', message);
                warnings.push(message);
                pages.push(page);
                continue;
            }
            const message = `Skipped page ${page.pageNumber}: existing-text probe was unavailable under ${input.supersessionPolicy} policy`;
            warnings.push(message);
            diagnostics.push({
                code: 'OCR_EXISTING_TEXT_SKIPPED',
                severity: 'warning',
                pageNumber: requirePageNumber(page.pageNumber),
                message,
            });
            continue;
        }
        const evidence = classifyOcrPageText({
            extractedText,
            ...(pageVisibility === undefined ? {} : {visibility: pageVisibility}),
            languages: page.languages,
        });
        if (shouldOcrClassifiedPage(evidence.classification, input.supersessionPolicy)) {
            pages.push(page);
            continue;
        }
        const message = `Skipped page ${page.pageNumber}: classified ${evidence.classification} under ${input.supersessionPolicy} policy`;
        warnings.push(message);
        diagnostics.push({
            code: 'OCR_EXISTING_TEXT_SKIPPED',
            severity: 'info',
            pageNumber: requirePageNumber(page.pageNumber),
            message,
        });
    }
    return {
        pages,
        warnings,
        diagnostics,
    };
}
