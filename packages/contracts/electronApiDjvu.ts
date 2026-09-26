import {parseDocumentRef} from '@contracts/documentRef';
import {EXPECTED_OUTCOME_CODES} from '@contracts/diagnostics/failureReceipt';
import type {TPageNumber} from '@contracts/pageNumbers';
import {parsePageNumber} from '@contracts/pageNumbers';
import type {
    pdfSearchProgressSchema,
    pdfSearchResponseSchema,
} from '@contracts/search';
import {
    DJVU_OUTLINE_MAX_DEPTH, DJVU_OUTLINE_MAX_NODES, DJVU_OUTLINE_MAX_TITLE_CHARS, DJVU_SEARCH_MAX_PAGE_TEXT_CHARS,
} from '@contracts/djvuResourceLimits';
import {
    parseJobId, parseRequestId,
} from '@contracts/shared';
import {parseEpochMs} from '@contracts/timestamps';
import * as v from 'valibot';

export type {TDjvuPdfExportStrategy} from '@contracts/djvuConversionPolicy';

const error = 'invalid DjVu payload';
const nonNegativeSafeInteger = v.pipe(v.number(error), v.check(value => Number.isSafeInteger(value), error), v.minValue(0, error));
const positiveSafeInteger = v.pipe(v.number(error), v.check(value => Number.isSafeInteger(value), error), v.minValue(1, error));
const finiteNumber = v.pipe(v.number(error), v.finite(error));
const pageNumberSchema = v.pipe(v.number(error), v.check(value => parsePageNumber(value) !== null, error), v.transform(value => parsePageNumber(value)!));
const documentRefSchema = v.pipe(v.string(error), v.check(value => parseDocumentRef(value) !== null, error), v.transform(value => parseDocumentRef(value)!));
const jobIdSchema = v.pipe(v.string(error), v.check(value => parseJobId(value) !== null, error), v.transform(value => parseJobId(value)!));
const requestIdSchema = (fieldName = 'requestId') => v.pipe(v.string(`${fieldName} must be a string`), v.transform(value => value.trim()), v.maxLength(128, `${fieldName} exceeds maximum length (128)`), v.check(value => parseRequestId(value) !== null, `${fieldName} must be a valid request ID`), v.transform(value => parseRequestId(value)!));
const positiveSafeIntegerWithMessage = (message: string) => v.pipe(v.number(message), v.check(value => Number.isSafeInteger(value), message), v.minValue(1, message));
const epochMsSchema = v.pipe(v.number(error), v.check(value => parseEpochMs(value) !== null, error), v.transform(value => parseEpochMs(value)!));
const failureReceiptSchema = v.strictObject({
    eventId: v.pipe(v.string(error), v.regex(/^[0-9a-f]{32}$/u, error)),
    code: v.pipe(v.string(error), v.regex(/^[A-Z][A-Z0-9_]{1,79}$/u, error)),
    occurredAt: epochMsSchema,
    severity: v.picklist([
        'error',
        'fatal',
    ], error),
}, error);
const expectedOutcomeSchema = v.strictObject({
    kind: v.literal('expected'),
    code: v.picklist(EXPECTED_OUTCOME_CODES, error),
}, error);

export const djvuPageSizeSchema = v.object({
    width: finiteNumber,
    height: finiteNumber,
    dpi: finiteNumber,
}, error);
export type IDjvuPageSize = v.InferOutput<typeof djvuPageSizeSchema>;

export const djvuPageSourceInfoSchema = v.pipe(v.object({
    pageCount: positiveSafeInteger,
    pageNumber: positiveSafeInteger,
    pageSize: djvuPageSizeSchema,
    sourceSize: v.optional(v.unknown()),
    sourceModifiedAt: v.optional(epochMsSchema),
}, error), v.check(value => value.pageNumber <= value.pageCount, error), v.transform(value => ({
    pageCount: value.pageCount,
    pageNumber: parsePageNumber(value.pageNumber)!,
    pageSize: value.pageSize,
    ...(typeof value.sourceSize === 'number' && Number.isSafeInteger(value.sourceSize) && value.sourceSize >= 0 ? {sourceSize: value.sourceSize} : {}),
    ...(value.sourceModifiedAt === undefined ? {} : {sourceModifiedAt: value.sourceModifiedAt}),
})));
export type IDjvuPageSourceInfo = v.InferOutput<typeof djvuPageSourceInfoSchema>;

