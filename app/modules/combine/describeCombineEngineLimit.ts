import type {TTranslateFn} from '@i18n-app';
import {DOCUMENT_OPEN_ERROR_ENVELOPE_SCHEMA} from '@contracts/documentOpenErrors';
import {NATIVE_ERROR_ENVELOPE_SCHEMA} from '@contracts/nativeErrors';
import {findSerializableErrorEnvelope} from '@contracts/serializableError';
import {hasElectronAPI} from '@app/utils/platform';

/**
 * The browser engine's request ceiling, named with its size, or the memory
 * its engine ran out of; null for any other Combine failure.
 */
export function describeCombineEngineLimit(cause: unknown, translate: TTranslateFn) {
    const envelope = findSerializableErrorEnvelope(cause, DOCUMENT_OPEN_ERROR_ENVELOPE_SCHEMA);
    if (envelope?.code === 'browser-byte-limit' && envelope.maxBytes !== undefined) {
        return translate('errors.browser.documentTooLarge', {limitMiB: Math.round(envelope.maxBytes / (1024 * 1024))});
    }
    return !hasElectronAPI() && findSerializableErrorEnvelope(cause, NATIVE_ERROR_ENVELOPE_SCHEMA)?.code === 'too-large'
        ? translate('errors.browser.notEnoughMemory')
        : null;
}
