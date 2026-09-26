import type { TPageNumber } from '@contracts/pageNumbers';

import type {
    IAnnotationCommentSummary,
    IAnnotationPropertyUpdate,
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
import type { TDocumentSidebarTab } from '@app/modules/document-viewer/public';
import type { TAnnotationCreationFailureReason } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    ITextBoxEntity,
    AnnotationEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {
    IAnnotationRecoveryDraft,
    ICanonicalAnnotationRecovery,
} from '@app/modules/pdf-viewer/annotations/domain/annotationRecovery';

export type TPdfSidebarTab = TDocumentSidebarTab;
export type TAgentTextMarkupKind = 'highlight' | 'underline' | 'strikethrough' | 'squiggly';

export interface ICreateTextMarkupFromTextOptions {
    pageNumber: TPageNumber;
    text: string;
    occurrence?: number | undefined;
    markup?: TAgentTextMarkupKind | undefined;
    caseSensitive?: boolean | undefined;
    wholeWord?: boolean | undefined;
    withNote?: boolean | undefined;
}

export interface ICreateTextMarkupFromTextResult {
    created: boolean;
    pageNumber: TPageNumber;
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
    pageNumber: TPageNumber;
    pageX: number;
    pageY: number;
    preferTextAnchor?: boolean | undefined;
}

export interface ICreatePointNoteAnnotationResult {
    created: boolean;
    pageNumber: TPageNumber;
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

export interface ICreateShapeAnnotationOptions extends IShapeAnnotationConstructionOptions {pageNumber: TPageNumber;}

export interface ICreateShapeAnnotationResult {
    created: boolean;
    pageNumber: TPageNumber;
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
    preparePageMutationRevisionSwap?: (input: {
        documentRevision: TDocumentRevisionToken;
        invalidatedPages: readonly number[];
        pageNumber: number;
        rotationDelta?: 90 | 180 | 270;
    }) => boolean | Promise<boolean>;
    beginPageRotationPreview?: (input: {
        invalidatedPages: readonly number[];
        rotationDelta: 90 | 180 | 270;
    }) => boolean | Promise<boolean>;
    cancelPageRotationPreview?: (input: {invalidatedPages: readonly number[]}) => boolean | Promise<boolean>;
    requestScrollToCurrentResult?: () => void;
}

export interface IPdfViewerLoadExpose {
    waitForViewerLoadSettled?: () => Promise<void>;
    ensurePageMetricsInRange?: (startPage: number, endPage: number) => Promise<boolean>;
    getPageMetricsSnapshot?: () => IPdfPageMetric[];
    pageMetrics?: readonly IPdfPageMetric[];
    pageMetricsVersion?: number;
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

export interface IPdfViewerSaveExpose {
    runSaveTransaction: (
        request: IPdfViewerSaveTransactionRequest,
    ) => Promise<IPdfViewerSaveTransactionResult>;
    commitPdfEditorsForSave?: () => Promise<void>;
}

export interface IPdfViewerBrowserPrintExpose {renderLoadedPdfPagesForBrowserPrint?: (
    targetDocument: IBrowserPrintDocument,
    pageNumbers: TPageNumber[],
    options?: { signal?: AbortSignal },
) => Promise<void>;}

export interface IPdfViewerAnnotationCommandExpose {
    annotationHistoryResetVersion?: number | undefined;
    hasCanonicalAnnotationChanges?: (() => boolean) | undefined;
    getAnnotationDirtyEntityCount?: (() => number) | undefined;
    hasCanonicalShapeChanges?: (() => boolean) | undefined;
    getDeletedCanonicalAnnotationIds?: (() => string[]) | undefined;
    getDeletedPersistedCanonicalAnnotationCount?: (() => number) | undefined;
    setWorkspaceCommandSink?: (sink: IWorkspaceCommandSink | null) => void;
    highlightSelection: () => Promise<boolean>;
    commentSelection: () => Promise<boolean>;
    createTextMarkupFromText: (
        options: ICreateTextMarkupFromTextOptions,
    ) => Promise<ICreateTextMarkupFromTextResult>;
    commentAtPoint: (
        pageNumber: TPageNumber,
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
    selectedAnnotations?: readonly AnnotationEntity[];
    selectAllAnnotations?: () => boolean;
    selectAnnotationById?: (annotationId: string) => boolean;
    focusSelectedAnnotation?: (annotationId: string) => boolean;
    editAnnotationTextBox?: (comment: IAnnotationCommentSummary) => Promise<void>;
    updateSelectedAnnotationProperties?: (updates: IAnnotationPropertyUpdate) => boolean;
    canRotateSelectedAnnotations?: (delta: -90 | 90) => boolean;
    prepareAnnotationToolChange?: () => void;
    handleAnnotationEscape?: () => boolean;
    selectedTextBox?: Pick<ITextBoxEntity, 'fontSize' | 'color'> | null;
    getSelectedTextBox?: () => ITextBoxEntity | null;
    updateSelectedTextBoxProperties?: (
        updates: Partial<Pick<ITextBoxEntity, 'fontSize' | 'color'>>,
    ) => boolean;
    /** Renderer-owned canonical state for main-process recovery publication. */
    captureCanonicalAnnotationRecovery?: (drafts?: readonly IAnnotationRecoveryDraft[]) => ICanonicalAnnotationRecovery;
    restoreCanonicalAnnotationRecovery?: (value: unknown) => ICanonicalAnnotationRecovery;
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
    deleteEmbeddedAnnotationDeferred?: (comment: IAnnotationCommentSummary) => boolean;
    removeAnnotationFromDom: (comment: IAnnotationCommentSummary) => void;
    removeAnnotationFromInternalCache: (stableKey: string) => void;
    getMarkupSubtypeOverrides: () => Map<string, TMarkupSubtype>;
    getMarkupSubtypeHints?: () => IMarkupSubtypeHint[];
    updateSelectedTextMarkupAnnotationColor?: (
        color: string,
        selected: ITextMarkupAnnotationProperties,
    ) => boolean;
    updateTextMarkupAnnotationColor?: (comment: IAnnotationCommentSummary, color: string) => boolean;
}

export interface IPdfViewerShapeExpose {
    getAllShapes: () => IShapeAnnotation[];
    getDeletedEmbeddedShapeAnnotationIds: () => string[];
    getDeletedEmbeddedShapeStableKeys?: () => string[];
    clearShapes: () => void;
    clearSelectedShape: () => void;
    deleteSelectedShape: () => void;
    hasShapes: boolean;
    selectedShapeId: string | null;
    updateShape: (id: string, updates: TShapeAnnotationPatch) => void;
    getSelectedShape: () => IShapeAnnotation | null;
}

export interface IPdfViewerImagePlacementExpose {
    startImagePlacement: (
        file: File,
        options?: {
            pageNumber?: TPageNumber | null;
            pageX?: number | null;
            pageY?: number | null;
            appAnnotationId?: string;
            stableKey?: string;
            annotationId?: string | null;
        },
    ) => Promise<boolean>;
    clearPendingImagePlacement: () => void;
}

export interface IPdfViewerExpose extends
    IDocumentViewerExpose,
    IPdfViewerLoadExpose,
    IPdfViewerRegionCaptureExpose,
    IPdfViewerCropExpose,
    IPdfViewerSaveExpose,
    IPdfViewerBrowserPrintExpose,
    IPdfViewerAnnotationCommandExpose,
    IPdfViewerAnnotationCommentExpose,
    IPdfViewerShapeExpose,
    IPdfViewerImagePlacementExpose {
    invalidatePages: (pages: number[]) => void;
    requestScrollToCurrentResult: () => void;
}