export const djvuPagePreviewSchema = v.object({
    bytes: v.instance(Uint8Array, error),
    width: finiteNumber,
    height: finiteNumber,
}, error);
export type IDjvuPagePreview = v.InferOutput<typeof djvuPagePreviewSchema>;

export const djvuPagePreviewOptionsSchema = v.object({
    previewPriority: v.optional(finiteNumber),
    previewRequestId: v.optional(requestIdSchema('renderPagePreview.options.previewRequestId')),
    subsample: v.optional(v.pipe(v.number(error), v.integer(error), v.minValue(1, error))),
    targetWidthPx: v.optional(v.pipe(v.number(error), v.integer(error), v.minValue(1, error))),
}, error);
export type IDjvuPagePreviewOptions = v.InferOutput<typeof djvuPagePreviewOptionsSchema>;

export const djvuTextSearchOptionsSchema = v.object({
    requestId: requestIdSchema('searchText.options.requestId'),
    pageCount: positiveSafeIntegerWithMessage('searchText.options.pageCount must be a positive safe integer'),
    matchCase: v.optional(v.boolean('matchCase must be a boolean')),
    wholeWord: v.optional(v.boolean('wholeWord must be a boolean')),
    useRegex: v.optional(v.boolean('useRegex must be a boolean')),
}, error);
export type IDjvuTextSearchOptions = v.InferOutput<typeof djvuTextSearchOptionsSchema>;
export type IDjvuTextSearchProgress = v.InferOutput<typeof pdfSearchProgressSchema>;
export type IDjvuTextSearchResponse = v.InferOutput<typeof pdfSearchResponseSchema>;

export const djvuConvertOptionsSchema = v.pipe(v.object({
    jobId: v.optional(jobIdSchema),
    subsample: v.optional(positiveSafeInteger),
    preserveBookmarks: v.optional(v.boolean(error)),
    pdfStrategy: v.optional(v.picklist([
        'direct',
        'compact-djvu-aware',
        'auto',
    ], error)),
    requestId: v.optional(requestIdSchema('startConvertToPdf.options.requestId')),
    documentRef: v.optional(documentRefSchema),
    hostTier: v.optional(v.picklist([
        'low',
        'medium',
        'high',
    ], error)),
}, error), v.transform(value => ({
    ...(value.jobId === undefined ? {} : {jobId: value.jobId}),
    ...(value.subsample === undefined ? {} : {subsample: value.subsample}),
    ...(value.preserveBookmarks === undefined ? {} : {preserveBookmarks: value.preserveBookmarks}),
    ...(value.pdfStrategy === undefined ? {} : {pdfStrategy: value.pdfStrategy}),
    ...(typeof value.requestId !== 'string' || value.requestId.trim().length === 0 ? {} : {requestId: parseRequestId(value.requestId.trim())!}),
    ...(value.documentRef === undefined ? {} : {documentRef: value.documentRef}),
    ...(value.hostTier === undefined ? {} : {hostTier: value.hostTier}),
})));
export type IDjvuConvertOptions = v.InferOutput<typeof djvuConvertOptionsSchema>;

