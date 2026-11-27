import type {TPageNumber} from '@contracts/pageNumbers';

import {pdfViewerDomSelectors} from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomSelectors';

function getPdfPageContainerSelector(pageNumber: TPageNumber) {
    return `${pdfViewerDomSelectors.pageContainer}[data-page="${pageNumber}"]`;
}

export function findPdfPageContainer(root: ParentNode | null | undefined, pageNumber: TPageNumber) {
    return root?.querySelector<HTMLElement>(getPdfPageContainerSelector(pageNumber)) ?? null;
}
