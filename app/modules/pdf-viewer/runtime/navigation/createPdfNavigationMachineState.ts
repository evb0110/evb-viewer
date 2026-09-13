import {
    createDocumentViewportNavigationMachineState,
    type IDocumentViewportNavigationState,
    type TPageSnapAnchor,
} from '@app/modules/document-viewer/public';

export type TPdfNavigationSource =
    | 'paged'
    | 'continuous'
    | 'search'
    | 'wheel';

export interface IPdfNavigationState extends IDocumentViewportNavigationState<TPdfNavigationSource, TPageSnapAnchor> {}

export function createPdfNavigationMachineState(
    txn = 0,
    currentPage: number | null = null,
): IPdfNavigationState {
    return createDocumentViewportNavigationMachineState<TPdfNavigationSource, TPageSnapAnchor>(txn, currentPage);
}
