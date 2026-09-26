import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    requirePageNumber, type TPageNumber,
} from '@contracts/pageNumbers';
import {
    parseJobId,
    parseRequestId,
    type TJobId,
    type TRequestId,
} from '@contracts/shared';
import {
    isEpochMs, type TEpochMs,
} from '@contracts/timestamps';
import * as v from 'valibot';

export const OCR_PROGRESS_EVENT_CHANNEL = 'ocr:progress';
export const OCR_COMPLETE_EVENT_CHANNEL = 'ocr:complete';

export const OCR_ERROR_CODES = [
    'OCR_INVALID_PAYLOAD',
    'OCR_INTERNAL_ERROR',
    'OCR_QUEUE_BACKPRESSURE',
    'OCR_WORKER_UNAVAILABLE',
    'OCR_WORKER_MESSAGE_ERROR',
    'OCR_TOOLS_VALIDATION_FAILED',
] as const;

export type TOcrErrorCode = typeof OCR_ERROR_CODES[number];

const requestIdSchema = v.pipe(
    v.string(),
    v.transform(value => parseRequestId(value) ?? ''),
    v.minLength(1),
    v.custom<TRequestId>(value => typeof value === 'string' && value.length > 0),
);
const jobIdSchema = v.pipe(
    v.string(),
    v.transform(value => parseJobId(value) ?? ''),
    v.minLength(1),
    v.custom<TJobId>(value => typeof value === 'string' && value.length > 0),
);
const documentRefSchema = v.custom<TDocumentRef>(value => parseDocumentRef(value) !== null);
const documentRevisionTokenSchema = v.pipe(
    v.string(),
    v.transform(value => parseDocumentRevisionToken(value) ?? ''),
    v.minLength(1),
    v.custom<TDocumentRevisionToken>(value => parseDocumentRevisionToken(value) !== null),
);
const epochMsSchema = v.custom<TEpochMs>(isEpochMs);
const safeIntegerSchema = (minimum: number) => v.pipe(
    v.number(),
    v.finite(),
    v.safeInteger(),
    v.minValue(minimum),
);
const pageNumberSchema = v.pipe(
    safeIntegerSchema(1),
    v.transform(value => requirePageNumber(value)),
);

export const OCR_ERROR_ENVELOPE_SCHEMA = v.object({
    code: v.picklist(OCR_ERROR_CODES),
    message: v.string(),
    retryable: v.boolean(),
    timestamp: epochMsSchema,
    details: v.optional(v.string()),
});
export type IOcrErrorEnvelope = v.InferOutput<typeof OCR_ERROR_ENVELOPE_SCHEMA>;

export interface IOcrErrorEnvelopeCarrier {readonly errorEnvelope?: IOcrErrorEnvelope;}

export const OCR_DIAGNOSTIC_CODES = [
    'OCR_PREPROCESSING_UNAVAILABLE',
    'OCR_PREPROCESSING_FAILED',
    'OCR_PREPROCESSING_GEOMETRY_CHANGED',
    'OCR_SOURCE_DPI_LIMITED',
    'OCR_EXISTING_TEXT_SKIPPED',
    'OCR_ENGINE_OPTION_UNSUPPORTED',
] as const;

export type TOcrDiagnosticCode = typeof OCR_DIAGNOSTIC_CODES[number];

export const OCR_DIAGNOSTIC_SCHEMA = v.object({
    code: v.picklist(OCR_DIAGNOSTIC_CODES),
    severity: v.picklist([
        'info',
        'warning',
    ]),
    message: v.string(),
    pageNumber: v.optional(pageNumberSchema),
});
export type IOcrDiagnostic = v.InferOutput<typeof OCR_DIAGNOSTIC_SCHEMA>;

export const OCR_COMPLETION_OUTCOMES = ['no-pages-to-process'] as const;

export type TOcrCompletionOutcome = typeof OCR_COMPLETION_OUTCOMES[number];

export interface IOcrRecognizeRequest {
    pageNumber: TPageNumber;
    imageData: Uint8Array;
    languages: string[];
    imageWidth?: number;
    imageHeight?: number;
}

/** A single page request for an OCR job. */
export const OCR_SEARCHABLE_PDF_PAGE_SCHEMA = v.object({
    pageNumber: pageNumberSchema,
    languages: v.array(v.string()),
});
export type IOcrSearchablePdfPage = v.InferOutput<typeof OCR_SEARCHABLE_PDF_PAGE_SCHEMA>;

