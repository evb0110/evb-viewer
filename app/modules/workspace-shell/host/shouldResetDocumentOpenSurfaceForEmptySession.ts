import type { IWorkspaceDocumentSnapshot } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { IDocumentOpenSurfaceSnapshot } from '@app/modules/document-viewer/public';

export function shouldResetDocumentOpenSurfaceForEmptySession(
    session: IWorkspaceDocumentSnapshot,
    surface: IDocumentOpenSurfaceSnapshot,
) {
    return session.phase === 'empty'
        && session.identity.documentSessionKey === null
        && session.identity.documentInstanceId === null
        && session.activeTransaction === null
        && surface.phase !== 'idle';
}
