import type { TPageNumber } from '@contracts/pageNumbers';

import type {
    IDjvuConvertResult,
    IDjvuConvertOptions,
    IDjvuInfo,
    IDjvuJobStartHandle,
    IDjvuOpenResult,
    IDjvuOutlineItem,
    IDjvuPagePreview,
    IDjvuPagePreviewOptions,
    IDjvuPageSize,
    IDjvuPageSourceInfo,
    IDjvuPrintResult,
    IDjvuPrintOptions,
    IDjvuProgress,
    IDjvuSizeEstimate,
    IDjvuTextSearchOptions,
    IDjvuTextSearchProgress,
    TDocumentOutputJobState,
} from '@contracts/electronApiDjvu';
import {
    decodeDjvuOutline,
    decodeDjvuPagePreview,
    decodeDjvuPageSizes,
    decodeDjvuPageSourceInfo,
    decodeDjvuPageText,
    isDjvuDocumentOutputOperation,
} from '@contracts/electronApiDjvu';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import { requirePageNumber } from '@contracts/pageNumbers';
import { SEARCH_WIRE_CODEC } from '@contracts/search';
import {
    decodeFailureReceipt,
    isExpectedOutcome,
} from '@contracts/diagnostics/failureReceipt';
import {
    definePlatformFeature,
    runtimeSchema as s,
    type IRuntimeSchema,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    parseJobId,
    parseRequestId,
    type TJobId,
    type TRequestId,
} from '@contracts/shared';
import {parseEpochMs} from '@contracts/timestamps';

const MAX_COLLECTION_ITEMS = 100_000;
const IPC_REQUEST_ID_MAX_LENGTH = 128;
const DJVU_NATIVE_IPC_TIMEOUT_MS = 30 * 60 * 1_000;
const DJVU_PROGRESS_PHASES = [
    'converting',
    'bookmarks',
    'optimizing',
    'loading',
    'printing',
] as const;
type TVoidResult = ReturnType<() => void>;

function requireArgs(args: readonly unknown[], count: number | {
    min: number;
    max: number
}) {
    const min = typeof count === 'number' ? count : count.min;
    const max = typeof count === 'number' ? count : count.max;
    if (args.length < min || args.length > max) {
        const expectedLabel = min === max ? String(min) : `${min}-${max}`;
        throw new Error(`expected ${expectedLabel} arguments, received ${args.length}`);
    }
    return args;
}

function decodeStringArg(args: readonly unknown[], index: number, fieldName: string): string {
    const value = args[index];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${fieldName} must be a non-empty string`);
    }
    return value;
}

function decodeSafeIntegerArg(
    args: readonly unknown[],
    index: number,
    fieldName: string,
    min = 0,
) {
    const value = args[index];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        throw new Error(`${fieldName} must be a safe integer >= ${min}`);
    }
    return value;
}

function normalizeOptionalRequestId(value: unknown, fieldName = 'requestId'): TRequestId | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value === 'string' && value.trim().length === 0) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new Error(`${fieldName} must be a string`);
    }
    const normalized = value.trim();
    if (normalized.length > IPC_REQUEST_ID_MAX_LENGTH) {
        throw new Error(`${fieldName} exceeds maximum length (${IPC_REQUEST_ID_MAX_LENGTH})`);
    }
    const parsed = parseRequestId(normalized);
    if (parsed === null) {
        throw new Error(`${fieldName} must be a valid request ID`);
    }
    return parsed;
}

function normalizeOptionalJobId(value: unknown, fieldName = 'jobId'): TJobId | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    const parsed = parseJobId(value);
    if (parsed === null) {
        throw new Error(`${fieldName} must be a valid job ID`);
    }
    return parsed;
}

function decodeDocumentRefArg(args: readonly unknown[], index: number, fieldName: string): TDocumentRef {
    const parsed = parseDocumentRef(args[index]);
    if (parsed === null) {
        throw new Error(`${fieldName} must be an absolute document reference`);
    }
    return parsed;
}

function decodeOptionalDocumentRef(value: unknown, fieldName: string): TDocumentRef | undefined {
    if (value === undefined) {
        return undefined;
    }
    const parsed = parseDocumentRef(value);
    if (parsed === null) {
        throw new Error(`${fieldName} must be an absolute document reference`);
    }
    return parsed;
}

function decodeOptionalPositiveInteger(value: unknown, fieldName: string) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${fieldName} must be a positive safe integer`);
    }
    return value;
}

function decodeOptionalString(value: unknown, fieldName: string) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new Error(`${fieldName} must be a string`);
    }
    return value;
}

function normalizeDjvuTextSearchOptions(options: unknown) {
    if (!isRecord(options)) {
        throw new TypeError('searchText.options must be an object');
    }
    const requestId = normalizeOptionalRequestId(
        options.requestId,
        'searchText.options.requestId',
    );
    if (!requestId) {
        throw new TypeError('searchText.options.requestId is required');
    }
    const pageCount = options.pageCount;
    if (typeof pageCount !== 'number' || !Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new TypeError('searchText.options.pageCount must be a positive safe integer');
    }
    return {
        requestId,
        pageCount,
        matchCase: Boolean(options.matchCase),
        wholeWord: Boolean(options.wholeWord),
        useRegex: Boolean(options.useRegex),
    };
}

