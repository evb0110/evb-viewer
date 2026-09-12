import type {
    TPageNumber,
    TPageIndex,
} from '@contracts/pageNumbers';

import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import type {
    IPlatformUnsupportedResult,
    TPlatformUnsupportedReason,
} from '@contracts/platformUnsupported';
import type {
    IDocumentRevisionChangedEvent,
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { parseDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    IPdfBox,
    IMarkerRect,
    IPoint2D,
} from '@contracts/geometry';
import type { IPdfAnnotationStampImageReference } from '@contracts/pdfAnnotationParseTypes';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type {
    IPdfPageLabelsMutation,
    IPdfPageLabelRange,
    TPdfPageLabelStyle,
} from '@contracts/pdfPageLabels';
import type {
    TPdfAnnotationLineEndStyle,
    TPdfAnnotationMarkupSubtype,
    TPdfAnnotationShapePdfSubtype,
    TPdfAnnotationShapeType,
} from '@contracts/annotations';
import {
    isFiniteNumber,
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import type {
    IRecentFile,
    TPdfViewRotation,
    TPdfViewMode,
    TPrintOrientation,
    TLeaseId,
    TRequestId,
    TSessionId,
} from '@contracts/shared';
import {
    parseLeaseId,
    parseRequestId,
} from '@contracts/shared';
import {
    parseEpochMs,
    type TEpochMs,
} from '@contracts/timestamps';
import type {TPdfDateString} from '@contracts/pdfDateString';
import type {
    IPdfConformanceAnalysisOptions,
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import type {
    TMenuEventCallback,
    TMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';
import type {INativeErrorEnvelope} from '@contracts/nativeErrors';
import type * as PdfAnnotationParse from '@contracts/pdfAnnotationParseTypes';
import type {
    IPdfDecryptRequest,
    IPdfDecryptResult,
} from '@contracts/pdfDecryptSchemas';
import type {TPdfOpenFileFailureResult} from '@contracts/pdfOpenFileResults';
export type TOpenBatchProgressOperation = 'document-open' | 'page-insert';
export interface IDocumentChunkReadOptions {
    chunkBytes?: number;
    signal?: AbortSignal;
}
export interface IDocumentChunkReadResult {
    readonly size: number;
    readonly bytesRead: number;
    readonly chunks: number;
}
export interface IPdfPathPrintOptions {
    pageNumbers?: TPageNumber[];
    requestId?: TRequestId;
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
}
export interface IPdfDataPrintOptions {requestId?: TRequestId;}
export interface IPdfNativePrintDialogOpenedEvent {readonly requestId: TRequestId;}
/** A PDF indirect-object reference returned by the native annotation index. */
export interface IPdfAnnotationIndexObjectRef {
    readonly objectNumber: number;
    readonly generationNumber: number;
}

export const PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES = 4 * 1024 * 1024;

/** One page-addressed annotation entry in a PDF annotation index. */
export interface IPdfAnnotationIndexEntry {
    readonly pageIndex: TPageIndex;
    /** Zero is reserved for a direct-dictionary page-presence marker. */
    readonly objectNumber: number;
    readonly generationNumber: number;
    readonly subtype: string;
    readonly name: string | null;
    readonly popupRef: IPdfAnnotationIndexObjectRef | null;
    readonly parentRef: IPdfAnnotationIndexObjectRef | null;
}

export interface IPdfAnnotationIndexOptions {expectedDocumentRevisionToken: TDocumentRevisionToken;}

export interface IPdfAnnotationIndexChunkOptions extends PdfAnnotationParse.IPdfSidecarChunkOptions {}

export interface IPdfAnnotationIndexSession {
    readonly sessionId: TSessionId;
    readonly documentRef: TDocumentRef;
    readonly documentRevisionToken: TDocumentRevisionToken;
    readonly pageCount: number;
    readonly entryCount: number;
    readonly totalBytes: number;
}

export interface IPdfAnnotationIndexChunk {
    readonly offset: number;
    readonly nextOffset: number | null;
    readonly byteLength: number;
    readonly done: boolean;
    readonly entries: readonly IPdfAnnotationIndexEntry[];
}

export {
    PDF_ANNOTATION_PARSE_MAX_CHUNK_BYTES, PDF_ANNOTATION_PARSE_MAX_LINE_BYTES,
} from '@contracts/pdfAnnotationParseTypes';
export type * from '@contracts/pdfAnnotationParseTypes';
export type {
    IPdfDecryptRequest, IPdfDecryptResult, TPdfDecryptOutcome,
} from '@contracts/pdfDecryptSchemas';
/** A normalized point returned by the private embedded-shape index. */
export interface IPdfEmbeddedShapeIndexPoint {
    readonly x: number;
    readonly y: number;
}

/** A typed structural shape entry returned by the private embedded-shape index. */
export interface IPdfEmbeddedShapeIndexEntry {
    readonly pageIndex: TPageIndex;
    readonly objectNumber: number;
    readonly generationNumber: number;
    readonly stableKey: string | null;
    readonly pdfSubtype: TPdfNativeShapePdfSubtype;
    readonly type: TPdfNativeShapeType;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly x2: number | null;
    readonly y2: number | null;
    readonly color: string;
    readonly fillColor: string | null;
    readonly opacity: number;
    readonly strokeWidth: number;
    readonly points: readonly IPdfEmbeddedShapeIndexPoint[] | null;
    readonly strokes: ReadonlyArray<readonly IPdfEmbeddedShapeIndexPoint[]> | null;
    readonly lineStartStyle: TPdfNativeShapeLineEndStyle | null;
    readonly lineEndStyle: TPdfNativeShapeLineEndStyle | null;
    readonly createdAt: TEpochMs | null;
    readonly modifiedAt: TEpochMs | null;
}

/** The renderer requests at most 512 KiB of decoded shape-index data. */
export const PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES = 512 * 1024;
/** Native JSONL lines may be larger than one renderer pull, but never exceed 4 MiB. */
export const PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES = 4 * 1024 * 1024;

export interface IPdfEmbeddedShapeIndexOptions {expectedDocumentRevisionToken: TDocumentRevisionToken;}

export interface IPdfEmbeddedShapeIndexChunkOptions extends PdfAnnotationParse.IPdfSidecarChunkOptions {}

export interface IPdfEmbeddedShapeIndexSession {
    readonly sessionId: TSessionId;
    readonly documentRef: TDocumentRef;
    readonly documentRevisionToken: TDocumentRevisionToken;
    readonly pageCount: number;
    readonly entryCount: number;
    readonly totalBytes: number;
}

export interface IPdfEmbeddedShapeIndexChunk {
    readonly offset: number;
    readonly nextOffset: number | null;
    readonly byteLength: number;
    readonly done: boolean;
    readonly entries: readonly IPdfEmbeddedShapeIndexEntry[];
}

export const IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024;

export interface IManagedTempFileHandle {
    readonly path: TDocumentRef;
    readonly size: number;
    readonly sha256: string;
    readonly leaseId: TLeaseId;
    readonly revision: TDocumentRevisionToken | null;
}

export const WORKING_COPY_BACKING_STATUS_STATES = [
    'lazy-original',
    'materializing',
    'materialized',
] as const;

export type TWorkingCopyBackingStatusState = typeof WORKING_COPY_BACKING_STATUS_STATES[number];

export const WORKING_COPY_BACKING_FAILURE_CODES = [
    'SOURCE_BACKING_CHANGED',
    'SOURCE_BACKING_UNAVAILABLE',
    'WORKING_COPY_MATERIALIZATION_CANCELLED',
    'WORKING_COPY_MATERIALIZATION_FAILED',
    'WORKING_COPY_MATERIALIZATION_NO_SPACE',
    'WORKING_COPY_MATERIALIZATION_VERIFICATION_FAILED',
    'WORKING_COPY_REGISTRATION_CHANGED',
] as const;

export type TWorkingCopyBackingFailureCode = typeof WORKING_COPY_BACKING_FAILURE_CODES[number];

export interface IWorkingCopyBackingFailure {
    readonly code: TWorkingCopyBackingFailureCode;
    readonly retryable: boolean;
}

export interface IWorkingCopyBackingStatus {
    readonly documentRef: TDocumentRef;
    readonly failure: IWorkingCopyBackingFailure | null;
    readonly progress: number;
    readonly state: TWorkingCopyBackingStatusState;
}

export function decodeWorkingCopyBackingStatus(value: unknown): IWorkingCopyBackingStatus | null {
    if (!isRecord(value)) {
        return null;
    }
    const documentRef = parseDocumentRef(value.documentRef);
    if (
        documentRef === null
        || !isFiniteNumber(value.progress)
        || value.progress < 0
        || value.progress > 1
        || !isOneOf(WORKING_COPY_BACKING_STATUS_STATES, value.state)
    ) {
        return null;
    }
    const failure = value.failure;
    let decodedFailure: IWorkingCopyBackingFailure | null = null;
    if (failure !== null) {
        if (
            !isRecord(failure)
            || !isOneOf(WORKING_COPY_BACKING_FAILURE_CODES, failure.code)
            || typeof failure.retryable !== 'boolean'
        ) {
            return null;
        }
        decodedFailure = {
            code: failure.code,
            retryable: failure.retryable,
        };
    }
    return {
        documentRef,
        failure: decodedFailure,
        progress: value.progress,
        state: value.state,
    };
}

export function decodeManagedTempFileHandle(value: unknown): IManagedTempFileHandle | null {
    if (!isRecord(value)) {
        return null;
    }
    const path = parseDocumentRef(value.path);
    const leaseId = parseLeaseId(value.leaseId);
    if (
        path === null
        || typeof value.size !== 'number'
        || !Number.isSafeInteger(value.size)
        || value.size < 0
        || typeof value.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/u.test(value.sha256)
        || leaseId === null
        || (value.revision !== null && typeof value.revision !== 'string')
    ) {
        return null;
    }
    const revision = value.revision === null ? null : parseDocumentRevisionToken(value.revision);
    if (value.revision !== null && revision === null) {
        return null;
    }
    return {
        path,
        size: value.size,
        sha256: value.sha256,
        leaseId,
        revision,
    };
}

export const MAX_DOCUMENT_ALLOCATION_BYTES = 512 * 1024 * 1024;

export function decodeFileStatResult(
    value: unknown,
    maxBytes = Number.MAX_SAFE_INTEGER,
): {
    size: number;
    modifiedAt?: TEpochMs
} | null {
    if (
        !isRecord(value)
        || typeof value.size !== 'number'
        || !Number.isSafeInteger(value.size)
        || value.size < 0
        || value.size > maxBytes
    ) {
        return null;
    }
    const modifiedAt = value.modifiedAt === undefined ? undefined : parseEpochMs(value.modifiedAt);
    if (modifiedAt === null) {
        return null;
    }
    return {
        size: value.size,
        ...(modifiedAt === undefined ? {} : {modifiedAt}),
    };
}

export function assertDocumentAllocationSize(
    value: unknown,
    maxBytes = MAX_DOCUMENT_ALLOCATION_BYTES,
) {
    const decoded = decodeFileStatResult({size: value}, maxBytes);
    if (decoded === null) {
        throw new RangeError(`Document allocation size must be a non-negative safe integer no greater than ${maxBytes} bytes`);
    }
    return decoded.size;
}

export type TDocumentChunkSource = Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

export interface IOpenPdfDirectBatchProgress {
    readonly operation: TOpenBatchProgressOperation;
    readonly requestId: TRequestId;
    readonly processed: number;
    readonly total: number;
    readonly percent: number;
    readonly elapsedMs: number;
    readonly estimatedRemainingMs: number | null;
}

export type TOpenDocumentDirectBatchProgress = IOpenPdfDirectBatchProgress;

export interface IDocumentsBatchProgress {
    readonly processed: number;
    readonly total: number;
    readonly percent: number;
    readonly elapsedMs: number;
    readonly estimatedRemainingMs: number | null;
}

export interface ICreateCombinedPdfFromFilesOptions {
    onProgress?: (progress: IDocumentsBatchProgress) => void;
    signal?: AbortSignal;
}

export interface IOpenPdfResult {
    readonly kind: 'pdf';
    readonly workingPath: TDocumentRef;
    readonly originalPath: TDocumentRef;
    readonly isGenerated?: boolean;
    /** True when recovery reopened unsaved bytes from a prior checkpoint. */
    readonly recoveryDirtyBaseline?: boolean;
    readonly wasEncrypted?: true;
    /**
     * Authoritative first-page metadata discovered by the main process from
     * the admitted working copy. The workspace host can therefore publish
     * the exact opening frame in the same transaction that claims the file.
     */
    readonly openingGeometry?: IPdfOpeningGeometry;
}
export interface IOpenDjvuResult {
    readonly kind: 'djvu';
    readonly workingPath: '';
    readonly originalPath: TDocumentRef;
}

export type TOpenFileResult = IOpenPdfResult | IOpenDjvuResult | TPdfOpenFileFailureResult;
export type TOpenFolderDialogResult =
    | {
        readonly ok: true;
        readonly value: TOpenFileResult | null
    }
    | IPlatformUnsupportedResult;
export type TShowItemInFolderResult =
    | {readonly ok: true}
    | IPlatformUnsupportedResult;

export interface IPdfSaveAsOptions {
    optimizeLossless?: boolean;
    stagedOutput?: ITypedStagedArtifact;
}

export const PDF_OPTIMIZE_PRESETS = [
    'lossless',
    'balancedScanned',
    'smallScanned',
    'blackAndWhite',
] as const;

export type TPdfOptimizePreset = typeof PDF_OPTIMIZE_PRESETS[number];

export function isPdfOptimizePreset(value: unknown): value is TPdfOptimizePreset {
    return isOneOf(PDF_OPTIMIZE_PRESETS, value);
}

export type TPdfOptimizeProgressPhase =
    | 'preparing'
    | 'rendering'
    | 'assembling'
    | 'optimizing'
    | 'validating'
    | 'complete';

export interface IPdfOptimizeOptions { preset: TPdfOptimizePreset; }

export interface IDocumentMutationRevisionOptions {expectedDocumentRevisionToken: TDocumentRevisionToken;}

export interface IPdfSerializedSaveOptions extends IDocumentMutationRevisionOptions {
    changedObjectRefs?: string[];
    /** Stage validated bytes into the managed working copy without publishing its original file. */
    workingCopyOnly?: true;
}

export interface IPdfSerializedCommitCallbacks {
    verifyBytesBeforeCommit?: (bytes: Uint8Array) => Promise<void>;
    verifyPathBeforeCommit?: (path: TDocumentRef, knownSize: number) => Promise<void>;
    assertBeforeCommit?: () => Promise<void> | void;
}

export interface IPdfNativeAnnotationIdentityBinding {
    /** Canonical application annotation identity from the save frontier. */
    readonly annotationId: string;
    /** Canonical indirect PDF object reference, formatted as `N G R`. */
    readonly pdfRef: string;
}

export interface IPdfNativeStagedCommitOptions extends IDocumentMutationRevisionOptions {
    changedObjectRefs?: string[];
    /** Bindings returned by the native staged mutation that is being committed. */
    identityBindings?: IPdfNativeAnnotationIdentityBinding[];
}

export interface IPdfOptimizeProgress {
    readonly requestId: TRequestId;
    readonly preset: TPdfOptimizePreset;
    readonly phase: TPdfOptimizeProgressPhase;
    readonly processed: number;
    readonly total: number;
    readonly percent: number;
}

const PDF_OPTIMIZE_PROGRESS_PHASES = [
    'preparing',
    'rendering',
    'assembling',
    'optimizing',
    'validating',
    'complete',
] as const satisfies readonly TPdfOptimizeProgressPhase[];
const OPEN_BATCH_PROGRESS_OPERATIONS = [
    'document-open',
    'page-insert',
] as const satisfies readonly TOpenBatchProgressOperation[];

function decodeProgressCounters(value: Record<string, unknown>, label: string) {
    if (
        !isFiniteNumber(value.processed)
        || value.processed < 0
        || !isFiniteNumber(value.total)
        || value.total < 0
        || !isFiniteNumber(value.percent)
    ) {
        throw new Error(`invalid ${label} progress counters`);
    }
    return {
        processed: value.processed,
        total: value.total,
        percent: value.percent,
    };
}

export function decodeOptimizeProgress(value: unknown): IPdfOptimizeProgress {
    const requestId = isRecord(value) ? parseRequestId(value.requestId) : null;
    if (
        !isRecord(value)
        || requestId === null
        || !isPdfOptimizePreset(value.preset)
        || !isOneOf(PDF_OPTIMIZE_PROGRESS_PHASES, value.phase)
    ) {
        throw new Error('invalid PDF optimize progress event');
    }
    return {
        requestId,
        preset: value.preset,
        phase: value.phase,
        ...decodeProgressCounters(value, 'PDF optimize'),
    };
}

export function decodeOpenBatchProgress(value: unknown): TOpenDocumentDirectBatchProgress {
    const requestId = isRecord(value) ? parseRequestId(value.requestId) : null;
    if (
        !isRecord(value)
        || requestId === null
        || !isOneOf(OPEN_BATCH_PROGRESS_OPERATIONS, value.operation)
        || !isFiniteNumber(value.elapsedMs)
        || value.elapsedMs < 0
        || (value.estimatedRemainingMs !== null && !isFiniteNumber(value.estimatedRemainingMs))
    ) {
        throw new Error('invalid open-batch progress event');
    }
    return {
        operation: value.operation,
        requestId,
        ...decodeProgressCounters(value, 'open-batch'),
        elapsedMs: value.elapsedMs,
        estimatedRemainingMs: value.estimatedRemainingMs,
    };
}

export interface IPdfOptimizeResult {
    readonly path: TDocumentRef | null;
    readonly validation: IPdfValidationResult | null;
    readonly preset: TPdfOptimizePreset;
    readonly originalBytes: number | null;
    readonly optimizedBytes: number | null;
    readonly pageCount: number | null;
}

export interface IPdfNativePageSize {
    readonly width: number;
    readonly height: number;
}

export interface IPdfNativePageSizeOverride extends IPdfNativePageSize {readonly pageNumber: TPageNumber;}

/** Compact native page metadata carries only bounded early/late overrides. */
export const PDF_NATIVE_PAGE_SIZE_OVERRIDE_LIMIT = 256;

/**
 * Compact native page-size metadata for documents whose page count cannot be
 * represented by a materialized JavaScript array.
 */
export interface IPdfNativePageSizes {
    readonly pageCount: number;
    readonly defaultPageSize: IPdfNativePageSize;
    readonly overrides: readonly IPdfNativePageSizeOverride[];
}

export type TPdfNativePageSizes = readonly IPdfNativePageSize[] | IPdfNativePageSizes;

export interface IPdfOpeningGeometry {
    readonly pageNumber: TPageNumber;
    readonly pageCount: number;
    readonly width: number;
    readonly height: number;
    readonly rotation: 0 | 90 | 180 | 270;
    readonly size: number;
    readonly modifiedAt: TEpochMs;
    readonly linearized?: boolean;
}

export interface IPdfNativePagePreviewOptions {
    previewRequestId?: TRequestId;
    targetWidthPx?: number;
}

export const PDF_NATIVE_PAGE_PREVIEW_RASTER_WIDTH_CEILING_PX = 4_096;

export interface IPdfNativePagePreview {
    readonly bytes: Uint8Array;
    readonly width: number;
    readonly height: number;
    readonly rasterWidthCeilingPx?: number;
}

export interface IPdfNoteTextUpdate {
    objectNumber: number;
    generationNumber: number;
    text: string;
}

/** A bounded geometry update for an existing indirect annotation. */
export interface IPdfNoteGeometryUpdate {
    objectNumber: number;
    generationNumber: number;
    pageIndex: TPageIndex;
    markerRect: IMarkerRect;
    /** Omitted keeps the imported PDF color. Null removes `/C`. */
    color?: string | null;
    open?: boolean;
}

export type IPdfNativeFreeTextNoteMarkerRect = IMarkerRect;

export interface IPdfNativeFreeTextNote {
    recoveryData?: string;
    pageIndex: TPageIndex;
    stableKey: string;
    text: string;
    markerRect: IPdfNativeFreeTextNoteMarkerRect;
    author?: string | null;
    color?: string | null;
    createdAt?: TEpochMs | null;
    open?: boolean;
}

export interface IPdfNativeTextBoxMutation {
    pageIndex: TPageIndex;
    stableKey: string;
    /** Existing PDF object ref when this mutation updates imported FreeText. */
    annotationId?: string | null;
    text: string;
    rect: [number, number, number, number];
    rotation: 0 | 90 | 180 | 270;
    fontSize: number;
    color: [number, number, number];
    author?: string | null;
    createdAt?: number | null;
    modifiedAt?: number | null;
}
export type IPdfNativeFreeTextEditor = IPdfNativeTextBoxMutation;
export interface IPdfNativeAnnotationDelete {
    pageIndex: TPageIndex;
    objectNumber?: number;
    generationNumber?: number;
    stableKey?: string;
    createdAt?: TEpochMs | null;
}
export interface IPdfNativeNoteChanges {
    updates?: IPdfNoteTextUpdate[];
    geometryUpdates?: IPdfNoteGeometryUpdate[];
    freeTextNotes?: IPdfNativeFreeTextNote[];
    deletes?: IPdfNativeAnnotationDelete[];
}
export type TPdfNativePageLabelStyle = TPdfPageLabelStyle;
export type IPdfNativePageLabelRange = IPdfPageLabelRange;
export type IPdfNativePageLabelsMutation = IPdfPageLabelsMutation;

export interface IPdfNativeBookmarksMutation {
    totalPages: number;
    untitledLabel: string;
    items: IPdfBookmarkEntry[];
}

export type TPdfNativeShapeType = TPdfAnnotationShapeType;
export type TPdfNativeShapePdfSubtype = TPdfAnnotationShapePdfSubtype;
export type TPdfNativeShapeLineEndStyle = TPdfAnnotationLineEndStyle;

export type IPdfNativeShapePoint = IPoint2D;

export interface IPdfNativeShapeAnnotation {
    author?: string | null;
    id?: string;
    type: TPdfNativeShapeType;
    pageIndex: TPageIndex;
    x: number;
    y: number;
    width: number;
    height: number;
    x2?: number | null;
    y2?: number | null;
    color: string;
    fillColor?: string | null;
    opacity: number;
    strokeWidth: number;
    points?: IPdfNativeShapePoint[];
    strokes?: IPdfNativeShapePoint[][];
    annotationId?: string | null;
    stableKey?: string | null;
    pdfSubtype?: TPdfNativeShapePdfSubtype | null;
    lineStartStyle?: TPdfNativeShapeLineEndStyle | null;
    lineEndStyle?: TPdfNativeShapeLineEndStyle | null;
    createdAt?: TEpochMs | null;
    modifiedAt?: TEpochMs | null;
}

export interface IPdfNativeShapesMutation {
    totalPages: number;
    rewriteShapeState: boolean;
    shapes: IPdfNativeShapeAnnotation[];
    deletedAnnotationIds: string[];
    deletedStableKeys: string[];
}

export type TPdfNativeMarkupSubtype = TPdfAnnotationMarkupSubtype;

export type IPdfNativeMarkupMarkerRect = IMarkerRect;

export interface IPdfNativeMarkupSubtypeHint {
    author?: string | null;
    subtype: TPdfNativeMarkupSubtype;
    pageIndex: TPageIndex;
    markerRect: IPdfNativeMarkupMarkerRect;
    /** One normalized marker rectangle per source text-markup quad. */
    markupGeometry?: IPdfNativeMarkupMarkerRect[] | null;
    /** Canonical application identity for a newly authored markup annotation. */
    appAnnotationId?: string | null;
    annotationId?: string | null;
    color?: string | null;
    opacity?: number | null;
    /** Replacement `/Contents` note text when this hint represents a canonical edit. */
    contents?: string | null;
    id?: string | null;
    pageMarkupIndex?: number | null;
    source?: string | null;
}

export interface IPdfNativeMarkupMutation {
    overrides: Array<readonly [string, TPdfNativeMarkupSubtype]>;
    hints: IPdfNativeMarkupSubtypeHint[];
}

export interface IPdfNativePlacedImage extends IPdfBox {
    author?: string | null;
    pageIndex: TPageIndex;
    stableKey?: string;
    annotationId?: string | null;
    rotationDegrees?: number | null;
    mimeType: 'image/jpeg' | 'image/png';
    source?: IManagedTempFileHandle;
    bytesBase64?: string;
    byteLength?: number;
    sha256?: string;
}

export interface IPdfNativePlacedImageGeometryUpdate extends IPdfBox {
    author?: string | null;
    sourceImage?: IPdfAnnotationStampImageReference;
    pageIndex: TPageIndex;
    stableKey?: string;
    annotationId?: string | null;
    rotationDegrees?: number | null;
}

export interface IPdfNativeMutationSet extends IPdfNativeNoteChanges {
    textBoxes?: IPdfNativeTextBoxMutation[];
    freeTextEditors?: IPdfNativeFreeTextEditor[];
    pageLabels?: IPdfNativePageLabelsMutation;
    bookmarks?: IPdfNativeBookmarksMutation;
    shapes?: IPdfNativeShapesMutation;
    markup?: IPdfNativeMarkupMutation;
    placedImages?: IPdfNativePlacedImage[];
    placedImageGeometryUpdates?: IPdfNativePlacedImageGeometryUpdate[];
}

export interface IPdfNativeNoteTextSaveResult {
    readonly applied: boolean;
    readonly validation: IPdfValidationResult | null;
    /**
     * The native mutation writer checked every projected mutation against the
     * staged appended revision before returning it. An affirmative proof lets
     * the renderer avoid reopening a multi-gigabyte PDF in PDF.js merely to
     * repeat the same semantic checks.
     */
    readonly nativeMutationPostconditionsVerified?: true;
    /** Exact canonical identities and indirect refs created by the native mutation. */
    readonly identityBindings?: readonly IPdfNativeAnnotationIdentityBinding[];
    readonly error?: INativeErrorEnvelope;
    readonly syncError?: string;
    /** Immutable native output. It is not visible as document state until committed. */
    readonly stagedOutput?: ITypedStagedArtifact;
}

export type IPdfNativeSaveResult = IPdfNativeNoteTextSaveResult;

export interface IPdfSaveAsResult {
    readonly path: TDocumentRef | null;
    readonly validation: IPdfValidationResult | null;
    /**
     * The target file was written but the working copy could not be rebound to
     * it, so the open document no longer corresponds to the file the user just
     * saved. Reported as its own member rather than a validation warning: the
     * save did not fully succeed, and the caller has to keep the dirty state.
     */
    readonly warning?: IPdfSaveAsWarning;
}

export interface IPdfSaveAsWarning {
    readonly reason: Extract<TDocumentSaveFailureReason, 'working-copy-sync-required'>;
    readonly message: string;
}

export function createWorkingCopySyncWarning(detail: string): IPdfSaveAsWarning {
    return {
        reason: 'working-copy-sync-required',
        message: `The file was written, but this document is no longer connected to it: ${detail}`,
    };
}

export interface IPdfCommittedSaveAsResult extends IPdfSaveAsResult {readonly validation: IPdfValidationResult;}

export type TDocumentSaveFailureReason =
    | 'user-canceled'
    | 'validation-failed'
    | 'working-copy-missing'
    | 'write-failed'
    | 'refresh-failed'
    | 'working-copy-sync-required'
    | 'unsupported'
    | 'stale'
    | 'unknown';

export interface IDocumentSaveSuccessResult {
    readonly ok: true;
    readonly externalWriteCommitted: boolean;
    readonly workingCopyRefreshed: boolean;
    readonly validation?: IPdfValidationResult | null;
    readonly warning?: {
        readonly reason: Extract<TDocumentSaveFailureReason, 'refresh-failed'>;
        readonly message: string;
    };
}

export interface IDocumentSaveFailureResult {
    readonly ok: false;
    readonly reason: TDocumentSaveFailureReason;
    readonly message?: string;
    /** null means a timed-out browser writer may still commit later. */
    readonly externalWriteCommitted?: boolean | null;
    readonly workingCopySyncRequired?: boolean;
    readonly validation?: IPdfValidationResult | null;
}

export type TDocumentSaveResult =
    | IDocumentSaveSuccessResult
    | IDocumentSaveFailureResult;

export type TImageExportProgressFormat = 'images' | 'multipage-tiff';
export type TImageExportProgressPhase = 'rendering' | 'combining';
export type TImageExportProgressStatus = 'running' | 'success' | 'canceled' | 'failed';

export interface IImageExportProgress {
    readonly requestId: TRequestId;
    readonly format: TImageExportProgressFormat;
    readonly phase: TImageExportProgressPhase;
    readonly processed: number;
    readonly total: number;
    readonly percent: number;
    readonly status?: TImageExportProgressStatus;
    readonly error?: string;
}

export type TDocumentImageExportSourceKind = 'pdf' | 'djvu';

export interface IApplicationMenuDocumentState {
    hasDocument: boolean;
    interactive?: boolean;
    canSave: boolean;
    supportsSaveAs?: boolean;
    canSaveAs?: boolean;
    supportsRepairSave?: boolean;
    canRepairSave?: boolean;
    supportsOptimizePdf?: boolean;
    canOptimizePdf?: boolean;
    supportsPrint?: boolean;
    canPrint?: boolean;
    supportsExportDocx?: boolean;
    canExportDocx?: boolean;
    isExportingDocx?: boolean;
    supportsRasterExport?: boolean;
    canExportRaster?: boolean;
    canUndo?: boolean;
    canRedo?: boolean;
    supportsPdfMutation?: boolean;
    canMutatePages?: boolean;
    selectedPageCount?: number;
    totalPages?: number;
    supportsContinuousScroll?: boolean;
    canContinuousScroll?: boolean;
    continuousScroll?: boolean;
    supportsViewMode?: boolean;
    viewMode?: TPdfViewMode;
    supportsViewRotation?: boolean;
    viewRotation?: TPdfViewRotation;
    isActualSizeActive?: boolean;
    isFitWidthActive?: boolean;
    isFitHeightActive?: boolean;
    canToggleAssistant?: boolean;
    canCreatePane?: boolean;
    canCloseTab?: boolean;
    canTransferActiveTab?: boolean;
}

export interface IDocumentsMenuCapability {
    setMenuDocumentState: (state: boolean | IApplicationMenuDocumentState) => Promise<void>;
    setMenuTabCount: (tabCount: number) => Promise<void>;
    onPdfOptimizeProgress: (callback: (progress: IPdfOptimizeProgress) => void) => TMenuEventUnsubscribe;
    onMenuOpenPdf: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuInsertImageFromFile: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuPasteImageFromClipboard: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuSave: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuRepairSave: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuOptimizePdfForInteraction: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuSaveAs: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuPrint: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuPrintCurrentPage: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuExportDocx: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuExportImages: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuExportMultiPageTiff: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuZoomIn: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuZoomOut: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuActualSize: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuFitWidth: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuFitHeight: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuToggleContinuousScroll: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuViewModeSingle: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuViewModeFacing: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuViewModeFacingFirstSingle: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuViewRotationCw: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuViewRotationCcw: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuToggleAssistant: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuUndo: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuRedo: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuSelectAll: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuDeletePages: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuExtractPages: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuRotateCw: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuRotateCcw: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuInsertPages: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuOpenRecentFile: (callback: (path: TDocumentRef) => void) => TMenuEventUnsubscribe;
    onMenuOpenExternalPaths: (callback: (paths: TDocumentRef[]) => void) => TMenuEventUnsubscribe;
    onMenuClearRecentFiles: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
}

export interface IDocumentsFileCapability {
    openDocumentDialog: () => Promise<TOpenFileResult | null>;
    openCombineDialog: () => Promise<TOpenFileResult | null>;
    openFolderDialog: () => Promise<TOpenFileResult | null>;
    openFolderDialogStructured?: () => Promise<TOpenFolderDialogResult>;
    openImageDialog: () => Promise<string | null>;
    openDocumentDirect: (path: TDocumentRef, password?: string) => Promise<TOpenFileResult | null>;
    openDocumentDirectBatch: (
        paths: TDocumentRef[],
        requestId?: TRequestId,
        options?: {forceCombine?: boolean},
    ) => Promise<TOpenFileResult | null>;
    cancelOpenDocumentDirectBatch?: (requestId: TRequestId) => Promise<boolean>;
    savePdfAs: (
        workingCopyPath: TDocumentRef,
        options: IPdfSaveAsOptions | undefined,
        revisionOptions?: IDocumentMutationRevisionOptions,
    ) => Promise<TDocumentRef | null>;
    savePdfDialog: (suggestedName: string) => Promise<string | null>;
    saveDocxAs: (workingCopyPath: TDocumentRef) => Promise<TDocumentRef | null>;
    readFile: (path: TDocumentRef) => Promise<Uint8Array>;
    statFile: (path: TDocumentRef) => Promise<{
        size: number;
        modifiedAt?: TEpochMs
    }>;
    readFileRange: (path: TDocumentRef, offset: number, length: number) => Promise<Uint8Array>;
    createManagedTempFileHandle?: (path: TDocumentRef) => Promise<IManagedTempFileHandle>;
    releaseManagedTempFileHandle?: (leaseId: TLeaseId) => Promise<boolean>;
    parsePdfAnnotations: PdfAnnotationParse.TPdfAnnotationParse;
    getPdfOpeningGeometry?: (path: TDocumentRef) => Promise<IPdfOpeningGeometry | null>;
    getPdfNativePageSizes?: (path: TDocumentRef) => Promise<TPdfNativePageSizes>;
    cancelPdfNativePagePreview?: (requestId: TRequestId) => Promise<{ canceled: boolean }>;
    renderPdfNativePagePreview?: (
        path: TDocumentRef,
        pageNumber: TPageNumber,
        options?: IPdfNativePagePreviewOptions,
    ) => Promise<IPdfNativePagePreview>;
    beginPdfAnnotationIndex?: (
        path: TDocumentRef,
        options: IPdfAnnotationIndexOptions,
    ) => Promise<IPdfAnnotationIndexSession>;
    readPdfAnnotationIndexChunk?: (
        sessionId: TSessionId,
        offset: number,
        options?: IPdfAnnotationIndexChunkOptions,
    ) => Promise<IPdfAnnotationIndexChunk>;
    releasePdfAnnotationIndex?: (sessionId: TSessionId) => Promise<boolean>;
    cancelPdfAnnotationIndex?: (sessionId: TSessionId) => Promise<{canceled: boolean}>;
    beginPdfAnnotationParse?: PdfAnnotationParse.TPdfAnnotationParseBegin;
    readPdfAnnotationParseChunk?: PdfAnnotationParse.TPdfAnnotationParseReadChunk;
    releasePdfAnnotationParse?: PdfAnnotationParse.TPdfAnnotationParseRelease;
    cancelPdfAnnotationParse?: PdfAnnotationParse.TPdfAnnotationParseCancel;
    beginPdfEmbeddedShapeIndex?: (
        path: TDocumentRef,
        options: IPdfEmbeddedShapeIndexOptions,
    ) => Promise<IPdfEmbeddedShapeIndexSession>;
    readPdfEmbeddedShapeIndexChunk?: (
        sessionId: TSessionId,
        offset: number,
        options?: IPdfEmbeddedShapeIndexChunkOptions,
    ) => Promise<IPdfEmbeddedShapeIndexChunk>;
    releasePdfEmbeddedShapeIndex?: (sessionId: TSessionId) => Promise<boolean>;
    cancelPdfEmbeddedShapeIndex?: (sessionId: TSessionId) => Promise<{canceled: boolean}>;
    decryptPdfWorkingCopy?: (path: TDocumentRef, request?: IPdfDecryptRequest) => Promise<IPdfDecryptResult>;
    readFileChunks: (
        path: TDocumentRef,
        options: IDocumentChunkReadOptions,
        onChunk: (chunk: Uint8Array, offset: number) => void | Promise<void>,
    ) => Promise<IDocumentChunkReadResult>;
    readTextFile: (path: TDocumentRef) => Promise<string>;
    fileExists: (path: TDocumentRef) => Promise<boolean>;
    getDocumentRevision: (path: TDocumentRef) => Promise<IDocumentRevisionInfo>;
    getWorkingCopyBackingStatus?: (path: TDocumentRef) => Promise<IWorkingCopyBackingStatus | null>;
    analyzePdfConformance: (
        path: TDocumentRef,
        options?: IPdfConformanceAnalysisOptions,
    ) => Promise<IPdfConformanceProfile>;
    validatePdfData: (data: Uint8Array, fileName?: string) => Promise<IPdfValidationResult>;
    openPdfInDefaultAppData: (data: Uint8Array, fileName?: string) => Promise<{
        success: boolean;
        error?: string;
        unsupportedReason?: TPlatformUnsupportedReason;
    }>;
    openPdfInDefaultAppPath: (path: TDocumentRef, fileName?: string) => Promise<{
        success: boolean;
        error?: string;
        unsupportedReason?: TPlatformUnsupportedReason;
    }>;
    printPdfData: (data: Uint8Array, fileName?: string, options?: IPdfDataPrintOptions) => Promise<{
        success: boolean;
        canceled?: boolean;
        error?: string;
        unsupportedReason?: TPlatformUnsupportedReason;
    }>;
    cancelPdfPrint?: (requestId: TRequestId) => Promise<{canceled: boolean}>;
    printPdfPath: (path: TDocumentRef, fileName?: string, options?: IPdfPathPrintOptions) => Promise<{
        success: boolean;
        canceled?: boolean;
        error?: string;
        unsupportedReason?: TPlatformUnsupportedReason;
    }>;
    onNativePrintDialogOpened?: (
        callback: (event: IPdfNativePrintDialogOpenedEvent) => void,
    ) => TMenuEventUnsubscribe;
    writeFile: (path: TDocumentRef, data: Uint8Array, options?: IDocumentMutationRevisionOptions) => Promise<boolean>;
    replaceWorkingCopyFromPath: (
        workingCopyPath: TDocumentRef,
        sourcePath: TDocumentRef,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<boolean>;
    writeDocxFile: (path: TDocumentRef, data: Uint8Array, signal?: AbortSignal) => Promise<boolean>;
    createWorkingCopyFromData: (fileName: string, data: Uint8Array, originalPath?: TDocumentRef, password?: string) => Promise<TDocumentRef>;
    createWorkingCopyFromPath: (sourcePath: TDocumentRef, originalPath?: TDocumentRef, password?: string) => Promise<TDocumentRef>;
    saveFileStructured: (path: TDocumentRef, options?: IDocumentMutationRevisionOptions) => Promise<TDocumentSaveResult>;
    resyncWorkingCopy?: (path: TDocumentRef) => Promise<TDocumentSaveResult>;
    savePdfData: (
        path: TDocumentRef,
        data: Uint8Array,
        options?: IPdfSerializedSaveOptions,
        commitCallbacks?: IPdfSerializedCommitCallbacks,
    ) => Promise<IPdfValidationResult>;
    savePdfDataChunks: (
        path: TDocumentRef,
        totalBytes: number,
        chunks: TDocumentChunkSource,
        options?: IPdfSerializedSaveOptions,
        commitCallbacks?: IPdfSerializedCommitCallbacks,
    ) => Promise<IPdfValidationResult>;
    repairPdf?: (path: TDocumentRef, options?: IDocumentMutationRevisionOptions) => Promise<IPdfValidationResult>;
    optimizePdfForInteraction?: (path: TDocumentRef, options?: IDocumentMutationRevisionOptions) => Promise<IPdfValidationResult>;
    optimizePdfAsCopy?: (
        path: TDocumentRef,
        options: IPdfOptimizeOptions,
        requestId?: TRequestId,
        revisionOptions?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfOptimizeResult>;
    savePdfNoteTextUpdates?: (
        path: TDocumentRef,
        updates: IPdfNoteTextUpdate[],
        modifiedAt: TPdfDateString,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfNativeNoteTextSaveResult>;
    savePdfNoteChanges?: (
        path: TDocumentRef,
        changes: IPdfNativeNoteChanges,
        modifiedAt: TPdfDateString,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfNativeNoteTextSaveResult>;
    savePdfNativeMutations?: (
        path: TDocumentRef,
        mutations: IPdfNativeMutationSet,
        modifiedAt: TPdfDateString,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfNativeSaveResult>;
    applyPdfNativeMutationsToWorkingCopy?: (
        path: TDocumentRef,
        mutations: IPdfNativeMutationSet,
        modifiedAt: TPdfDateString,
        options: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfNativeSaveResult>;
    commitStagedPdfNativeMutations?: (
        path: TDocumentRef,
        stagedOutput: ITypedStagedArtifact,
        options?: IPdfNativeStagedCommitOptions,
    ) => Promise<IPdfNativeSaveResult>;
    /** Consume a native staged receipt as an uncommitted split snapshot. */
    cloneStagedPdfNativeMutationToWorkingCopy?: (
        stagedOutput: ITypedStagedArtifact,
        originalPath?: TDocumentRef,
    ) => Promise<TDocumentRef>;
    /** Consume a native staged receipt by replacing only the working copy. */
    replaceWorkingCopyFromStagedPdfNativeMutation?: (
        path: TDocumentRef,
        stagedOutput: ITypedStagedArtifact,
        options: IDocumentMutationRevisionOptions,
    ) => Promise<boolean>;
    savePdfDataAs: (
        workingCopyPath: TDocumentRef,
        data: Uint8Array,
        options?: IPdfSaveAsOptions,
        serializedSaveOptions?: IPdfSerializedSaveOptions,
        commitCallbacks?: IPdfSerializedCommitCallbacks,
    ) => Promise<IPdfSaveAsResult>;
    validatePdfPath: (
        path: TDocumentRef,
        options?: IPdfPathValidationOptions,
    ) => Promise<IPdfValidationResult>;
    cleanupFile: (path: TDocumentRef) => Promise<void>;
    cleanupOcrTemp: (path: TDocumentRef) => Promise<void>;
    setWindowTitle: (title: string) => Promise<void>;
    showItemInFolder: (path: TDocumentRef) => Promise<boolean>;
    showItemInFolderStructured?: (path: TDocumentRef) => Promise<TShowItemInFolderResult>;
    onDocumentRevisionChanged: (
        callback: (event: IDocumentRevisionChangedEvent) => void,
    ) => TMenuEventUnsubscribe;
    onWorkingCopyBackingStatusChanged?: (
        callback: (event: IWorkingCopyBackingStatus) => void,
    ) => TMenuEventUnsubscribe;

    recentFiles: {
        get: () => Promise<IRecentFile[]>;
        remove: (path: TDocumentRef) => Promise<void>;
        clear: () => Promise<void>;
    };

    /**
     * Synchronous native path extraction for file inputs. Browser File ingestion
     * for open/drop flows must use registerFilesForOpen so ingestion failures
     * reach the caller before a document ref is opened.
     */
    getPathForFile: (file: File) => TDocumentRef;
    /**
     * Synchronous native path extraction for file inputs. Browser File ingestion
     * for open/drop flows must use registerFilesForOpen so ingestion failures
     * reach the caller before document refs are opened.
     */
    getPathsForFiles: (files: File[]) => TDocumentRef[];
    registerFilesForOpen: (files: File[]) => Promise<TDocumentRef[]>;
    createCombinedPdfFromFiles?: (
        files: File[],
        options?: ICreateCombinedPdfFromFilesOptions,
    ) => Promise<Uint8Array>;
}

export interface IPdfPathValidationOptions {purpose: 'opening';}

export interface IDocumentsPickerCapability extends Pick<
    IDocumentsFileCapability,
    | 'openDocumentDialog'
    | 'openCombineDialog'
    | 'openFolderDialog'
    | 'openFolderDialogStructured'
    | 'openImageDialog'
    | 'getPathForFile'
    | 'getPathsForFiles'
    | 'registerFilesForOpen'
    | 'createCombinedPdfFromFiles'
> {}

export interface IDocumentsOpenCapability extends Pick<
    IDocumentsFileCapability,
    | 'openDocumentDirect'
    | 'openDocumentDirectBatch'
    | 'cancelOpenDocumentDirectBatch'
> {onOpenDocumentDirectBatchProgress: (
    callback: (progress: TOpenDocumentDirectBatchProgress) => void,
) => TMenuEventUnsubscribe;}

export interface IDocumentsWorkingCopyCapability extends Pick<
    IDocumentsFileCapability,
    | 'createWorkingCopyFromData'
    | 'createWorkingCopyFromPath'
    | 'parsePdfAnnotations'
    | 'cleanupFile'
    | 'cleanupOcrTemp'
> {}

export interface IDocumentsReadCapability extends Pick<
    IDocumentsFileCapability,
    | 'readFile'
    | 'statFile'
    | 'readFileRange'
    | 'createManagedTempFileHandle'
    | 'releaseManagedTempFileHandle'
    | 'getPdfOpeningGeometry'
    | 'getPdfNativePageSizes'
    | 'cancelPdfNativePagePreview'
    | 'renderPdfNativePagePreview'
    | 'beginPdfAnnotationIndex'
    | 'readPdfAnnotationIndexChunk'
    | 'releasePdfAnnotationIndex'
    | 'cancelPdfAnnotationIndex'
    | 'beginPdfAnnotationParse'
    | 'readPdfAnnotationParseChunk'
    | 'releasePdfAnnotationParse'
    | 'cancelPdfAnnotationParse'
    | 'beginPdfEmbeddedShapeIndex'
    | 'readPdfEmbeddedShapeIndexChunk'
    | 'releasePdfEmbeddedShapeIndex'
    | 'cancelPdfEmbeddedShapeIndex'
    | 'decryptPdfWorkingCopy'
    | 'readFileChunks'
    | 'readTextFile'
    | 'fileExists'
    | 'getDocumentRevision'
    | 'getWorkingCopyBackingStatus'
    | 'onDocumentRevisionChanged'
    | 'onWorkingCopyBackingStatusChanged'
> {}

export interface IDocumentsPdfValidationCapability extends Pick<
    IDocumentsFileCapability,
    | 'analyzePdfConformance'
    | 'validatePdfData'
    | 'validatePdfPath'
> {}
export interface IDocumentsPdfExternalCapability extends Pick<
    IDocumentsFileCapability,
    | 'openPdfInDefaultAppData'
    | 'openPdfInDefaultAppPath'
    | 'printPdfData'
    | 'cancelPdfPrint'
    | 'printPdfPath'
    | 'onNativePrintDialogOpened'
> {}
export interface IDocumentsPdfPersistenceCapability extends Pick<
    IDocumentsFileCapability,
    | 'savePdfAs'
    | 'savePdfDataAs'
    | 'savePdfDialog'
    | 'saveDocxAs'
    | 'writeFile'
    | 'replaceWorkingCopyFromPath'
    | 'writeDocxFile'
    | 'saveFileStructured'
    | 'resyncWorkingCopy'
    | 'savePdfData'
    | 'savePdfDataChunks'
    | 'repairPdf'
    | 'optimizePdfForInteraction'
    | 'optimizePdfAsCopy'
    | 'savePdfNoteTextUpdates'
    | 'savePdfNoteChanges'
    | 'savePdfNativeMutations'
    | 'applyPdfNativeMutationsToWorkingCopy'
    | 'commitStagedPdfNativeMutations'
    | 'cloneStagedPdfNativeMutationToWorkingCopy'
    | 'replaceWorkingCopyFromStagedPdfNativeMutation'
> {}

export interface IDocumentsFileIoCapability extends
    IDocumentsReadCapability,
    IDocumentsPdfPersistenceCapability {}

export interface IDocumentsPdfCapability extends
    IDocumentsPdfValidationCapability,
    IDocumentsPdfExternalCapability {}

export interface IDocumentsRecentFilesCapability extends Pick<
    IDocumentsFileCapability,
    'recentFiles'
> {}

export interface IDocumentsWindowCapability extends Pick<
    IDocumentsFileCapability,
    | 'setWindowTitle'
    | 'showItemInFolder'
    | 'showItemInFolderStructured'
> {}
