import type { IDocumentNavigationTicket } from '@app/modules/document-viewer/navigation/documentNavigationRequest';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSessionContract';

/** Where a renderer placed its view: the page, the physical offsets and the inputs that fenced them. */
export interface IDocumentViewportPlacement {
    readonly page: number;
    readonly left: number;
    readonly top: number;
    readonly geometryRevision: number;
    readonly interactionEpoch: number;
    readonly navigationTicket?: IDocumentNavigationTicket | null | undefined;
}

/**
 * Every renderer's report of a placement to its view's surface: a ticket's
 * placement, the opening viewport, or the page a settled position shows.
 */
export function reportDocumentViewportPlacement(
    surface: Pick<IDocumentOpenSurfaceSession,
        'isNavigationCurrent' | 'reportNavigation' | 'viewportSession' | 'snapshot' | 'commitViewport' | 'observeViewportPage'>,
    placement: IDocumentViewportPlacement,
) {
    const ticket = placement.navigationTicket;
    if (ticket) {
        return surface.isNavigationCurrent(ticket) && surface.reportNavigation(ticket, {
            kind: 'placed',
            page: placement.page,
            left: placement.left,
            top: placement.top,
            geometryRevision: placement.geometryRevision,
            interactionEpoch: placement.interactionEpoch,
        });
    }
    const viewport = surface.viewportSession.value;
    if (viewport.lifecycle !== 'ready') {
        const identity = surface.snapshot.value.identity;
        const viewportIntent = viewport.viewportIntent;
        if (
            !identity
            || viewportIntent?.pageNumber !== placement.page
            || !surface.commitViewport({
                generation: viewport.generation,
                documentRevision: identity.documentRevision,
                viewportIntentId: viewportIntent.id,
                documentGeometryRevision: placement.geometryRevision,
                interactionEpoch: placement.interactionEpoch,
                pageNumber: placement.page,
                left: placement.left,
                top: placement.top,
            })
        ) {
            return false;
        }
    }
    return surface.observeViewportPage(placement.page) === placement.page;
}
