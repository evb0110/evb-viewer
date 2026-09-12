import { getErrorMessage } from '@electron/utils/error';
import { uniq } from 'es-toolkit/array';
import { AVAILABLE_OCR_LANGUAGE_CODES } from '@electron/features/ocr/availableLanguages';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import { isOneOf } from '@contracts/runtimeGuards';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    requireRequestId,
    type TRequestId,
} from '@contracts/shared';
import {createEpochMs} from '@contracts/timestamps';
import type {
    IOcrErrorEnvelope,
    IOcrSearchablePdfPage,
    IOcrSearchablePdfPageRange,
    IOcrSearchablePdfOptions,
    TOcrSearchablePdfPages,
    TOcrPreprocessingMode,
    TOcrErrorCode,
    TOcrQualityProfile,
} from '@contracts/electronApiOcr';
import {
    AGENT_OCR_PAGE_SEGMENTATION_MODES,
    isSupportedPageSegmentationMode,
} from '@contracts/agentOcr';

interface IOcrCreateSearchablePdfPayload {
    sourcePdfPath: string;
    pages: TOcrSearchablePdfPages;
    requestId: TRequestId;
    options: IOcrSearchablePdfOptions;
}

const MAX_LANGUAGES_PER_PAGE = 16;
const MAX_BATCH_PAGES = 5_000;
const OCR_PAGE_REQUEST_BATCH_SIZE = MAX_BATCH_PAGES;
const MAX_SELECTION_RANGES = 100_000;
const MAX_EXPLICIT_PAGE_REQUESTS = 100_000;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ERROR_DETAILS_LENGTH = 512;
const OCR_QUALITY_PROFILES = [
    'balanced',
    'accurate',
    'poor-scan',
] as const satisfies readonly TOcrQualityProfile[];
const OCR_PREPROCESSING_MODES = [
    'off',
    'clean',
] as const satisfies readonly TOcrPreprocessingMode[];
const MAX_UNIQUE_LANGUAGES_PER_JOB = parseIntegerEnv(
    'EVB_OCR_MAX_UNIQUE_LANGUAGES_PER_JOB',
    AVAILABLE_OCR_LANGUAGE_CODES.size,
    1,
    AVAILABLE_OCR_LANGUAGE_CODES.size,
);

export interface IOcrPageRange extends IOcrSearchablePdfPageRange {
    firstPage: number;
    lastPage: number;
}

export function getOcrPageSelectionCount(selection: TOcrSearchablePdfPages) {
    if (Array.isArray(selection)) {
        return selection.length;
    }
    switch (selection.kind) {
        case 'all':
            return selection.pageCount;
        case 'range':
            return selection.lastPage - selection.firstPage + 1;
        case 'ranges':
            return selection.ranges.reduce(
                (count, pageRange) => count + pageRange.lastPage - pageRange.firstPage + 1,
                0,
            );
        case 'pages':
            return selection.pages.length;
    }
}

/**
 * Expands a scalar selection into bounded arrays suitable for one worker
 * iteration. At most MAX_BATCH_PAGES page objects exist at any point.
 */
export function* iterateOcrPageRequestBatches(
    selection: TOcrSearchablePdfPages,
    chunkPages = OCR_PAGE_REQUEST_BATCH_SIZE,
): Generator<IOcrSearchablePdfPage[]> {
    assertPositiveSafeInteger(chunkPages, 'chunkPages');
    if (chunkPages > MAX_BATCH_PAGES) {
        throw new OcrPayloadValidationError(`chunkPages exceeds maximum size (${MAX_BATCH_PAGES})`);
    }
    if (Array.isArray(selection)) {
        for (let offset = 0; offset < selection.length; offset += chunkPages) {
            yield selection.slice(offset, offset + chunkPages);
        }
        return;
    }

    if (selection.kind === 'pages') {
        for (let offset = 0; offset < selection.pages.length; offset += chunkPages) {
            yield selection.pages.slice(offset, offset + chunkPages);
        }
        return;
    }

    const ranges = selection.kind === 'all'
        ? [{
            firstPage: 1,
            lastPage: selection.pageCount,
        }]
        : selection.kind === 'range'
            ? [{
                firstPage: selection.firstPage,
                lastPage: selection.lastPage,
            }]
            : selection.ranges;
    const languages = [...selection.languages];
    let batch: IOcrSearchablePdfPage[] = [];
    for (const pageRange of ranges) {
        for (let offset = 0; offset <= pageRange.lastPage - pageRange.firstPage; offset += 1) {
            const pageNumber = pageRange.firstPage + offset;
            batch.push({
                pageNumber: requirePageNumber(pageNumber),
                languages,
            });
            if (batch.length === chunkPages) {
                yield batch;
                batch = [];
            }
        }
    }
    if (batch.length > 0) {
        yield batch;
    }
}

