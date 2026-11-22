import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TPdfSourceJobOutcome } from '@app/types/pdfUi';
import type { IWorkspaceOpenFailure } from '@app/types/workspaceExpose';

export type TDocumentOpenOutcome =
    | {
        status: 'prepared';
        result: TOpenFileResult;
    }
    | {
        status: 'opened';
        result: TOpenFileResult;
        /** How the views take the published source: its PDF source job's end; null for a page source. */
        presentation: Promise<TPdfSourceJobOutcome> | null;
    }
    | { status: 'cancelled' }
    | {
        status: 'failed';
        error: string;
    }
    | {
        status: 'stale';
        result: TOpenFileResult;
    };

export type TWorkspaceOpenFinish =
    | {status: 'presented' | 'accepted-without-visual' | 'cancelled' | 'superseded'}
    | {status: 'failed'; failure: IWorkspaceOpenFailure | null};

/** An open's file work admitted a document; how its views take it, null when no view has to. */
export interface IWorkspaceOpenAdmission {
    presentation: Promise<TWorkspaceOpenFinish> | null;
}

/** An open the controller runs: `accepted` once it has a managed source and a command target, `finished` once it ended. */
export interface IWorkspaceOpenOperation {
    accepted: Promise<boolean>;
    finished: Promise<TWorkspaceOpenFinish>;
}

export function isOpenFileResultOfKind<TKind extends TOpenFileResult['kind']>(
    result: TOpenFileResult,
    kind: TKind,
): result is Extract<TOpenFileResult, {kind: TKind}> {
    return result.kind === kind;
}

export function didOpenDocument(outcome: TDocumentOpenOutcome) {
    return outcome.status === 'opened';
}

/** The open ended with its document shown, or accepted where no view had to show it. */
export function didPresent({status}: TWorkspaceOpenFinish) {
    return status === 'presented' || status === 'accepted-without-visual';
}

export async function didFinishOpen(operation: IWorkspaceOpenOperation) {
    return didPresent(await operation.finished);
}

/** What an open's file work admitted: an opened document, whose views end its source job. */
export function admitOpenedDocument(outcome: TDocumentOpenOutcome, readFailure = (): IWorkspaceOpenFailure | null => null): IWorkspaceOpenAdmission | null {
    return outcome.status === 'opened' ? {presentation: outcome.presentation?.then(({status}): TWorkspaceOpenFinish => (
        status === 'failed' ? {status, failure: readFailure()} : {status: status === 'presented' ? status : 'superseded'})) ?? null} : null;
}