function normalizeDjvuPagePreviewOptions(options: unknown) {
    if (options === undefined) {
        return undefined;
    }
    if (!isRecord(options)) {
        throw new TypeError('renderPagePreview.options must be an object');
    }

    const normalizedOptions: IDjvuPagePreviewOptions = {};
    const subsample = options.subsample;
    if (subsample !== undefined) {
        if (typeof subsample !== 'number' || !Number.isInteger(subsample) || subsample < 1) {
            throw new TypeError('renderPagePreview.options.subsample must be a positive integer');
        }
        normalizedOptions.subsample = subsample;
    }
    const targetWidthPx = options.targetWidthPx;
    if (targetWidthPx !== undefined) {
        if (typeof targetWidthPx !== 'number' || !Number.isInteger(targetWidthPx) || targetWidthPx < 1) {
            throw new TypeError('renderPagePreview.options.targetWidthPx must be a positive integer');
        }
        normalizedOptions.targetWidthPx = targetWidthPx;
    }
    const previewRequestId = options.previewRequestId;
    if (previewRequestId !== undefined) {
        const normalizedPreviewRequestId = normalizeOptionalRequestId(
            previewRequestId,
            'renderPagePreview.options.previewRequestId',
        );
        if (normalizedPreviewRequestId === undefined) {
            throw new TypeError('renderPagePreview.options.previewRequestId must be a non-empty string');
        }
        normalizedOptions.previewRequestId = normalizedPreviewRequestId;
    }
    const previewPriority = options.previewPriority;
    if (previewPriority !== undefined) {
        if (!isFiniteNumber(previewPriority)) {
            throw new TypeError('renderPagePreview.options.previewPriority must be a finite number');
        }
        normalizedOptions.previewPriority = previewPriority;
    }
    return normalizedOptions;
}

function normalizePrintPageNumbers(pageNumbers: unknown) {
    if (!Array.isArray(pageNumbers)) {
        throw new TypeError('printDjvuPath.options.pageNumbers must be an array');
    }
    return pageNumbers.map((pageNumber) => {
        if (typeof pageNumber !== 'number' || !Number.isInteger(pageNumber) || pageNumber < 1) {
            throw new TypeError('printDjvuPath.options.pageNumbers must contain positive integers');
        }
        return requirePageNumber(pageNumber);
    });
}

function normalizeDjvuConvertOptions(
    options: unknown,
    requestIdFieldName = 'startConvertToPdf.options.requestId',
) {
    if (!isRecord(options)) {
        throw new TypeError('startConvertToPdf.options must be an object');
    }

    const normalizedOptions: IDjvuConvertOptions = {};
    if (options.jobId !== undefined) {
        const jobId = normalizeOptionalJobId(options.jobId, 'startConvertToPdf.options.jobId');
        if (jobId === undefined) {
            throw new TypeError('startConvertToPdf.options.jobId must be a non-empty string');
        }
        normalizedOptions.jobId = jobId;
    }
    if (options.subsample !== undefined) {
        if (
            typeof options.subsample !== 'number'
            || !Number.isSafeInteger(options.subsample)
            || options.subsample < 1
        ) {
            throw new TypeError('startConvertToPdf.options.subsample must be a positive integer');
        }
        normalizedOptions.subsample = options.subsample;
    }
    if (options.preserveBookmarks !== undefined) {
        if (typeof options.preserveBookmarks !== 'boolean') {
            throw new TypeError('startConvertToPdf.options.preserveBookmarks must be a boolean');
        }
        normalizedOptions.preserveBookmarks = options.preserveBookmarks;
    }
    if (
        options.pdfStrategy !== undefined
        && options.pdfStrategy !== 'direct'
        && options.pdfStrategy !== 'compact-djvu-aware'
        && options.pdfStrategy !== 'auto'
    ) {
        throw new TypeError('startConvertToPdf.options.pdfStrategy is invalid');
    }
    if (options.pdfStrategy !== undefined) {
        normalizedOptions.pdfStrategy = options.pdfStrategy;
    }
    if (options.requestId !== undefined) {
        const requestId = normalizeOptionalRequestId(
            options.requestId,
            requestIdFieldName,
        );
        if (requestId === undefined) {
            throw new TypeError(`${requestIdFieldName} must be a non-empty string`);
        }
        normalizedOptions.requestId = requestId;
    }
    if (options.documentRef !== undefined) {
        const documentRef = parseDocumentRef(options.documentRef);
        if (documentRef === null) {
            throw new TypeError('startConvertToPdf.options.documentRef must be an absolute document reference');
        }
        normalizedOptions.documentRef = documentRef;
    }
    return normalizedOptions;
}

function normalizeDjvuPrintOptions(options: unknown) {
    if (!isRecord(options)) {
        throw new TypeError('printDjvuPath.options must be an object');
    }
    if (
        options.viewMode !== 'single'
        && options.viewMode !== 'facing'
        && options.viewMode !== 'facing-first-single'
    ) {
        throw new TypeError('printDjvuPath.options.viewMode is invalid');
    }
    if (
        options.orientation !== 'auto'
        && options.orientation !== 'portrait'
        && options.orientation !== 'landscape'
    ) {
        throw new TypeError('printDjvuPath.options.orientation is invalid');
    }
    if (
        options.pdfStrategy !== undefined
        && options.pdfStrategy !== 'direct'
        && options.pdfStrategy !== 'compact-djvu-aware'
        && options.pdfStrategy !== 'auto'
    ) {
        throw new TypeError('printDjvuPath.options.pdfStrategy is invalid');
    }
    if (
        options.subsample !== undefined
        && (
            typeof options.subsample !== 'number'
            || !Number.isSafeInteger(options.subsample)
            || options.subsample < 1
        )
    ) {
        throw new TypeError('printDjvuPath.options.subsample must be a positive integer');
    }
    const fileName = options.fileName;
    if (fileName !== undefined && typeof fileName !== 'string') {
        throw new TypeError('printDjvuPath.options.fileName must be a string');
    }
    const requestId = normalizeOptionalRequestId(
        options.requestId,
        'printDjvuPath.options.requestId',
    );

    const normalizedOptions: IDjvuPrintOptions = {
        viewMode: options.viewMode,
        orientation: options.orientation,
    };
    if (fileName !== undefined) {
        normalizedOptions.fileName = fileName;
    }
    if (options.pageNumbers !== undefined) {
        normalizedOptions.pageNumbers = normalizePrintPageNumbers(options.pageNumbers);
    }
    if (requestId !== undefined) {
        normalizedOptions.requestId = requestId;
    }
    if (options.subsample !== undefined) {
        normalizedOptions.subsample = options.subsample;
    }
    if (options.pdfStrategy !== undefined) {
        normalizedOptions.pdfStrategy = options.pdfStrategy;
    }
    return normalizedOptions;
}