function assertPositiveSafeInteger(value: number, fieldName: string) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new OcrPayloadValidationError(`${fieldName} must be a positive safe integer`);
    }
}

/**
 * Yields bounded page ranges without materializing a range for every page.
 * Keep this independent of request-window budgets. It plans a document span,
 * while individual page numbers only need to remain safely representable.
 */
export function* iterateOcrPageRanges(
    pageCount: number,
    chunkPages = OCR_PAGE_REQUEST_BATCH_SIZE,
): Generator<IOcrPageRange> {
    assertPositiveSafeInteger(pageCount, 'pageCount');
    assertPositiveSafeInteger(chunkPages, 'chunkPages');
    if (chunkPages > MAX_BATCH_PAGES) {
        throw new OcrPayloadValidationError(`chunkPages exceeds maximum size (${MAX_BATCH_PAGES})`);
    }

    let firstPage = 1;
    while (firstPage <= pageCount) {
        const pageSpan = Math.min(chunkPages, pageCount - firstPage + 1);
        const lastPage = firstPage + pageSpan - 1;
        yield {
            firstPage,
            lastPage,
        };
        if (lastPage === pageCount) {
            return;
        }
        firstPage = lastPage + 1;
    }
}

export class OcrPayloadValidationError extends Error {
    readonly code: TOcrErrorCode;
    readonly subsystem = 'ocr';

    constructor(message: string, code: TOcrErrorCode = 'OCR_INVALID_PAYLOAD') {
        super(message);
        this.name = 'OcrPayloadValidationError';
        this.code = code;
    }
}

function trimErrorDetails(input: string) {
    const normalized = input.trim();
    if (normalized.length <= MAX_ERROR_DETAILS_LENGTH) {
        return normalized;
    }
    return `${normalized.slice(0, MAX_ERROR_DETAILS_LENGTH - 3)}...`;
}

function asString(value: unknown, fieldName: string, maxLength = 1_024) {
    if (typeof value !== 'string') {
        throw new OcrPayloadValidationError(`${fieldName} must be a string`);
    }
    const trimmed = value.trim();
    if (!trimmed) {
        throw new OcrPayloadValidationError(`${fieldName} must not be empty`);
    }
    if (trimmed.length > maxLength) {
        throw new OcrPayloadValidationError(`${fieldName} exceeds maximum length (${maxLength})`);
    }
    return trimmed;
}

function asPositiveInteger(value: unknown, fieldName: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new OcrPayloadValidationError(`${fieldName} must be a positive safe integer`);
    }
    return value;
}

function asOptionalDpi(value: unknown, fieldName: string) {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new OcrPayloadValidationError(`${fieldName} must be a finite number`);
    }
    const rounded = Math.round(value);
    if (rounded < 72 || rounded > 1200) {
        throw new OcrPayloadValidationError(`${fieldName} must be between 72 and 1200`);
    }
    return rounded;
}

function asOptionalOcrQualityProfile(value: unknown, fieldName: string) {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (!isOneOf(OCR_QUALITY_PROFILES, value)) {
        throw new OcrPayloadValidationError(`${fieldName} must be one of: balanced, accurate, poor-scan`);
    }
    return value;
}

function asOptionalOcrPreprocessingMode(value: unknown, fieldName: string) {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (!isOneOf(OCR_PREPROCESSING_MODES, value)) {
        throw new OcrPayloadValidationError(`${fieldName} must be one of: off, clean`);
    }
    return value;
}

