import type {
    IOcrDiagnostic,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    IOcrPdfPageRequest,
    TWorkerLog,
} from '@electron/ocr/worker/types';
import { iterateOcrPageRanges } from '@electron/features/ocr/contracts';
import {
    classifyOcrPageText,
    inspectPdfPageTextVisibility,
    shouldOcrClassifiedPage,
} from '@electron/features/ocr/worker/pageTextClassifier';
import { runOcrCommand } from '@electron/features/ocr/worker/runOcrCommand';
import {
    groupContiguousPages,
    splitPdfTextOutput,
} from '@electron/pdf/pdfTextPageBatching';
import { isAbortError } from '@electron/utils/abort';
import { getErrorMessage } from '@electron/utils/error';
import {openCatalog} from '@electron/features/ocr/main/ocrCatalogV4';
import { requirePageNumber } from '@contracts/pageNumbers';

const TEXT_PROBE_TIMEOUT_MS = 2 * 60 * 1000;
const TEXT_PROBE_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const TEXT_PROBE_UNAVAILABLE = '[text-probe-unavailable]';

async function readCurrentEvbGenerations(
    sourcePdfPath: string,
    documentRevisionToken: TDocumentRevisionToken,
    requestedPageNumbers: readonly number[],
) {
    const generations = new Map<number, string>();
    const catalog = await openCatalog(`${sourcePdfPath}.ocr`, {expectedDocumentRevision: documentRevisionToken}).catch(() => null);
    if (!catalog) {
        return generations;
    }
    try {
        const orderedPages = Array.from(new Set(requestedPageNumbers))
            .filter(pageNumber => Number.isSafeInteger(pageNumber) && pageNumber > 0)
            .sort((left, right) => left - right);
        for (let index = 0; index < orderedPages.length;) {
            const start = orderedPages[index]!;
            let count = 1;
            while (
                index + count < orderedPages.length
                && count < 256
                && orderedPages[index + count] === start + count
            ) {
                count += 1;
            }
            const mappings = await catalog.readWindowMappings(start, count).catch(() => []);
            for (const entry of mappings) {
                if (!entry.mapping) {
                    continue;
                }
                if (catalog.header.version === 3 || entry.mapping.generation === 0) {
                    generations.set(entry.pageNumber, 'legacy-v3');
                } else if (entry.mapping.generation > 0) {
                    generations.set(entry.pageNumber, `gen-${String(entry.mapping.generation).padStart(8, '0')}`);
                }
            }
            index += count;
        }
    } finally {
        await catalog.close();
    }
    return generations;
}

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
                const probe = await runOcrCommand(input.pdftotextBinary, [
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
    documentRevisionToken: TDocumentRevisionToken;
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
    const generations = await readCurrentEvbGenerations(
        input.sourcePdfPath,
        input.documentRevisionToken,
        input.pages.map(page => page.pageNumber),
    );
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
        const evbGeneration = generations.get(page.pageNumber);
        const evidence = classifyOcrPageText({
            extractedText: textProbe.texts.get(page.pageNumber) ?? TEXT_PROBE_UNAVAILABLE,
            ...(pageVisibility === undefined ? {} : {visibility: pageVisibility}),
            ...(evbGeneration === undefined ? {} : {evbGeneration}),
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
