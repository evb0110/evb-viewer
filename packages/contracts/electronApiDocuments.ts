import type {TPageIndex} from '@contracts/pageNumbers';

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
import type {
    IPdfEmbeddedShapeIndexChunk,
    IPdfEmbeddedShapeIndexChunkOptions,
    IPdfEmbeddedShapeIndexOptions,
    IPdfEmbeddedShapeIndexSession,
} from '@contracts/pdfEmbeddedShapeIndexSchemas';
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
import type {
    IRecentFile,
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
    IPdfConformanceProfile,IPdfValidationResult,
} from '@contracts/pdfConformance';
import type {
    TMenuEventCallback,
    TMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';
import type * as PdfAnnotationParse from '@contracts/pdfAnnotationParseTypes';
import type {
    IPdfDecryptRequest,
    IPdfDecryptResult,
} from '@contracts/pdfDecryptSchemas';
import type {TOpenFileResult} from '@contracts/pdfOpenFileSchemas';
import * as v from 'valibot';
import type {
    IApplicationMenuDocumentState as TPlatformApplicationMenuDocumentState,
    IPdfNativeNoteTextSaveResult as TPlatformPdfNativeNoteTextSaveResult,
    IPdfOptimizeOptions as TPlatformPdfOptimizeOptions,
    IPdfOptimizeResult as TPlatformPdfOptimizeResult,
    TDocumentSaveResult as TPlatformDocumentSaveResult,
} from '@contracts/documentsPlatformFeatureSchemas';
import type {
    IPdfNativePageGeometry as TPlatformPdfNativePageGeometry,
    IPdfNativePageSizesExactOptions as TPlatformPdfNativePageSizesExactOptions,
    IPdfOpeningGeometry as TPlatformPdfOpeningGeometry,
} from '@contracts/documentsPlatformFeatureNativePageSchemas';
import type {
    IPdfDataPrintOptions,
    IPdfNativePrintDialogOpenedEvent,
    IPdfPathPrintOptions,
} from '@contracts/pdfPathPrintOptions';
import type {IPdfPathValidationOptions as TPlatformPdfPathValidationOptions} from '@contracts/pdfValidationPathArgs';
import type {
    IPdfNativeStagedCommitOptions,
    IPdfSaveAsOptions,
    IPdfSaveAsWarning,
    IPdfSerializedSaveOptions,
} from '@contracts/documentsPersistenceSchemas';
export type {
    IOpenDjvuResult,
    IOpenPdfResult,
    IPdfNeedsPasswordResult,
    IPdfUnsupportedEncryptionResult,
    TOpenFileResult,
    TPdfOpenFileFailureResult,
} from '@contracts/pdfOpenFileSchemas';
export type {
    IApplicationMenuDocumentState,
    IDocumentSaveFailureResult,
    IDocumentSaveSuccessResult,
    IPdfOptimizeOptions,
    IPdfOptimizeResult,
    TDocumentSaveFailureReason,
    TDocumentSaveResult,
} from '@contracts/documentsPlatformFeatureSchemas';
export type {
    IPdfNativePageGeometry,
    IPdfNativePageGeometryPage,
    IPdfNativePageSizesExactOptions,
    IPdfOpeningGeometry,
} from '@contracts/documentsPlatformFeatureNativePageSchemas';
export type {
    IPdfDataPrintOptions,
    IPdfNativePrintDialogOpenedEvent,
    IPdfPathPrintOptions,
} from '@contracts/pdfPathPrintOptions';
export type {IPdfPathValidationOptions} from '@contracts/pdfValidationPathArgs';
export type {
    IPdfNativeStagedCommitOptions,
    IPdfSaveAsOptions,
    IPdfSaveAsWarning,
    IPdfSerializedSaveOptions,
} from '@contracts/documentsPersistenceSchemas';

export type TOpenBatchProgressOperation = 'document-open' | 'page-insert';
export {PDF_ANNOTATION_PARSE_MAX_LINE_BYTES} from '@contracts/pdfAnnotationParseTypes';
export type * from '@contracts/pdfAnnotationParseTypes';
export type {
    IPdfDecryptRequest, IPdfDecryptResult, TPdfDecryptOutcome,
} from '@contracts/pdfDecryptSchemas';
export type {
    IPdfEmbeddedShapeIndexChunk,
    IPdfEmbeddedShapeIndexChunkOptions,
    IPdfEmbeddedShapeIndexEntry,
    IPdfEmbeddedShapeIndexOptions,
    IPdfEmbeddedShapeIndexPoint,
    IPdfEmbeddedShapeIndexSession,
} from '@contracts/pdfEmbeddedShapeIndexSchemas';

/** The renderer requests at most 512 KiB of decoded shape-index data. */
export const PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES = 512 * 1024;
/** Native JSONL lines may be larger than one renderer pull, but never exceed 4 MiB. */
export const PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES = 4 * 1024 * 1024;

export const IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024;

const documentRefSchema = v.pipe(
    v.string(),
    v.check(value => parseDocumentRef(value) !== null),
    v.transform(value => parseDocumentRef(value) as TDocumentRef),
);
const leaseIdSchema = v.pipe(
    v.string(),
    v.check(value => parseLeaseId(value) !== null),
    v.transform(value => parseLeaseId(value) as TLeaseId),
);
const documentRevisionTokenSchema = v.pipe(
    v.string(),
    v.check(value => parseDocumentRevisionToken(value) !== null),
    v.transform(value => parseDocumentRevisionToken(value) as TDocumentRevisionToken),
);
const epochMsSchema = v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(0, 'invalid file modification time'),
    v.transform(value => parseEpochMs(value) as TEpochMs),
);
const nonNegativeSafeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const FILE_STAT_RESULT_SCHEMA = v.object({
    size: nonNegativeSafeInteger,
    modifiedAt: v.exactOptional(epochMsSchema),
});
export type IFileStatResult = v.InferOutput<typeof FILE_STAT_RESULT_SCHEMA>;