function asOptionalPageSegmentationMode(value: unknown, fieldName: string) {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (!isSupportedPageSegmentationMode(value)) {
        throw new OcrPayloadValidationError(
            `${fieldName} must be one of the output-capable Tesseract modes: ${AGENT_OCR_PAGE_SEGMENTATION_MODES.join(', ')}`,
        );
    }
    return value;
}

function asOptionalSupersessionPolicy(value: unknown, fieldName: string) {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (value !== 'missing-only' && value !== 'replace-evb' && value !== 'replace-all') {
        throw new OcrPayloadValidationError(`${fieldName} must be one of: missing-only, replace-evb, replace-all`);
    }
    return value;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asSearchablePdfOptions(value: unknown): IOcrSearchablePdfOptions {
    if (value === null || value === undefined) {
        return {};
    }

    if (typeof value === 'number') {
        const renderDpi = asOptionalDpi(value, 'renderDpi');
        return renderDpi === undefined ? {} : {renderDpi};
    }

    if (!isObjectRecord(value)) {
        throw new OcrPayloadValidationError('ocrOptions must be an object or legacy renderDpi number');
    }

    const options: IOcrSearchablePdfOptions = {};
    const renderDpi = asOptionalDpi(value.renderDpi, 'ocrOptions.renderDpi');
    const qualityProfile = asOptionalOcrQualityProfile(value.qualityProfile, 'ocrOptions.qualityProfile');
    const preprocessingMode = asOptionalOcrPreprocessingMode(value.preprocessingMode, 'ocrOptions.preprocessingMode');
    const pageSegmentationMode = asOptionalPageSegmentationMode(value.pageSegmentationMode, 'ocrOptions.pageSegmentationMode');
    const supersessionPolicy = asOptionalSupersessionPolicy(value.supersessionPolicy, 'ocrOptions.supersessionPolicy');
    if (value.replaceAllAcknowledged !== undefined && typeof value.replaceAllAcknowledged !== 'boolean') {
        throw new OcrPayloadValidationError('ocrOptions.replaceAllAcknowledged must be a boolean');
    }
    if (supersessionPolicy === 'replace-all' && value.replaceAllAcknowledged !== true) {
        throw new OcrPayloadValidationError('replace-all OCR requires replaceAllAcknowledged=true');
    }

    if (renderDpi !== undefined) {
        options.renderDpi = renderDpi;
    }
    if (qualityProfile !== undefined) {
        options.qualityProfile = qualityProfile;
    }
    if (preprocessingMode !== undefined) {
        options.preprocessingMode = preprocessingMode;
    }
    if (pageSegmentationMode !== undefined) {
        options.pageSegmentationMode = pageSegmentationMode;
    }
    if (supersessionPolicy !== undefined) {
        options.supersessionPolicy = supersessionPolicy;
    }
    if (value.replaceAllAcknowledged !== undefined) {
        options.replaceAllAcknowledged = value.replaceAllAcknowledged;
    }
    return options;
}

function asLanguages(value: unknown, fieldName: string) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new OcrPayloadValidationError(`${fieldName} must be a non-empty array`);
    }
    if (value.length > MAX_LANGUAGES_PER_PAGE) {
        throw new OcrPayloadValidationError(`${fieldName} exceeds maximum size (${MAX_LANGUAGES_PER_PAGE})`);
    }

    const parsed = value.map((languageCode, index) => asString(languageCode, `${fieldName}[${index}]`, 32));
    const unique = uniq(parsed);
    for (const languageCode of unique) {
        if (!AVAILABLE_OCR_LANGUAGE_CODES.has(languageCode)) {
            throw new OcrPayloadValidationError(`Unsupported OCR language: ${languageCode}`);
        }
    }
    return unique;
}