function decodeConvertOptions(
    value: unknown,
    requestIdFieldName = 'startConvertToPdf.options.requestId',
) {
    return normalizeDjvuConvertOptions(
        value,
        requestIdFieldName,
    );
}

function decodePrintOptions(value: unknown) {
    if (isRecord(value) && value.pageNumbers !== undefined) {
        if (!Array.isArray(value.pageNumbers) || value.pageNumbers.length === 0) {
            throw new Error('pageNumbers must be a non-empty array');
        }
        if (value.pageNumbers.length > MAX_COLLECTION_ITEMS) {
            throw new Error(`pageNumbers exceeds maximum item count (${MAX_COLLECTION_ITEMS})`);
        }
    }
    return normalizeDjvuPrintOptions(value);
}

function decodePreviewOptions(value: unknown) {
    return normalizeDjvuPagePreviewOptions(value);
}

function decodeTextSearchOptions(value: unknown) {
    if (isRecord(value)) {
        for (const field of [
            'matchCase',
            'wholeWord',
            'useRegex',
        ] as const) {
            if (value[field] !== undefined && typeof value[field] !== 'boolean') {
                throw new Error(`${field} must be a boolean`);
            }
        }
    }
    return normalizeDjvuTextSearchOptions(value);
}

function decodeOptionalNonNegativeInteger(value: unknown) {
    if (value === undefined) {
        return undefined;
    }
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
}

function decodeTextSearchResponse(value: unknown) {
    const response = SEARCH_WIRE_CODEC.decodeResponse(value);
    if (!response) {
        throw new Error('DjVu text search result is invalid');
    }
    return response;
}

export function decodeDjvuTextSearchProgress(value: unknown): IDjvuTextSearchProgress | null {
    const resultsStartIndex = isRecord(value)
        ? decodeOptionalNonNegativeInteger(value.resultsStartIndex)
        : null;
    const requestId = isRecord(value) ? parseRequestId(value.requestId) : null;
    if (
        !isRecord(value)
        || requestId === null
        || typeof value.processed !== 'number'
        || !Number.isSafeInteger(value.processed)
        || value.processed < 0
        || typeof value.total !== 'number'
        || !Number.isSafeInteger(value.total)
        || value.total < 0
        || resultsStartIndex === null
        || (value.truncated !== undefined && typeof value.truncated !== 'boolean')
        || (value.canceled !== undefined && typeof value.canceled !== 'boolean')
        || (value.error !== undefined && typeof value.error !== 'string')
        || (
            value.status !== undefined
            && value.status !== 'running'
            && value.status !== 'success'
            && value.status !== 'canceled'
            && value.status !== 'failed'
        )
    ) {
        return null;
    }
    const results = value.results === undefined
        ? undefined
        : SEARCH_WIRE_CODEC.decodeResponse({
            results: value.results,
            truncated: Boolean(value.truncated),
        })?.results;
    if (value.results !== undefined && !results) {
        return null;
    }
    return {
        requestId,
        processed: value.processed,
        total: value.total,
        ...(results === undefined ? {} : {results}),
        ...(resultsStartIndex === undefined ? {} : {resultsStartIndex}),
        ...(value.truncated === undefined ? {} : {truncated: value.truncated}),
        ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
        ...(value.status === undefined ? {} : {status: value.status}),
        ...(value.error === undefined ? {} : {error: value.error}),
    };
}

function decodeDjvuProgress(payload: unknown): IDjvuProgress | null {
    const jobId = isRecord(payload) ? parseJobId(payload.jobId) : null;
    const requestId = isRecord(payload) && payload.requestId !== undefined
        ? parseRequestId(payload.requestId)
        : undefined;
    const documentRef = isRecord(payload) && payload.documentRef !== undefined
        ? parseDocumentRef(payload.documentRef)
        : undefined;
    if (
        !isRecord(payload)
        || jobId === null
        || !isFiniteNumber(payload.percent)
        || (
            payload.phase !== 'converting'
            && payload.phase !== 'bookmarks'
            && payload.phase !== 'optimizing'
            && payload.phase !== 'loading'
            && payload.phase !== 'printing'
        )
        || (payload.current !== undefined && !isFiniteNumber(payload.current))
        || (payload.total !== undefined && !isFiniteNumber(payload.total))
        || requestId === null
        || documentRef === null
        || (
            payload.status !== undefined
            && payload.status !== 'running'
            && payload.status !== 'success'
            && payload.status !== 'canceled'
            && payload.status !== 'failed'
        )
        || (payload.error !== undefined && typeof payload.error !== 'string')
    ) {
        return null;
    }

    return {
        jobId,
        ...(requestId === undefined ? {} : {requestId}),
        ...(documentRef === undefined ? {} : {documentRef}),
        phase: payload.phase,
        percent: payload.percent,
        ...(payload.status === undefined ? {} : {status: payload.status}),
        ...(payload.current === undefined ? {} : {current: payload.current}),
        ...(payload.total === undefined ? {} : {total: payload.total}),
        ...(payload.error === undefined ? {} : {error: payload.error}),
    };
}

function decodeOptionalResultString(value: unknown, fieldName: string) {
    return decodeOptionalString(value, fieldName);
}

function decodeOptionalJobId(value: unknown, fieldName: string): TJobId | undefined {
    if (value === undefined) {
        return undefined;
    }
    // A decoded result may omit the field, but a present null is malformed rather
    // than an omission the way it is for an outgoing optional argument.
    if (value === null) {
        throw new Error(`${fieldName} must be a valid job ID`);
    }
    return normalizeOptionalJobId(value, fieldName);
}