/** A scalar contiguous page span. The span is expanded only in bounded worker batches. */
export const OCR_SEARCHABLE_PDF_PAGE_RANGE_SCHEMA = v.pipe(
    v.object({
        firstPage: safeIntegerSchema(1),
        lastPage: safeIntegerSchema(1),
    }),
    v.check(range => range.lastPage >= range.firstPage, 'lastPage must be greater than or equal to firstPage'),
);
export type IOcrSearchablePdfPageRange = v.InferOutput<typeof OCR_SEARCHABLE_PDF_PAGE_RANGE_SCHEMA>;

/**
 * Page selections are deliberately serializable. Do not replace these with a
 * JavaScript iterator in the IPC contract. An iterator would be eagerly
 * cloned by Electron and would put the old whole-document allocation back in
 * the renderer/main-process boundary.
 */
const ocrSearchablePdfPageRangesSchema = v.pipe(
    v.array(OCR_SEARCHABLE_PDF_PAGE_RANGE_SCHEMA),
    v.minLength(1),
    v.maxLength(100_000),
);
const ocrSearchablePdfPagesSchema = v.pipe(v.array(OCR_SEARCHABLE_PDF_PAGE_SCHEMA), v.maxLength(100_000));
const ocrSearchablePdfLanguagesSchema = v.array(v.string());
export const OCR_SEARCHABLE_PDF_ALL_PAGES_SELECTION_SCHEMA = v.object({
    kind: v.literal('all'),
    pageCount: safeIntegerSchema(1),
    languages: ocrSearchablePdfLanguagesSchema,
});
export type IOcrSearchablePdfAllPagesSelection = v.InferOutput<typeof OCR_SEARCHABLE_PDF_ALL_PAGES_SELECTION_SCHEMA>;
export const OCR_SEARCHABLE_PDF_RANGE_SELECTION_SCHEMA = v.pipe(
    v.object({
        kind: v.literal('range'),
        firstPage: safeIntegerSchema(1),
        lastPage: safeIntegerSchema(1),
        languages: ocrSearchablePdfLanguagesSchema,
    }),
    v.check(selection => selection.lastPage >= selection.firstPage, 'lastPage must be greater than or equal to firstPage'),
);
export type IOcrSearchablePdfRangeSelection = v.InferOutput<typeof OCR_SEARCHABLE_PDF_RANGE_SELECTION_SCHEMA>;
export const OCR_SEARCHABLE_PDF_RANGES_SELECTION_SCHEMA = v.object({
    kind: v.literal('ranges'),
    ranges: ocrSearchablePdfPageRangesSchema,
    languages: ocrSearchablePdfLanguagesSchema,
});
export type IOcrSearchablePdfRangesSelection = v.InferOutput<typeof OCR_SEARCHABLE_PDF_RANGES_SELECTION_SCHEMA>;
export const OCR_SEARCHABLE_PDF_PAGES_SELECTION_SCHEMA = v.object({
    kind: v.literal('pages'),
    pages: ocrSearchablePdfPagesSchema,
});
export type IOcrSearchablePdfPagesSelection = v.InferOutput<typeof OCR_SEARCHABLE_PDF_PAGES_SELECTION_SCHEMA>;

export const OCR_SEARCHABLE_PDF_PAGE_SELECTION_SCHEMA = v.union([
    OCR_SEARCHABLE_PDF_ALL_PAGES_SELECTION_SCHEMA,
    OCR_SEARCHABLE_PDF_RANGE_SELECTION_SCHEMA,
    OCR_SEARCHABLE_PDF_RANGES_SELECTION_SCHEMA,
    OCR_SEARCHABLE_PDF_PAGES_SELECTION_SCHEMA,
]);
export type TOcrSearchablePdfPageSelection = v.InferOutput<typeof OCR_SEARCHABLE_PDF_PAGE_SELECTION_SCHEMA>;

/**
 * The legacy array form remains valid for current/sparse selections. New
 * all-page and contiguous-range requests use the scalar forms above.
 */
export const OCR_SEARCHABLE_PDF_PAGES_SCHEMA = v.union([
    ocrSearchablePdfPagesSchema,
    OCR_SEARCHABLE_PDF_PAGE_SELECTION_SCHEMA,
]);
export type TOcrSearchablePdfPages = v.InferOutput<typeof OCR_SEARCHABLE_PDF_PAGES_SCHEMA>;

/** Aliases used by worker-side code and callers that refer to page plans. */
export type IOcrPageRequest = IOcrSearchablePdfPage;
export type IOcrPageRange = IOcrSearchablePdfPageRange;
export type TOcrPageSelection = TOcrSearchablePdfPageSelection;