function assertUniqueLanguageBudget(
    pages: Array<{ languages: string[] }>,
    fieldName: string,
) {
    const uniqueLanguages = new Set<string>();
    for (const page of pages) {
        for (const language of page.languages) {
            uniqueLanguages.add(language);
            if (uniqueLanguages.size > MAX_UNIQUE_LANGUAGES_PER_JOB) {
                throw new OcrPayloadValidationError(
                    `${fieldName} exceed maximum unique language count (${MAX_UNIQUE_LANGUAGES_PER_JOB})`,
                );
            }
        }
    }
}

function asCreatePdfPageRequest(payload: unknown, fieldName: string): IOcrSearchablePdfPage {
    if (!payload || typeof payload !== 'object') {
        throw new OcrPayloadValidationError(`${fieldName} must be an object`);
    }

    const record = payload as Record<string, unknown>;
    return {
        pageNumber: requirePageNumber(asPositiveInteger(record.pageNumber, `${fieldName}.pageNumber`)),
        languages: asLanguages(record.languages, `${fieldName}.languages`),
    };
}

function asRequestId(value: unknown, fieldName: string) {
    const normalized = asString(value, fieldName, MAX_REQUEST_ID_LENGTH);
    return requireRequestId(normalized);
}

function asPageRange(payload: unknown, fieldName: string): IOcrSearchablePdfPageRange {
    if (!isObjectRecord(payload)) {
        throw new OcrPayloadValidationError(`${fieldName} must be an object`);
    }
    const firstPage = asPositiveInteger(payload.firstPage, `${fieldName}.firstPage`);
    const lastPage = asPositiveInteger(payload.lastPage, `${fieldName}.lastPage`);
    if (lastPage < firstPage) {
        throw new OcrPayloadValidationError(`${fieldName}.lastPage must be greater than or equal to firstPage`);
    }
    return {
        firstPage,
        lastPage,
    };
}

function asSelectionKind(payload: Record<string, unknown>, fieldName: string) {
    const rawKind = payload.kind ?? payload.mode ?? payload.type;
    if (rawKind !== 'all' && rawKind !== 'range' && rawKind !== 'ranges' && rawKind !== 'pages') {
        throw new OcrPayloadValidationError(`${fieldName}.kind must be all, range, ranges, or pages`);
    }
    return rawKind;
}

function asSearchablePdfPageSelection(
    pagesPayload: unknown,
    fieldName: string,
): TOcrSearchablePdfPages {
    if (Array.isArray(pagesPayload)) {
        if (pagesPayload.length === 0) {
            throw new OcrPayloadValidationError(`${fieldName} must be a non-empty array`);
        }
        if (pagesPayload.length > MAX_EXPLICIT_PAGE_REQUESTS) {
            throw new OcrPayloadValidationError(`${fieldName} exceeds maximum size (${MAX_EXPLICIT_PAGE_REQUESTS})`);
        }
        const pages = pagesPayload.map((page, index) =>
            asCreatePdfPageRequest(page, `${fieldName}[${index}]`));
        assertUniqueLanguageBudget(pages, fieldName);
        return pages;
    }

    if (!isObjectRecord(pagesPayload)) {
        throw new OcrPayloadValidationError(`${fieldName} must be a non-empty array or scalar selection object`);
    }

    // Accept a request wrapper as well as the direct selection form. This
    // keeps the IPC boundary forwards-compatible with callers that add
    // request metadata around the page scope.
    const wrappedSelection = pagesPayload.selection;
    if (wrappedSelection !== undefined) {
        return asSearchablePdfPageSelection(wrappedSelection, `${fieldName}.selection`);
    }
    const wrappedPages = pagesPayload.pages;
    if (wrappedPages !== undefined && pagesPayload.kind === undefined && pagesPayload.mode === undefined && pagesPayload.type === undefined) {
        return asSearchablePdfPageSelection(wrappedPages, `${fieldName}.pages`);
    }

    const kind = asSelectionKind(pagesPayload, fieldName);
    if (kind === 'pages') {
        return asSearchablePdfPageSelection(pagesPayload.pages, `${fieldName}.pages`);
    }

    const languages = asLanguages(pagesPayload.languages, `${fieldName}.languages`);
    if (kind === 'all') {
        const pageCount = asPositiveInteger(pagesPayload.pageCount, `${fieldName}.pageCount`);
        return {
            kind: 'all',
            pageCount,
            languages,
        };
    }
    if (kind === 'range') {
        const pageRange = asPageRange(pagesPayload, fieldName);
        return {
            kind: 'range',
            ...pageRange,
            languages,
        };
    }

    const rawRanges = pagesPayload.ranges;
    if (!Array.isArray(rawRanges) || rawRanges.length === 0) {
        throw new OcrPayloadValidationError(`${fieldName}.ranges must be a non-empty array`);
    }
    if (rawRanges.length > MAX_SELECTION_RANGES) {
        throw new OcrPayloadValidationError(`${fieldName}.ranges exceeds maximum size (${MAX_SELECTION_RANGES})`);
    }
    const ranges = rawRanges.map((pageRange, index) =>
        asPageRange(pageRange, `${fieldName}.ranges[${index}]`));
    ranges.sort((left, right) => left.firstPage - right.firstPage || left.lastPage - right.lastPage);
    const mergedRanges: IOcrSearchablePdfPageRange[] = [];
    for (const pageRange of ranges) {
        const previous = mergedRanges.at(-1);
        if (previous && pageRange.firstPage <= previous.lastPage + 1) {
            previous.lastPage = Math.max(previous.lastPage, pageRange.lastPage);
        } else {
            mergedRanges.push({...pageRange});
        }
    }
    let pageCount = 0;
    for (const pageRange of mergedRanges) {
        const span = pageRange.lastPage - pageRange.firstPage + 1;
        if (pageCount > Number.MAX_SAFE_INTEGER - span) {
            throw new OcrPayloadValidationError(`${fieldName}.ranges page count exceeds safe integer range`);
        }
        pageCount += span;
    }
    return {
        kind: 'ranges',
        ranges: mergedRanges,
        languages,
    };
}

