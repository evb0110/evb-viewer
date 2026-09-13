import type {
    IDocumentViewerChassisAuthority,
    commitDocumentOpenSurfaceViewport,
    shouldProjectDocumentViewportCommitPage,
    type IDocumentOpenSurfaceSession, 
} from '@app/modules/document-viewer/public';
import type { IPdfViewportPositionCommit } from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';

function projectSettledProgrammaticPage(
    authority: IDocumentViewerChassisAuthority | null | undefined,
    commit: IPdfViewportPositionCommit,
    emitCurrentPage: (page: number) => void,
) {
    const surface = authority?.openSurface;
    if (
        !surface
        || surface.viewportSession.value.lifecycle !== 'ready'
        || ![
            'navigate',
            'search',
            'wheel-page',
        ].includes(commit.intentKind)
    ) {
        return false;
    }
    emitCurrentPage(authority.observePage(commit.page));
    return true;
}

function projectPdfViewportPositionCommit(
    surface: IDocumentOpenSurfaceSession | null | undefined,
    commit: IPdfViewportPositionCommit,
    emitCurrentPage: (page: number) => void,
) {
    if (!surface) {
        emitCurrentPage(commit.page);
        return false;
    }
    if (!shouldProjectDocumentViewportCommitPage(surface, commit)) {
        return false;
    }
    surface.requestNavigation(commit.page);
    emitCurrentPage(commit.page);
    return commitDocumentOpenSurfaceViewport(surface, commit);
}

export function createPdfOpenSurfaceViewportCallbacks(
    authority: IDocumentViewerChassisAuthority | null | undefined,
    emitCurrentPage: (page: number) => void,
    onNavigationViewportCommitted: (page: number) => void,
) {
    return {
        onUserViewportPageObserved: (page: number) => {
            emitCurrentPage(authority?.observePage(page, {supersedeNavigation: true}) ?? page);
        },
        onViewportPositionCommitted: (commit: IPdfViewportPositionCommit) => {
            if (commit.intentKind === 'user-scroll') {
                return;
            }
            if (projectPdfViewportPositionCommit(authority?.openSurface, commit, emitCurrentPage)) {
                onNavigationViewportCommitted(commit.page);
                return;
            }
            projectSettledProgrammaticPage(authority, commit, emitCurrentPage);
        },
    };
}
