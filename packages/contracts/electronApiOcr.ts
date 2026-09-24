import type { TPageNumber } from '@contracts/pageNumbers';
import type {
    TJobId,
    TRequestId,
} from '@contracts/shared';
import type {TEpochMs} from '@contracts/timestamps';

import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';

export const OCR_PROGRESS_EVENT_CHANNEL = 'ocr:progress';
export const OCR_COMPLETE_EVENT_CHANNEL = 'ocr:complete';

export type TOcrErrorCode =
    | 'OCR_INVALID_PAYLOAD'
    | 'OCR_INTERNAL_ERROR'
    | 'OCR_QUEUE_BACKPRESSURE'
    | 'OCR_WORKER_UNAVAILABLE'
    | 'OCR_WORKER_MESSAGE_ERROR'
    | 'OCR_TOOLS_VALIDATION_FAILED';

export const OCR_ERROR_CODES = [
    'OCR_INVALID_PAYLOAD',
    'OCR_INTERNAL_ERROR',
    'OCR_QUEUE_BACKPRESSURE',
    'OCR_WORKER_UNAVAILABLE',
    'OCR_WORKER_MESSAGE_ERROR',
    'OCR_TOOLS_VALIDATION_FAILED',
] as const satisfies readonly TOcrErrorCode[];

export interface IOcrErrorEnvelope {
    readonly code: TOcrErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly timestamp: TEpochMs;
    readonly details?: string;
}

export interface IOcrErrorEnvelopeCarrier {readonly errorEnvelope?: IOcrErrorEnvelope;}

export type TOcrDiagnosticCode =
    | 'OCR_PREPROCESSING_UNAVAILABLE'
    | 'OCR_PREPROCESSING_FAILED'
    | 'OCR_PREPROCESSING_GEOMETRY_CHANGED'
    | 'OCR_SOURCE_DPI_LIMITED'
    | 'OCR_EXISTING_TEXT_SKIPPED'
    | 'OCR_ENGINE_OPTION_UNSUPPORTED';

export const OCR_DIAGNOSTIC_CODES = [
    'OCR_PREPROCESSING_UNAVAILABLE',
    'OCR_PREPROCESSING_FAILED',
    'OCR_PREPROCESSING_GEOMETRY_CHANGED',
    'OCR_SOURCE_DPI_LIMITED',
    'OCR_EXISTING_TEXT_SKIPPED',
    'OCR_ENGINE_OPTION_UNSUPPORTED',
] as const satisfies readonly TOcrDiagnosticCode[];

export interface IOcrDiagnostic {
    readonly code: TOcrDiagnosticCode;
    readonly severity: 'info' | 'warning';
    readonly message: string;
    readonly pageNumber?: TPageNumber;
}

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
export interface IOcrSearchablePdfPage {
    pageNumber: TPageNumber;
    languages: string[];
}

/** A scalar contiguous page span. The span is expanded only in bounded worker batches. */
export interface IOcrSearchablePdfPageRange {
    firstPage: number;
    lastPage: number;
}

/**
 * Page selections are deliberately serializable. Do not replace these with a
 * JavaScript iterator in the IPC contract. An iterator would be eagerly
 * cloned by Electron and would put the old whole-document allocation back in
 * the renderer/main-process boundary.
 */
export interface IOcrSearchablePdfAllPagesSelection {
    kind: 'all';
    pageCount: number;
    languages: string[];
}

export interface IOcrSearchablePdfRangeSelection {
    kind: 'range';
    firstPage: number;
    lastPage: number;
    languages: string[];
}

export interface IOcrSearchablePdfRangesSelection {
    kind: 'ranges';
    ranges: IOcrSearchablePdfPageRange[];
    languages: string[];
}

export interface IOcrSearchablePdfPagesSelection {
    kind: 'pages';
    pages: IOcrSearchablePdfPage[];
}

export type TOcrSearchablePdfPageSelection =
    | IOcrSearchablePdfAllPagesSelection
    | IOcrSearchablePdfRangeSelection
    | IOcrSearchablePdfRangesSelection
    | IOcrSearchablePdfPagesSelection;

