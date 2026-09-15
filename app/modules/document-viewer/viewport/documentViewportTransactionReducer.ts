import {
    doDocumentPageRangesIntersect,
    type IDocumentPageRange,
} from '@app/modules/document-viewer/documentPageRange';
import type {
    IDocumentViewportTransactionBase,
    IDocumentViewportTransactionMachineState,
    TDocumentViewportTransactionEvent,
    TDocumentViewportTransactionState,
} from '@app/modules/document-viewer/viewport/documentViewportTransactionTypes';

const AUTHORITATIVE_TRANSACTION_KINDS = new Set<string>([
    'navigation',
    'render',
    'rerender',
    'reload',
    'resize',
    'zoom',
    'search',
]);

const DOCUMENT_VIEWPORT_TRANSACTION_STATE_ORDER = {
    preparing: 0,
    'layout-ready': 1,
    'visible-range-committed': 2,
    'scroll-applied': 3,
    'render-requested': 4,
    'render-settled': 5,
    'current-page-committed': 6,
    settled: 7,
    cancelled: 8,
} satisfies Record<TDocumentViewportTransactionState, number>;

interface IDocumentViewportFitRenderHandoffPlan {pagedTargetRenderHandoff?: 'pending' | 'consumed' | null | undefined;}

interface IDocumentViewportPriorityTransaction {
    kind: string;
    renderRequest: {
        priority: string;
        renderRequestId: number | string;
    } | null;
}

export function createDocumentViewportTransactionMachineState<
    TTransaction extends IDocumentViewportTransactionBase,
>(
    options: Partial<IDocumentViewportTransactionMachineState<TTransaction>> = {},
): IDocumentViewportTransactionMachineState<TTransaction> {
    return {
        active: options.active ?? null,
        cancelled: options.cancelled ?? [],
        settled: options.settled ?? null,
        nextTransactionId: options.nextTransactionId ?? 1,
        nextRenderRequestId: options.nextRenderRequestId ?? 1,
        renderVersion: options.renderVersion ?? 0,
    };
}

function getDocumentViewportTransactionPriority(
    transaction: IDocumentViewportPriorityTransaction,
) {
    if (transaction.renderRequest) {
        return transaction.renderRequest.priority;
    }
    if (transaction.kind === 'warm') {
        return 'warm';
    }
    if (transaction.kind === 'recovery') {
        return 'recovery';
    }
    if (transaction.kind === 'zoom' || transaction.kind === 'resize') {
        return 'interactive';
    }
    return 'authoritative';
}

function isDocumentViewportTransactionAuthoritative(
    transaction: IDocumentViewportPriorityTransaction | null,
) {
    return Boolean(transaction && AUTHORITATIVE_TRANSACTION_KINDS.has(transaction.kind));
}

function isDocumentViewportTransactionCurrent<
    TTransaction extends IDocumentViewportTransactionBase,
>(
    state: IDocumentViewportTransactionMachineState<TTransaction>,
    transactionId: number,
) {
    return state.active?.id === transactionId
        && state.active.state !== 'cancelled'
        && state.active.state !== 'settled';
}

export function canDocumentViewportTransactionSupersede(
    active: IDocumentViewportPriorityTransaction | null,
    incoming: IDocumentViewportPriorityTransaction,
) {
    if (!active) {
        return true;
    }
    const incomingPriority = getDocumentViewportTransactionPriority(incoming);
    if (
        isDocumentViewportTransactionAuthoritative(active)
        && (
            incomingPriority === 'warm'
            || incomingPriority === 'recovery'
            || incomingPriority === 'background'
        )
    ) {
        return false;
    }
    return true;
}

function cancelTransaction<
    TTransaction extends IDocumentViewportTransactionBase,
>(
    transaction: TTransaction,
    cancellation: NonNullable<TTransaction['cancellation']>,
): TTransaction {
    return {
        ...transaction,
        state: 'cancelled',
        cancellation,
    };
}

function createSupersededCancellation<
    TTransaction extends IDocumentViewportTransactionBase,
>(
    supersededByTransactionId: number,
): NonNullable<TTransaction['cancellation']> {
    return {
        reason: 'superseded',
        supersededByTransactionId,
        cancelInFlightRenders: true,
        bumpRenderVersion: false,
        preserveVisualContent: true,
    };
}

function isForwardStateChange(
    currentState: TDocumentViewportTransactionState,
    nextState: TDocumentViewportTransactionState,
) {
    const currentOrder = DOCUMENT_VIEWPORT_TRANSACTION_STATE_ORDER[currentState];
    const nextOrder = DOCUMENT_VIEWPORT_TRANSACTION_STATE_ORDER[nextState];
    return nextOrder >= currentOrder;
}