export const djvuPrintOptionsSchema = v.pipe(v.object({
    fileName: v.optional(v.string(error)),
    pageNumbers: v.optional(v.pipe(v.array(pageNumberSchema, error), v.minLength(1, 'pageNumbers must be a non-empty array'), v.maxLength(100_000, 'pageNumbers exceeds maximum item count (100000)'))),
    viewMode: v.picklist([
        'single',
        'facing',
        'facing-first-single',
    ], error),
    orientation: v.picklist([
        'auto',
        'portrait',
        'landscape',
    ], error),
    requestId: v.optional(v.unknown()),
    subsample: v.optional(positiveSafeInteger),
    pdfStrategy: v.optional(v.picklist([
        'direct',
        'compact-djvu-aware',
        'auto',
    ], error)),
}, error), v.check(value => value.requestId === undefined || value.requestId === null || typeof value.requestId === 'string' && (value.requestId.trim().length === 0 || value.requestId.trim().length <= 128 && parseRequestId(value.requestId.trim()) !== null), error), v.transform(value => ({
    viewMode: value.viewMode,
    orientation: value.orientation,
    ...(value.fileName === undefined ? {} : {fileName: value.fileName}),
    ...(value.pageNumbers === undefined ? {} : {pageNumbers: value.pageNumbers}),
    ...(typeof value.requestId !== 'string' || value.requestId.trim().length === 0 ? {} : {requestId: parseRequestId(value.requestId.trim())!}),
    ...(value.subsample === undefined ? {} : {subsample: value.subsample}),
    ...(value.pdfStrategy === undefined ? {} : {pdfStrategy: value.pdfStrategy}),
})));
export type IDjvuPrintOptions = v.InferOutput<typeof djvuPrintOptionsSchema>;

export const djvuInfoSchema = v.object({
    pageCount: nonNegativeSafeInteger,
    sourceDpi: finiteNumber,
    hasBookmarks: v.boolean(error),
    hasText: v.boolean(error),
    metadata: v.record(v.string(), v.string(error), error),
}, error);
export type IDjvuInfo = v.InferOutput<typeof djvuInfoSchema>;

export const djvuSizeEstimateSchema = v.object({
    subsample: positiveSafeInteger,
    label: v.string(error),
    description: v.string(error),
    resultingDpi: finiteNumber,
    estimatedBytes: nonNegativeSafeInteger,
}, error);
export type IDjvuSizeEstimate = v.InferOutput<typeof djvuSizeEstimateSchema>;

// The outline's aggregate node, depth, and title limits require a traversal after structural validation.
export const djvuOutlineSchema = v.pipe(v.array(v.unknown(), error), v.transform(value => mapDjvuOutlineWithLimits(value)));
interface IDjvuOutlineItemOutput {
    title: string;
    pageNumber: TPageNumber | null;
    children: IDjvuOutlineItemOutput[];
}
export type IDjvuOutlineItem = v.InferOutput<typeof djvuOutlineSchema>[number];
function mapDjvuOutlineWithLimits(value: unknown[]): IDjvuOutlineItemOutput[] {
    const result: IDjvuOutlineItemOutput[] = [];
    const stack: Array<{
        depth: number;
        item: unknown;
        target: IDjvuOutlineItemOutput[]
    }> = value.toReversed().map(item => ({
        depth: 1,
        item,
        target: result,
    }));
    let nodeCount = 0;
    let titleChars = 0;
    while (stack.length) {
        const entry = stack.pop()!;
        if (typeof entry.item !== 'object' || entry.item === null || Array.isArray(entry.item)) throw new Error('invalid DjVu outline item');
        const item = entry.item as Record<string, unknown>;
        const pageNumber = item.pageNumber;
        const children = item.children;
        if (typeof item.title !== 'string' || !(pageNumber === null || typeof pageNumber === 'number' && parsePageNumber(pageNumber) !== null) || !Array.isArray(children)) throw new Error('invalid DjVu outline item');
        nodeCount++;
        titleChars += item.title.length;
        if (entry.depth > DJVU_OUTLINE_MAX_DEPTH || nodeCount > DJVU_OUTLINE_MAX_NODES || titleChars > DJVU_OUTLINE_MAX_TITLE_CHARS) throw new Error('DjVu outline exceeds the supported limit');
        const mapped: IDjvuOutlineItemOutput = {
            title: item.title,
            pageNumber: pageNumber === null ? null : parsePageNumber(pageNumber)!,
            children: [],
        };
        entry.target.push(mapped);
        for (let index = children.length - 1; index >= 0; index--) stack.push({
            depth: entry.depth + 1,
            item: children[index],
            target: mapped.children,
        });
    }
    return result;
}

