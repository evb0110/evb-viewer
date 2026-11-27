import {isAbortError} from '@electron/utils/abort';

const EXPECTED_UPDATE_NETWORK_ERROR_CODES = new Set([
    'EAI_AGAIN',
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETDOWN',
    'ENETRESET',
    'ENETUNREACH',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ERR_INTERNET_DISCONNECTED',
    'ERR_NETWORK_CHANGED',
    'UND_ERR_CONNECT_TIMEOUT',
]);

function getErrorCode(error: unknown) {
    if (!error || typeof error !== 'object') {
        return undefined;
    }
    const errorLike = error as {
        cause?: unknown;
        code?: unknown;
    };
    if (typeof errorLike.code === 'string') {
        return errorLike.code;
    }
    if (errorLike.cause && typeof errorLike.cause === 'object') {
        const causeCode = (errorLike.cause as {code?: unknown}).code;
        return typeof causeCode === 'string' ? causeCode : undefined;
    }
    return undefined;
}

export function isExpectedUpdateNetworkError(error: unknown) {
    return isAbortError(error) || EXPECTED_UPDATE_NETWORK_ERROR_CODES.has(getErrorCode(error) ?? '');
}
