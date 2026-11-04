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
 * view that cannot prepare reloads as a fresh open; only the failure of the
 * view in use reaches the caller. Returns what the view in use answered.
 */
export async function prepareDocumentViewsForRevisionSwap(
    views: Pick<TDocumentViews, 'viewPorts'>,
    viewerInUse: unknown,
    swap: IDocumentRevisionSwap,
) {
    const {
        mapPageNumber, ...revisionSwap
    } = swap;
    let didPrepare: boolean | undefined;
    for (const port of views.viewPorts.value.values()) {
        if (swap.rotationDelta !== undefined) {
            port.search.adoptPageRotation(swap.documentRevision, swap.invalidatedPages, swap.rotationDelta);
        }
        const viewer = port.view.pdfViewerRef.value;
        try {
            const prepared = await viewer?.preparePageMutationRevisionSwap?.({
                ...revisionSwap,
                pageNumber: mapPageNumber?.(port.view.currentPage.value) ?? port.view.currentPage.value,
            });
            if (viewer === viewerInUse) {
                didPrepare = prepared;
            }
        } catch (error) {
            if (viewer === viewerInUse) {
                throw error;
            }
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
    viewerInUse: unknown,
    totalPages: number,
    documentRevision: TDocumentRevisionToken,
    delta: IPageIdentityDelta | undefined,
) {
    const pageCount = (delta ? getPageIdentityDeltaNextPageCount(delta) : undefined) ?? totalPages;
    await prepareDocumentViewsForRevisionSwap(views, viewerInUse, {
        documentRevision,
        invalidatedPages: Array.from({length: pageCount}, (_, index) => index + 1),
        ...(delta ? {
            pageIdentityDelta: delta,
            mapPageNumber: (page: number) => mapPageNumberThroughPageIdentityDelta(delta, requirePageNumber(page))
                ?? Math.max(1, Math.min(page, pageCount)),
        } : {}),
    }).catch((error: unknown) => {
        BrowserLogger.warn('pdf-history', 'Could not preserve the viewer surface for history reload', {error});
    });
    return () => {
        if (delta) views.mapPageIdentity(delta);
    };
}