export const OCR_QUALITY_PROFILES = [
    'balanced',
    'accurate',
    'poor-scan',
] as const;
export type TOcrQualityProfile = typeof OCR_QUALITY_PROFILES[number];
export const OCR_PREPROCESSING_MODES = [
    'off',
    'clean',
] as const;
export type TOcrPreprocessingMode = typeof OCR_PREPROCESSING_MODES[number];
export const OCR_TEXT_SUPERSESSION_POLICIES = [
    'missing-only',
    'replace-evb',
    'replace-all',
] as const;
export type TOcrTextSupersessionPolicy = typeof OCR_TEXT_SUPERSESSION_POLICIES[number];
export type TOcrPageTextClassification =
    | 'native-text'
    | 'foreign-hidden-ocr'
    | 'evb-current-generation'
    | 'no-text';

export const OCR_SEARCHABLE_PDF_OPTIONS_SCHEMA = v.pipe(
    v.object({
        renderDpi: v.optional(safeIntegerSchema(1)),
        qualityProfile: v.optional(v.picklist(OCR_QUALITY_PROFILES)),
        preprocessingMode: v.optional(v.picklist(OCR_PREPROCESSING_MODES)),
        pageSegmentationMode: v.optional(safeIntegerSchema(0)),
        supersessionPolicy: v.optional(v.picklist(OCR_TEXT_SUPERSESSION_POLICIES)),
        replaceAllAcknowledged: v.optional(v.boolean()),
    }),
    v.check(options => options.supersessionPolicy !== 'replace-all' || options.replaceAllAcknowledged === true, 'replace-all OCR requires acknowledgement'),
);
export type IOcrSearchablePdfOptions = v.InferOutput<typeof OCR_SEARCHABLE_PDF_OPTIONS_SCHEMA>;

/** Recognition options a new OCR run starts with in the popup: automatic layout, no preprocessing. */
export const DEFAULT_OCR_RECOGNITION_OPTIONS = {
    qualityProfile: 'balanced',
    preprocessingMode: 'off',
} as const satisfies IOcrSearchablePdfOptions;

/** Recognition options the popup switches to when the Poor scan profile is chosen. */
export const POOR_SCAN_OCR_RECOGNITION_OPTIONS = {
    qualityProfile: 'poor-scan',
    preprocessingMode: 'clean',
} as const satisfies IOcrSearchablePdfOptions;

export interface IOcrRecognizeResult extends IOcrErrorEnvelopeCarrier {
    readonly pageNumber: TPageNumber;
    readonly success: boolean;
    readonly text: string;
    readonly error?: string;
}

export const OCR_PROGRESS_PHASES = [
    'preparing',
    'model-prep',
    'pdf-prep',
    'dpi-inspection',
    'page-size-probing',
    'processing',
    'merging',
    'indexing',
] as const;
export type TOcrProgressPhase = typeof OCR_PROGRESS_PHASES[number];
export const OCR_PROGRESS_STATUSES = [
    'running',
    'success',
    'canceled',
    'failed',
] as const;
export type TOcrProgressStatus = typeof OCR_PROGRESS_STATUSES[number];

export const OCR_PROGRESS_SCHEMA = v.object({
    requestId: requestIdSchema,
    currentPage: v.pipe(v.number(), v.finite()),
    processedCount: v.pipe(v.number(), v.finite()),
    totalPages: v.pipe(v.number(), v.finite()),
    phase: v.optional(v.picklist(OCR_PROGRESS_PHASES)),
    phaseProgress: v.optional(v.pipe(v.number(), v.finite())),
    activePages: v.optional(v.array(v.pipe(v.number(), v.finite()))),
    languageCode: v.optional(v.string()),
    status: v.optional(v.picklist(OCR_PROGRESS_STATUSES)),
    error: v.optional(v.string()),
});
export type IOcrProgress = v.InferOutput<typeof OCR_PROGRESS_SCHEMA>;

export const OCR_JOB_START_RESULT_SCHEMA = v.object({
    started: v.boolean(),
    jobId: jobIdSchema,
    error: v.optional(v.string()),
    installed: v.optional(v.array(v.string())),
    errors: v.optional(v.array(v.string())),
    errorEnvelope: v.optional(OCR_ERROR_ENVELOPE_SCHEMA),
});
export type IOcrJobStartResult = v.InferOutput<typeof OCR_JOB_START_RESULT_SCHEMA>;

export const OCR_CANCEL_FAILURE_REASONS = [
    'invalid-request',
    'not-found',
    'failed',
] as const;
export type TOcrCancelFailureReason = typeof OCR_CANCEL_FAILURE_REASONS[number];
export const OCR_CANCEL_RESULT_SCHEMA = v.object({
    canceled: v.boolean(),
    reason: v.optional(v.picklist(OCR_CANCEL_FAILURE_REASONS)),
    error: v.optional(v.string()),
    errorEnvelope: v.optional(OCR_ERROR_ENVELOPE_SCHEMA),
});
export type IOcrCancelResult = v.InferOutput<typeof OCR_CANCEL_RESULT_SCHEMA>;
export const OCR_RESULT_FILE_ACK_RESULT_SCHEMA = v.object({
    cleaned: v.boolean(),
    error: v.optional(v.string()),
    errorEnvelope: v.optional(OCR_ERROR_ENVELOPE_SCHEMA),
});
export type IOcrResultFileAckResult = v.InferOutput<typeof OCR_RESULT_FILE_ACK_RESULT_SCHEMA>;

