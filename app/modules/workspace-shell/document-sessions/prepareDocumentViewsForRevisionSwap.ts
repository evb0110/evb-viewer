import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IPageIdentityDelta } from '@contracts/electronApiPageOps';
import type { TDocumentViews } from '@app/modules/workspace-shell/document-sessions/createDocumentViews';

interface IDocumentRevisionSwap {
    documentRevision: TDocumentRevisionToken;
    invalidatedPages: readonly number[];
    rotationDelta?: 90 | 180 | 270;
    pageIdentityDelta?: IPageIdentityDelta;
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
    let didPrepare: boolean | undefined;
    for (const port of views.viewPorts.value.values()) {
        const viewer = port.view.pdfViewerRef.value;
        try {
            const prepared = await viewer?.preparePageMutationRevisionSwap?.({
                ...swap,
                pageNumber: port.view.currentPage.value,
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
