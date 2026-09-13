import type { Ref } from 'vue';
import {
    resolveDocumentViewportCurrentPage,
    type IDocumentViewportSessionState,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceReducer';

interface IDocumentOpenSurfaceProjectionSnapshot {
    readonly generation: number;
    readonly identity: {readonly documentRevision: string} | null;
    readonly phase: string;
    readonly presentation: string;
}

interface IDocumentOpenSurfaceProjectionPort {
    readonly snapshot: Readonly<Ref<IDocumentOpenSurfaceProjectionSnapshot>>;
    readonly viewportSession: Readonly<Ref<IDocumentViewportSessionState>>;
    commitViewport(commit: {
        readonly generation: number;
        readonly documentRevision: string;
        readonly viewportIntentId: string;
        readonly documentGeometryRevision: number;
        readonly interactionEpoch: number;
        readonly pageNumber: number;
        readonly left: number;
        readonly top: number;
    }): boolean;
}

/** Prevents provisional scroll state from superseding the committed viewport. */
export function shouldProjectDocumentViewportScroll(
    snapshot: IDocumentOpenSurfaceProjectionSnapshot,
    viewportSession: IDocumentViewportSessionState,
) {
    return snapshot.phase === 'ready'
        && snapshot.presentation === 'committed'
        && viewportSession.lifecycle === 'ready'
        && viewportSession.committedPage !== null
        && viewportSession.requestedPage === viewportSession.committedPage;
}

export interface IDocumentViewportPositionProjection {
    readonly geometryRevision: number;
    readonly interactionEpoch: number;
    readonly left: number;
    readonly page: number;
    readonly top: number;
}

export function shouldProjectDocumentViewportCommitPage(
    surface: IDocumentOpenSurfaceProjectionPort,
    commit: IDocumentViewportPositionProjection,
) {
    const viewport = surface.viewportSession.value;
    return viewport.requestedPage === commit.page
        && resolveDocumentViewportCurrentPage(viewport) === commit.page;
}

/** Commits a feature-local position against the shared surface's live intent. */
export function commitDocumentOpenSurfaceViewport(
    surface: IDocumentOpenSurfaceProjectionPort,
    commit: IDocumentViewportPositionProjection,
) {
    const snapshot = surface.snapshot.value;
    const viewport = surface.viewportSession.value;
    const intent = viewport.viewportIntent;
    if (
        snapshot.identity === null
        || intent === null
        || intent.generation !== viewport.generation
        || viewport.requestedPage !== commit.page
        || intent.pageNumber !== commit.page
    ) {
        return false;
    }
    return surface.commitViewport({
        generation: snapshot.generation,
        documentRevision: snapshot.identity.documentRevision,
        viewportIntentId: intent.id,
        documentGeometryRevision: commit.geometryRevision,
        interactionEpoch: commit.interactionEpoch,
        pageNumber: commit.page,
        left: commit.left,
        top: commit.top,
    });
}
