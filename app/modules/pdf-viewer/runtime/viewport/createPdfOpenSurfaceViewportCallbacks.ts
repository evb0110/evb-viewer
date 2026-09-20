import type {
    IDocumentNavigationTicket,
    IDocumentOpenSurfaceSession,
    IDocumentViewerRuntime,
} from '@app/modules/document-viewer/public';
import type { IPdfViewportPositionCommit } from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';

type IPdfNavigationRuntime = Pick<IDocumentViewerRuntime, 'openSurface' | 'observePage'>;

export interface IPdfOpenSurfaceViewportCallbacks {
    onUserViewportPageObserved: (page: number) => void;
    onViewportPositionCommitted: (commit: IPdfViewportPositionCommit) => boolean;
}

function projectSettledProgrammaticPage(
    authority: IPdfNavigationRuntime | null | undefined,
    commit: IPdfViewportPositionCommit,
    emitCurrentPage: (page: number) => void,
) {
    const surface = authority?.openSurface;
    if (!surface || [
        'navigate',
        'search',
        'wheel-page',
    ].includes(commit.intentKind)) {
        return false;
    }
    const viewport = surface.viewportSession.value;
    if (viewport.lifecycle === 'ready') {
        const page = surface.observeViewportPage(commit.page);
        emitCurrentPage(page);
        return page === commit.page;
    }
    const identity = surface.snapshot.value.identity;
    const viewportIntent = viewport.viewportIntent;
    if (
        !identity
        || !viewportIntent
        || viewportIntent.pageNumber !== commit.page
        || commit.documentRevision <= 0
    ) {
        return false;
    }
    const accepted = surface.commitViewport({
        generation: viewport.generation,
        documentRevision: identity.documentRevision,
        viewportIntentId: viewportIntent.id,
        documentGeometryRevision: commit.geometryRevision,
        interactionEpoch: commit.interactionEpoch,
        pageNumber: commit.page,
        left: commit.left,
        top: commit.top,
    });
    if (!accepted) {
        return false;
    }
    const page = surface.observeViewportPage(commit.page);
    emitCurrentPage(page);
    return page === commit.page;
}

function reportNavigationPlacement(
    surface: IDocumentOpenSurfaceSession | null | undefined,
    commit: IPdfViewportPositionCommit,
    ticket: IDocumentNavigationTicket,
    emitCurrentPage: (page: number) => void,
) {
    if (!surface || !surface.isNavigationCurrent(ticket)) {
        return false;
    }
    const accepted = surface.reportNavigation(ticket, {
        kind: 'placed',
        page: commit.page,
        left: commit.left,
        top: commit.top,
        geometryRevision: commit.geometryRevision,
        interactionEpoch: commit.interactionEpoch,
    });
    if (accepted) {
        emitCurrentPage(commit.page);
    }
    return accepted;
}

export function createPdfOpenSurfaceViewportCallbacks(
    authority: IPdfNavigationRuntime | null | undefined,
    emitCurrentPage: (page: number) => void,
    onNavigationViewportCommitted: (page: number) => void,
): IPdfOpenSurfaceViewportCallbacks {
    return {
        onUserViewportPageObserved: (page: number) => {
            emitCurrentPage(authority?.observePage(page) ?? page);
        },
        onViewportPositionCommitted: (commit: IPdfViewportPositionCommit) => {
            if (commit.intentKind === 'user-scroll') {
                return false;
            }
            const accepted = commit.navigationTicket
                ? reportNavigationPlacement(
                    authority?.openSurface,
                    commit,
                    commit.navigationTicket,
                    emitCurrentPage,
                )
                : projectSettledProgrammaticPage(authority, commit, emitCurrentPage);
            if (accepted) {
                onNavigationViewportCommitted(commit.page);
            }
            return accepted;
        },
    };
}
