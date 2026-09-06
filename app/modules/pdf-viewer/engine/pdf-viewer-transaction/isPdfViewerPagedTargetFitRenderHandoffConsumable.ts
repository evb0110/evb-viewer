import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { TPdfViewMode } from '@contracts/shared';
import type { IPdfViewerTransaction } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';

interface IPdfViewerPagedTargetFitRenderHandoffConsumableOptions {
    document: IPdfDocument;
    documentLoadToken: number;
    documentVersion: number;
    fitMode: 'fit-width' | 'fit-height';
    page: number;
    viewMode: TPdfViewMode;
}

export function isPdfViewerPagedTargetFitRenderHandoffConsumable(
    transaction: IPdfViewerTransaction | null,
    options: IPdfViewerPagedTargetFitRenderHandoffConsumableOptions,
) {
    return Boolean(
        transaction
        && transaction.kind === 'rerender'
        && transaction.source === 'fit-paged-target'
        && transaction.target?.page === options.page
        && transaction.fitPlan.mode === options.fitMode
        && transaction.fitPlan.scalePage === options.page
        && transaction.fitPlan.hydrateRange !== null
        && transaction.fitPlan.viewMode === options.viewMode
        && transaction.fitPlan.pagedTargetRenderHandoff === 'pending'
        && transaction.documentRef.document === options.document
        && transaction.documentRef.documentLoadToken === options.documentLoadToken
        && transaction.documentRef.documentVersion === options.documentVersion,
    );
}
