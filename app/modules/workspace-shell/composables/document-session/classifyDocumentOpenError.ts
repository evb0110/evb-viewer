import type { TTranslateFn } from '@i18n-app';
import type { TDocumentRef } from '@contracts/documentRef';
import {DOCUMENT_OPEN_ERROR_ENVELOPE_SCHEMA} from '@contracts/documentOpenErrors';
import {getFailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {NATIVE_ERROR_ENVELOPE_SCHEMA} from '@contracts/nativeErrors';
import {findSerializableErrorEnvelope} from '@contracts/serializableError';
import {isBrowserFilePickerSetupDeniedError} from '@app/platform/browser-api/public';
import {getDocumentRefBaseName} from '@app/utils/documentRef';
import {BrowserLogger} from '@app/utils/browserLogger';
import {stripIpcInvocationPrefix} from '@app/utils/stripIpcInvocationPrefix';

export function classifyDocumentOpenError(
    error: unknown,
    path: TDocumentRef | null,
    t: TTranslateFn,
) {
    if (isBrowserFilePickerSetupDeniedError(error)) {
        return t('errors.browser.filePickerSetupDenied');
    }
    const openError = findSerializableErrorEnvelope(error, DOCUMENT_OPEN_ERROR_ENVELOPE_SCHEMA);
    const rawMessage = error instanceof Error ? stripIpcInvocationPrefix(error.message) : '';
    if (openError ? openError.code === 'not-found' : /ENOENT|could not be found|no such file|chunk missing|does not exist/i.test(rawMessage)) {
        return t('errors.file.openNotFound', {name: openError?.fileName ?? (path ? getDocumentRefBaseName(path) ?? String(path) : '')});
    }
    if (openError) {
        return t(openError.code === 'source-changed' ? 'errors.file.changedWhileOpening' : openError.code === 'djvu-raster-limit' ? 'errors.file.djvuRasterLimit' : openError.code === 'empty-pdf' ? 'errors.file.emptyPdf' : 'errors.file.invalid');
    }
    return t(findSerializableErrorEnvelope(error, NATIVE_ERROR_ENVELOPE_SCHEMA)?.code === 'too-large' ? 'errors.file.encryptedTooLarge' : 'errors.file.openDescription');
}

/**
 * An open the main process refused before the renderer had the file, such as
 * a picked PDF that cannot be rewritten: the localized reason, the chosen
 * file's name and a failure receipt, never the IPC error text.
 */
export function describeRefusedDocumentOpen(error: unknown, t: TTranslateFn) {
    return {
        message: classifyDocumentOpenError(error, null, t),
        fileName: findSerializableErrorEnvelope(error, DOCUMENT_OPEN_ERROR_ENVELOPE_SCHEMA)?.fileName ?? null,
        failure: BrowserLogger.error(
            'recent-open',
            'Document open failed',
            {error},
            getFailureReceipt(error) ?? {code: 'RENDERER_PDF_DOCUMENT_LOAD_FAILED'},
        ),
    };
}