export const MANAGED_TEMP_FILE_HANDLE_SCHEMA = v.pipe(v.object({
    path: documentRefSchema,
    size: nonNegativeSafeInteger,
    sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
    leaseId: leaseIdSchema,
    revision: v.nullable(documentRevisionTokenSchema),
}), v.readonly());
export type IManagedTempFileHandle = v.InferOutput<typeof MANAGED_TEMP_FILE_HANDLE_SCHEMA>;

const workingCopyBackingStatusStates = [
    'lazy-original',
    'materializing',
    'materialized',
] as const;

const workingCopyBackingFailureCodes = [
    'SOURCE_BACKING_CHANGED',
    'SOURCE_BACKING_UNAVAILABLE',
    'WORKING_COPY_MATERIALIZATION_CANCELLED',
    'WORKING_COPY_MATERIALIZATION_FAILED',
    'WORKING_COPY_MATERIALIZATION_NO_SPACE',
    'WORKING_COPY_MATERIALIZATION_VERIFICATION_FAILED',
    'WORKING_COPY_REGISTRATION_CHANGED',
] as const;

export const WORKING_COPY_BACKING_STATUS_SCHEMA = v.pipe(v.object({
    documentRef: documentRefSchema,
    failure: v.nullable(v.pipe(v.object({
        code: v.picklist(workingCopyBackingFailureCodes),
        retryable: v.boolean(),
    }), v.readonly())),
    progress: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
    state: v.picklist(workingCopyBackingStatusStates),
}), v.readonly());
export type TWorkingCopyBackingStatusState = v.InferOutput<typeof WORKING_COPY_BACKING_STATUS_SCHEMA>['state'];
export type TWorkingCopyBackingFailureCode = Exclude<
    v.InferOutput<typeof WORKING_COPY_BACKING_STATUS_SCHEMA>['failure'],
    null
>['code'];
export type IWorkingCopyBackingFailure = v.InferOutput<typeof WORKING_COPY_BACKING_STATUS_SCHEMA>['failure'] extends infer TFailure
    ? Exclude<TFailure, null>
    : never;
export type IWorkingCopyBackingStatus = v.InferOutput<typeof WORKING_COPY_BACKING_STATUS_SCHEMA>;

export const MAX_DOCUMENT_ALLOCATION_BYTES = 512 * 1024 * 1024;

export function assertDocumentAllocationSize(
    value: unknown,
    maxBytes = MAX_DOCUMENT_ALLOCATION_BYTES,
) {
    const parsed = v.safeParse(FILE_STAT_RESULT_SCHEMA, {size: value}, {abortEarly: true});
    if (!parsed.success || parsed.output.size > maxBytes) {
        throw new RangeError(`Document allocation size must be a non-negative safe integer no greater than ${maxBytes} bytes`);
    }
    return parsed.output.size;
}

export type TDocumentChunkSource = Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

