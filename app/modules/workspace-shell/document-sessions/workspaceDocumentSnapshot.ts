import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentInstanceId } from '@contracts/documentInstanceId';
import type { IStartOpenFailure } from '@app/types/startSection';

/**
 * The tab's document lifecycle. `presented` means the tab owns a document the
 * viewer has shown; a cold tab keeps it while its view is released and
 * restores it when the tab is shown again.
 */
export type TWorkspaceDocumentPhase =
    | 'empty'
    | 'opening'
    | 'presented'
    | 'failed'
    | 'closing';

export type TWorkspaceDocumentTransactionKind = 'open' | 'restore' | 'close';

/** What the tab shows while an open is in flight. */
export interface IWorkspaceDocumentTarget {
    fileName?: string | null | undefined;
    originalPath?: TDocumentRef | null | undefined;
    isDjvu?: boolean | undefined;
}

export interface IWorkspaceDocumentIdentity {
    documentSessionKey: string | null;
    documentInstanceId: TDocumentInstanceId | null;
    documentRef: TDocumentRef | null;
    originalPath: TDocumentRef | null;
    workingCopyPath: TDocumentRef | null;
    fileName: string | null;
    isDjvu: boolean;
    revisionInfo: IDocumentRevisionInfo | null;
}

export interface IWorkspaceDocumentTransaction {
    id: string;
    kind: TWorkspaceDocumentTransactionKind;
    target: IWorkspaceDocumentTarget | null;
    acceptDocumentWithoutVisual: boolean;
}

export interface IWorkspaceDocumentSnapshot {
    tabId: string;
    sessionId: string;
    sessionRevision: number;
    phase: TWorkspaceDocumentPhase;
    identity: IWorkspaceDocumentIdentity;
    activeTransaction: IWorkspaceDocumentTransaction | null;
    /** Batch opens name the tab by their progress instead of a file. */
    openingLabel: string | null;
    /** Why the last open failed, with the file it tried to open. */
    failure: IStartOpenFailure | null;
    dirty: boolean;
    /** A checkpoint working copy that must be recovered before the source file. */
    recoveryWorkingCopyPath: TDocumentRef | null;
    mounted: boolean;
}
