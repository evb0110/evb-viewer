import {
    captureDocumentOpenSurfaceViewportIntent,
    commitDocumentOpenSurfaceViewport,
    isDocumentOpenSurfaceViewportIntentCurrent,
    shouldProjectDocumentViewportCommitPage,
    type IDocumentOpenSurfaceSession,
    type IDocumentOpenSurfaceViewportIntentIdentity,
    type IDocumentViewerRuntime,
} from '@app/modules/document-viewer/public';
import type { IPdfViewportPositionCommit } from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';

export interface IPdfOpenSurfaceViewportCallbacks {
    onUserViewportPageObserved: (page: number) => void;
    onViewportPositionCommitted: (
        commit: IPdfViewportPositionCommit,
        expected?: IDocumentOpenSurfaceViewportIntentIdentity | null,
    ) => boolean;
    captureSurfaceNavigation: (
        page: number,
    ) => IDocumentOpenSurfaceViewportIntentIdentity | null;
    captureCurrentSurfaceNavigation: () => IDocumentOpenSurfaceViewportIntentIdentity | null;
    isSurfaceNavigationCurrent: (
        expected: IDocumentOpenSurfaceViewportIntentIdentity,
    ) => boolean;
    onSurfaceNavigationAbandoned: (
        expected: IDocumentOpenSurfaceViewportIntentIdentity,
        page: number,
    ) => boolean;
}

function projectSettledProgrammaticPage(
    authority: IDocumentViewerRuntime | null | undefined,
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
    expected?: IDocumentOpenSurfaceViewportIntentIdentity | null,
) {
    const hasExpectedBoundary = expected !== undefined;
    if (!surface) {
        if (hasExpectedBoundary && expected !== null) {
            // A captured shared identity cannot be accepted after its surface
            // has gone away, even when the PDF-local position is otherwise
            // usable.
            return false;
        }
        // Preserve the local PDF mode when no shared surface exists. A null
        // identity is valid here because there is no later surface to adopt.
        emitCurrentPage(commit.page);
        return true;
    }
    if (expected === null) {
        return false;
    }
    if (
        expected !== undefined
        && !isDocumentOpenSurfaceViewportIntentCurrent(surface, expected)
    ) {
        return false;
    }
    if (!shouldProjectDocumentViewportCommitPage(surface, commit)) {
        return false;
    }
    const accepted = commitDocumentOpenSurfaceViewport(surface, commit, expected);
    if (!accepted) {
        return false;
    }
    emitCurrentPage(commit.page);
    return true;
}

function hasCommittedSurfaceFences(surface: IDocumentOpenSurfaceSession) {
    const viewport = surface.viewportSession.value;
    return viewport.committedRenderFence !== null
        && viewport.committedViewportFence !== null;
}

function normalizeAbandonedPage(page: number) {
    return Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : null;
}

export function createPdfOpenSurfaceViewportCallbacks(
    authority: IDocumentViewerRuntime | null | undefined,
    emitCurrentPage: (page: number) => void,
    onNavigationViewportCommitted: (page: number) => void,
): IPdfOpenSurfaceViewportCallbacks {
    const captureCurrentSurfaceNavigation = () => (
        authority?.openSurface
            ? captureDocumentOpenSurfaceViewportIntent(authority.openSurface)
            : null
    );

    return {
        onUserViewportPageObserved: (page: number) => {
            emitCurrentPage(authority?.observePage(page, {supersedeNavigation: true}) ?? page);
        },
        onViewportPositionCommitted: (
            commit: IPdfViewportPositionCommit,
            expected?: IDocumentOpenSurfaceViewportIntentIdentity | null,
        ) => {
            if (commit.intentKind === 'user-scroll') {
                return false;
            }
            if (projectPdfViewportPositionCommit(
                authority?.openSurface,
                commit,
                emitCurrentPage,
                expected,
            )) {
                onNavigationViewportCommitted(commit.page);
                return true;
            }
            // An explicit identity is a hard ownership boundary. A stale
            // continuation must not fall through to the legacy settled-page
            // observation path, which would mutate the newer surface intent.
            if (expected !== undefined) {
                return false;
            }
            return projectSettledProgrammaticPage(authority, commit, emitCurrentPage);
        },
        captureSurfaceNavigation: (page: number) => {
            if (!authority) {
                return null;
            }
            authority.navigate(page);
            return captureCurrentSurfaceNavigation();
        },
        captureCurrentSurfaceNavigation,
        isSurfaceNavigationCurrent: (expected) => (
            authority?.openSurface
                ? isDocumentOpenSurfaceViewportIntentCurrent(authority.openSurface, expected)
                : false
        ),
        onSurfaceNavigationAbandoned: (expected, page) => {
            const surface = authority?.openSurface;
            const abandonedPage = normalizeAbandonedPage(page);
            if (!surface || abandonedPage === null) {
                return false;
            }
            if (!isDocumentOpenSurfaceViewportIntentCurrent(surface, expected)) {
                return false;
            }

            if (hasCommittedSurfaceFences(surface)) {
                const observedPage = authority?.observePage(abandonedPage, {supersedeNavigation: true});
                const accepted = surface.viewportSession.value.lifecycle === 'ready';
                if (!accepted || observedPage === undefined) {
                    return false;
                }
                emitCurrentPage(observedPage);
                return true;
            }

            // Initial opening has no committed recovery point. Retarget its
            // existing surface intent and let the actual raster and viewport
            // commit close the opening lifecycle.
            const requestedPage = surface.requestNavigation(abandonedPage);
            return requestedPage === surface.viewportSession.value.requestedPage
                && surface.viewportSession.value.lifecycle === 'opening';
        },
    };
}