function decodeOptionalRequestId(value: unknown, fieldName: string): TRequestId | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (value === null) {
        throw new Error(`${fieldName} must be a string`);
    }
    return normalizeOptionalRequestId(value, fieldName);
}

function decodeFailureOutcomeFields(
    value: Record<string, unknown>,
    fieldPrefix: string,
) {
    let failure;
    if (value.failure !== undefined) {
        failure = decodeFailureReceipt(value.failure);
        if (failure === null) {
            throw new Error(`${fieldPrefix} has an invalid failure receipt`);
        }
    }

    let expected;
    if (value.expected !== undefined) {
        if (!isExpectedOutcome(value.expected)) {
            throw new Error(`${fieldPrefix} has an invalid expected outcome`);
        }
        expected = value.expected;
    }

    if (failure !== undefined && expected !== undefined) {
        throw new Error(`${fieldPrefix} cannot contain both failure and expected outcome`);
    }

    return {
        ...(failure === undefined ? {} : {failure}),
        ...(expected === undefined ? {} : {expected}),
    };
}

function decodeSuccessResult(value: unknown): Record<PropertyKey, unknown> & {success: boolean} {
    if (!isRecord(value) || typeof value.success !== 'boolean') {
        throw new Error('result must include success');
    }
    return {
        ...value,
        success: value.success,
    };
}

function decodeOpenResult(value: unknown) {
    const result = decodeSuccessResult(value);
    const jobId = decodeOptionalJobId(result.jobId, 'jobId');
    const requestId = decodeOptionalRequestId(result.requestId, 'requestId');
    const error = decodeOptionalResultString(result.error, 'error');
    const pageCount = decodeOptionalPositiveInteger(result.pageCount, 'pageCount');
    const pageSourceInfo = result.pageSourceInfo === undefined
        ? undefined
        : decodeDjvuPageSourceInfo(result.pageSourceInfo);
    return {
        success: result.success,
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(pageSourceInfo === undefined ? {} : {pageSourceInfo}),
        ...(jobId === undefined ? {} : {jobId}),
        ...(requestId === undefined ? {} : {requestId}),
        ...(error === undefined ? {} : {error}),
    };
}

function decodeJobStartHandle(value: unknown) {
    const jobId = isRecord(value) ? parseJobId(value.jobId) : null;
    const requestId = isRecord(value) ? parseRequestId(value.requestId) : null;
    if (!isRecord(value) || jobId === null || requestId === null) {
        throw new Error('invalid DjVu job start handle');
    }
    return {
        jobId,
        requestId,
    };
}

function decodeConvertResult(value: unknown) {
    const result = decodeSuccessResult(value);
    const pdfPath = decodeOptionalDocumentRef(result.pdfPath, 'pdfPath');
    const jobId = decodeOptionalJobId(result.jobId, 'jobId');
    const requestId = decodeOptionalRequestId(result.requestId, 'requestId');
    const documentRef = decodeOptionalDocumentRef(result.documentRef, 'documentRef');
    const error = decodeOptionalResultString(result.error, 'error');
    const failureOutcome = decodeFailureOutcomeFields(result, 'DjVu conversion result');
    if (result.success && Object.keys(failureOutcome).length > 0) {
        throw new Error('successful DjVu conversion result cannot contain a failure outcome');
    }
    return {
        success: result.success,
        ...(pdfPath === undefined ? {} : {pdfPath}),
        ...(jobId === undefined ? {} : {jobId}),
        ...(requestId === undefined ? {} : {requestId}),
        ...(documentRef === undefined ? {} : {documentRef}),
        ...(error === undefined ? {} : {error}),
        ...failureOutcome,
    };
}

function decodePrintResult(value: unknown) {
    const result = decodeSuccessResult(value);
    const jobId = decodeOptionalJobId(result.jobId, 'jobId');
    const error = decodeOptionalResultString(result.error, 'error');
    if (result.canceled !== undefined && typeof result.canceled !== 'boolean') {
        throw new Error('canceled must be a boolean');
    }
    return {
        success: result.success,
        ...(result.canceled === undefined ? {} : {canceled: result.canceled}),
        ...(jobId === undefined ? {} : {jobId}),
        ...(error === undefined ? {} : {error}),
    };
}

function decodeCanceledResult(value: unknown) {
    if (!isRecord(value) || typeof value.canceled !== 'boolean') {
        throw new Error('result must include canceled');
    }
    return {canceled: value.canceled};
}

function decodeJobProgress(value: unknown): IDjvuProgress {
    const jobId = isRecord(value) ? parseJobId(value.jobId) : null;
    const requestId = isRecord(value) && value.requestId !== undefined
        ? parseRequestId(value.requestId)
        : undefined;
    const documentRef = isRecord(value) && value.documentRef !== undefined
        ? parseDocumentRef(value.documentRef)
        : undefined;
    if (
        !isRecord(value)
        || jobId === null
        || requestId === null
        || documentRef === null
        || !isFiniteNumber(value.percent)
    ) {
        throw new Error('invalid document output progress');
    }
    const phase = DJVU_PROGRESS_PHASES.find(candidate => candidate === value.phase);
    if (phase === undefined) {
        throw new Error('invalid document output progress');
    }
    return {
        jobId,
        phase,
        percent: value.percent,
        ...(requestId === undefined ? {} : {requestId}),
        ...(documentRef === undefined ? {} : {documentRef}),
        ...(isFiniteNumber(value.current) ? {current: value.current} : {}),
        ...(isFiniteNumber(value.total) ? {total: value.total} : {}),
        ...(value.status === 'running' || value.status === 'success' || value.status === 'canceled' || value.status === 'failed'
            ? {status: value.status}
            : {}),
        ...(typeof value.error === 'string' ? {error: value.error} : {}),
    };
}

