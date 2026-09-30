import type { IWindowTabTransferSessionState } from '@contracts/windowTabs';
import { parseSessionId } from '@contracts/shared';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { resolveDocumentRefBackend } from '@app/utils/documentRef';

/** The document fence a cross-window tab transfer carries: its session, revision and identity. */
export function createDocumentSessionTransferState(
    session: IWorkspaceDocumentController | null | undefined,
): IWindowTabTransferSessionState | null {
    const snapshot = session?.snapshot.value;
    const sessionId = parseSessionId(snapshot?.sessionId);
    if (!snapshot || sessionId === null) {
        return null;
    }

    const documentBackend = resolveDocumentRefBackend(snapshot.identity.documentRef);
    return {
        sessionId,
        sessionRevision: snapshot.sessionRevision,
        documentRef: snapshot.identity.documentRef,
        ...(documentBackend === undefined ? {} : {documentBackend}),
        documentInstanceId: snapshot.identity.documentInstanceId,
        ...(snapshot.identity.revisionInfo?.token === undefined
            ? {}
            : {documentRevisionToken: snapshot.identity.revisionInfo.token}),
    };
}
