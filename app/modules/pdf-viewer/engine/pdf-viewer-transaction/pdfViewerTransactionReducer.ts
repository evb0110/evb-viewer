import type {
    IPdfViewerTransaction,
    IPdfViewerTransactionMachineState,
    TPdfViewerTransactionEvent,
} from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import {
    canDocumentViewportTransactionSupersede,
    createDocumentViewportTransactionMachineState,
    reduceDocumentViewportTransactionMachine,
} from '@app/modules/document-viewer/public';

export function createPdfViewerTransactionMachineState(
    options: Partial<IPdfViewerTransactionMachineState> = {},
): IPdfViewerTransactionMachineState {
    return createDocumentViewportTransactionMachineState<IPdfViewerTransaction>(options);
}

export function canPdfViewerTransactionSupersede(
    active: IPdfViewerTransaction | null,
    incoming: Pick<IPdfViewerTransaction, 'kind' | 'renderRequest'>,
) {
    return canDocumentViewportTransactionSupersede(active, incoming);
}

export function reducePdfViewerTransactionMachine(
    state: IPdfViewerTransactionMachineState,
    event: TPdfViewerTransactionEvent,
): IPdfViewerTransactionMachineState {
    return reduceDocumentViewportTransactionMachine<IPdfViewerTransaction>(state, event);
}
