import type { IDocumentPageRange } from '@app/modules/document-viewer/documentPageRange';

type TDocumentViewportTransactionKind =
    | 'navigation'
    | 'render'
    | 'rerender'
    | 'reload'
    | 'resize'
    | 'zoom'
    | 'search'
    | 'recovery'
    | 'warm';

export type TDocumentViewportTransactionState =
    | 'preparing'
    | 'layout-ready'
    | 'visible-range-committed'
    | 'scroll-applied'
    | 'render-requested'
    | 'render-settled'
    | 'current-page-committed'
    | 'settled'
    | 'cancelled';

export type TDocumentViewportRenderPriority =
    | 'urgent'
    | 'normal'
    | 'background';

export interface IDocumentViewportDocumentRef<TDocument = unknown> {
    document: TDocument | null;
    documentLoadToken: number;
    documentVersion: number;
}

interface IDocumentViewportMarkerRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface IDocumentViewportTarget<TRange extends IDocumentPageRange = IDocumentPageRange> {
    page: number;
    range: TRange;
    anchor: 'top' | 'center' | 'bottom' | 'marker' | null;
    markerRect?: IDocumentViewportMarkerRect | null | undefined;
}

export interface IDocumentViewportRenderRequest<
    TMetadata = unknown,
    TTransactionId extends number | string = string,
    TRenderRequestId extends number | string = string,
    TSource extends string = string,
    TPriority extends string = TDocumentViewportRenderPriority,
    TRange extends IDocumentPageRange = IDocumentPageRange,
> {
    transactionId: TTransactionId;
    renderRequestId: TRenderRequestId;
    documentVersion: number;
    renderVersion: number;
    source: TSource;
    range: TRange;
    requiredRange: TRange;
    buffer: number;
    preserveRenderedPages: boolean;
    preserveInFlightRequiredPages: boolean;
    forceRerender: boolean;
    priority: TPriority;
    metadata?: TMetadata | undefined;
}

type TDocumentViewportCancellationReason =
    | 'superseded'
    | 'document-changed'
    | 'reload'
    | 'zoom'
    | 'resize'
    | 'user-scroll'
    | 'inactive'
    | 'timeout'
    | 'disposed';

export interface IDocumentViewportTransactionCancellation<
    TReason extends string = TDocumentViewportCancellationReason,
> {
    reason: TReason;
    supersededByTransactionId?: number | undefined;
    cancelInFlightRenders: boolean;
    bumpRenderVersion: boolean;
    preserveVisualContent: boolean;
}

export interface IDocumentViewportTransactionBase<
    TKind extends string = TDocumentViewportTransactionKind,
    TSource extends string = string,
    TDocument = unknown,
    TRange extends IDocumentPageRange = IDocumentPageRange,
    TRenderRequest extends {
        priority: string;
        renderRequestId: number | string
    } = IDocumentViewportRenderRequest<
        unknown,
        number | string,
        number | string,
        string,
        string
    >,
    TFitPlan = unknown,
    TScrollPlan = unknown,
    TCancellation extends IDocumentViewportTransactionCancellation = IDocumentViewportTransactionCancellation,
> {
    id: number;
    kind: TKind;
    source: TSource;
    state: TDocumentViewportTransactionState;
    documentRef: IDocumentViewportDocumentRef<TDocument>;
    target: IDocumentViewportTarget<TRange> | null;
    fitPlan: TFitPlan;
    scrollPlan: TScrollPlan | null;
    renderRequest: TRenderRequest | null;
    createdAtMs: number;
    userViewportInteractionEpoch: number;
    cancellation: TCancellation | null;
}

export interface IDocumentViewportTransactionMachineState<
    TTransaction extends IDocumentViewportTransactionBase = IDocumentViewportTransactionBase,
> {
    active: TTransaction | null;
    cancelled: TTransaction[];
    settled: TTransaction | null;
    nextTransactionId: number;
    nextRenderRequestId: number;
    renderVersion: number;
}

type TDocumentViewportTransactionAdvanceState = Exclude<
    TDocumentViewportTransactionState,
    'preparing' | 'cancelled'
>;

export interface IDocumentViewportTransactionBeginEvent<
    TTransaction extends IDocumentViewportTransactionBase = IDocumentViewportTransactionBase,
> {
    type: 'BEGIN';
    transaction: Omit<
        TTransaction,
        'id' | 'state' | 'renderRequest' | 'cancellation'
    > & {
        id?: number | undefined;
        state?: TDocumentViewportTransactionState | undefined;
        renderRequest?: TTransaction['renderRequest'] | null | undefined;
    };
}

export interface IDocumentViewportTransactionAdvanceEvent<
    TTransaction extends IDocumentViewportTransactionBase = IDocumentViewportTransactionBase,
> {
    type: 'ADVANCE';
    transactionId: number;
    state: TDocumentViewportTransactionAdvanceState;
    renderRequest?: TTransaction['renderRequest'] | null | undefined;
}

export interface IDocumentViewportTransactionCancelEvent<
    TTransaction extends IDocumentViewportTransactionBase = IDocumentViewportTransactionBase,
> {
    type: 'CANCEL';
    transactionId?: number | undefined;
    cancellation: NonNullable<TTransaction['cancellation']>;
}

export interface IDocumentViewportTransactionConsumeFitRenderHandoffEvent {
    type: 'CONSUME_FIT_RENDER_HANDOFF';
    transactionId: number;
}

export type TDocumentViewportTransactionEvent<
    TTransaction extends IDocumentViewportTransactionBase = IDocumentViewportTransactionBase,
> =
    | IDocumentViewportTransactionBeginEvent<TTransaction>
    | IDocumentViewportTransactionAdvanceEvent<TTransaction>
    | IDocumentViewportTransactionCancelEvent<TTransaction>
    | IDocumentViewportTransactionConsumeFitRenderHandoffEvent;
