import type {
    IAnnotationCommentSummary,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
    TPdfSaveMode,
} from '@app/types/pdfContracts';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/annotation-subtype-hints/pdfSerializationSubtypeHintsTypes';
import type {ISerializationPlan} from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import type {IBackendAnnotationMutation} from '@app/modules/pdf-viewer/annotations/persistence/annotationBackendConformance';
import type {
    IPdfNativeAnnotationDelete,
    IPdfNativeFreeTextEditor,
    IPdfNativeFreeTextNote,
    IPdfNativeMutationSet,
    IPdfNativePlacedImageGeometryUpdate,
    IPdfNativeTextBoxMutation,
    IPdfNoteGeometryUpdate,
    IPdfNoteTextUpdate,
} from '@contracts/electronApiDocuments';
import type {IPdfLiveAnnotationChangeSummary} from '@app/modules/pdf-viewer/runtime/save/pdfjsAnnotationDiagnostics';
import type {TDocumentRef} from '@contracts/documentRef';
export type TPdfViewerSaveTransactionMode =
    | 'persist'
    | 'print'
    | 'snapshot'
    | 'embedded-mutation'
    | 'writer-save';

export type TPdfViewerSaveTransactionSource =
    | 'source-clean'
    | 'loaded-source'
    | 'writer-save'
    | 'serialized-rewrite'
    | 'native-mutation-projection'
    | 'native-required-failure';

export type TPdfViewerAnnotationSaveRoute =
    | 'source-clean'
    | 'loaded-source'
    | 'writer-save';

export type TPdfViewerAnnotationSaveReason =
    | 'pending-embedded-annotation-operations'
    | 'live-pdfjs-ids-covered-by-embedded-operations'
    | 'unreplayable-live-pdfjs-annotation-ids'
    | 'unknown-live-pdfjs-annotation-storage'
    | 'live-pdfjs-annotation-storage'
    | 'editor-only-annotations-pending-materialization'
    | 'saved-pdfjs-annotation-baseline-diverged'
    | 'live-pdfjs-annotation-baseline-diverged'
    | 'no-live-pdfjs-annotation-work';

export interface IPdfViewerAnnotationSavePlan {
    route: TPdfViewerAnnotationSaveRoute;
    expectedCost: 'small' | 'full-document';
    reason: TPdfViewerAnnotationSaveReason;
    unreplayableLiveAnnotationIds: string[];
}

export interface IPdfSaveCanonicalInputs {
    readonly comments: IAnnotationCommentSummary[];
    readonly pendingTexts: Map<string, string>;
    readonly pendingDeletes: IAnnotationCommentSummary[];
    readonly liveAnnotationChanges: IPdfLiveAnnotationChangeSummary;
    readonly replayableEmbeddedAnnotationIds: ReadonlySet<string>;
    /** Stable keys for changed, editor-owned canonical point notes. */
    readonly replayableCanonicalStickyNoteStableKeys: ReadonlySet<string>;
}

export type TNativeSaveRouteRejection =
    | 'backend-not-native-append'
    | 'save-descriptors-unavailable'
    | 'not-save-mode'
    | 'native-save-capability-unavailable'
    | 'saved-pdfjs-baseline-dirty-requires-materialization'
    | 'writer-save-required'
    | 'pending-texts-not-covered-by-native-mutations'
    | 'pending-deletes-not-covered-by-native-mutations'
    | 'live-pdfjs-annotation-work-not-covered-by-native-mutations'
    | 'annotation-work-not-covered-by-native-mutations'
    | 'shape-payload-unavailable'
    | 'metadata-payload-unavailable'
    | 'native-structured-save-capability-unavailable'
    | 'native-text-box-payload-unavailable'
    | 'native-write-failed'
    | 'no-native-mutations-projected';

export type TNativeRequiredSaveFailureReason =
    | 'missing-native-projection'
    | 'missing-native-capability'
    | 'classifier-rejection'
    | 'native-decline'
    | 'native-error';

export interface IPdfViewerNativeRequiredFailure {
    readonly code: 'native-save-required';
    readonly phase: 'pre-write';
    readonly reason: TNativeRequiredSaveFailureReason;
    readonly nativeRejection?: TNativeSaveRouteRejection;
    readonly detail?: string;
}

export interface IPdfSaveByteRouteDecision {
    readonly route: TPdfViewerAnnotationSaveRoute;
    readonly annotationPlan: IPdfViewerAnnotationSavePlan;
    readonly canonical: IPdfSaveCanonicalInputs;
    readonly baseBytes: 'loaded-source' | 'writer-save';
    /** Precondition: source bytes may only replace a failed materialization on the loaded-source route. */
    readonly sourceFallbackAllowed: boolean;
    readonly nativeRejection: TNativeSaveRouteRejection;
}

