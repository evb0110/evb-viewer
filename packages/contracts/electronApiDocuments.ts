/* eslint-disable max-lines -- This file is the public desktop document protocol contract. */
import type { TDocumentRef } from '@contracts/documentRef';
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
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type {
    IPdfPageLabelsMutation,
    IPdfPageLabelRange,
    TPdfPageLabelStyle,
} from '@contracts/pdfPageLabels';
import type { TPageIndex } from '@contracts/pageNumbers';
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
} from '@contracts/shared';
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
    size: number;
    bytesRead: number;
    chunks: number;
}
export interface IPdfPathPrintOptions {
    pageNumbers?: number[];
    requestId?: string;
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
}
export interface IPdfDataPrintOptions {requestId?: string;}
export interface IPdfNativePrintDialogOpenedEvent {requestId: string;}
/** A PDF indirect-object reference returned by the native annotation index. */
export interface IPdfAnnotationIndexObjectRef {
    objectNumber: number;
    generationNumber: number;
}

export const PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES = 4 * 1024 * 1024;

/** One page-addressed annotation entry in a PDF annotation index. */
export interface IPdfAnnotationIndexEntry {
    pageIndex: TPageIndex;
    /** Zero is reserved for a direct-dictionary page-presence marker. */
    objectNumber: number;
    generationNumber: number;
    subtype: string;
    name: string | null;
    popupRef: IPdfAnnotationIndexObjectRef | null;
    parentRef: IPdfAnnotationIndexObjectRef | null;
}

export interface IPdfAnnotationIndexOptions {expectedDocumentRevisionToken: TDocumentRevisionToken;}

export interface IPdfAnnotationIndexChunkOptions extends PdfAnnotationParse.IPdfSidecarChunkOptions {}

export interface IPdfAnnotationIndexSession {
    sessionId: string;
    documentRef: TDocumentRef;
    documentRevisionToken: TDocumentRevisionToken;
    pageCount: number;
    entryCount: number;
    totalBytes: number;
}

export interface IPdfAnnotationIndexChunk {
    offset: number;
    nextOffset: number | null;
    byteLength: number;
    done: boolean;
    entries: IPdfAnnotationIndexEntry[];
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
    x: number;
    y: number;
}

/** A typed structural shape entry returned by the private embedded-shape index. */
export interface IPdfEmbeddedShapeIndexEntry {
    pageIndex: TPageIndex;
    objectNumber: number;
    generationNumber: number;
    stableKey: string | null;
    pdfSubtype: TPdfNativeShapePdfSubtype;
    type: TPdfNativeShapeType;
    x: number;
    y: number;
    width: number;
    height: number;
    x2: number | null;
    y2: number | null;
    color: string;
    fillColor: string | null;
    opacity: number;
    strokeWidth: number;
    points: IPdfEmbeddedShapeIndexPoint[] | null;
    strokes: IPdfEmbeddedShapeIndexPoint[][] | null;
    lineStartStyle: TPdfNativeShapeLineEndStyle | null;
    lineEndStyle: TPdfNativeShapeLineEndStyle | null;
    createdAt: number | null;
    modifiedAt: number | null;
}

/** The renderer requests at most 512 KiB of decoded shape-index data. */
export const PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES = 512 * 1024;
/** Native JSONL lines may be larger than one renderer pull, but never exceed 4 MiB. */
export const PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES = 4 * 1024 * 1024;

export interface IPdfEmbeddedShapeIndexOptions {expectedDocumentRevisionToken: TDocumentRevisionToken;}

export interface IPdfEmbeddedShapeIndexChunkOptions extends PdfAnnotationParse.IPdfSidecarChunkOptions {}

export interface IPdfEmbeddedShapeIndexSession {
    sessionId: string;
    documentRef: TDocumentRef;
    documentRevisionToken: TDocumentRevisionToken;
    pageCount: number;
    entryCount: number;
    totalBytes: number;
}

export interface IPdfEmbeddedShapeIndexChunk {
    offset: number;
    nextOffset: number | null;
    byteLength: number;
    done: boolean;
    entries: IPdfEmbeddedShapeIndexEntry[];
}

export const IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024;

export interface IManagedTempFileHandle {
    path: TDocumentRef;
    size: number;
    sha256: string;
    leaseId: string;
    revision: TDocumentRevisionToken | null;
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
    code: TWorkingCopyBackingFailureCode;
    retryable: boolean;
}

export interface IWorkingCopyBackingStatus {
    documentRef: TDocumentRef;
    failure: IWorkingCopyBackingFailure | null;
    progress: number;
    state: TWorkingCopyBackingStatusState;
}

