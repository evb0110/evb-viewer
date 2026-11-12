import type { IDocumentViewerRuntime } from '@app/modules/document-viewer/public';
import type { IPdfViewportPositionCommit } from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';

type IPdfNavigationRuntime = Pick<IDocumentViewerRuntime, 'openSurface' | 'observePage'>;

export interface IPdfOpenSurfaceViewportCallbacks {
    onUserViewportPageObserved: (page: number) => void;
    onViewportPositionCommitted: (commit: IPdfViewportPositionCommit) => boolean;
}

/**
 * The viewport's report to the shared surface: a ticket's placement, the
 * opening viewport, or the page a settled position shows.
 */
function reportViewportPosition(
    authority: IPdfNavigationRuntime | null | undefined,
    commit: IPdfViewportPositionCommit,
) {
    const surface = authority?.openSurface;
    if (!surface) {
        return false;
    }
    const ticket = commit.navigationTicket;
    if (ticket) {
        return surface.isNavigationCurrent(ticket) && surface.reportNavigation(ticket, {
            kind: 'placed',
            page: commit.page,
            left: commit.left,
            top: commit.top,
            geometryRevision: commit.geometryRevision,
            interactionEpoch: commit.interactionEpoch,
        });
    }
    if ([
        'navigate',
        'search',
        'wheel-page',
    ].includes(commit.intentKind)) {
        return false;
    }
    const viewport = surface.viewportSession.value;
    if (viewport.lifecycle !== 'ready') {
        const identity = surface.snapshot.value.identity;
        const viewportIntent = viewport.viewportIntent;
        if (
            !identity
            || !viewportIntent
            || viewportIntent.pageNumber !== commit.page
            || commit.documentRevision <= 0
            || !surface.commitViewport({
                generation: viewport.generation,
                documentRevision: identity.documentRevision,
                viewportIntentId: viewportIntent.id,
                documentGeometryRevision: commit.geometryRevision,
                interactionEpoch: commit.interactionEpoch,
                pageNumber: commit.page,
                left: commit.left,
                top: commit.top,
            })
        ) {
            return false;
        }
    }
    return surface.observeViewportPage(commit.page) === commit.page;
}

export function createPdfOpenSurfaceViewportCallbacks(
    authority: IPdfNavigationRuntime | null | undefined,
    onNavigationViewportCommitted: (page: number) => void,
): IPdfOpenSurfaceViewportCallbacks {
    return {
        onUserViewportPageObserved: (page: number) => {
            authority?.observePage(page);
        },
        onViewportPositionCommitted: (commit: IPdfViewportPositionCommit) => {
            if (commit.intentKind === 'user-scroll') {
                return false;
            }
            const accepted = reportViewportPosition(authority, commit);
            if (accepted) {
                onNavigationViewportCommitted(commit.page);
            }
            return accepted;
        },
    };
}
