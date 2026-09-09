import {
    readFile,
    stat,
} from 'node:fs/promises';
import {join} from 'node:path';
import {uniq} from 'es-toolkit/array';
import type {
    IOcrDiagnostic,
    TOcrSearchablePdfPages,
} from '@contracts/electronApiOcr';
import {iterateOcrPageRequestBatches} from '@electron/features/ocr/contracts';
import type {
    IOcrPageWithWords,
    IOcrPdfPageRequest,
    TOcrPdfPageSelection,
} from '@electron/ocr/worker/types';

export interface IOcrCheckpointPageResult {
    pageData: IOcrPageWithWords;
    pageDataPath: string;
    pdfPath: string;
    effectiveDpi?: number;
    diagnostics: IOcrDiagnostic[];
}

function throwIfAborted(signal?: AbortSignal) {
    if (!signal?.aborted) {
        return;
    }
    throw signal.reason instanceof Error ? signal.reason : new Error('OCR job aborted');
}

function isCheckpointPageData(value: unknown, pageNumber: number): value is IOcrPageWithWords {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const pageData = value as Partial<IOcrPageWithWords>;
    return pageData.pageNumber === pageNumber
        && Number.isSafeInteger(pageData.pageNumber)
        && Array.isArray(pageData.words)
        && typeof pageData.text === 'string'
        && typeof pageData.imageWidth === 'number'
        && Number.isFinite(pageData.imageWidth)
        && pageData.imageWidth > 0
        && typeof pageData.imageHeight === 'number'
        && Number.isFinite(pageData.imageHeight)
        && pageData.imageHeight > 0;
}

/** Read one bounded checkpoint artifact at a time for assembly and indexing. */
export async function* iterateCheckpointPageResults(
    selection: TOcrPdfPageSelection,
    checkpointDir: string,
    signal?: AbortSignal,
): AsyncGenerator<IOcrCheckpointPageResult> {
    for (const batch of iterateOcrPageRequestBatches(selection)) {
        for (const page of batch) {
            throwIfAborted(signal);
            const pageDataPath = join(checkpointDir, `page-${page.pageNumber}.json`);
            const pdfPath = join(checkpointDir, `page-${page.pageNumber}.pdf`);
            const checkpoint = await readFile(pageDataPath, 'utf8')
                .then(raw => JSON.parse(raw) as Record<string, unknown>)
                .catch(() => null);
            if (!checkpoint || !isCheckpointPageData(checkpoint.pageData, page.pageNumber)) {
                continue;
            }
            const pdfStat = await stat(pdfPath).catch(() => null);
            if (!pdfStat?.isFile() || pdfStat.size <= 0) {
                continue;
            }
            const effectiveDpi = typeof checkpoint.effectiveDpi === 'number'
                && Number.isFinite(checkpoint.effectiveDpi)
                && checkpoint.effectiveDpi > 0
                ? checkpoint.effectiveDpi
                : undefined;
            const diagnostics = Array.isArray(checkpoint.diagnostics)
                ? checkpoint.diagnostics as IOcrDiagnostic[]
                : [];
            yield {
                pageData: checkpoint.pageData,
                pageDataPath,
                pdfPath,
                ...(effectiveDpi === undefined ? {} : {effectiveDpi}),
                diagnostics,
            };
        }
    }
}

export async function* iterateCheckpointPageData(
    selection: TOcrPdfPageSelection,
    checkpointDir: string,
    signal: AbortSignal,
) {
    for await (const result of iterateCheckpointPageResults(selection, checkpointDir, signal)) {
        yield result.pageData;
    }
}

export async function* iterateCheckpointPdfEntries(
    selection: TOcrPdfPageSelection,
    checkpointDir: string,
    signal: AbortSignal,
) {
    for await (const result of iterateCheckpointPageResults(selection, checkpointDir, signal)) {
        yield [
            result.pageData.pageNumber,
            result.pdfPath,
        ] as const;
    }
}

export function getLastOcrSelectionPage(selection: TOcrPdfPageSelection) {
    if (Array.isArray(selection)) {
        return selection.at(-1)?.pageNumber ?? 0;
    }
    switch (selection.kind) {
        case 'all':
            return selection.pageCount;
        case 'range':
            return selection.lastPage;
        case 'ranges':
            return selection.ranges.at(-1)?.lastPage ?? 0;
        case 'pages':
            return selection.pages.at(-1)?.pageNumber ?? 0;
    }
}

export function getOcrSelectionLanguages(selection: TOcrPdfPageSelection) {
    if (!Array.isArray(selection) && selection.kind !== 'pages') {
        return uniq(selection.languages);
    }
    const pageRequests = Array.isArray(selection) ? selection : selection.pages;
    return uniq(pageRequests.flatMap(page => page.languages));
}

function assertUniqueOcrPageNumbers(pages: readonly IOcrPdfPageRequest[]) {
    const seenPageNumbers = new Set<number>();
    for (const page of pages) {
        if (seenPageNumbers.has(page.pageNumber)) {
            throw new Error(`Duplicate OCR page number ${page.pageNumber}`);
        }
        seenPageNumbers.add(page.pageNumber);
    }
}

export function normalizeOcrPageSelection(selection: TOcrPdfPageSelection): TOcrSearchablePdfPages {
    if (Array.isArray(selection)) {
        assertUniqueOcrPageNumbers(selection);
        return [...selection].sort((left, right) => left.pageNumber - right.pageNumber);
    }
    if (selection.kind === 'pages') {
        assertUniqueOcrPageNumbers(selection.pages);
        return {
            kind: 'pages',
            pages: [...selection.pages].sort((left, right) => left.pageNumber - right.pageNumber),
        };
    }
    return selection;
}