function decodeJobState(value: unknown): TDocumentOutputJobState | null {
    if (value === null) {
        return null;
    }
    if (!isRecord(value)) {
        throw new Error('invalid document output job state');
    }
    const operation = value.operation;
    const jobId = parseJobId(value.jobId);
    const updatedAtMs = parseEpochMs(value.updatedAtMs);
    if (
        jobId === null
        || !isDjvuDocumentOutputOperation(operation)
        || ![
            'queued',
            'running',
            'handoff',
            'completed',
            'canceled',
            'failed',
        ].includes(String(value.status))
        || updatedAtMs === null
    ) {
        throw new Error('invalid document output job state');
    }
    const progress = decodeJobProgress(value.progress);
    if (value.status === 'handoff') {
        const artifactPath = parseDocumentRef(value.artifactPath);
        if (artifactPath === null) throw new Error('handoff state requires artifactPath');
        return {
            jobId,
            operation,
            status: 'handoff',
            artifactPath,
            progress,
            updatedAtMs,
        };
    }
    if (value.status === 'completed') {
        return {
            jobId,
            operation,
            status: 'completed',
            ...(value.artifactPath === undefined ? {} : {artifactPath: parseDocumentRef(value.artifactPath) ?? (() => { throw new Error('invalid artifact path'); })()}),
            progress,
            updatedAtMs,
        };
    }
    if (value.status === 'failed' || value.status === 'canceled') {
        const failureOutcome = decodeFailureOutcomeFields(value, 'DjVu job state');
        if (value.status === 'canceled' && 'failure' in failureOutcome) {
            throw new Error('canceled DjVu job state cannot contain a failure receipt');
        }
        return {
            jobId,
            operation,
            status: value.status,
            ...(typeof value.error === 'string' ? {error: value.error} : {}),
            ...failureOutcome,
            progress,
            updatedAtMs,
        };
    }
    return {
        jobId,
        operation,
        status: value.status === 'queued' ? 'queued' : 'running',
        progress,
        updatedAtMs,
    };
}

function decodeInfoResult(value: unknown) {
    if (
        !isRecord(value)
        || typeof value.pageCount !== 'number'
        || !Number.isSafeInteger(value.pageCount)
        || value.pageCount < 0
        || !isFiniteNumber(value.sourceDpi)
        || typeof value.hasBookmarks !== 'boolean'
        || typeof value.hasText !== 'boolean'
        || !isRecord(value.metadata)
        || Object.values(value.metadata).some(item => typeof item !== 'string')
    ) {
        throw new Error('invalid DjVu info result');
    }
    const metadata: Record<string, string> = {};
    for (const [
        key,
        item,
    ] of Object.entries(value.metadata)) {
        if (typeof item !== 'string') {
            throw new Error('invalid DjVu metadata');
        }
        metadata[key] = item;
    }
    return {
        pageCount: value.pageCount,
        sourceDpi: value.sourceDpi,
        hasBookmarks: value.hasBookmarks,
        hasText: value.hasText,
        metadata,
    };
}

function decodeSizeEstimate(value: unknown) {
    if (
        !isRecord(value)
        || typeof value.subsample !== 'number'
        || !Number.isSafeInteger(value.subsample)
        || value.subsample < 1
        || typeof value.label !== 'string'
        || typeof value.description !== 'string'
        || !isFiniteNumber(value.resultingDpi)
        || typeof value.estimatedBytes !== 'number'
        || !Number.isSafeInteger(value.estimatedBytes)
        || value.estimatedBytes < 0
    ) {
        throw new Error('invalid DjVu size estimate');
    }
    return {
        subsample: value.subsample,
        label: value.label,
        description: value.description,
        resultingDpi: value.resultingDpi,
        estimatedBytes: value.estimatedBytes,
    };
}

function decodeSizeEstimatesResult(value: unknown) {
    if (!Array.isArray(value)) {
        throw new Error('size estimates must be an array');
    }
    return value.map(decodeSizeEstimate);
}

function argsSchema<TArgs extends unknown[]>(
    decode: (value: readonly unknown[]) => TArgs,
    example: () => TArgs,
): IRuntimeSchema<TArgs> {
    return {
        decode: value => decode(Array.isArray(value) ? value : []),
        encode: value => value,
        example,
    };
}

function resultSchema<TResult>(
    decode: (value: unknown) => TResult,
    example: () => TResult,
) {
    return s.declared<TResult>()(s.fromParser(decode, example));
}

function singleDocumentRefArgs(
    fieldName: string,
    example: TDocumentRef,
) {
    return argsSchema<[TDocumentRef]>(
        args => [decodeDocumentRefArg(requireArgs(args, 1), 0, fieldName)],
        () => [example],
    );
}

function singleJobIdArgs(fieldName: string, example: TJobId) {
    return argsSchema<[TJobId]>(
        (args) => {
            const value = normalizeOptionalJobId(
                decodeStringArg(requireArgs(args, 1), 0, fieldName),
                fieldName,
            );
            if (value === undefined) {
                throw new Error(`${fieldName} must be a non-empty string`);
            }
            return [value];
        },
        () => [example],
    );
}

function singleRequestIdArgs(fieldName: string, example: TRequestId) {
    return argsSchema<[TRequestId]>(
        (args) => {
            const value = decodeStringArg(requireArgs(args, 1), 0, fieldName);
            const normalized = normalizeOptionalRequestId(value, fieldName);
            if (normalized === undefined) {
                throw new Error(`${fieldName} must be a non-empty string`);
            }
            return [normalized];
        },
        () => [example],
    );
}