export function validateCreateSearchablePdfPayload(
    sourcePdfPathPayload: unknown,
    pagesPayload: unknown,
    requestIdPayload: unknown,
    renderDpiOrOptionsPayload?: unknown,
): IOcrCreateSearchablePdfPayload {
    const pages = asSearchablePdfPageSelection(pagesPayload, 'pages');
    return {
        sourcePdfPath: asString(sourcePdfPathPayload, 'sourcePdfPath', 4_096),
        pages,
        requestId: asRequestId(requestIdPayload, 'requestId'),
        options: asSearchablePdfOptions(renderDpiOrOptionsPayload),
    };
}

export function validateCancelRequestId(requestIdPayload: unknown) {
    return asRequestId(requestIdPayload, 'requestId');
}

export function mapStartFailureCode(message: string): TOcrErrorCode {
    const normalized = message.toLowerCase();
    if (normalized.includes('queue') && normalized.includes('full')) {
        return 'OCR_QUEUE_BACKPRESSURE';
    }
    if (
        normalized.includes('worker')
        && (
            normalized.includes('missing')
            || normalized.includes('unavailable')
            || normalized.includes('not found')
        )
    ) {
        return 'OCR_WORKER_UNAVAILABLE';
    }
    return 'OCR_INTERNAL_ERROR';
}

export function buildOcrErrorEnvelope(
    code: TOcrErrorCode,
    message: string,
    options: {
        retryable?: boolean;
        details?: string;
    } = {},
): IOcrErrorEnvelope {
    return {
        code,
        message,
        retryable: options.retryable ?? false,
        timestamp: createEpochMs(),
        ...(options.details ? {details: trimErrorDetails(options.details)} : {}),
    };
}

export function toOcrErrorEnvelope(
    error: unknown,
    fallbackCode: TOcrErrorCode = 'OCR_INTERNAL_ERROR',
    retryable = false,
): IOcrErrorEnvelope {
    if (error instanceof OcrPayloadValidationError) {
        return buildOcrErrorEnvelope(error.code, error.message, {retryable: false});
    }
    if (error instanceof Error) {
        return buildOcrErrorEnvelope(fallbackCode, getErrorMessage(error) || 'Unknown OCR error', { retryable });
    }
    return buildOcrErrorEnvelope(fallbackCode, 'Unknown OCR error', { retryable });
}
