import type { TPageNumber } from '@contracts/pageNumbers';

import type { Ref } from 'vue';
import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import { findPdfPageContainer } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/findPdfPageContainer';
import { pdfViewerDomSelectors } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomSelectors';

interface ICreatePdfRendererPageDomOptions {
    container: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
}

export function createPdfRendererPageDom(options: ICreatePdfRendererPageDomOptions) {
    const {
        container,
        currentPage,
    } = options;

    function getMountedPageContainer(
        pageNumber: TPageNumber,
        containerRoot = container.value,
    ) {
        return findPdfPageContainer(containerRoot, pageNumber);
    }

    function clearSelectionBeforePageLayerTeardown(pageNumber: TPageNumber): boolean {
        const containerRoot = container.value;
        return clearPdfSelectionForLayerTeardown({
            target: getMountedPageContainer(pageNumber, containerRoot)
                ?.querySelector<HTMLElement>(pdfViewerDomSelectors.textLayerAny) ?? null,
            root: containerRoot,
            includeDetached: true,
            includeAnyPdfTextSelection: pageNumber === currentPage.value,
        });
    }

    return {
        getMountedPageContainer,
        clearSelectionBeforePageLayerTeardown,
    };
}
