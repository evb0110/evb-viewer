import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { TPdfViewMode } from '@contracts/shared';
import type { IPageRange } from '@app/types/pdfUi';
import type { TPdfRerenderSource } from '@app/modules/pdf-viewer/engine/pdf-rerender-protocol/pdfRerenderProtocol';
import type {
    IDocumentViewportDocumentRef,
    IDocumentViewportRenderRequest,
    IDocumentViewportTransactionBase,
    IDocumentViewportTransactionBeginEvent,
    IDocumentViewportTransactionCancellation,
    IDocumentViewportTransactionCancelEvent,
    IDocumentViewportTransactionAdvanceEvent,
    IDocumentViewportTransactionConsumeFitRenderHandoffEvent,
    IDocumentViewportTransactionMachineState,
    TDocumentViewportTransactionState,
} from '@app/utils/document-viewer/viewport/documentViewportTransactionTypes';

export type TPdfViewerTransactionKind =
    | 'navigation'
    | 'rerender'
    | 'reload'
    | 'resize'
    | 'zoom'
    | 'search'
    | 'recovery'
    | 'warm';

export type TPdfViewerTransactionSource =
    | 'paged-navigation'
    | 'continuous-navigation'
    | 'search-navigation'
    | 'wheel-navigation'
    | 'public-scroll'
    | 'fit-mode'
    | 'fit-current-page'
    | 'fit-paged-target'
    | 'zoom-change'
    | 'zoom-gesture'
    | 'resize-observer'
    | 'resize-settle'
    | 'view-mode'
    | 'reload'
    | 'activation-restore'
    | 'render-stall-recovery'
    | 'continuous-warm'
    | 'dpr-change';

export type TPdfViewerTransactionState = TDocumentViewportTransactionState;

export type TPdfViewerTransactionPriority =
    | 'authoritative'
    | 'interactive'
    | 'warm'
    | 'recovery';

export interface IPdfViewerTransactionDocumentRef extends IDocumentViewportDocumentRef<IPdfDocument> {}

export interface IPdfViewerTransactionFitPlan {
    mode: 'none' | 'fit-width' | 'fit-height';
    scalePage: number | null;
    hydrateRange: IPageRange | null;
    viewMode: TPdfViewMode | null;
    pagedTargetRenderHandoff: 'pending' | 'consumed' | null;
}

export interface IPdfViewerTransactionScrollPlan {
    preferExactDom: boolean;
    commitCurrentPageOnScroll: boolean;
    suppressSnapAfterScroll: boolean;
    holdProgrammaticNavigationMs: number;
}

export interface IPdfViewerTransactionRenderRequest extends IDocumentViewportRenderRequest<
    undefined,
    number,
    number,
    TPdfRerenderSource | TPdfViewerTransactionSource,
    TPdfViewerTransactionPriority
> {
    renderWindowOverride?: IPageRange | undefined;
    prioritizeTextLayer?: boolean | undefined;
}

export type TPdfViewerTransactionCancellationReason =
    | 'superseded'
    | 'document-changed'
    | 'reload'
    | 'zoom'
    | 'resize'
    | 'user-scroll'
    | 'inactive'
    | 'timeout'
    | 'disposed';

export interface IPdfViewerTransactionCancellation extends IDocumentViewportTransactionCancellation<TPdfViewerTransactionCancellationReason> {}

export interface IPdfViewerTransaction extends IDocumentViewportTransactionBase<
    TPdfViewerTransactionKind,
    TPdfViewerTransactionSource,
    IPdfDocument,
    IPageRange,
    IPdfViewerTransactionRenderRequest,
    IPdfViewerTransactionFitPlan,
    IPdfViewerTransactionScrollPlan,
    IPdfViewerTransactionCancellation
> {}

export interface IPdfViewerTransactionMachineState extends IDocumentViewportTransactionMachineState<IPdfViewerTransaction> {}

export interface IPdfViewerTransactionBeginEvent extends IDocumentViewportTransactionBeginEvent<IPdfViewerTransaction> {}

export interface IPdfViewerTransactionAdvanceEvent extends IDocumentViewportTransactionAdvanceEvent<IPdfViewerTransaction> {}

export interface IPdfViewerTransactionCancelEvent extends IDocumentViewportTransactionCancelEvent<IPdfViewerTransaction> {}

export interface IPdfViewerTransactionConsumeFitRenderHandoffEvent extends IDocumentViewportTransactionConsumeFitRenderHandoffEvent {}

export type TPdfViewerTransactionEvent =
    | IPdfViewerTransactionBeginEvent
    | IPdfViewerTransactionAdvanceEvent
    | IPdfViewerTransactionCancelEvent
    | IPdfViewerTransactionConsumeFitRenderHandoffEvent;

export const DEFAULT_PDF_VIEWER_TRANSACTION_FIT_PLAN: IPdfViewerTransactionFitPlan = {
    mode: 'none',
    scalePage: null,
    hydrateRange: null,
    viewMode: null,
    pagedTargetRenderHandoff: null,
};
