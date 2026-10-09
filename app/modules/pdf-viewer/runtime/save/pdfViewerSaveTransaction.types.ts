import type {IAnnotationCommentSummary} from '@app/types/annotations';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
    TPdfSaveMode,
} from '@app/types/pdfContracts';
import type {ISerializationPlan} from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import type {IBackendAnnotationMutation} from '@app/modules/pdf-viewer/annotations/persistence/annotationBackendConformance';
import type {
    IPdfNativeAnnotationIdentityBinding,
    IPdfNativeAnnotationDelete,
    IPdfNativeFreeTextNote,
    IPdfNativeMutationSet,
    IPdfNativePlacedImageGeometryUpdate,
    IPdfNativeTextBoxMutation,
    IPdfNoteGeometryUpdate,
    IPdfNoteTextUpdate,
} from '@contracts/electronApiDocuments';
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
    | 'changed-annotation-ids-covered-by-embedded-operations'
    | 'unreplayable-changed-annotation-ids'
    | 'changed-annotations-not-replayable'
    | 'editor-only-annotations-pending-materialization'
    | 'writer-save-forced'
    | 'writer-save-forced-with-annotation-changes'
    | 'no-annotation-work';

export interface IPdfViewerAnnotationSavePlan {
    route: TPdfViewerAnnotationSaveRoute;
    expectedCost: 'small' | 'full-document';
    reason: TPdfViewerAnnotationSaveReason;
    unreplayableAnnotationIds: string[];
}

/**
 * Annotation work the save captured from the canonical store's frontier:
 * the ids of every changed annotation, and those of the changed notes and
 * text boxes.
 */
export interface IPdfFrontierAnnotationChanges {
    ids: Set<string>;
    noteIds: Set<string>;
    hasChanges: boolean;
}

export interface IPdfSaveCanonicalInputs {
    readonly comments: IAnnotationCommentSummary[];
    readonly pendingTexts: Map<string, string>;
    readonly pendingDeletes: IAnnotationCommentSummary[];
    readonly frontierChanges: IPdfFrontierAnnotationChanges;
    readonly replayableEmbeddedAnnotationIds: ReadonlySet<string>;
    /** Stable keys for changed, editor-owned canonical point notes. */
    readonly replayableCanonicalStickyNoteStableKeys: ReadonlySet<string>;
}

export type TNativeSaveRouteRejection =
    | 'backend-not-native-append'
    | 'save-descriptors-unavailable'
    | 'not-save-mode'
    | 'native-save-capability-unavailable'
    | 'writer-save-required'
    | 'pending-texts-not-covered-by-native-mutations'
    | 'pending-deletes-not-covered-by-native-mutations'
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

export interface IPdfViewerNativeMaterializationRequest extends IPdfViewerSaveTransactionDescriptors {
    mode: TPdfViewerSaveTransactionMode;
    annotationSerializationPlan?: ISerializationPlan;
    saveMode?: TPdfSaveMode;
    saveFlowMode?: 'save' | 'save_as';
    forceRewrite?: boolean;
    forceWriterSave?: boolean;
    includeManagedShapes?: boolean;
    rewriteShapeState?: boolean;
    /** Persistence services validate the working-copy target outside this transaction. */
    workingPath?: TDocumentRef | null;
    source?: IPdfViewerSaveTransactionSource;
}

export interface IPdfViewerSaveTransactionDescriptors {
    nativeCapabilities: IPdfViewerSaveTransactionNativeCapabilities;
    dirtyState: IPdfViewerSaveTransactionDirtyState;
    documentStructure: IPdfViewerSaveTransactionDocumentStructure;
}

export interface IPdfViewerSaveTransactionResult {
    source: TPdfViewerSaveTransactionSource;
    nativeMutationProjection: INativePdfMutationProjection | null;
    nativeRequiredFailure?: IPdfViewerNativeRequiredFailure;
    /** Even with native-required-failure, a captured empty frontier proves the current working bytes need no mutation. */
    verifiedUnchangedWorkingCopy?: boolean;
    /** Exact classifier-owned alternate; consumers must not independently plan another route. */
    fallbackDecision: IPdfSaveByteRouteDecision;
    annotationSavePlan: IPdfViewerAnnotationSavePlan;
    verifyAnnotationSave?(bytes: Uint8Array): Promise<void>;
    verifyAnnotationSavePath?(path: string, knownSize: number): Promise<void>;
    assertAnnotationSaveCurrent?(): Promise<void> | void;
    commitAnnotationSave?(identityBindings?: readonly IPdfNativeAnnotationIdentityBinding[]): void;
}
