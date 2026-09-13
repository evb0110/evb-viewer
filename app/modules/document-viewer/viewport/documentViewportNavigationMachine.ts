type TDocumentViewportNavigationSource =
    | 'paged'
    | 'continuous'
    | 'search'
    | 'wheel';

type TDocumentViewportNavigationStatus =
    | 'idle'
    | 'navigating'
    | 'settling';

type TDocumentViewportNavigationAnchor =
    | 'center'
    | 'top'
    | 'bottom'
    | 'marker';

export interface IDocumentViewportNavigationState<
    TSource extends string = TDocumentViewportNavigationSource,
    TAnchor extends string = TDocumentViewportNavigationAnchor,
> {
    anchor: TAnchor | null;
    currentPage: number | null;
    source: TSource | null;
    status: TDocumentViewportNavigationStatus;
    targetPage: number | null;
    txn: number;
}

interface IDocumentViewportNavigateEvent<
    TSource extends string = TDocumentViewportNavigationSource,
    TAnchor extends string = TDocumentViewportNavigationAnchor,
> {
    anchor?: TAnchor | null | undefined;
    source: TSource;
    targetPage: number;
    type: 'NAVIGATE';
}

interface IDocumentViewportNavigationTxnPageEvent {
    page: number;
    txn: number;
}

interface IDocumentViewportNavigationScrollAppliedEvent extends IDocumentViewportNavigationTxnPageEvent {type: 'SCROLL_APPLIED';}

interface IDocumentViewportNavigationRenderSettledEvent extends IDocumentViewportNavigationTxnPageEvent {type: 'RENDER_SETTLED';}

interface IDocumentViewportNavigationCurrentPageCommittedEvent extends IDocumentViewportNavigationTxnPageEvent {type: 'CURRENT_PAGE_COMMITTED';}

interface IDocumentViewportNavigationViewportCurrentPageEvent {
    page: number;
    type: 'VIEWPORT_CURRENT_PAGE';
}

interface IDocumentViewportNavigationCancelEvent {type: 'CANCEL' | 'DOCUMENT_CHANGED' | 'USER_SCROLL';}

export type TDocumentViewportNavigationEvent<
    TSource extends string = TDocumentViewportNavigationSource,
    TAnchor extends string = TDocumentViewportNavigationAnchor,
> =
    | IDocumentViewportNavigateEvent<TSource, TAnchor>
    | IDocumentViewportNavigationScrollAppliedEvent
    | IDocumentViewportNavigationRenderSettledEvent
    | IDocumentViewportNavigationCurrentPageCommittedEvent
    | IDocumentViewportNavigationViewportCurrentPageEvent
    | IDocumentViewportNavigationCancelEvent;

export function createDocumentViewportNavigationMachineState<
    TSource extends string = TDocumentViewportNavigationSource,
    TAnchor extends string = TDocumentViewportNavigationAnchor,
>(
    txn = 0,
    currentPage: number | null = null,
): IDocumentViewportNavigationState<TSource, TAnchor> {
    return {
        anchor: null,
        currentPage,
        source: null,
        status: 'idle',
        targetPage: null,
        txn,
    };
}

function eventMatchesCurrentTarget<
    TSource extends string,
    TAnchor extends string,
>(
    state: IDocumentViewportNavigationState<TSource, TAnchor>,
    event: IDocumentViewportNavigationTxnPageEvent,
) {
    return state.txn === event.txn && state.targetPage === event.page;
}

export function reduceDocumentViewportNavigationMachine<
    TSource extends string = TDocumentViewportNavigationSource,
    TAnchor extends string = TDocumentViewportNavigationAnchor,
>(
    state: IDocumentViewportNavigationState<TSource, TAnchor>,
    event: TDocumentViewportNavigationEvent<TSource, TAnchor>,
): IDocumentViewportNavigationState<TSource, TAnchor> {
    switch (event.type) {
        case 'NAVIGATE':
            return {
                anchor: event.anchor ?? null,
                currentPage: event.targetPage,
                source: event.source,
                status: 'navigating',
                targetPage: event.targetPage,
                txn: state.txn + 1,
            };
        case 'CURRENT_PAGE_COMMITTED':
            if (!eventMatchesCurrentTarget(state, event)) {
                return state;
            }
            return {
                ...state,
                currentPage: event.page,
            };
        case 'VIEWPORT_CURRENT_PAGE':
            if (!canSyncDocumentViewportNavigationFromViewport(state)) {
                return state;
            }
            return {
                ...state,
                currentPage: event.page,
            };
        case 'SCROLL_APPLIED':
            if (state.status !== 'navigating' || !eventMatchesCurrentTarget(state, event)) {
                return state;
            }
            return {
                ...state,
                status: 'settling',
            };
        case 'RENDER_SETTLED':
            if (
                (state.status !== 'navigating' && state.status !== 'settling')
                || !eventMatchesCurrentTarget(state, event)
            ) {
                return state;
            }
            return createDocumentViewportNavigationMachineState<TSource, TAnchor>(state.txn, state.currentPage);
        case 'CANCEL':
        case 'DOCUMENT_CHANGED':
        case 'USER_SCROLL':
            return createDocumentViewportNavigationMachineState<TSource, TAnchor>(state.txn + 1, state.currentPage);
    }
}

export function isDocumentViewportNavigationTxnCurrent<
    TSource extends string,
    TAnchor extends string,
>(
    state: IDocumentViewportNavigationState<TSource, TAnchor>,
    txn: number,
) {
    return state.txn === txn && state.status !== 'idle';
}

export function getDocumentViewportNavigationStatusForSource<
    TSource extends string,
    TAnchor extends string,
>(
    state: IDocumentViewportNavigationState<TSource, TAnchor>,
    source: TSource,
) {
    return state.source === source
        ? state.status
        : 'idle';
}

export function getDocumentViewportNavigationTargetPageForSource<
    TSource extends string,
    TAnchor extends string,
>(
    state: IDocumentViewportNavigationState<TSource, TAnchor>,
    source: TSource,
) {
    return state.source === source && state.status !== 'idle'
        ? state.targetPage
        : null;
}

export function getDocumentViewportNavigationTxnForSource<
    TSource extends string,
    TAnchor extends string,
>(
    state: IDocumentViewportNavigationState<TSource, TAnchor>,
    source: TSource,
) {
    return state.source === source && state.status !== 'idle'
        ? state.txn
        : null;
}

export function isDocumentViewportNavigationTargetCurrent<
    TSource extends string,
    TAnchor extends string,
>(
    state: IDocumentViewportNavigationState<TSource, TAnchor>,
    source: TSource,
    txn: number,
    targetPage: number,
) {
    return state.source === source
        && state.status !== 'idle'
        && state.txn === txn
        && state.targetPage === targetPage;
}

export function canSyncDocumentViewportNavigationFromViewport<
    TSource extends string,
    TAnchor extends string,
>(state: IDocumentViewportNavigationState<TSource, TAnchor>) {
    return state.status === 'idle';
}