export interface IPdfViewerSaveTransactionNativeCapabilities {
    hasNativePdfMutationCapability: boolean;
    canPersistNativeMetadataMutations: boolean;
}

export interface IPdfViewerSaveTransactionDocumentStructure {
    pageLabelsDirty: boolean;
    pageLabelRanges: IPdfPageLabelRange[];
    bookmarksDirty: boolean;
    bookmarkItems: IPdfBookmarkEntry[];
    untitledBookmarkLabel: string;
    totalPages: number;
}

export interface IPdfViewerSaveTransactionDirtyState {
    annotationDirty: boolean;
    hasAnnotationChanges: boolean;
    shapeStateDirty: boolean;
}

export interface INativePdfMutationProjection {
    canonicalAnnotationProgram: readonly IBackendAnnotationMutation[];
    mutations: IPdfNativeMutationSet;
    /** Geometry-only updates are carried separately so persistence cannot lose them while adapting the payload. */
    placedImageGeometryUpdates?: IPdfNativePlacedImageGeometryUpdate[];
    noteTextUpdates: IPdfNoteTextUpdate[];
    noteGeometryUpdates?: IPdfNoteGeometryUpdate[];
    freeTextNotes: IPdfNativeFreeTextNote[];
    freeTextEditors: IPdfNativeFreeTextEditor[];
    /** Canonical text-box mutations. Older projections may omit this field. */
    textBoxes?: IPdfNativeTextBoxMutation[];
    annotationDeletes: IPdfNativeAnnotationDelete[];
    hasMetadataMutations: boolean;
    hasShapeMutations: boolean;
    hasMarkupMutations: boolean;
    phase: string;
}

export interface IPdfViewerSaveTransactionSource {
    getSourcePdfData: () => Promise<Uint8Array | null>;
    /** Compatibility index for snapshot-only callers while they migrate to source reads. */
    readonly [key: string]: unknown;
}

export interface IPdfViewerSaveTransactionRequest {
    annotationSerializationPlan?: ISerializationPlan;
    mode: TPdfViewerSaveTransactionMode;
    saveMode?: TPdfSaveMode;
    saveFlowMode?: 'save' | 'save_as';
    forceRewrite?: boolean;
    forceWriterSave?: boolean;
    includeManagedShapes?: boolean;
    rewriteShapeState?: boolean;
    planOnly?: boolean;
    serializeResult?: boolean;
    /** An absolute working path makes renderer byte fallback unsafe. */
    workingPath?: TDocumentRef | null;
    markupSubtypeOverrides?: Map<string, TMarkupSubtype> | undefined;
    markupSubtypeHints?: IMarkupSubtypeHint[] | undefined;
    nativeCapabilities?: IPdfViewerSaveTransactionNativeCapabilities;
    dirtyState?: IPdfViewerSaveTransactionDirtyState;
    documentStructure?: IPdfViewerSaveTransactionDocumentStructure;
    source?: IPdfViewerSaveTransactionSource;
}

export interface IPdfViewerSaveTransactionSerializedResult {
    finalBytes: Uint8Array;
    saveMode: TPdfSaveMode;
    source: TPdfViewerSaveTransactionSource;
    changedObjectRefs: readonly string[];
}

export interface IPdfViewerSaveTransactionResult {
    source: TPdfViewerSaveTransactionSource;
    baseBytes: Uint8Array | null;
    serializedBytes: Uint8Array | null;
    serializedResult: IPdfViewerSaveTransactionSerializedResult | null;
    nativeMutationProjection: INativePdfMutationProjection | null;
    nativeRequiredFailure?: IPdfViewerNativeRequiredFailure;
    /** Exact classifier-owned alternate; consumers must not independently plan another route. */
    fallbackDecision: IPdfSaveByteRouteDecision;
    annotationSavePlan: IPdfViewerAnnotationSavePlan;
    verifyAnnotationSave?(bytes: Uint8Array): Promise<void>;
    verifyAnnotationSavePath?(path: string, knownSize: number): Promise<void>;
    assertAnnotationSaveCurrent?(): Promise<void> | void;
    commitAnnotationSave?(): void;
    /**
     * Executes the exact classifier-owned fallback captured by a plan-only
     * transaction. It retains the same annotation frontier and serialization
     * plan; callers must never start another transaction after native decline.
     */
    executeFallback?(): Promise<IPdfViewerSaveTransactionResult>;
}

export function resolvePdfViewerSaveTransactionFinalBytes(
    result: IPdfViewerSaveTransactionResult | null | undefined,
) {
    return result?.serializedResult?.finalBytes
        ?? result?.serializedBytes
        ?? result?.baseBytes
        ?? null;
}