const PDF_OPTIMIZE_PROGRESS_PHASES = [
    'preparing',
    'rendering',
    'assembling',
    'optimizing',
    'validating',
    'complete',
] as const;
export const PDF_OPTIMIZE_PRESETS = [
    'lossless',
    'balancedScanned',
    'smallScanned',
    'blackAndWhite',
] as const;
const OPEN_BATCH_PROGRESS_OPERATIONS = [
    'document-open',
    'page-insert',
] as const;
const requestIdSchema = v.pipe(
    v.string(),
    v.check(value => parseRequestId(value) !== null),
    v.transform(value => parseRequestId(value) as TRequestId),
);
const finiteNumber = v.pipe(v.number(), v.finite());
const progressCountersSchema = v.object({
    processed: v.pipe(finiteNumber, v.minValue(0)),
    total: v.pipe(finiteNumber, v.minValue(0)),
    percent: finiteNumber,
});
const optimizeProgressSchema = v.pipe(v.object({
    requestId: requestIdSchema,
    preset: v.picklist(PDF_OPTIMIZE_PRESETS),
    phase: v.picklist(PDF_OPTIMIZE_PROGRESS_PHASES),
    ...progressCountersSchema.entries,
}), v.readonly());
const openBatchProgressSchema = v.pipe(v.object({
    operation: v.picklist(OPEN_BATCH_PROGRESS_OPERATIONS),
    requestId: requestIdSchema,
    ...progressCountersSchema.entries,
    elapsedMs: v.pipe(finiteNumber, v.minValue(0)),
    estimatedRemainingMs: v.nullable(finiteNumber),
}), v.readonly());

export type IPdfOptimizeProgress = v.InferOutput<typeof optimizeProgressSchema>;
export type IOpenPdfDirectBatchProgress = v.InferOutput<typeof openBatchProgressSchema>;
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

export type TOpenFolderDialogResult =
    | {
        readonly ok: true;
        readonly value: TOpenFileResult | null
    }
    | IPlatformUnsupportedResult;
export type TShowItemInFolderResult =
    | {readonly ok: true}
    | IPlatformUnsupportedResult;

export const PDF_OPTIMIZE_PRESET_SCHEMA = v.picklist(PDF_OPTIMIZE_PRESETS);
export type TPdfOptimizePreset = v.InferOutput<typeof PDF_OPTIMIZE_PRESET_SCHEMA>;

export function isPdfOptimizePreset(value: unknown): value is TPdfOptimizePreset {
    return v.is(PDF_OPTIMIZE_PRESET_SCHEMA, value);
}

export type TPdfOptimizeProgressPhase = v.InferOutput<typeof optimizeProgressSchema>['phase'];

export type IDocumentMutationRevisionOptions = Pick<IPdfSerializedSaveOptions, 'expectedDocumentRevisionToken'>;

export const PDF_SERIALIZED_COMMIT_CALLBACKS_SCHEMA = v.object({
    verifyBytesBeforeCommit: v.exactOptional(v.custom<(bytes: Uint8Array) => Promise<void>>(
        value => typeof value === 'function',
    )),
    verifyPathBeforeCommit: v.exactOptional(v.custom<(path: TDocumentRef, knownSize: number) => Promise<void>>(
        value => typeof value === 'function',
    )),
    assertBeforeCommit: v.exactOptional(v.custom<() => Promise<void> | void>(
        value => typeof value === 'function',
    )),
});
export type IPdfSerializedCommitCallbacks = v.InferOutput<typeof PDF_SERIALIZED_COMMIT_CALLBACKS_SCHEMA>;

export interface IPdfNativeAnnotationIdentityBinding {
    /** Canonical application annotation identity from the save frontier. */
    readonly annotationId: string;
    /** Canonical indirect PDF object reference, formatted as `N G R`. */
    readonly pdfRef: string;
}

export {
    optimizeProgressSchema as PDF_OPTIMIZE_PROGRESS_SCHEMA, openBatchProgressSchema as OPEN_BATCH_PROGRESS_SCHEMA,
};

export type IPdfNativePageSizesCapability = (
    path: TDocumentRef,
    options: TPlatformPdfNativePageSizesExactOptions,
) => Promise<TPlatformPdfNativePageGeometry>;

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

export type IPdfNativeNoteTextSaveResult = TPlatformPdfNativeNoteTextSaveResult;

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

export function createWorkingCopySyncWarning(detail: string): IPdfSaveAsWarning {
    return {
        reason: 'working-copy-sync-required',
        message: `The file was written, but this document is no longer connected to it: ${detail}`,
    };
}

export interface IPdfCommittedSaveAsResult extends IPdfSaveAsResult {readonly validation: IPdfValidationResult;}

