import { existsSync } from 'fs';
import { createLogger } from '@electron/utils/createLogger';
import { runElectronCommand } from '@electron/utils/runElectronCommand';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import {
    groupContiguousPages,
    splitPdfTextOutput,
} from '@electron/pdf/pdfTextPageBatching';
import { buildPopplerEnv } from '@electron/native-tools/buildPopplerEnv';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import { getErrorMessage } from '@electron/utils/error';
import { assembleSearchablePageText } from '@pdf-core/pdfSearchCore';
import type { IPageText } from '@electron/search/pageText';

const log = createLogger('pdfTextExtractor');
const PDFTOTEXT_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDFTOTEXT_TIMEOUT_MS ?? `${2 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 5_000) {
        return 2 * 60 * 1000;
    }
    return parsed;
})();
const PDFTOTEXT_MAX_STDOUT_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDFTOTEXT_MAX_STDOUT_MB ?? '8', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 8 * 1024 * 1024;
    }
    return Math.min(parsed * 1024 * 1024, 8 * 1024 * 1024);
})();
const PDFTOTEXT_MAX_PAGE_BYTES = 8 * 1024 * 1024;
const PDFTOTEXT_DEFAULT_PAGE_WINDOW = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDFTOTEXT_PAGE_WINDOW ?? '32', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 32;
    }
    return Math.min(parsed, 64);
})();
const PDFINFO_MAX_STDOUT_BYTES = 64 * 1024;
const PDFINFO_TIMEOUT_MS = 30_000;

export interface IExtractTextOptions {
    pageCount?: number;
    signal?: AbortSignal;
    pages?: readonly number[];
    onPageText?: (page: IPageText) => void;
    collectPages?: boolean;
}

const _PDF_TEXT_EXTRACTION_CAPABILITY_ERROR_CODES = [
    'native-unavailable',
    'native-failure',
    'too-large',
] as const;

type TPdfTextExtractionCapabilityErrorCode =
    typeof _PDF_TEXT_EXTRACTION_CAPABILITY_ERROR_CODES[number];

class PdfTextExtractionCapabilityError extends Error {
    constructor(
        public readonly code: TPdfTextExtractionCapabilityErrorCode,
        message: string,
        public readonly pdfPath?: string,
        options: {cause?: unknown} = {},
    ) {
        super(message);
        this.name = 'PdfTextExtractionCapabilityError';
        if (options.cause !== undefined) {
            Object.defineProperty(this, 'cause', {
                configurable: true,
                enumerable: false,
                value: options.cause,
                writable: false,
            });
        }
    }
}

export function isPdfTextExtractionCapabilityError(
    error: unknown,
): error is PdfTextExtractionCapabilityError {
    return error instanceof PdfTextExtractionCapabilityError;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function normalizeRequestedPages(pages: readonly number[] | undefined, pageCount?: number) {
    if (!pages || pages.length === 0) {
        return [];
    }

    return Array.from(new Set(
        pages
            .map(page => Math.trunc(page))
            .filter(page => page >= 1 && (pageCount === undefined || page <= pageCount)),
    )).sort((left, right) => left - right);
}

function parsePdfInfoPageCount(output: string) {
    const match = output.match(/^Pages:\s*(\d+)\s*$/mu);
    const pageCount = match ? Number.parseInt(match[1] ?? '', 10) : Number.NaN;
    return Number.isSafeInteger(pageCount) && pageCount > 0 ? pageCount : null;
}

function isStdoutLimitError(error: unknown) {
    const message = getErrorMessage(error);
    return /stdout (?:exceeded|truncat)/iu.test(message);
}

function splitPageRange(firstPage: number, lastPage: number) {
    const ranges: Array<{
        firstPage: number;
        lastPage: number;
    }> = [];
    for (
        let rangeFirstPage = firstPage;
        rangeFirstPage <= lastPage;
        rangeFirstPage += PDFTOTEXT_DEFAULT_PAGE_WINDOW
    ) {
        ranges.push({
            firstPage: rangeFirstPage,
            lastPage: Math.min(lastPage, rangeFirstPage + PDFTOTEXT_DEFAULT_PAGE_WINDOW - 1),
        });
    }
    return ranges;
}

function normalizePageText(text: string, pageNumber: number, pdfPath: string) {
    const trimmed = text.trim();
    if (Buffer.byteLength(trimmed, 'utf8') > PDFTOTEXT_MAX_PAGE_BYTES) {
        throw new PdfTextExtractionCapabilityError(
            'too-large',
            `PDF page ${pageNumber} text exceeds ${PDFTOTEXT_MAX_PAGE_BYTES} bytes`,
            pdfPath,
        );
    }
    return assembleSearchablePageText([{text: trimmed}]).text;
}

/**
 * Extract all text from a PDF using pdftotext command
 * Returns text organized by page
 */
export async function extractTextFromPdf(
    pdfPath: string,
    options: IExtractTextOptions = {},
): Promise<IPageText[]> {
    log.debug(`Extracting text from PDF: ${pdfPath}`);
    const {
        collectPages = !options.onPageText,
        onPageText,
        signal,
    } = options;
    throwIfAborted(signal);

    try {
        const paths = getPdfNativeToolPaths();
        const {pdftotext} = paths;
        const popplerEnv = buildPopplerEnv(paths);
        log.debug(`Using pdftotext at: ${pdftotext}`);

        // Check if the resolved path exists (if it's an absolute path).
        const isAbsolutePath = pdftotext.includes('/') || pdftotext.includes('\\');
        if (isAbsolutePath && !existsSync(pdftotext)) {
            throw new PdfTextExtractionCapabilityError(
                'native-unavailable',
                `pdftotext binary not found at: ${pdftotext}. `
                + 'Ensure Poppler is bundled in resources/poppler/ or installed system-wide.',
                pdfPath,
            );
        }

        throwIfAborted(signal);
        // Use pdftotext -layout to preserve some structure
        // Each page is separated by form feed character (0x0C)
        const commandOptions: Parameters<typeof runElectronCommand>[2] = {
            timeoutMs: PDFTOTEXT_TIMEOUT_MS,
            maxStdoutBytes: PDFTOTEXT_MAX_STDOUT_BYTES,
            rejectOnStdoutTruncation: true,
        };
        if (popplerEnv !== undefined) {
            commandOptions.env = popplerEnv;
        }
        if (signal !== undefined) {
            commandOptions.signal = signal;
        }

        const requestedPages = normalizeRequestedPages(options.pages, options.pageCount);
        const argsForRange = (firstPage: number, lastPage: number) => [
            '-layout',
            '-f',
            String(firstPage),
            '-l',
            String(lastPage),
            pdfPath,
            '-',
        ];
        const pagesByNumber: IPageText[] = [];
        const emitRange = async (firstPage: number, lastPage: number) => {
            throwIfAborted(signal);
            const result = await runElectronCommand(
                pdftotext,
                argsForRange(firstPage, lastPage),
                commandOptions,
            );
            const texts = splitPdfTextOutput(
                result.stdout ?? '',
                lastPage - firstPage + 1,
            );
            for (let index = 0; index < texts.length; index += 1) {
                throwIfAborted(signal);
                const page = {
                    pageNumber: firstPage + index,
                    text: normalizePageText(texts[index] ?? '', firstPage + index, pdfPath),
                } satisfies IPageText;
                if (collectPages) {
                    pagesByNumber.push(page);
                }
                onPageText?.(page);
            }
        };

        let ranges: Array<{
            firstPage: number;
            lastPage: number;
        }>;
        if (requestedPages.length > 0) {
            ranges = groupContiguousPages(requestedPages).flatMap(range => (
                splitPageRange(range.firstPage, range.lastPage)
            ));
        } else if (options.pageCount !== undefined && options.pageCount > 0) {
            ranges = splitPageRange(1, Math.trunc(options.pageCount));
        } else {
            let pageCount: number | null = null;
            const pdfinfo = paths.pdfinfo;
            if (typeof pdfinfo !== 'string' || pdfinfo.length === 0) {
                throw new PdfTextExtractionCapabilityError(
                    'native-unavailable',
                    `pdfinfo is unavailable for ${pdfPath}. A page count is required for bounded PDF text extraction.`,
                    pdfPath,
                );
            }
            const isPdfinfoAbsolutePath = pdfinfo.includes('/') || pdfinfo.includes('\\');
            if (isPdfinfoAbsolutePath && !existsSync(pdfinfo)) {
                throw new PdfTextExtractionCapabilityError(
                    'native-unavailable',
                    `pdfinfo binary not found at: ${pdfinfo}. `
                    + 'A page count is required for bounded PDF text extraction.',
                    pdfPath,
                );
            }
            const pdfinfoOptions: Parameters<typeof runElectronCommand>[2] = {
                timeoutMs: PDFINFO_TIMEOUT_MS,
                maxStdoutBytes: PDFINFO_MAX_STDOUT_BYTES,
                rejectOnStdoutTruncation: true,
            };
            if (popplerEnv !== undefined) {
                pdfinfoOptions.env = popplerEnv;
            }
            if (signal !== undefined) {
                pdfinfoOptions.signal = signal;
            }
            const infoResult = await runElectronCommand(pdfinfo, [pdfPath], pdfinfoOptions);
            pageCount = parsePdfInfoPageCount(infoResult.stdout ?? '');
            if (pageCount === null) {
                throw new PdfTextExtractionCapabilityError(
                    'native-failure',
                    `pdfinfo did not return a valid page count for ${pdfPath}`,
                    pdfPath,
                );
            }
            ranges = splitPageRange(1, pageCount);
        }

        const emitBoundedRange = async (firstPage: number, lastPage: number): Promise<void> => {
            try {
                await emitRange(firstPage, lastPage);
            } catch (error) {
                if (!isStdoutLimitError(error) || firstPage === lastPage) {
                    throw error;
                }

                // A pathological batch can contain more text than the output
                // budget. Split it without ever retaining the rejected output.
                const midpoint = Math.floor((firstPage + lastPage) / 2);
                await emitBoundedRange(firstPage, midpoint);
                await emitBoundedRange(midpoint + 1, lastPage);
            }
        };

        for (const range of ranges) {
            await emitBoundedRange(range.firstPage, range.lastPage);
        }
        throwIfAborted(signal);

        log.debug(`Extracted ${pagesByNumber.length} page segments from PDF`);

        return pagesByNumber;
    } catch (err) {
        if (isAbortError(err)) {
            throw err;
        }

        if (isPdfTextExtractionCapabilityError(err)) {
            throw err;
        }

        const errMsg = getErrorMessage(err);
        log.debug(`Failed to extract text using Poppler: ${errMsg}`);

        // Provide actionable error message
        const isNotFound = errMsg.includes('ENOENT') || errMsg.includes('not found');
        if (isNotFound) {
            throw new PdfTextExtractionCapabilityError(
                'native-unavailable',
                `Poppler text extraction is unavailable for ${pdfPath}: ${errMsg}`,
                pdfPath,
                {cause: err},
            );
        }

        throw new PdfTextExtractionCapabilityError(
            'native-failure',
            `Failed to extract text from PDF: ${errMsg}`,
            pdfPath,
            {cause: err},
        );
    }
}