const documentArgs = singleDocumentRefArgs(
    'djvuPath',
    parseDocumentRef('/tmp/fixture.djvu') ?? (() => {
        throw new Error('invalid fixture document reference');
    })(),
);
const jobArgs = singleJobIdArgs(
    'jobId',
    parseJobId('djvu-convert-fixture') ?? (() => {
        throw new Error('invalid fixture job ID');
    })(),
);
const cancelPreviewArgs = singleRequestIdArgs(
    'cancelPagePreview.requestId',
    parseRequestId('djvu-preview-fixture') ?? (() => {
        throw new Error('invalid fixture request ID');
    })(),
);
const cancelTextSearchArgs = singleRequestIdArgs(
    'cancelTextSearch.requestId',
    parseRequestId('djvu-search-fixture') ?? (() => {
        throw new Error('invalid fixture request ID');
    })(),
);
const tempPathArgs = singleDocumentRefArgs(
    'tempPdfPath',
    parseDocumentRef('/tmp/djvu-fixture.pdf') ?? (() => {
        throw new Error('invalid fixture document reference');
    })(),
);
const startOpenArgs = argsSchema<[TDocumentRef, TRequestId]>(
    (args) => {
        requireArgs(args, 2);
        const requestId = normalizeOptionalRequestId(
            decodeStringArg(args, 1, 'requestId'),
            'startOpenForViewing.requestId',
        );
        if (requestId === undefined) {
            throw new Error('startOpenForViewing.requestId must be a non-empty string');
        }
        return [
            decodeDocumentRefArg(args, 0, 'djvuPath'),
            requestId,
        ];
    },
    () => [
        parseDocumentRef('/tmp/fixture.djvu') ?? (() => {
            throw new Error('invalid fixture document reference');
        })(),
        parseRequestId('djvu-open-fixture') ?? (() => {
            throw new Error('invalid fixture request ID');
        })(),
    ],
);
const startConvertArgs = argsSchema<[TDocumentRef, TDocumentRef, IDjvuConvertOptions]>(
    (args) => {
        requireArgs(args, 3);
        const options = decodeConvertOptions(
            args[2],
            'startConvertToPdf.options.requestId',
        );
        if (!options.requestId) {
            throw new Error('startConvertToPdf.options.requestId is required');
        }
        return [
            decodeDocumentRefArg(args, 0, 'djvuPath'),
            decodeDocumentRefArg(args, 1, 'outputPath'),
            options,
        ];
    },
    () => [
        parseDocumentRef('/tmp/fixture.djvu') ?? (() => {
            throw new Error('invalid fixture document reference');
        })(),
        parseDocumentRef('/tmp/fixture.pdf') ?? (() => {
            throw new Error('invalid fixture document reference');
        })(),
        {
            preserveBookmarks: true,
            requestId: parseRequestId('djvu-convert-fixture') ?? (() => {
                throw new Error('invalid fixture request ID');
            })(),
        },
    ],
);
const printArgs = argsSchema<[TDocumentRef, IDjvuPrintOptions]>(
    (args) => {
        requireArgs(args, 2);
        return [
            decodeDocumentRefArg(args, 0, 'djvuPath'),
            decodePrintOptions(args[1]),
        ];
    },
    () => [
        parseDocumentRef('/tmp/fixture.djvu') ?? (() => {
            throw new Error('invalid fixture document reference');
        })(),
        {
            viewMode: 'single',
            orientation: 'auto',
        },
    ],
);
const searchTextArgs = argsSchema<[TDocumentRef, string, IDjvuTextSearchOptions]>(
    (args) => {
        requireArgs(args, 3);
        return [
            decodeDocumentRefArg(args, 0, 'djvuPath'),
            decodeStringArg(args, 1, 'query'),
            decodeTextSearchOptions(args[2]),
        ];
    },
    () => [
        parseDocumentRef('/tmp/fixture.djvu') ?? (() => {
            throw new Error('invalid fixture document reference');
        })(),
        'needle',
        {
            requestId: parseRequestId('djvu-search-fixture') ?? (() => {
                throw new Error('invalid fixture request ID');
            })(),
            pageCount: 1,
        },
    ],
);
const pageSourceInfoArgs = argsSchema<[TDocumentRef, number]>(
    args => [
        decodeDocumentRefArg(requireArgs(args, 2), 0, 'djvuPath'),
        decodeSafeIntegerArg(args, 1, 'pageNumber', 1),
    ],
    () => [
        parseDocumentRef('/tmp/fixture.djvu') ?? (() => {
            throw new Error('invalid fixture document reference');
        })(),
        1,
    ],
);
const previewArgs = argsSchema<[
    TDocumentRef,
    number,
    IDjvuPagePreviewOptions | undefined,
]>(
    (args) => {
        requireArgs(args, {
            min: 2,
            max: 3,
        });
        return [
            decodeDocumentRefArg(args, 0, 'djvuPath'),
            decodeSafeIntegerArg(args, 1, 'pageNumber', 1),
            decodePreviewOptions(args[2]),
        ];
    },
    () => [
        parseDocumentRef('/tmp/fixture.djvu') ?? (() => {
            throw new Error('invalid fixture document reference');
        })(),
        1,
        {targetWidthPx: 800},
    ],
);

