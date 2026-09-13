import type { TOpenFileResult } from '@contracts/electronApiDocuments';

export type TDocumentOpenOutcome =
    | {
        status: 'prepared';
        result: TOpenFileResult;
    }
    | {
        status: 'opened';
        result: TOpenFileResult;
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

export function isOpenFileResultOfKind<TKind extends TOpenFileResult['kind']>(
    result: TOpenFileResult,
    kind: TKind,
): result is Extract<TOpenFileResult, {kind: TKind}> {
    return result.kind === kind;
}

export function didOpenDocument(outcome: TDocumentOpenOutcome) {
    return outcome.status === 'opened';
}