export const djvuPageTextSchema = v.pipe(v.string('DjVu page text must be a string'), v.maxLength(DJVU_SEARCH_MAX_PAGE_TEXT_CHARS, 'DjVu page text exceeds the supported limit'));

export const djvuProgressSchema = v.pipe(v.object({
    jobId: jobIdSchema,
    requestId: v.optional(requestIdSchema()),
    documentRef: v.optional(documentRefSchema),
    phase: v.picklist([
        'converting',
        'bookmarks',
        'optimizing',
        'loading',
        'printing',
    ], error),
    status: v.optional(v.picklist([
        'running',
        'success',
        'canceled',
        'failed',
    ], error)),
    current: v.optional(finiteNumber),
    total: v.optional(finiteNumber),
    percent: finiteNumber,
    error: v.optional(v.string(error)),
}, error), v.transform(value => ({
    jobId: value.jobId,
    phase: value.phase,
    percent: value.percent,
    ...(value.requestId === undefined ? {} : {requestId: value.requestId}),
    ...(value.documentRef === undefined ? {} : {documentRef: value.documentRef}),
    ...(value.status === undefined ? {} : {status: value.status}),
    ...(value.current === undefined ? {} : {current: value.current}),
    ...(value.total === undefined ? {} : {total: value.total}),
    ...(value.error === undefined ? {} : {error: value.error}),
})));
export type IDjvuProgress = v.InferOutput<typeof djvuProgressSchema>;

export const djvuOpenResultSchema = v.pipe(v.object({
    success: v.boolean(error),
    pageCount: v.optional(positiveSafeInteger),
    pageSourceInfo: v.optional(djvuPageSourceInfoSchema),
    jobId: v.optional(jobIdSchema),
    requestId: v.optional(requestIdSchema()),
    error: v.optional(v.string(error)),
}, error), v.transform(value => ({
    success: value.success,
    ...(value.pageCount === undefined ? {} : {pageCount: value.pageCount}),
    ...(value.pageSourceInfo === undefined ? {} : {pageSourceInfo: value.pageSourceInfo}),
    ...(value.jobId === undefined ? {} : {jobId: value.jobId}),
    ...(value.requestId === undefined ? {} : {requestId: value.requestId}),
    ...(value.error === undefined ? {} : {error: value.error}),
})));
export type IDjvuOpenResult = v.InferOutput<typeof djvuOpenResultSchema>;
export const djvuConvertResultSchema = v.pipe(v.object({
    success: v.boolean(error),
    pdfPath: v.optional(documentRefSchema),
    jobId: v.optional(jobIdSchema),
    requestId: v.optional(requestIdSchema()),
    documentRef: v.optional(documentRefSchema),
    error: v.optional(v.string(error)),
    failure: v.optional(failureReceiptSchema),
    expected: v.optional(expectedOutcomeSchema),
}, error), v.check(value => !(value.success && (value.failure !== undefined || value.expected !== undefined)) && !(value.failure !== undefined && value.expected !== undefined), error), v.transform(value => ({
    success: value.success,
    ...(value.pdfPath === undefined ? {} : {pdfPath: value.pdfPath}),
    ...(value.jobId === undefined ? {} : {jobId: value.jobId}),
    ...(value.requestId === undefined ? {} : {requestId: value.requestId}),
    ...(value.documentRef === undefined ? {} : {documentRef: value.documentRef}),
    ...(value.error === undefined ? {} : {error: value.error}),
    ...(value.failure === undefined ? {} : {failure: value.failure}),
    ...(value.expected === undefined ? {} : {expected: value.expected}),
})));
export type IDjvuConvertResult = v.InferOutput<typeof djvuConvertResultSchema>;
export const djvuPrintResultSchema = v.pipe(v.object({
    success: v.boolean(error),
    canceled: v.optional(v.boolean(error)),
    jobId: v.optional(jobIdSchema),
    error: v.optional(v.string(error)),
}, error), v.transform(value => ({
    success: value.success,
    ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
    ...(value.jobId === undefined ? {} : {jobId: value.jobId}),
    ...(value.error === undefined ? {} : {error: value.error}),
})));
export type IDjvuPrintResult = v.InferOutput<typeof djvuPrintResultSchema>;
export const djvuJobStartHandleSchema = v.object({
    jobId: jobIdSchema,
    requestId: requestIdSchema(),
}, error);
export type IDjvuJobStartHandle = v.InferOutput<typeof djvuJobStartHandleSchema>;
export const djvuCanceledResultSchema = v.object({canceled: v.boolean(error)}, error);

