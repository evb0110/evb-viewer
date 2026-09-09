import {runOcrCommand} from '@electron/features/ocr/worker/runOcrCommand';
import {isAbortError} from '@electron/utils/abort';
import {getErrorMessage} from '@electron/utils/error';
import type {
    TOcrPageTextClassification,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';

const TEXT_TOKEN_RE = /\bBT\b|\bET\b|(?:^|\s)([0-7])(?:\.0+)?\s+Tr\b|\b(Tj|TJ)\b|(?:^|\s)(['"])(?=\s|$)/gm;
const OCR_TEXT_VISIBILITY_MAX_PAGE_MAP_BYTES = 16 * 1024 * 1024;
const OCR_TEXT_VISIBILITY_MAX_STREAM_BYTES = 4 * 1024 * 1024;
const OCR_TEXT_VISIBILITY_MAX_PAGE_BYTES = 16 * 1024 * 1024;
const OCR_TEXT_VISIBILITY_TIMEOUT_MS = 2 * 60 * 1000;

export interface IOcrPageTextEvidence {
    classification: TOcrPageTextClassification;
    extractedTextLength: number;
    hasHiddenTextOperators: boolean;
    hasVisibleTextOperators: boolean;
    evbGeneration?: string;
}

export interface IOcrPdfTextVisibility {
    hasHiddenTextOperators: boolean;
    hasVisibleTextOperators: boolean;
}

export function inspectPdfTextVisibility(streamSources: readonly string[]): IOcrPdfTextVisibility {
    let renderingMode = 0;
    let inTextObject = false;
    let hasHiddenTextOperators = false;
    let hasVisibleTextOperators = false;

    for (const source of streamSources) {
        TEXT_TOKEN_RE.lastIndex = 0;
        for (const match of source.matchAll(TEXT_TOKEN_RE)) {
            const token = match[0].trim();
            if (token === 'BT') {
                inTextObject = true;
            } else if (token === 'ET') {
                inTextObject = false;
            } else if (match[1] !== undefined) {
                renderingMode = Number(match[1]);
            } else if (inTextObject && (match[2] !== undefined || match[3] !== undefined)) {
                if (renderingMode === 3) hasHiddenTextOperators = true;
                else hasVisibleTextOperators = true;
            }
        }
    }
    return {
        hasHiddenTextOperators,
        hasVisibleTextOperators,
    };
}

export type TOcrPdfTextVisibilityAnalysis =
    | {
        status: 'available';
        visibility: Map<number, IOcrPdfTextVisibility>;
    }
    | {
        status: 'degraded';
        reason: 'qpdf-unavailable' | 'qpdf-failed';
        message: string;
        visibility: Map<number, IOcrPdfTextVisibility>;
    };

interface IOcrQpdfPage {contentObjects: string[]}

function abortIfRequested(signal?: AbortSignal) {
    if (!signal?.aborted) {
        return;
    }
    throw signal.reason instanceof Error ? signal.reason : new Error('OCR job aborted');
}

function parseQpdfPageMap(output: string, requestedPageNumbers: ReadonlySet<number>) {
    const pages = new Map<number, IOcrQpdfPage>();
    let currentPage: IOcrQpdfPage | null = null;
    let readingContents = false;

    for (const line of output.split(/\r?\n/u)) {
        const pageMatch = /^page\s+(\d+):\s+(\d+)\s+(\d+)\s+R\s*$/u.exec(line);
        if (pageMatch) {
            const pageNumber = Number(pageMatch[1]);
            currentPage = requestedPageNumbers.has(pageNumber)
                ? {contentObjects: []}
                : null;
            if (currentPage) {
                pages.set(pageNumber, currentPage);
            }
            readingContents = false;
            continue;
        }
        if (currentPage === null) {
            continue;
        }
        if (line.trim() === 'content:') {
            readingContents = true;
            continue;
        }
        if (!readingContents) {
            continue;
        }
        const contentMatch = /^\s+(\d+)\s+(\d+)\s+R\s*$/u.exec(line);
        if (contentMatch) {
            const objectNumber = contentMatch[1] ?? '<missing>';
            const generation = contentMatch[2] ?? '<missing>';
            currentPage.contentObjects.push(`${objectNumber},${generation}`);
            continue;
        }
        if (line.trim().length > 0 && !/^\s/u.test(line)) {
            readingContents = false;
        }
    }

    for (const pageNumber of requestedPageNumbers) {
        if (!pages.has(pageNumber)) {
            throw new Error(`qpdf did not report requested page ${pageNumber}`);
        }
    }
    return pages;
}

async function inspectPdfPageTextVisibilityWithQpdf(
    pdfPath: string,
    pageNumbers: readonly number[],
    qpdfBinary: string,
    signal?: AbortSignal,
): Promise<Map<number, IOcrPdfTextVisibility>> {
    abortIfRequested(signal);
    const requestedPageNumbers = new Set(pageNumbers);
    if (requestedPageNumbers.size === 0) {
        return new Map();
    }
    const pageMapResult = await runOcrCommand(qpdfBinary, [
        '--show-pages',
        '--',
        pdfPath,
    ], {
        commandLabel: 'qpdf(ocr-text-visibility-pages)',
        timeoutMs: OCR_TEXT_VISIBILITY_TIMEOUT_MS,
        maxStdoutBytes: OCR_TEXT_VISIBILITY_MAX_PAGE_MAP_BYTES,
        rejectOnStdoutTruncation: true,
        ...(signal ? {signal} : {}),
    });
    const pageMap = parseQpdfPageMap(pageMapResult.stdout, requestedPageNumbers);
    const evidence = new Map<number, IOcrPdfTextVisibility>();

    for (const pageNumber of pageNumbers) {
        abortIfRequested(signal);
        if (evidence.has(pageNumber)) {
            continue;
        }
        const page = pageMap.get(pageNumber);
        if (!page) {
            throw new Error(`qpdf did not report requested page ${pageNumber}`);
        }
        let remainingBytes = OCR_TEXT_VISIBILITY_MAX_PAGE_BYTES;
        const sources: string[] = [];
        for (const objectReference of page.contentObjects) {
            abortIfRequested(signal);
            const byteLimit = Math.min(remainingBytes, OCR_TEXT_VISIBILITY_MAX_STREAM_BYTES);
            if (byteLimit <= 0) {
                throw new RangeError(`OCR text-visibility page ${pageNumber} exceeds the ${OCR_TEXT_VISIBILITY_MAX_PAGE_BYTES}-byte decoded budget`);
            }
            const streamResult = await runOcrCommand(qpdfBinary, [
                '--filtered-stream-data',
                `--show-object=${objectReference}`,
                '--',
                pdfPath,
            ], {
                commandLabel: 'qpdf(ocr-text-visibility-stream)',
                timeoutMs: OCR_TEXT_VISIBILITY_TIMEOUT_MS,
                maxStdoutBytes: byteLimit,
                rejectOnStdoutTruncation: true,
                ...(signal ? {signal} : {}),
            });
            sources.push(streamResult.stdout);
            remainingBytes -= Buffer.byteLength(streamResult.stdout, 'utf8');
            const visibility = inspectPdfTextVisibility(sources);
            if (visibility.hasHiddenTextOperators && visibility.hasVisibleTextOperators) {
                break;
            }
        }
        evidence.set(pageNumber, inspectPdfTextVisibility(sources));
    }
    return evidence;
}

export async function inspectPdfPageTextVisibility(
    pdfPath: string,
    pageNumbers: readonly number[],
    qpdfBinary?: string,
    signal?: AbortSignal,
): Promise<TOcrPdfTextVisibilityAnalysis> {
    if (qpdfBinary === undefined) {
        return {
            status: 'degraded',
            reason: 'qpdf-unavailable',
            message: 'qpdf is unavailable; hidden OCR layers could not be inspected',
            visibility: new Map(),
        };
    }
    try {
        return {
            status: 'available',
            visibility: await inspectPdfPageTextVisibilityWithQpdf(
                pdfPath,
                pageNumbers,
                qpdfBinary,
                signal,
            ),
        };
    } catch (error) {
        if (isAbortError(error) || signal?.aborted) {
            throw error;
        }
        return {
            status: 'degraded',
            reason: 'qpdf-failed',
            message: `qpdf text-visibility inspection failed; hidden OCR layers could not be inspected: ${getErrorMessage(error)}`,
            visibility: new Map(),
        };
    }
}

export function classifyOcrPageText(input: {
    extractedText: string;
    visibility?: IOcrPdfTextVisibility;
    evbGeneration?: string;
}): IOcrPageTextEvidence {
    const extractedTextLength = input.extractedText.trim().length;
    const hasHiddenTextOperators = input.visibility?.hasHiddenTextOperators ?? false;
    const hasVisibleTextOperators = input.visibility?.hasVisibleTextOperators ?? false;
    if (input.evbGeneration) {
        return {
            classification: 'evb-current-generation',
            extractedTextLength,
            hasHiddenTextOperators,
            hasVisibleTextOperators,
            evbGeneration: input.evbGeneration,
        };
    }
    if (extractedTextLength === 0) {
        return {
            classification: 'no-text',
            extractedTextLength,
            hasHiddenTextOperators,
            hasVisibleTextOperators,
        };
    }
    return {
        classification: hasHiddenTextOperators && !hasVisibleTextOperators
            ? 'foreign-hidden-ocr'
            : 'native-text',
        extractedTextLength,
        hasHiddenTextOperators,
        hasVisibleTextOperators,
    };
}

export function shouldOcrClassifiedPage(
    classification: TOcrPageTextClassification,
    policy: TOcrTextSupersessionPolicy,
) {
    if (classification === 'no-text') {
        return true;
    }
    if (classification === 'evb-current-generation') {
        return policy === 'replace-evb' || policy === 'replace-all';
    }
    if (classification === 'foreign-hidden-ocr') {
        return policy === 'replace-all';
    }
    return false;
}
