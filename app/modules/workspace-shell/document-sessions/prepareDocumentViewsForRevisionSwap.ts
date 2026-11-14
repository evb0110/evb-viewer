import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {
    getPageIdentityDeltaNextPageCount,
    mapPageNumberThroughPageIdentityDelta,
    type IPageIdentityDelta,
} from '@contracts/electronApiPageOps';
import { requirePageNumber } from '@contracts/pageNumbers';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { TDocumentViews } from '@app/modules/workspace-shell/document-sessions/createDocumentViews';

interface IDocumentRevisionSwap {
    documentRevision: TDocumentRevisionToken;
    invalidatedPages: readonly number[];
    rotationDelta?: 90 | 180 | 270;
    pageIdentityDelta?: IPageIdentityDelta;
    mapPageNumber?: (page: number) => number;
}

/**
 * Stages a rewrite of the open document in every view before it reloads, so
 * each view keeps its picture and its reading point through the reload. A
 * view that cannot prepare reloads as a fresh open. Returns whether any view
 * prepared.
 */
export async function prepareDocumentViewsForRevisionSwap(
    views: Pick<TDocumentViews, 'viewPorts'>,
    swap: IDocumentRevisionSwap,
) {
    const {
        mapPageNumber, ...revisionSwap
    } = swap;
    let didPrepare = false;
    for (const port of views.viewPorts.value.values()) {
        if (swap.rotationDelta !== undefined) {
            port.search.adoptPageRotation(swap.documentRevision, swap.invalidatedPages, swap.rotationDelta);
        }
        try {
            didPrepare = await port.view.pdfViewerRef.value?.preparePageMutationRevisionSwap?.({
                ...revisionSwap,
                pageNumber: mapPageNumber?.(port.view.currentPage.value) ?? port.view.currentPage.value,
            }) === true || didPrepare;
        } catch (error) {
            BrowserLogger.warn('pdf-document', 'A view could not keep its surface through the revision swap', {error});
        }
    }
    return didPrepare;
}

/**
 * Prepares every view for a history reload. The returned commit moves each
 * view's page through the delta; the caller runs it only once the reload is
 * still the current one, so a superseded restore leaves the views untouched.
 */
export async function prepareDocumentViewsForHistorySwap(
    views: Pick<TDocumentViews, 'viewPorts' | 'mapPageIdentity'>,
    totalPages: number,
    documentRevision: TDocumentRevisionToken,
    delta: IPageIdentityDelta | undefined,
) {
    const pageCount = (delta ? getPageIdentityDeltaNextPageCount(delta) : undefined) ?? totalPages;
    await prepareDocumentViewsForRevisionSwap(views, {
        documentRevision,
        invalidatedPages: Array.from({length: pageCount}, (_, index) => index + 1),
        ...(delta ? {
            pageIdentityDelta: delta,
            mapPageNumber: (page: number) => mapPageNumberThroughPageIdentityDelta(delta, requirePageNumber(page))
                ?? Math.max(1, Math.min(page, pageCount)),
        } : {}),
    });
    return () => {
        if (delta) views.mapPageIdentity(delta);
    };
}
