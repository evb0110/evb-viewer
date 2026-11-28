import type {TTranslateFn, TTranslationKey} from '@i18n-app';
import type {TDocumentRef} from '@contracts/documentRef';
import {DOCUMENT_OPEN_ERROR_ENVELOPE_SCHEMA, type TDocumentOpenErrorEnvelope} from '@contracts/documentOpenErrors';
import {getFailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {isRecord} from '@contracts/runtimeGuards';
import {findSerializableErrorEnvelope} from '@contracts/serializableError';
import {
    isBrowserFilePickerSetupDeniedError,
    isBrowserFullReadTooLargeError,
    isBrowserQpdfEngineUnavailableError,
} from '@app/utils/browserOpenErrors';
import {getDocumentRefBaseName} from '@app/utils/documentRef';
import {BrowserLogger} from '@app/utils/browserLogger';

/** A browser engine's limit or unavailability, told alike for opening and saving; null for any other error. */
export function describeBrowserEngineLimit(error: unknown, t: TTranslateFn) {
    const openError = findSerializableErrorEnvelope(error, DOCUMENT_OPEN_ERROR_ENVELOPE_SCHEMA);
    if (isBrowserFullReadTooLargeError(error) || openError?.code === 'browser-byte-limit') {
        return t('errors.browser.documentTooLarge', {
            limitMiB: Math.round(
                (openError?.maxBytes ?? (isBrowserFullReadTooLargeError(error) ? error.maxBytes : undefined) ?? 16 * 1024 * 1024) /
                    (1024 * 1024),
            ),
        });
    }
    if ((error instanceof Error && error.name === 'BrowserPageOpsWorkerUnavailableError') || isBrowserQpdfEngineUnavailableError(error)) {
        return t('errors.browser.documentToolsUnavailable');
    }
    return null;
}

/** What a file named .djvu turned out to hold, in the user's words. */
const NOT_DJVU_MESSAGE_KEYS = {
    html: 'errors.file.notDjvuHtml',
    pdf: 'errors.file.notDjvuPdf',
    zip: 'errors.file.notDjvuZip',
    empty: 'errors.file.notDjvuEmpty',
    unknown: 'errors.file.notDjvu',
} as const satisfies Record<NonNullable<TDocumentOpenErrorEnvelope['detectedFormat']>, TTranslationKey>;

type TStructuredOpenErrorKind = 'permission-denied' | 'storage-full' | 'invalid' | 'not-found';

function findStructuredOpenErrorKind(error: unknown): TStructuredOpenErrorKind | null {
    const seen = new Set<object>();
    let candidate: unknown = error;
    while (candidate !== null && candidate !== undefined && typeof candidate === 'object') {
        if (seen.has(candidate)) {
            return null;
        }
        seen.add(candidate);
        const name =
            candidate instanceof Error
                ? candidate.name
                : isRecord(candidate) && typeof candidate.name === 'string'
                  ? candidate.name
                  : undefined;
        const code = isRecord(candidate) && typeof candidate.code === 'string' ? candidate.code : undefined;
        if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'NotReadableError') {
            return 'permission-denied';
        }
        if (name === 'QuotaExceededError') {
            return 'storage-full';
        }
        if (name === 'InvalidPDFException' || name === 'FormatError') {
            return 'invalid';
        }
        if (name === 'NotFoundError' || name === 'MissingPDFException' || code === 'ENOENT') {
            return 'not-found';
        }
        candidate = isRecord(candidate) ? candidate.cause : null;
    }
    return null;
}

export function classifyDocumentOpenError(error: unknown, path: TDocumentRef | null, t: TTranslateFn) {
    if (isBrowserFilePickerSetupDeniedError(error)) {
        return t('errors.browser.filePickerSetupDenied');
    }
    const engineLimit = describeBrowserEngineLimit(error, t);
    if (engineLimit) {
        return engineLimit;
    }
    const fallbackFileName = path ? (getDocumentRefBaseName(path) ?? String(path)) : '';
    const openError = findSerializableErrorEnvelope(error, DOCUMENT_OPEN_ERROR_ENVELOPE_SCHEMA);
    if (openError) {
        switch (openError.code) {
            case 'not-found':
                return t('errors.file.openNotFound', {name: openError.fileName ?? fallbackFileName});
            case 'not-djvu':
                return t(NOT_DJVU_MESSAGE_KEYS[openError.detectedFormat ?? 'unknown']);
            case 'invalid-djvu':
                return t('errors.file.invalidDjvu');
            case 'djvu-components-required':
                return t('errors.file.djvuComponentsRequired');
            case 'source-changed':
                return t('errors.file.changedWhileOpening');
            case 'djvu-raster-limit':
                return t('errors.file.djvuRasterLimit');
            case 'empty-pdf':
                return t('errors.file.emptyPdf');
            case 'invalid-pdf':
            case 'browser-byte-limit':
                return t('errors.file.invalid');
        }
    }
    switch (findStructuredOpenErrorKind(error)) {
        case 'permission-denied':
            return t('errors.browser.filePermissionDenied');
        case 'storage-full':
            return t('errors.browser.storageFull');
        case 'invalid':
            return t('errors.file.invalid');
        case 'not-found':
            return t('errors.file.openNotFound', {name: fallbackFileName});
        case null:
            return t('errors.file.openDescription');
    }
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
