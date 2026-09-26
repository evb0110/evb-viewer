import type {
    TDocumentBackend,
    TDocumentRef,
} from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TDocumentInstanceId } from '@contracts/documentInstanceId';
import type { TSessionId } from '@contracts/shared';
import type { TTabId } from '@contracts/windowTabs';

export type TWorkspaceCommandTarget =
    | {
        kind: 'transaction';
        tabId: TTabId;
        sessionId: TSessionId;
        documentRef: TDocumentRef | null;
        documentBackend?: TDocumentBackend | undefined;
        documentInstanceId: TDocumentInstanceId | null;
        transactionId: string;
        documentRevisionToken?: TDocumentRevisionToken | undefined;
    }
    | {
        kind: 'revision';
        tabId: TTabId;
        sessionId: TSessionId;
        documentRef: TDocumentRef | null;
        documentBackend?: TDocumentBackend | undefined;
        documentInstanceId: TDocumentInstanceId | null;
        sessionRevision: number;
        documentRevisionToken?: TDocumentRevisionToken | undefined;
    };