export interface IOcrRecognizeBatchResult extends IOcrErrorEnvelopeCarrier {
    readonly results: Readonly<Record<number, string>>;
    readonly errors: readonly string[];
}

const ocrCompleteResultOptionalProperties = {
    outcome: v.optional(v.picklist(OCR_COMPLETION_OUTCOMES)),
    pdfPath: v.optional(documentRefSchema),
    sourceDocumentRevisionToken: v.optional(documentRevisionTokenSchema),
    resultSha256: v.optional(v.pipe(v.string(), v.check(value => /^[a-f0-9]{64}$/u.test(value)))),
    requiresCleanupAck: v.optional(v.boolean()),
    diagnostics: v.optional(v.array(OCR_DIAGNOSTIC_SCHEMA)),
    errorEnvelope: v.optional(OCR_ERROR_ENVELOPE_SCHEMA),
};
const ocrCompleteFailureSchema = v.object({
    requestId: requestIdSchema,
    success: v.literal(false),
    errors: v.array(v.string()),
    ...ocrCompleteResultOptionalProperties,
});
const ocrCompleteSuccessSchema = v.object({
    requestId: requestIdSchema,
    success: v.literal(true),
    pdfPath: documentRefSchema,
    sourceDocumentRevisionToken: documentRevisionTokenSchema,
    resultSha256: v.pipe(v.string(), v.check(value => /^[a-f0-9]{64}$/u.test(value))),
    requiresCleanupAck: v.boolean(),
    errors: v.array(v.string()),
    outcome: v.optional(v.picklist(OCR_COMPLETION_OUTCOMES)),
    diagnostics: v.optional(v.array(OCR_DIAGNOSTIC_SCHEMA)),
    errorEnvelope: v.optional(OCR_ERROR_ENVELOPE_SCHEMA),
});
export const OCR_COMPLETE_RESULT_SCHEMA = v.pipe(
    v.union([
        ocrCompleteFailureSchema,
        ocrCompleteSuccessSchema,
    ]),
    v.check(result => !result.success || result.outcome === undefined, 'successful OCR results cannot have an outcome'),
);
export type IOcrCompleteResult = v.InferOutput<typeof OCR_COMPLETE_RESULT_SCHEMA>;

export type TOcrJobProjectionPhase = TOcrProgressPhase
    | 'queued'
    | 'recognizing'
    | 'applying'
    | 'cancel-requested';

export interface IOcrJobProjectionState {
    readonly jobId: TJobId;
    readonly requestId: TRequestId;
    readonly status: 'queued' | 'running' | 'handoff' | 'completed' | 'canceled' | 'failed';
    readonly phase: TOcrJobProjectionPhase;
    readonly percent: number;
    readonly current?: number;
    readonly total?: number;
    readonly error?: string;
    readonly updatedAtMs: number;
    readonly supersessionPolicy?: TOcrTextSupersessionPolicy;
    readonly replaceAllAcknowledged?: boolean;
}

export interface IPreprocessingValidationResult extends IOcrErrorEnvelopeCarrier {
    readonly valid: boolean;
    readonly available: readonly string[];
    readonly missing: readonly string[];
}

export interface IOcrToolValidationResult extends IOcrErrorEnvelopeCarrier {
    readonly valid: boolean;
    readonly tools: {
        readonly tesseract: {
            readonly found: boolean;
            readonly path: string;
            readonly version?: string;
        };
        readonly tessdata: {
            readonly found: boolean;
            readonly path: string;
            readonly languages?: readonly string[];
            /** Supported models not installed yet; resolved through the on-demand model flow. */
            readonly onDemandLanguages?: readonly string[];
        };
        readonly pdftoppm: {
            readonly found: boolean;
            readonly path: string;
        };
        readonly pdftotext: {
            readonly found: boolean;
            readonly path: string;
        };
        readonly popplerRuntime: {
            readonly dataDirFound: boolean;
            readonly dataDir?: string;
            readonly fontConfigDirFound: boolean;
            readonly fontConfigDir?: string;
        };
        readonly qpdf: {
            readonly found: boolean;
            readonly path: string;
        };
    };
    readonly errors: readonly string[];
}

export interface IPreprocessPageResult extends IOcrErrorEnvelopeCarrier {
    readonly success: boolean;
    readonly imageData: Uint8Array;
    readonly message?: string;
    readonly error?: string;
}