/**
 * The legacy array form remains valid for current/sparse selections. New
 * all-page and contiguous-range requests use the scalar forms above.
 */
export type TOcrSearchablePdfPages = IOcrSearchablePdfPage[] | TOcrSearchablePdfPageSelection;

/** Aliases used by worker-side code and callers that refer to page plans. */
export type IOcrPageRequest = IOcrSearchablePdfPage;
export type IOcrPageRange = IOcrSearchablePdfPageRange;
export type TOcrPageSelection = TOcrSearchablePdfPageSelection;

export type TOcrQualityProfile = 'balanced' | 'accurate' | 'poor-scan';
export type TOcrPreprocessingMode = 'off' | 'clean';
export type TOcrTextSupersessionPolicy = 'missing-only' | 'replace-evb' | 'replace-all';
export type TOcrPageTextClassification =
    | 'native-text'
    | 'foreign-hidden-ocr'
    | 'evb-current-generation'
    | 'no-text';

export interface IOcrSearchablePdfOptions {
    renderDpi?: number;
    qualityProfile?: TOcrQualityProfile;
    preprocessingMode?: TOcrPreprocessingMode;
    pageSegmentationMode?: number;
    /** Defaults to missing-only. replace-all requires an explicit UI acknowledgement. */
    supersessionPolicy?: TOcrTextSupersessionPolicy;
    /** Required when supersessionPolicy is replace-all. */
    replaceAllAcknowledged?: boolean;
}

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

export type TOcrProgressPhase =
    | 'preparing'
    | 'model-prep'
    | 'pdf-prep'
    | 'dpi-inspection'
    | 'page-size-probing'
    | 'processing'
    | 'merging'
    | 'indexing';

export const OCR_PROGRESS_PHASES = [
    'preparing',
    'model-prep',
    'pdf-prep',
    'dpi-inspection',
    'page-size-probing',
    'processing',
    'merging',
    'indexing',
] as const satisfies readonly TOcrProgressPhase[];
export type TOcrProgressStatus = 'running' | 'success' | 'canceled' | 'failed';

export interface IOcrProgress {
    readonly requestId: TRequestId;
    readonly currentPage: number;
    readonly processedCount: number;
    readonly totalPages: number;
    readonly phase?: TOcrProgressPhase;
    readonly phaseProgress?: number;
    readonly activePages?: readonly number[];
    readonly languageCode?: string;
    readonly status?: TOcrProgressStatus;
    readonly error?: string;
}

export interface IOcrJobStartResult extends IOcrErrorEnvelopeCarrier {
    readonly started: boolean;
    readonly jobId: TJobId;
    readonly error?: string;
    readonly installed?: readonly string[];
    readonly errors?: readonly string[];
}

export type TOcrCancelFailureReason = 'invalid-request' | 'not-found' | 'failed';

export interface IOcrCancelResult extends IOcrErrorEnvelopeCarrier {
    readonly canceled: boolean;
    readonly reason?: TOcrCancelFailureReason;
    readonly error?: string;
}

export interface IOcrResultFileAckResult extends IOcrErrorEnvelopeCarrier {
    readonly cleaned: boolean;
    readonly error?: string;
}

export interface IOcrRecognizeBatchResult extends IOcrErrorEnvelopeCarrier {
    readonly results: Readonly<Record<number, string>>;
    readonly errors: readonly string[];
}

export interface IOcrCompleteResult extends IOcrErrorEnvelopeCarrier {
    readonly requestId: TRequestId;
    readonly success: boolean;
    /** A non-error terminal result where the selected policy intentionally did no work. */
    readonly outcome?: TOcrCompletionOutcome;
    readonly pdfPath?: TDocumentRef;
    readonly sourceDocumentRevisionToken?: TDocumentRevisionToken;
    readonly resultSha256?: string;
    readonly requiresCleanupAck?: boolean;
    readonly errors: readonly string[];
    readonly diagnostics?: readonly IOcrDiagnostic[];
}

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