export const DJVU_DOCUMENT_OUTPUT_OPERATIONS = [
    'djvu-convert',
    'djvu-open',
    'djvu-print',
] as const;
export type TDjvuDocumentOutputOperation = typeof DJVU_DOCUMENT_OUTPUT_OPERATIONS[number];
export function isDjvuDocumentOutputOperation(value: unknown): value is TDjvuDocumentOutputOperation {
    return DJVU_DOCUMENT_OUTPUT_OPERATIONS.some(operation => operation === value);
}
export type TDocumentOutputOperation = TDjvuDocumentOutputOperation;

const djvuJobStateProgressSchema = v.pipe(v.object({
    jobId: jobIdSchema,
    requestId: v.optional(v.pipe(v.string(error), v.check(value => parseRequestId(value) !== null, error), v.transform(value => parseRequestId(value)!))),
    documentRef: v.optional(documentRefSchema),
    phase: v.picklist([
        'converting',
        'bookmarks',
        'optimizing',
        'loading',
        'printing',
    ], error),
    status: v.optional(v.unknown()),
    current: v.optional(v.unknown()),
    total: v.optional(v.unknown()),
    percent: finiteNumber,
    error: v.optional(v.unknown()),
}, error), v.transform(value => ({
    jobId: value.jobId,
    phase: value.phase,
    percent: value.percent,
    ...(value.requestId === undefined ? {} : {requestId: value.requestId}),
    ...(value.documentRef === undefined ? {} : {documentRef: value.documentRef}),
    ...(typeof value.current === 'number' && Number.isFinite(value.current) ? {current: value.current} : {}),
    ...(typeof value.total === 'number' && Number.isFinite(value.total) ? {total: value.total} : {}),
    ...(value.status === 'running' || value.status === 'success' || value.status === 'canceled' || value.status === 'failed' ? {status: value.status} : {}),
    ...(typeof value.error === 'string' ? {error: value.error} : {}),
})));

export const djvuJobStateSchema = v.nullable(v.variant('status', [
    v.object({
        jobId: jobIdSchema,
        operation: v.picklist(DJVU_DOCUMENT_OUTPUT_OPERATIONS),
        status: v.picklist([
            'queued',
            'running',
        ]),
        progress: djvuJobStateProgressSchema,
        updatedAtMs: epochMsSchema,
    }, error),
    v.object({
        jobId: jobIdSchema,
        operation: v.picklist(DJVU_DOCUMENT_OUTPUT_OPERATIONS),
        status: v.literal('handoff'),
        artifactPath: documentRefSchema,
        progress: djvuJobStateProgressSchema,
        updatedAtMs: epochMsSchema,
    }, error),
    v.object({
        jobId: jobIdSchema,
        operation: v.picklist(DJVU_DOCUMENT_OUTPUT_OPERATIONS),
        status: v.literal('completed'),
        artifactPath: v.optional(documentRefSchema),
        progress: djvuJobStateProgressSchema,
        updatedAtMs: epochMsSchema,
    }, error),
    v.pipe(v.object({
        jobId: jobIdSchema,
        operation: v.picklist(DJVU_DOCUMENT_OUTPUT_OPERATIONS),
        status: v.picklist([
            'canceled',
            'failed',
        ]),
        error: v.optional(v.string(error)),
        failure: v.optional(failureReceiptSchema),
        expected: v.optional(expectedOutcomeSchema),
        progress: djvuJobStateProgressSchema,
        updatedAtMs: epochMsSchema,
    }, error), v.check(state => !(state.failure && state.expected) && !(state.status === 'canceled' && state.failure), error)),
]));
export type TDocumentOutputJobState = Exclude<v.InferOutput<typeof djvuJobStateSchema>, null>;