function hasPendingFitRenderHandoff(fitPlan: unknown): fitPlan is IDocumentViewportFitRenderHandoffPlan {
    return Boolean(
        fitPlan
        && typeof fitPlan === 'object'
        && (fitPlan as IDocumentViewportFitRenderHandoffPlan).pagedTargetRenderHandoff === 'pending',
    );
}

function consumeFitRenderHandoff<
    TTransaction extends IDocumentViewportTransactionBase,
>(
    transaction: TTransaction,
    state: TDocumentViewportTransactionState = transaction.state,
): TTransaction {
    if (!hasPendingFitRenderHandoff(transaction.fitPlan)) {
        return transaction;
    }
    return {
        ...transaction,
        state,
        fitPlan: {
            ...transaction.fitPlan,
            pagedTargetRenderHandoff: 'consumed',
        },
    };
}

export function reduceDocumentViewportTransactionMachine<
    TTransaction extends IDocumentViewportTransactionBase,
>(
    state: IDocumentViewportTransactionMachineState<TTransaction>,
    event: TDocumentViewportTransactionEvent<TTransaction>,
): IDocumentViewportTransactionMachineState<TTransaction> {
    switch (event.type) {
        case 'BEGIN': {
            const id = event.transaction.id ?? state.nextTransactionId;
            const nextTransaction = {
                ...event.transaction,
                id,
                state: event.transaction.state ?? 'preparing',
                renderRequest: event.transaction.renderRequest ?? null,
                cancellation: null,
            } as TTransaction;
            if (!canDocumentViewportTransactionSupersede(state.active, nextTransaction)) {
                return state;
            }

            const cancelled = state.active
                ? [
                    ...state.cancelled,
                    cancelTransaction(state.active, createSupersededCancellation<TTransaction>(id)),
                ]
                : state.cancelled;
            return {
                ...state,
                active: nextTransaction,
                cancelled,
                settled: null,
                nextTransactionId: Math.max(state.nextTransactionId, id + 1),
            };
        }
        case 'ADVANCE': {
            if (!isDocumentViewportTransactionCurrent(state, event.transactionId) || !state.active) {
                return state;
            }
            if (!isForwardStateChange(state.active.state, event.state)) {
                return state;
            }

            const active = {
                ...state.active,
                state: event.state,
                renderRequest: event.renderRequest === undefined
                    ? state.active.renderRequest
                    : event.renderRequest,
            } as TTransaction;
            const nextRenderRequestId = event.renderRequest && typeof event.renderRequest.renderRequestId === 'number'
                ? Math.max(state.nextRenderRequestId, event.renderRequest.renderRequestId + 1)
                : state.nextRenderRequestId;
            if (event.state === 'settled') {
                return {
                    ...state,
                    active: null,
                    settled: active,
                    nextRenderRequestId,
                };
            }
            return {
                ...state,
                active,
                nextRenderRequestId,
            };
        }
        case 'CANCEL': {
            if (!state.active) {
                return event.cancellation.bumpRenderVersion
                    ? {
                        ...state,
                        renderVersion: state.renderVersion + 1,
                    }
                    : state;
            }
            if (
                event.transactionId !== undefined
                && event.transactionId !== state.active.id
            ) {
                return state;
            }

            return {
                ...state,
                active: null,
                cancelled: [
                    ...state.cancelled,
                    cancelTransaction(state.active, event.cancellation),
                ],
                renderVersion: event.cancellation.bumpRenderVersion
                    ? state.renderVersion + 1
                    : state.renderVersion,
            };
        }
        case 'CONSUME_FIT_RENDER_HANDOFF': {
            if (state.active?.id === event.transactionId) {
                return {
                    ...state,
                    active: consumeFitRenderHandoff(
                        state.active,
                        isForwardStateChange(state.active.state, 'current-page-committed')
                            ? 'current-page-committed'
                            : state.active.state,
                    ),
                };
            }
            if (state.settled?.id === event.transactionId) {
                return {
                    ...state,
                    settled: consumeFitRenderHandoff(state.settled),
                };
            }
            return state;
        }
    }
}

export function isDocumentViewportRenderRequestCurrent(
    activeTransaction: Pick<IDocumentViewportTransactionBase, 'id' | 'documentRef'> | null,
    request: {
        transactionId: number | string;
        documentVersion: number
    },
) {
    return activeTransaction?.id === request.transactionId
        && activeTransaction.documentRef.documentVersion === request.documentVersion;
}

export function isDocumentViewportTargetRangeCurrent(
    range: IDocumentPageRange,
    activeRange: IDocumentPageRange | null,
    visibleRange: IDocumentPageRange,
) {
    return doDocumentPageRangesIntersect(range, activeRange ?? visibleRange);
}
