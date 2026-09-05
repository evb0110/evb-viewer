import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    IShapeAnnotation,
    TShapeAnnotationPatch,
    ITextMarkupAnnotationProperties,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {IPageIdentityDelta} from '@contracts/electronApiPageOps';
import type { IShapeAnnotationConstructionOptions } from '@app/types/shapeAnnotationConstructionOptions';
import type { ICropSelectionResult } from '@app/types/crop';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/annotation-subtype-hints/pdfSerializationSubtypeHintsTypes';
import type { IPdfPageMetric } from '@app/types/pdfUi';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { IBrowserPrintDocument } from '@app/utils/pdfPrintShared';
import type {
    IPdfViewerSaveTransactionRequest,
    IPdfViewerSaveTransactionResult,
} from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';
import type {IWorkspaceCommandSink} from '@app/types/workspaceCommand';
import type { TDocumentSidebarTab } from '@app/utils/document-viewer/sidebar/documentSidebarTabs';
import type { TAnnotationCreationFailureReason } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
import type {IPdfAnnotationStorageDebugState} from '@app/modules/pdf-viewer/runtime/save/pdfjsAnnotationDiagnostics';
import type { ITextBoxEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

/** @deprecated Use the format-neutral document sidebar tab contract. */
export type TPdfSidebarTab = TDocumentSidebarTab;
export type TAgentTextMarkupKind = 'highlight' | 'underline' | 'strikethrough' | 'squiggly';

export interface ICreateTextMarkupFromTextOptions {
    pageNumber: number;
    text: string;
    occurrence?: number | undefined;
    markup?: TAgentTextMarkupKind | undefined;
    caseSensitive?: boolean | undefined;
    wholeWord?: boolean | undefined;
    withNote?: boolean | undefined;
}

export interface ICreateTextMarkupFromTextResult {
    created: boolean;
    pageNumber: number;
    requestedText: string;
    matchedText: string | null;
    occurrence: number;
    subtype: TMarkupSubtype;
    reason?: string | undefined;
    /** Machine-readable counterpart of `reason` for automation callers. */
    failureReason?: TAnnotationCreationFailureReason | undefined;
    /**
     * The canonical annotation exists but no editor is bound to it yet, so it
     * is neither a clean success nor safe to retry: retrying mints a duplicate.
     */
    pendingEditor?: boolean | undefined;
}

export interface ICreatePointNoteAnnotationOptions {
    pageNumber: number;
    pageX: number;
    pageY: number;
    preferTextAnchor?: boolean | undefined;
}

export interface ICreatePointNoteAnnotationResult {
    created: boolean;
    pageNumber: number;
    pageX: number;
    pageY: number;
    reason?: string | undefined;
    /** Machine-readable counterpart of `reason` for automation callers. */
    failureReason?: TAnnotationCreationFailureReason | undefined;
    /**
     * The canonical annotation exists but no editor is bound to it yet, so it
     * is neither a clean success nor safe to retry: retrying mints a duplicate.
     */
    pendingEditor?: boolean | undefined;
}

export interface ICreateShapeAnnotationOptions extends IShapeAnnotationConstructionOptions {pageNumber: number;}

export interface ICreateShapeAnnotationResult {
    created: boolean;
    pageNumber: number;
    shape: IAnnotationCommentSummary | null;
    reason?: string | undefined;
}

export interface IDocumentViewerExpose {
    getViewerContainer: () => HTMLElement | null;
    getCurrentPage?: () => number;
    getPendingNavigationTargetPage?: () => number | null;
    waitForViewerLoadSettled?: () => Promise<void>;
    scrollToPage: (page: number, options?: IScrollToPageOptions) => void;
    cancelProgrammaticNavigation?: () => void;
    getUserViewportInteractionEpoch?: () => number;
    invalidatePages?: (pages: number[]) => void;
    remapPageIdentityDelta?: (delta: IPageIdentityDelta) => void;
    requestScrollToCurrentResult?: () => void;
}

export interface IPdfViewerLoadExpose {
    applyFitWidthToCurrentPage?: () => Promise<boolean>;
    waitForViewerLoadSettled?: () => Promise<void>;
    ensurePageMetricsInRange?: (startPage: number, endPage: number) => Promise<boolean>;
    getPageMetricsSnapshot?: () => IPdfPageMetric[];
}

export interface IPdfViewerRegionCaptureExpose {
    captureRegionToClipboard: () => Promise<boolean>;
    isCapturingRegion: boolean;
}

export interface IPdfViewerCropExpose {
    startCropSelection: () => Promise<ICropSelectionResult | null>;
    cancelCropSelection: () => void;
    isCropSelecting: boolean;
}

export interface IPdfViewerShapePersistenceExpose {
    adoptPersistedManagedShapesOnNextImport?: () => void;
    clearPendingManagedShapeImportAdoption?: () => void;
    ensureManagedShapeBaselineReady?: () => Promise<boolean>;
    preparePersistedManagedShapesForSave?: (data?: Uint8Array) => Promise<unknown>;
    restorePreparedManagedShapesAfterFailedSave?: (snapshot: unknown) => Promise<void>;
}

export interface IPdfViewerSaveExpose {
    runSaveTransaction: (
        request: IPdfViewerSaveTransactionRequest,
    ) => Promise<IPdfViewerSaveTransactionResult>;
    commitPdfEditorsForSave?: () => Promise<void>;
}

export interface IPdfViewerBrowserPrintExpose {renderLoadedPdfPagesForBrowserPrint?: (
    targetDocument: IBrowserPrintDocument,
    pageNumbers: number[],
    options?: { signal?: AbortSignal },
) => Promise<void>;}

export interface IPdfViewerAnnotationCommandExpose {
    annotationHistoryMutationVersion?: number | undefined;
    annotationHistoryResetVersion?: number | undefined;
    hasCanonicalAnnotationChanges?: (() => boolean) | undefined;
    getAnnotationDirtyEntityCount?: (() => number) | undefined;
    hasCanonicalShapeChanges?: (() => boolean) | undefined;
    getAnnotationStorageDebugState?: (() => IPdfAnnotationStorageDebugState) | undefined;
    getDeletedCanonicalAnnotationIds?: (() => string[]) | undefined;
    getDeletedPersistedCanonicalAnnotationCount?: (() => number) | undefined;
    clearAnnotationHistory?: () => void;
    setWorkspaceCommandSink?: (sink: IWorkspaceCommandSink | null) => void;
    highlightSelection: () => Promise<boolean>;
    commentSelection: () => Promise<boolean>;
    createTextMarkupFromText: (
        options: ICreateTextMarkupFromTextOptions,
    ) => Promise<ICreateTextMarkupFromTextResult>;
    commentAtPoint: (
        pageNumber: number,
        pageX: number,
        pageY: number,
        options?: { preferTextAnchor?: boolean },
    ) => Promise<boolean>;
    createPointNoteAnnotation: (
        options: ICreatePointNoteAnnotationOptions,
    ) => Promise<ICreatePointNoteAnnotationResult>;
    createShapeAnnotation: (
        options: ICreateShapeAnnotationOptions,
    ) => Promise<ICreateShapeAnnotationResult>;
    registerAnnotationHistoryCommand?: (command: {
        cmd: () => void;
        undo: () => void;
    }) => void;
    selectedTextBox?: Pick<ITextBoxEntity, 'fontSize' | 'color'> | null;
    getSelectedTextBox?: () => ITextBoxEntity | null;
    updateSelectedTextBoxProperties?: (
        updates: Partial<Pick<ITextBoxEntity, 'fontSize' | 'color'>>,
    ) => boolean;
}

export interface IPdfViewerAnnotationCommentExpose {
    ensurePdfAnnotationNameReconciliation?: (
        reason: 'annotations-ui-open' | 'existing-annotation-mutation',
    ) => Promise<
        | 'reconciled'
        | 'already-reconciled'
        | 'skipped-over-limit'
        | 'stale'
        | 'failed'
    >;
    focusAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<void>;
    updateAnnotationComment: (
        comment: IAnnotationCommentSummary,
        text: string,
    ) => boolean | Promise<boolean>;
    moveAnnotationMarker: (comment: IAnnotationCommentSummary, rect: IAnnotationMarkerRect) => boolean;
    deleteAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<boolean>;
    /** Remove the live PDF.js editor without mutating the canonical store. */
    deleteAnnotationEditor?: (comment: IAnnotationCommentSummary) => Promise<boolean>;
    /** Remove a reopened editor and tombstone its canonical entity in one history transaction. */
    deleteReopenedEditorAnnotation?: (comment: IAnnotationCommentSummary) => Promise<boolean>;
    getAnnotationCommentsSnapshot?: () => IAnnotationCommentSummary[];
    rerenderAnnotationPage: (pageNumber: number) => Promise<boolean>;
    deleteEmbeddedAnnotationDeferred?: (comment: IAnnotationCommentSummary) => boolean;
    removeAnnotationFromDom: (comment: IAnnotationCommentSummary) => void;
    removeAnnotationFromInternalCache: (stableKey: string) => void;
    restoreAnnotationToInternalCache?: (comment: IAnnotationCommentSummary) => void;
    clearPendingMarkerMoves?: () => void;
    getMarkupSubtypeOverrides: () => Map<string, TMarkupSubtype>;
    getMarkupSubtypeHints?: () => IMarkupSubtypeHint[];
    getSelectedTextMarkupAnnotationProperties?: () => ITextMarkupAnnotationProperties | null;
    updateSelectedTextMarkupAnnotationColor?: (
        color: string,
        selected: ITextMarkupAnnotationProperties,
    ) => boolean;
    updateSelectedTextMarkupAnnotationProperties?: (
        updates: Partial<Pick<ITextMarkupAnnotationProperties, 'color' | 'opacity' | 'contents'>>,
        selected: ITextMarkupAnnotationProperties,
    ) => boolean;
    updateTextMarkupAnnotationColor?: (comment: IAnnotationCommentSummary, color: string) => boolean;
}

export interface IPdfViewerShapeExpose {
    getAllShapes: () => IShapeAnnotation[];
    /** `prepared` is the token this save's shape priming returned, if any. */
    markSavedShapeState?: (prepared?: unknown) => void;
    getDeletedEmbeddedShapeAnnotationIds: () => string[];
    getDeletedEmbeddedShapeStableKeys?: () => string[];
    clearShapes: () => void;
    clearSelectedShape: () => void;
    deleteSelectedShape: () => void;
    deleteShapeById: (id: string) => boolean;
    hasShapes: boolean;
    selectedShapeId: string | null;
    updateShape: (id: string, updates: TShapeAnnotationPatch) => void;
    getSelectedShape: () => IShapeAnnotation | null;
}

export interface IPdfViewerImagePlacementExpose {
    startImagePlacement: (
        file: File,
        options?: {
            pageNumber?: number | null;
            pageX?: number | null;
            pageY?: number | null;
            stableKey?: string;
            annotationId?: string | null;
        },
    ) => Promise<boolean>;
    clearPendingImagePlacement: () => void;
    restorePendingImagePlacement: () => void;
}

export interface IPdfViewerExpose extends
    IDocumentViewerExpose,
    IPdfViewerLoadExpose,
    IPdfViewerRegionCaptureExpose,
    IPdfViewerCropExpose,
    IPdfViewerShapePersistenceExpose,
    IPdfViewerSaveExpose,
    IPdfViewerBrowserPrintExpose,
    IPdfViewerAnnotationCommandExpose,
    IPdfViewerAnnotationCommentExpose,
    IPdfViewerShapeExpose,
    IPdfViewerImagePlacementExpose {
    invalidatePages: (pages: number[]) => void;
    requestScrollToCurrentResult: () => void;
}