export function decodeWorkingCopyBackingStatus(value: unknown): IWorkingCopyBackingStatus | null {
    if (
        !isRecord(value)
        || typeof value.documentRef !== 'string'
        || value.documentRef.trim().length === 0
        || !isFiniteNumber(value.progress)
        || value.progress < 0
        || value.progress > 1
        || !isOneOf(WORKING_COPY_BACKING_STATUS_STATES, value.state)
    ) {
        return null;
    }
    const failure = value.failure;
    if (
        failure !== null
        && (
            !isRecord(failure)
            || !isOneOf(WORKING_COPY_BACKING_FAILURE_CODES, failure.code)
            || typeof failure.retryable !== 'boolean'
        )
    ) {
        return null;
    }
    return {
        documentRef: value.documentRef,
        failure: failure === null
            ? null
            : {
                code: failure.code as TWorkingCopyBackingFailureCode,
                retryable: failure.retryable as boolean,
            },
        progress: value.progress,
        state: value.state,
    };
}

export function decodeManagedTempFileHandle(value: unknown): IManagedTempFileHandle | null {
    if (
        !isRecord(value)
        || typeof value.path !== 'string'
        || value.path.length === 0
        || typeof value.size !== 'number'
        || !Number.isSafeInteger(value.size)
        || value.size < 0
        || typeof value.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/u.test(value.sha256)
        || typeof value.leaseId !== 'string'
        || value.leaseId.length === 0
        || (value.revision !== null && typeof value.revision !== 'string')
    ) {
        return null;
    }
    const revision = value.revision === null ? null : parseDocumentRevisionToken(value.revision);
    if (value.revision !== null && revision === null) {
        return null;
    }
    return {
        path: value.path,
        size: value.size,
        sha256: value.sha256,
        leaseId: value.leaseId,
        revision,
    };
}

export const MAX_DOCUMENT_ALLOCATION_BYTES = 512 * 1024 * 1024;

