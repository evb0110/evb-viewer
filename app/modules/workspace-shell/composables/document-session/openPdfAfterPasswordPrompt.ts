import type { TTranslateFn } from '@i18n-app';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { IPdfRasterDisplayProfileOpenOptions } from '@app/types/pdfRasterDisplayProfile';
import {getDocumentRefBaseName} from '@app/utils/documentRef';

type TOpenedFileResult = Extract<TOpenFileResult, {kind: 'pdf' | 'djvu'}>;
type TPdfPasswordFailureResult = Extract<
    TOpenFileResult,
    {kind: 'pdf-needs-password' | 'pdf-unsupported-encryption'}
>;
type TOpenMethod = 'picker' | 'preselected' | 'direct' | 'batch';

interface IOpenPdfAfterPasswordPromptDeps {
    requestPassword: (
        fileName: string,
        errorMessage?: string | null,
    ) => Promise<string | null>;
    isCurrentOpenRequest: (requestId: number) => boolean;
    openDocumentDirect: (
        path: TDocumentRef,
        password: string,
    ) => Promise<TOpenFileResult | null>;
    cleanupAbandonedPdfWorkingCopy: (
        result: TOpenFileResult,
        reason: string,
    ) => Promise<void>;
    setError: (message: string) => void;
    reportUnsupportedEncryption: (openRequestId: number) => TDocumentOpenOutcome;
    trackOpenedDocument: (
        result: TOpenedFileResult,
        openMethod: TOpenMethod,
    ) => Promise<void>;
    setPendingDjvuPath: (path: TDocumentRef) => void;
    finishPdfOpenResult: (
        openRequestId: number,
        result: Extract<TOpenFileResult, {kind: 'pdf'}>,
        openMethod: TOpenMethod,
        options?: IPdfRasterDisplayProfileOpenOptions,
    ) => Promise<TDocumentOpenOutcome>;
    t: TTranslateFn;
}

export async function openPdfAfterPasswordPrompt(
    openRequestId: number,
    initialFailure: TPdfPasswordFailureResult,
    openMethod: TOpenMethod,
    options: IPdfRasterDisplayProfileOpenOptions,
    deps: IOpenPdfAfterPasswordPromptDeps,
): Promise<TDocumentOpenOutcome> {
    let retryError: string | null = null;
    while (deps.isCurrentOpenRequest(openRequestId)) {
        if (initialFailure.kind === 'pdf-unsupported-encryption') {
            return deps.reportUnsupportedEncryption(openRequestId);
        }

        const password = await deps.requestPassword(
            getDocumentRefBaseName(initialFailure.originalPath) ?? initialFailure.originalPath,
            retryError,
        );
        if (!deps.isCurrentOpenRequest(openRequestId)) {
            return {
                status: 'stale',
                result: initialFailure,
            };
        }
        if (password === null) {
            return { status: 'cancelled' };
        }

        const result = await deps.openDocumentDirect(initialFailure.originalPath, password);
        if (!deps.isCurrentOpenRequest(openRequestId)) {
            if (result) {
                await deps.cleanupAbandonedPdfWorkingCopy(result, 'stale-password-retry-result');
                return {
                    status: 'stale',
                    result,
                };
            }
            return {
                status: 'stale',
                result: initialFailure,
            };
        }
        if (!result) {
            const message = deps.t('errors.file.invalid');
            deps.setError(message);
            return {
                status: 'failed',
                error: message,
            };
        }
        if (result.kind === 'pdf-needs-password') {
            retryError = deps.t('errors.file.passwordPromptIncorrect');
            initialFailure = result;
            continue;
        }
        if (result.kind === 'pdf-unsupported-encryption') {
            return deps.reportUnsupportedEncryption(openRequestId);
        }
        if (result.kind === 'djvu') {
            deps.setPendingDjvuPath(result.originalPath);
            await deps.trackOpenedDocument(result, openMethod);
            return {
                status: 'prepared',
                result,
            };
        }
        return deps.finishPdfOpenResult(openRequestId, result, openMethod, options);
    }

    return {
        status: 'stale',
        result: initialFailure,
    };
}
