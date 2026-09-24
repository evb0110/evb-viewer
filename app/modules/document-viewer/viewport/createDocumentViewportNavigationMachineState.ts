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