export interface IDocumentsMenuCapability {
    setMenuDocumentState: (state: boolean | TPlatformApplicationMenuDocumentState) => Promise<void>;
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
    readPdfPageLabelRanges: (path: TDocumentRef) => Promise<IPdfPageLabelRange[]>;
    statFile: (path: TDocumentRef) => Promise<{
        size: number;
        modifiedAt?: TEpochMs
    }>;
    readFileRange: (path: TDocumentRef, offset: number, length: number) => Promise<Uint8Array>;
    createManagedTempFileHandle?: (path: TDocumentRef) => Promise<IManagedTempFileHandle>;
    releaseManagedTempFileHandle?: (leaseId: TLeaseId) => Promise<boolean>;
    parsePdfAnnotations: PdfAnnotationParse.TPdfAnnotationParse;
    getPdfOpeningGeometry?: (path: TDocumentRef) => Promise<TPlatformPdfOpeningGeometry | null>;
    getPdfNativePageSizes?: IPdfNativePageSizesCapability;
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
    decryptPdfWorkingCopy?: (path: TDocumentRef, request?: IPdfDecryptRequest) => Promise<IPdfDecryptResult>;
    readTextFile: (path: TDocumentRef) => Promise<string>;
    fileExists: (path: TDocumentRef) => Promise<boolean>;
    getDocumentRevision: (path: TDocumentRef) => Promise<IDocumentRevisionInfo>;
    getWorkingCopyBackingStatus?: (path: TDocumentRef) => Promise<IWorkingCopyBackingStatus | null>;
    analyzePdfConformance: (
        path: TDocumentRef,
        options?: IPdfConformanceAnalysisOptions,
    ) => Promise<IPdfConformanceProfile>;
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
    saveFileStructured: (path: TDocumentRef, options?: IDocumentMutationRevisionOptions) => Promise<TPlatformDocumentSaveResult>;
    savePdfData: (
        path: TDocumentRef,
        data: Uint8Array,
        options?: IPdfSerializedSaveOptions,
        commitCallbacks?: IPdfSerializedCommitCallbacks,
    ) => Promise<IPdfValidationResult>;
    repairPdf?: (path: TDocumentRef, options?: IDocumentMutationRevisionOptions) => Promise<IPdfValidationResult>;
    optimizePdfForInteraction?: (path: TDocumentRef, options?: IDocumentMutationRevisionOptions) => Promise<IPdfValidationResult>;
    optimizePdfAsCopy?: (
        path: TDocumentRef,
        options: TPlatformPdfOptimizeOptions,
        requestId?: TRequestId,
        revisionOptions?: IDocumentMutationRevisionOptions,
    ) => Promise<TPlatformPdfOptimizeResult>;
    savePdfNoteTextUpdates?: (
        path: TDocumentRef,
        updates: IPdfNoteTextUpdate[],
        modifiedAt: TPdfDateString,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<TPlatformPdfNativeNoteTextSaveResult>;
    savePdfNoteChanges?: (
        path: TDocumentRef,
        changes: IPdfNativeNoteChanges,
        modifiedAt: TPdfDateString,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<TPlatformPdfNativeNoteTextSaveResult>;
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
    validatePdfPath: (
        path: TDocumentRef,
        options?: TPlatformPdfPathValidationOptions,
    ) => Promise<IPdfValidationResult>;
    cleanupFile: (path: TDocumentRef) => Promise<void>;
    setWindowTitle: (title: string) => Promise<void>;
    showItemInFolder: (path: TDocumentRef) => Promise<boolean>;
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

export interface IDocumentsPickerCapability extends Pick<
    IDocumentsFileCapability,
    | 'openDocumentDialog'
    | 'openCombineDialog'
    | 'openFolderDialog'
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
> {}

export interface IDocumentsReadCapability extends Pick<
    IDocumentsFileCapability,
    | 'readFile'
    | 'readPdfPageLabelRanges'
    | 'statFile'
    | 'readFileRange'
    | 'createManagedTempFileHandle'
    | 'releaseManagedTempFileHandle'
    | 'getPdfOpeningGeometry'
    | 'getPdfNativePageSizes'
    | 'beginPdfEmbeddedShapeIndex'
    | 'readPdfEmbeddedShapeIndexChunk'
    | 'releasePdfEmbeddedShapeIndex'
    | 'decryptPdfWorkingCopy'
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
    | 'validatePdfPath'
> {}
export interface IDocumentsPdfExternalCapability extends Pick<
    IDocumentsFileCapability,
    | 'printPdfData'
    | 'cancelPdfPrint'
    | 'printPdfPath'
    | 'onNativePrintDialogOpened'
> {}
export interface IDocumentsPdfPersistenceCapability extends Pick<
    IDocumentsFileCapability,
    | 'savePdfAs'
    | 'savePdfDialog'
    | 'saveDocxAs'
    | 'writeFile'
    | 'replaceWorkingCopyFromPath'
    | 'writeDocxFile'
    | 'saveFileStructured'
    | 'savePdfData'
    | 'repairPdf'
    | 'optimizePdfForInteraction'
    | 'optimizePdfAsCopy'
    | 'savePdfNoteTextUpdates'
    | 'savePdfNoteChanges'
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
> {}
