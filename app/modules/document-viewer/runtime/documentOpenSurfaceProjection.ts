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

/**
 * Identity captured at the shared surface boundary for one viewport intent.
 *
 * The PDF viewport authority has its own intent id, so continuations must
 * carry this tuple instead of relying on a page number that can be reused by
 * a later command.
 */
export interface IDocumentOpenSurfaceViewportIntentIdentity {
    readonly generation: number;
    readonly documentRevision: string;
    readonly viewportIntentId: string;
    readonly pageNumber: number;
}

function readCurrentSurfaceViewportIntent(
    surface: IDocumentOpenSurfaceProjectionPort,
) {
    const snapshot = surface.snapshot.value;
    const viewport = surface.viewportSession.value;
    const intent = viewport.viewportIntent;
    if (
        snapshot.identity === null
        || intent === null
        || snapshot.generation !== viewport.generation
        || snapshot.identity.documentRevision !== viewport.identity?.revision
        || intent.generation !== viewport.generation
        || intent.pageNumber !== viewport.requestedPage
    ) {
        return null;
    }
    return {
        snapshot,
        viewport,
        intent,
    } as const;
}

/** Captures the live shared-surface identity without creating a new intent. */
export function captureDocumentOpenSurfaceViewportIntent(
    surface: IDocumentOpenSurfaceProjectionPort,
): IDocumentOpenSurfaceViewportIntentIdentity | null {
    const current = readCurrentSurfaceViewportIntent(surface);
    if (!current) {
        return null;
    }
    return Object.freeze({
        generation: current.snapshot.generation,
        documentRevision: current.snapshot.identity!.documentRevision,
        viewportIntentId: current.intent.id,
        pageNumber: current.intent.pageNumber,
    });
}

function isSameSurfaceViewportIntent(
    left: IDocumentOpenSurfaceViewportIntentIdentity,
    right: IDocumentOpenSurfaceViewportIntentIdentity,
) {
    return left.generation === right.generation
        && left.documentRevision === right.documentRevision
        && left.viewportIntentId === right.viewportIntentId
        && left.pageNumber === right.pageNumber;
}

/** Returns whether an identity still names the surface's current intent. */
export function isDocumentOpenSurfaceViewportIntentCurrent(
    surface: IDocumentOpenSurfaceProjectionPort,
    expected: IDocumentOpenSurfaceViewportIntentIdentity,
) {
    const current = captureDocumentOpenSurfaceViewportIntent(surface);
    return current !== null && isSameSurfaceViewportIntent(current, expected);
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
    expected?: IDocumentOpenSurfaceViewportIntentIdentity | null,
) {
    if (expected !== undefined) {
        if (expected === null) {
            return false;
        }
        const current = captureDocumentOpenSurfaceViewportIntent(surface);
        if (
            current === null
            || !isSameSurfaceViewportIntent(current, expected)
            || commit.page !== expected.pageNumber
        ) {
            return false;
        }
        return surface.commitViewport({
            generation: expected.generation,
            documentRevision: expected.documentRevision,
            viewportIntentId: expected.viewportIntentId,
            documentGeometryRevision: commit.geometryRevision,
            interactionEpoch: commit.interactionEpoch,
            pageNumber: expected.pageNumber,
            left: commit.left,
            top: commit.top,
        });
    }

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