const openResult = resultSchema<IDjvuOpenResult>(
    decodeOpenResult,
    () => ({
        success: true,
        pageCount: 1,
    }),
);
const convertResult = resultSchema<IDjvuConvertResult>(
    decodeConvertResult,
    () => ({
        success: true,
        pdfPath: parseDocumentRef('/tmp/fixture.pdf') ?? (() => {
            throw new Error('invalid fixture document reference');
        })(),
        jobId: parseJobId('djvu-convert-fixture') ?? (() => {
            throw new Error('invalid fixture job ID');
        })(),
    }),
);
const jobStartResult = resultSchema<IDjvuJobStartHandle>(
    decodeJobStartHandle,
    () => ({
        jobId: parseJobId('djvu-job-fixture') ?? (() => {
            throw new Error('invalid fixture job ID');
        })(),
        requestId: parseRequestId('djvu-request-fixture') ?? (() => {
            throw new Error('invalid fixture request ID');
        })(),
    }),
);
const canceledResult = resultSchema(
    decodeCanceledResult,
    () => ({canceled: false}),
);
const jobStateResult = resultSchema<TDocumentOutputJobState | null>(
    decodeJobState,
    () => null,
);
const progress = s.declared<IDjvuProgress>()(
    s.fromNullableDecoder(decodeDjvuProgress, 'DjVu progress', () => ({
        jobId: parseJobId('djvu-job-fixture') ?? (() => {
            throw new Error('invalid fixture job ID');
        })(),
        phase: 'converting',
        percent: 0,
        status: 'running',
    })),
);
const textSearchProgress = s.declared<IDjvuTextSearchProgress>()(
    s.fromNullableDecoder(
        decodeDjvuTextSearchProgress,
        'DjVu text search progress',
        () => ({
            requestId: parseRequestId('djvu-search-fixture') ?? (() => {
                throw new Error('invalid fixture request ID');
            })(),
            processed: 0,
            total: 1,
            status: 'running',
        }),
    ),
);
const voidResult = s.declared<TVoidResult>()(s.undefined());
const progressReplay = {
    owner: 'ipc-progress-pump',
    mode: 'latest-per-key',
    key: (payload: IDjvuProgress) => `${payload.jobId}:${payload.phase}`,
    terminal: (payload: IDjvuProgress) =>
        payload.status === 'success'
        || payload.status === 'canceled'
        || payload.status === 'failed',
    intervalMs: 50,
    terminalRetentionMs: 30_000,
} as const;

function defineDjvuMethod<
    const TName extends string,
    const TChannel extends string,
    const TArgs extends IRuntimeSchema<unknown[]>,
    const TResult extends IRuntimeSchema<unknown>,
>(definition: {
    name: TName;
    channel: TChannel;
    args: TArgs;
    result: TResult;
    timeout?: boolean;
}) {
    return {
        kind: 'async',
        channel: definition.channel,
        ipc: {
            args: definition.args,
            result: definition.result,
            ...(definition.timeout ? {timeoutMs: DJVU_NATIVE_IPC_TIMEOUT_MS} : {}),
        },
        main: {
            method: definition.name,
            context: 'sender',
        },
        browser: {method: definition.name},
        lazy: 'forwarded',
    } as const;
}

function defineDjvuClientMethod<
    const TName extends string,
    const TChannel extends string,
    const TArgs extends IRuntimeSchema<unknown[]>,
    const TResult extends IRuntimeSchema<unknown>,
    const TMapArgs extends (...args: never[]) => ReturnType<TArgs['decode']>,
>(definition: {
    name: TName;
    channel: TChannel;
    args: TArgs;
    result: TResult;
    mapArgs: TMapArgs;
    timeout?: boolean;
}) {
    return {
        ...defineDjvuMethod(definition),
        client: {mapArgs: definition.mapArgs},
    } as const;
}

function defineOptionalNativeDjvuMethod<
    const TName extends string,
    const TChannel extends string,
    const TArgs extends IRuntimeSchema<unknown[]>,
    const TResult extends IRuntimeSchema<unknown>,
>(definition: {
    name: TName;
    channel: TChannel;
    args: TArgs;
    result: TResult;
    timeout?: boolean;
}) {
    return {
        ...defineDjvuMethod(definition),
        browser: {
            unsupported: 'omitted',
            reason: 'requires-native-backend',
        },
        optionalWhenImplemented: true,
        required: {
            browser: false,
            electron: false,
        },
    } as const;
}

