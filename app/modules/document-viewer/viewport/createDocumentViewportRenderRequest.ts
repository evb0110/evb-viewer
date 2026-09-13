import type { IDocumentPageRange } from '@app/modules/document-viewer/documentPageRange';
import type {
    IDocumentViewportDocumentRef,
    IDocumentViewportRenderRequest,
    IDocumentViewportTarget,
    TDocumentViewportRenderPriority,
} from '@app/modules/document-viewer/viewport/documentViewportTransactionTypes';

interface IDocumentViewportRenderTransactionLike<
    TTransactionId extends number | string,
    TSource extends string,
    TRange extends IDocumentPageRange,
    TDocument,
> {
    id: TTransactionId;
    source: TSource;
    documentRef: IDocumentViewportDocumentRef<TDocument>;
    target: IDocumentViewportTarget<TRange> | null;
}

interface ICreateDocumentViewportRenderRequestOptions<
    TMetadata = unknown,
    TTransactionId extends number | string = string,
    TRenderRequestId extends number | string = string,
    TSource extends string = string,
    TPriority extends string = TDocumentViewportRenderPriority,
    TRange extends IDocumentPageRange = IDocumentPageRange,
    TDocument = unknown,
> {
    transaction: IDocumentViewportRenderTransactionLike<TTransactionId, TSource, TRange, TDocument>;
    renderRequestId: TRenderRequestId;
    renderVersion: number;
    range?: TRange | undefined;
    requiredRange?: TRange | undefined;
    buffer?: number | undefined;
    preserveRenderedPages?: boolean | undefined;
    preserveInFlightRequiredPages?: boolean | undefined;
    forceRerender?: boolean | undefined;
    priority: TPriority;
    metadata?: TMetadata | undefined;
}

export function createDocumentViewportRenderRequest<
    TMetadata = unknown,
    TTransactionId extends number | string = string,
    TRenderRequestId extends number | string = string,
    TSource extends string = string,
    TPriority extends string = TDocumentViewportRenderPriority,
    TRange extends IDocumentPageRange = IDocumentPageRange,
    TDocument = unknown,
>(
    options: ICreateDocumentViewportRenderRequestOptions<
        TMetadata,
        TTransactionId,
        TRenderRequestId,
        TSource,
        TPriority,
        TRange,
        TDocument
    >,
): IDocumentViewportRenderRequest<
    TMetadata,
    TTransactionId,
    TRenderRequestId,
    TSource,
    TPriority,
    TRange
> {
    const fallbackPage = options.transaction.target?.page ?? 1;
    const range = options.range ?? options.transaction.target?.range ?? {
        start: fallbackPage,
        end: fallbackPage,
    } as TRange;

    return {
        transactionId: options.transaction.id,
        renderRequestId: options.renderRequestId,
        documentVersion: options.transaction.documentRef.documentVersion,
        renderVersion: options.renderVersion,
        source: options.transaction.source,
        range,
        requiredRange: options.requiredRange ?? range,
        buffer: options.buffer ?? 0,
        preserveRenderedPages: options.preserveRenderedPages ?? false,
        preserveInFlightRequiredPages: options.preserveInFlightRequiredPages ?? false,
        forceRerender: options.forceRerender ?? false,
        priority: options.priority,
        ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    };
}
