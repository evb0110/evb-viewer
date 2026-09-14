import { getErrorMessage } from '@app/utils/error';
import { useTypedI18n } from '@app/composables/useTypedI18n';
import {
    ocrErrorCodeMessageKeys,
    ocrErrorMessageKeys,
} from '@app/utils/ocr/ocrErrorMessageKeys';
import type { IOcrErrorEnvelope } from '@contracts/electronApiOcr';
import type { TOcrErrorFallbackKey } from '@app/utils/ocr/ocrErrorMessageKeys';

const REMOTE_METHOD_PREFIX_RE = /^Error invoking remote method '[^']+':\s*/u;
const ERROR_PREFIX_RE = /^(?:Error:\s*)+/u;

function normalizeOcrErrorMessage(message: string) {
    return message
        .replace(REMOTE_METHOD_PREFIX_RE, '')
        .replace(ERROR_PREFIX_RE, '')
        .trim();
}

function truncateOcrErrorDetails(message: string) {
    const trimmed = message.trim();
    if (trimmed.length <= 240) {
        return trimmed;
    }
    return `${trimmed.slice(0, 237)}...`;
}

function isOcrErrorEnvelope(value: unknown): value is IOcrErrorEnvelope {
    return typeof value === 'object'
        && value !== null
        && typeof (value as { message?: unknown }).message === 'string'
        && typeof (value as { code?: unknown }).code === 'string';
}

function getOcrErrorEnvelope(value: unknown): IOcrErrorEnvelope | null {
    if (isOcrErrorEnvelope(value)) {
        return value;
    }
    if (
        typeof value === 'object'
        && value !== null
        && isOcrErrorEnvelope((value as { errorEnvelope?: unknown }).errorEnvelope)
    ) {
        return (value as { errorEnvelope: IOcrErrorEnvelope }).errorEnvelope;
    }
    return null;
}

export const useOcrErrorLocalizer = () => {
    const { t } = useTypedI18n();

    function isKnownLocalizedOcrError(message: string) {
        return ocrErrorMessageKeys
            .map(key => t(key))
            .includes(message);
    }

    function localizeOcrError(errorValue: unknown, fallbackKey: TOcrErrorFallbackKey) {
        const envelope = getOcrErrorEnvelope(errorValue);
        const rawMessage = envelope !== null
            ? envelope.message
            : typeof errorValue === 'string'
                ? errorValue
                : (errorValue instanceof Error ? getErrorMessage(errorValue) : '');
        if (!rawMessage) {
            return t(fallbackKey);
        }

        const normalized = normalizeOcrErrorMessage(rawMessage);
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

        if (envelope !== null) {
            const codeMessageKey = ocrErrorCodeMessageKeys[envelope.code];
            const codeMessage = t(codeMessageKey);
            if (
                envelope.code === 'OCR_MULTIPLE_LANGUAGES'
                || !normalized
                || normalized === envelope.code
                || normalized === codeMessage
            ) {
                return codeMessage;
            }
            return `${codeMessage}: ${truncateOcrErrorDetails(normalized)}`;
        }

        return `${t(fallbackKey)}: ${truncateOcrErrorDetails(normalized)}`;
    }

    return { localizeOcrError };
};