export const DJVU_PLATFORM_FEATURE = definePlatformFeature({
    path: ['djvu'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        startOpenForViewing: defineDjvuClientMethod({
            name: 'startOpenForViewing',
            channel: 'djvu:open:start',
            args: startOpenArgs,
            result: jobStartResult,
            timeout: true,
            mapArgs: (
                djvuPath: TDocumentRef,
                requestId: TRequestId,
            ): [TDocumentRef, TRequestId] => [
                djvuPath,
                requestId,
            ],
        }),
        releaseViewingPath: defineDjvuMethod({
            name: 'releaseViewingPath',
            channel: 'djvu:releaseViewingPath',
            args: documentArgs,
            result: voidResult,
        }),
        startConvertToPdf: defineDjvuClientMethod({
            name: 'startConvertToPdf',
            channel: 'djvu:convert:start',
            args: startConvertArgs,
            result: jobStartResult,
            timeout: true,
            mapArgs: (
                djvuPath: TDocumentRef,
                outputPath: TDocumentRef,
                options: IDjvuConvertOptions,
            ): [TDocumentRef, TDocumentRef, IDjvuConvertOptions] => [
                djvuPath,
                outputPath,
                normalizeDjvuConvertOptions(options),
            ],
        }),
        printDjvuPath: defineDjvuClientMethod({
            name: 'printDjvuPath',
            channel: 'djvu:printDjvuPath',
            args: printArgs,
            result: resultSchema<IDjvuPrintResult>(
                decodePrintResult,
                () => ({success: true}),
            ),
            timeout: true,
            mapArgs: (
                djvuPath: TDocumentRef,
                options: IDjvuPrintOptions,
            ): [TDocumentRef, IDjvuPrintOptions] => [
                djvuPath,
                normalizeDjvuPrintOptions(options),
            ],
        }),
        cancel: defineDjvuMethod({
            name: 'cancel',
            channel: 'djvu:cancel',
            args: jobArgs,
            result: canceledResult,
        }),
        getJobState: defineDjvuMethod({
            name: 'getJobState',
            channel: 'djvu:job:getState',
            args: jobArgs,
            result: jobStateResult,
        }),
        cancelPagePreview: defineDjvuClientMethod({
            name: 'cancelPagePreview',
            channel: 'djvu:cancelPagePreview',
            args: cancelPreviewArgs,
            result: canceledResult,
            mapArgs: (requestId: TRequestId): [TRequestId] => [requestId],
        }),
        searchText: defineDjvuClientMethod({
            name: 'searchText',
            channel: 'djvu:text:search',
            args: searchTextArgs,
            result: resultSchema(
                decodeTextSearchResponse,
                () => ({
                    results: [],
                    truncated: false,
                }),
            ),
            timeout: true,
            mapArgs: (
                djvuPath: TDocumentRef,
                query: string,
                options: IDjvuTextSearchOptions,
            ): [TDocumentRef, string, IDjvuTextSearchOptions] => [
                djvuPath,
                query,
                normalizeDjvuTextSearchOptions(options),
            ],
        }),
        cancelTextSearch: defineDjvuClientMethod({
            name: 'cancelTextSearch',
            channel: 'djvu:text:cancel',
            args: cancelTextSearchArgs,
            result: canceledResult,
            mapArgs: (requestId: TRequestId): [TRequestId] => [requestId],
        }),
        getInfo: defineDjvuMethod({
            name: 'getInfo',
            channel: 'djvu:getInfo',
            args: documentArgs,
            result: resultSchema<IDjvuInfo>(decodeInfoResult, () => ({
                pageCount: 1,
                sourceDpi: 300,
                hasBookmarks: false,
                hasText: false,
                metadata: {},
            })),
            timeout: true,
        }),
        getPageSourceInfo: defineDjvuMethod({
            name: 'getPageSourceInfo',
            channel: 'djvu:getPageSourceInfo',
            args: pageSourceInfoArgs,
            result: resultSchema<IDjvuPageSourceInfo>(decodeDjvuPageSourceInfo, () => ({
                pageCount: 1,
                pageNumber: requirePageNumber(1),
                pageSize: {
                    width: 600,
                    height: 800,
                    dpi: 300,
                },
            })),
            timeout: true,
        }),
        getPageSizes: defineDjvuMethod({
            name: 'getPageSizes',
            channel: 'djvu:getPageSizes',
            args: documentArgs,
            result: resultSchema<IDjvuPageSize[]>(decodeDjvuPageSizes, () => [{
                width: 600,
                height: 800,
                dpi: 300,
            }]),
            timeout: true,
        }),
        getPageText: defineOptionalNativeDjvuMethod({
            name: 'getPageText',
            channel: 'djvu:getPageText',
            args: pageSourceInfoArgs,
            result: resultSchema<string>(
                decodeDjvuPageText,
                () => '',
            ),
            timeout: true,
        }),
        getOutline: defineOptionalNativeDjvuMethod({
            name: 'getOutline',
            channel: 'djvu:getOutline',
            args: documentArgs,
            result: resultSchema<IDjvuOutlineItem[]>(
                decodeDjvuOutline,
                () => [],
            ),
            timeout: true,
        }),
        renderPagePreview: defineDjvuClientMethod({
            name: 'renderPagePreview',
            channel: 'djvu:renderPagePreview',
            args: previewArgs,
            result: resultSchema<IDjvuPagePreview>(
                decodeDjvuPagePreview,
                () => ({
                    bytes: new Uint8Array([1]),
                    width: 600,
                    height: 800,
                }),
            ),
            timeout: true,
            mapArgs: (
                djvuPath: TDocumentRef,
                pageNumber: TPageNumber,
                options?: IDjvuPagePreviewOptions,
            ): [TDocumentRef, number, IDjvuPagePreviewOptions | undefined] => [
                djvuPath,
                pageNumber,
                normalizeDjvuPagePreviewOptions(options),
            ],
        }),
        estimateSizes: defineDjvuMethod({
            name: 'estimateSizes',
            channel: 'djvu:estimateSizes',
            args: documentArgs,
            result: resultSchema<IDjvuSizeEstimate[]>(decodeSizeEstimatesResult, () => [{
                subsample: 1,
                label: 'Original',
                description: 'Original resolution',
                resultingDpi: 300,
                estimatedBytes: 1,
            }]),
            timeout: true,
        }),
        cleanupTemp: defineDjvuMethod({
            name: 'cleanupTemp',
            channel: 'djvu:cleanupTemp',
            args: tempPathArgs,
            result: voidResult,
        }),
    },
    events: {
        onProgress: {
            kind: 'event',
            channel: 'djvu:progress',
            payload: progress,
            subscription: {
                channel: 'djvu:progress:subscribe',
                request: 'once-per-preload-event-channel',
                main: {
                    method: 'subscribeProgress',
                    context: 'sender',
                },
                replay: progressReplay,
            },
            browser: {method: 'onProgress'},
            lazy: 'forwarded',
        },
        onConvertComplete: {
            kind: 'event',
            channel: 'djvu:convert:complete',
            payload: convertResult,
            browser: {method: 'onConvertComplete'},
            lazy: 'forwarded',
        },
        onOpenComplete: {
            kind: 'event',
            channel: 'djvu:open:complete',
            payload: openResult,
            browser: {method: 'onOpenComplete'},
            lazy: 'forwarded',
        },
        onTextSearchProgress: {
            kind: 'event',
            channel: 'djvu:text:progress',
            payload: textSearchProgress,
            browser: {method: 'onTextSearchProgress'},
            lazy: 'forwarded',
        },
        onMenuConvertToPdf: {
            kind: 'event',
            channel: 'menu:convertToPdf',
            payload: s.undefined(),
            browser: {method: 'onMenuConvertToPdf'},
            lazy: 'forwarded',
        },
    },
});

export type IDjvuCapability = TFeatureCapability<typeof DJVU_PLATFORM_FEATURE>;
export type IDjvuInvokeMap = TFeatureInvokeMap<typeof DJVU_PLATFORM_FEATURE>;
export type IDjvuEventMap = TFeatureEventMap<typeof DJVU_PLATFORM_FEATURE>;
