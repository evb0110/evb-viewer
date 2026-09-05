import type { TOpenFileResult } from '@contracts/electronApiDocuments';

export type TPdfPasswordFailureResult = Extract<
    TOpenFileResult,
    {kind: 'pdf-needs-password' | 'pdf-unsupported-encryption'}
>;

export const isPdfPasswordFailureResult = (
    result: TOpenFileResult,
): result is TPdfPasswordFailureResult => result.kind === 'pdf-needs-password'
    || result.kind === 'pdf-unsupported-encryption';
