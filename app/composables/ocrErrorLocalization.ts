import type { TTranslationKey } from '@app/i18n/locales';

const REMOTE_METHOD_PREFIX_RE = /^Error invoking remote method '[^']+':\s*/u;

export function createOcrErrorLocalizer(t: (key: TTranslationKey) => string) {
    function normalizeErrorMessage(message: string) {
        return message.replace(REMOTE_METHOD_PREFIX_RE, '').trim();
    }

    function truncateErrorDetails(message: string) {
        const trimmed = message.trim();
        if (trimmed.length <= 240) {
            return trimmed;
        }
        return `${trimmed.slice(0, 237)}...`;
    }

    function isKnownLocalizedOcrError(message: string) {
        return [
            t('errors.file.invalid'),
            t('errors.ocr.loadLanguages'),
            t('errors.ocr.noValidPages'),
            t('errors.ocr.timeout'),
            t('errors.ocr.start'),
            t('errors.ocr.noPdfData'),
            t('errors.ocr.createSearchablePdf'),
            t('errors.ocr.noText'),
            t('errors.ocr.exportDocx'),
        ].includes(message);
    }

    function localizeOcrError(errorValue: unknown, fallbackKey: TTranslationKey) {
        const rawMessage = typeof errorValue === 'string'
            ? errorValue
            : (errorValue instanceof Error ? errorValue.message : '');
        if (!rawMessage) {
            return t(fallbackKey);
        }

        const normalized = normalizeErrorMessage(rawMessage);
        if (isKnownLocalizedOcrError(rawMessage)) {
            return rawMessage;
        }
        if (isKnownLocalizedOcrError(normalized)) {
            return normalized;
        }

        if (
            normalized === 'Invalid file path'
            || normalized === 'Invalid file path: path must be a non-empty string'
        ) {
            return t('errors.file.invalid');
        }

        if (
            normalized === 'Invalid file path: reads only allowed within temp directory'
            || normalized === 'Invalid file path: writes only allowed within temp directory'
        ) {
            return t(fallbackKey);
        }

        return `${t(fallbackKey)}: ${truncateErrorDetails(normalized)}`;
    }

    return { localizeOcrError };
}