export function decodeFileStatResult(
    value: unknown,
    maxBytes = Number.MAX_SAFE_INTEGER,
): {
    size: number;
    modifiedAt?: number
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
    const modifiedAt = value.modifiedAt;
    if (modifiedAt !== undefined && (
        typeof modifiedAt !== 'number'
        || !Number.isSafeInteger(modifiedAt)
        || modifiedAt < 0
    )) {
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
    operation: TOpenBatchProgressOperation;
    requestId: string;
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

export type TOpenDocumentDirectBatchProgress = IOpenPdfDirectBatchProgress;

export interface IDocumentsBatchProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

export interface ICreateCombinedPdfFromFilesOptions {
    onProgress?: (progress: IDocumentsBatchProgress) => void;
    signal?: AbortSignal;
}

export interface IOpenPdfResult {
    kind: 'pdf';
    workingPath: TDocumentRef;
    originalPath: TDocumentRef;
    isGenerated?: boolean;
    wasEncrypted?: true;
    /**
     * Authoritative first-page metadata discovered by the main process from
     * the admitted working copy. The workspace host can therefore publish
     * the exact opening frame in the same transaction that claims the file.
     */
    openingGeometry?: IPdfOpeningGeometry;
}
export interface IOpenDjvuResult {
    kind: 'djvu';
    workingPath: '';
    originalPath: TDocumentRef;
}

export type TOpenFileResult = IOpenPdfResult | IOpenDjvuResult | TPdfOpenFileFailureResult;
export type TOpenFolderDialogResult =
    | {
        ok: true;
        value: TOpenFileResult | null
    }
    | IPlatformUnsupportedResult;
export type TShowItemInFolderResult =
    | {ok: true}
    | IPlatformUnsupportedResult;

export interface IPdfSaveAsOptions { optimizeLossless?: boolean; }

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
    annotationId: string;
    /** Canonical indirect PDF object reference, formatted as `N G R`. */
    pdfRef: string;
}

export interface IPdfNativeStagedCommitOptions extends IDocumentMutationRevisionOptions {
    changedObjectRefs?: string[];
    /** Bindings returned by the native staged mutation that is being committed. */
    identityBindings?: IPdfNativeAnnotationIdentityBinding[];
}

export interface IPdfOptimizeProgress {
    requestId: string;
    preset: TPdfOptimizePreset;
    phase: TPdfOptimizeProgressPhase;
    processed: number;
    total: number;
    percent: number;
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
    if (
        !isRecord(value)
        || typeof value.requestId !== 'string'
        || !isPdfOptimizePreset(value.preset)
        || !isOneOf(PDF_OPTIMIZE_PROGRESS_PHASES, value.phase)
    ) {
        throw new Error('invalid PDF optimize progress event');
    }
    return {
        requestId: value.requestId,
        preset: value.preset,
        phase: value.phase,
        ...decodeProgressCounters(value, 'PDF optimize'),
    };
}

export function decodeOpenBatchProgress(value: unknown): TOpenDocumentDirectBatchProgress {
    if (
        !isRecord(value)
        || typeof value.requestId !== 'string'
        || !isOneOf(OPEN_BATCH_PROGRESS_OPERATIONS, value.operation)
        || !isFiniteNumber(value.elapsedMs)
        || value.elapsedMs < 0
        || (value.estimatedRemainingMs !== null && !isFiniteNumber(value.estimatedRemainingMs))
    ) {
        throw new Error('invalid open-batch progress event');
    }
    return {
        operation: value.operation,
        requestId: value.requestId,
        ...decodeProgressCounters(value, 'open-batch'),
        elapsedMs: value.elapsedMs,
        estimatedRemainingMs: value.estimatedRemainingMs,
    };
}

export interface IPdfOptimizeResult {
    path: TDocumentRef | null;
    validation: IPdfValidationResult | null;
    preset: TPdfOptimizePreset;
    originalBytes: number | null;
    optimizedBytes: number | null;
    pageCount: number | null;
}

export interface IPdfNativePageSize {
    width: number;
    height: number;
}

export interface IPdfNativePageSizeOverride extends IPdfNativePageSize {pageNumber: number;}

/** Compact native page metadata carries only bounded early/late overrides. */
export const PDF_NATIVE_PAGE_SIZE_OVERRIDE_LIMIT = 256;

/**
 * Compact native page-size metadata for documents whose page count cannot be
 * represented by a materialized JavaScript array.
 */
export interface IPdfNativePageSizes {
    pageCount: number;
    defaultPageSize: IPdfNativePageSize;
    overrides: IPdfNativePageSizeOverride[];
}

export type TPdfNativePageSizes = IPdfNativePageSize[] | IPdfNativePageSizes;

export interface IPdfOpeningGeometry {
    pageNumber: 1;
    pageCount: number;
    width: number;
    height: number;
    rotation: 0 | 90 | 180 | 270;
    size: number;
    modifiedAt: number;
    linearized?: boolean;
}

export interface IPdfNativePagePreviewOptions {
    previewRequestId?: string;
    targetWidthPx?: number;
}

export const PDF_NATIVE_PAGE_PREVIEW_RASTER_WIDTH_CEILING_PX = 4_096;

export interface IPdfNativePagePreview {
    bytes: Uint8Array;
    width: number;
    height: number;
    rasterWidthCeilingPx?: number;
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
}

export type IPdfNativeFreeTextNoteMarkerRect = IMarkerRect;

export interface IPdfNativeFreeTextNote {
    pageIndex: TPageIndex;
    stableKey: string;
    text: string;
    markerRect: IPdfNativeFreeTextNoteMarkerRect;
    author?: string | null;
    color?: string | null;
    createdAt?: number | null;
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
    createdAt?: number | null;
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
    createdAt?: number | null;
    modifiedAt?: number | null;
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
    subtype: TPdfNativeMarkupSubtype;
    pageIndex: TPageIndex;
    markerRect: IPdfNativeMarkupMarkerRect;
    /** One normalized marker rectangle per source text-markup quad. */
    markupGeometry?: IPdfNativeMarkupMarkerRect[] | null;
    /** Canonical application identity for a newly authored markup annotation. */
    appAnnotationId?: string | null;
    annotationId?: string | null;
    color?: string | null;
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
    pageIndex: TPageIndex;
    stableKey?: string;
    annotationId?: string | null;
    rotationDegrees?: number | null;
    mimeType: 'image/jpeg';
    source: IManagedTempFileHandle;
}

export interface IPdfNativePlacedImageGeometryUpdate extends IPdfBox {
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
    applied: boolean;
    validation: IPdfValidationResult | null;
    /**
     * The native mutation writer checked every projected mutation against the
     * staged appended revision before returning it. An affirmative proof lets
     * the renderer avoid reopening a multi-gigabyte PDF in PDF.js merely to
     * repeat the same semantic checks.
     */
    nativeMutationPostconditionsVerified?: true;
    /** Exact canonical identities and indirect refs created by the native mutation. */
    identityBindings?: IPdfNativeAnnotationIdentityBinding[];
    error?: INativeErrorEnvelope;
    syncError?: string;
    /** Immutable native output. It is not visible as document state until committed. */
    stagedOutput?: ITypedStagedArtifact;
}

export type IPdfNativeSaveResult = IPdfNativeNoteTextSaveResult;

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
    ok: true;
    externalWriteCommitted: boolean;
    workingCopyRefreshed: boolean;
    validation?: IPdfValidationResult | null;
    warning?: {
        reason: Extract<TDocumentSaveFailureReason, 'refresh-failed'>;
        message: string;
    };
}

