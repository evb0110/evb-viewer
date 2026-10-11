import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { IBookmarkItem } from '@app/types/pdfOutline';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';
import { createPdfPageNavigationRequest } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/createPdfPageNavigationRequest';

interface INavigateToBookmarkDestinationOptions {
    item: IBookmarkItem;
    pdfDocument: IPdfDocument | null;
    navigationRequestId: number;
    isBookmarkNavigationRequestCurrent: (requestId: number) => boolean;
    emitGoToPage: (page: number, options?: IScrollToPageOptions) => void;
}

/**
 * Emits one semantic destination request. Resolution, supersession, mounting,
 * readiness and the single pixel write all belong to ViewportAuthority.
 */
export function navigateToBookmarkDestination(options: INavigateToBookmarkDestinationOptions) {
    if (!options.isBookmarkNavigationRequestCurrent(options.navigationRequestId)) {
        return;
    }
    const pageIndex = options.item.pageIndex;
    const hasFiniteFallback = typeof pageIndex === 'number'
        && Number.isFinite(pageIndex);
    if (!options.item.dest && !hasFiniteFallback) {
        return;
    }
    const fallbackPage = hasFiniteFallback
        ? pageIndex + 1
        : 1;
    // A bookmark without a named destination keeps the vertical position its
    // saved or restored entry records, so its ratio still reaches the page.
    const request = createPdfPageNavigationRequest(fallbackPage, {
        navigationSource: 'bookmark',
        pageYRatio: hasFiniteFallback ? options.item.pageYRatio : null,
    });
    if (options.item.dest) {
        request.target = {
            kind: 'named-dest',
            destination: options.item.dest,
        };
    }
    options.emitGoToPage(fallbackPage, {navigationRequest: request});
}
