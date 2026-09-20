import type {IDocumentViewportSessionState} from '@app/modules/document-viewer/runtime/documentOpenSurfaceReducer';

interface IDocumentOpenSurfaceProjectionSnapshot {
    readonly phase: string;
    readonly presentation: string;
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