export interface IDocumentSaveFailureResult {
    ok: false;
    reason: TDocumentSaveFailureReason;
    message?: string;
    /** null means a timed-out browser writer may still commit later. */
    externalWriteCommitted?: boolean | null;
    workingCopySyncRequired?: boolean;
    validation?: IPdfValidationResult | null;
}

export type TDocumentSaveResult =
    | IDocumentSaveSuccessResult
    | IDocumentSaveFailureResult;

export type TImageExportProgressFormat = 'images' | 'multipage-tiff';
export type TImageExportProgressPhase = 'rendering' | 'combining';
export type TImageExportProgressStatus = 'running' | 'success' | 'canceled' | 'failed';

export interface IImageExportProgress {
    requestId: string;
    format: TImageExportProgressFormat;
    phase: TImageExportProgressPhase;
    processed: number;
    total: number;
    percent: number;
    status?: TImageExportProgressStatus;
    error?: string;
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
        requestId?: string,
        options?: {forceCombine?: boolean},
    ) => Promise<TOpenFileResult | null>;
    cancelOpenDocumentDirectBatch?: (requestId: string) => Promise<boolean>;
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
        modifiedAt?: number
    }>;
    readFileRange: (path: TDocumentRef, offset: number, length: number) => Promise<Uint8Array>;
    createManagedTempFileHandle?: (path: TDocumentRef) => Promise<IManagedTempFileHandle>;
    releaseManagedTempFileHandle?: (leaseId: string) => Promise<boolean>;
    parsePdfAnnotations: PdfAnnotationParse.TPdfAnnotationParse;
    getPdfOpeningGeometry?: (path: TDocumentRef) => Promise<IPdfOpeningGeometry | null>;
    getPdfNativePageSizes?: (path: TDocumentRef) => Promise<TPdfNativePageSizes>;
    cancelPdfNativePagePreview?: (requestId: string) => Promise<{ canceled: boolean }>;
    renderPdfNativePagePreview?: (
        path: TDocumentRef,
        pageNumber: number,
        options?: IPdfNativePagePreviewOptions,
    ) => Promise<IPdfNativePagePreview>;
    beginPdfAnnotationIndex?: (
        path: TDocumentRef,
        options: IPdfAnnotationIndexOptions,
    ) => Promise<IPdfAnnotationIndexSession>;
    readPdfAnnotationIndexChunk?: (
        sessionId: string,
        offset: number,
        options?: IPdfAnnotationIndexChunkOptions,
    ) => Promise<IPdfAnnotationIndexChunk>;
    releasePdfAnnotationIndex?: (sessionId: string) => Promise<boolean>;
    cancelPdfAnnotationIndex?: (sessionId: string) => Promise<{canceled: boolean}>;
    beginPdfAnnotationParse?: PdfAnnotationParse.TPdfAnnotationParseBegin;
    readPdfAnnotationParseChunk?: PdfAnnotationParse.TPdfAnnotationParseReadChunk;
    releasePdfAnnotationParse?: PdfAnnotationParse.TPdfAnnotationParseRelease;
    cancelPdfAnnotationParse?: PdfAnnotationParse.TPdfAnnotationParseCancel;
    beginPdfEmbeddedShapeIndex?: (
        path: TDocumentRef,
        options: IPdfEmbeddedShapeIndexOptions,
    ) => Promise<IPdfEmbeddedShapeIndexSession>;
    readPdfEmbeddedShapeIndexChunk?: (
        sessionId: string,
        offset: number,
        options?: IPdfEmbeddedShapeIndexChunkOptions,
    ) => Promise<IPdfEmbeddedShapeIndexChunk>;
    releasePdfEmbeddedShapeIndex?: (sessionId: string) => Promise<boolean>;
    cancelPdfEmbeddedShapeIndex?: (sessionId: string) => Promise<{canceled: boolean}>;
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
    cancelPdfPrint?: (requestId: string) => Promise<{canceled: boolean}>;
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
        requestId?: string,
        revisionOptions?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfOptimizeResult>;
    savePdfNoteTextUpdates?: (
        path: TDocumentRef,
        updates: IPdfNoteTextUpdate[],
        modifiedAt: string,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfNativeNoteTextSaveResult>;
    savePdfNoteChanges?: (
        path: TDocumentRef,
        changes: IPdfNativeNoteChanges,
        modifiedAt: string,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfNativeNoteTextSaveResult>;
    savePdfNativeMutations?: (
        path: TDocumentRef,
        mutations: IPdfNativeMutationSet,
        modifiedAt: string,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfNativeSaveResult>;
    applyPdfNativeMutationsToWorkingCopy?: (
        path: TDocumentRef,
        mutations: IPdfNativeMutationSet,
        modifiedAt: string,
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
    ) => Promise<{
        path: TDocumentRef | null;
        validation: IPdfValidationResult | null;
    }>;
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
        removeIfMissing: (path: TDocumentRef) => Promise<boolean>;
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
