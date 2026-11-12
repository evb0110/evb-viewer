import {
    reportDocumentViewportPlacement,
    type IDocumentViewerRuntime,
} from '@app/modules/document-viewer/public';
import type { IPdfViewportPositionCommit } from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';

type IPdfNavigationRuntime = Pick<IDocumentViewerRuntime, 'openSurface' | 'observePage'>;

export interface IPdfOpenSurfaceViewportCallbacks {
    onUserViewportPageObserved: (page: number) => void;
    onViewportPositionCommitted: (commit: IPdfViewportPositionCommit) => boolean;
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
            // A ticketless navigation-kind commit, or one before a document,
            // places nothing the surface asked for.
            const accepted = Boolean(
                authority
                && commit.intentKind !== 'user-scroll'
                && (commit.navigationTicket || (
                    commit.documentRevision > 0
                    && ![
                        'navigate',
                        'search',
                        'wheel-page',
                    ].includes(commit.intentKind)
                ))
                && reportDocumentViewportPlacement(authority.openSurface, commit),
            );
            if (accepted) {
                onNavigationViewportCommitted(commit.page);
            }
            return accepted;
        },
    };
}
