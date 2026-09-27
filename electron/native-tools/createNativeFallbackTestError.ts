import { getErrorMessage } from '@electron/utils/error';

export function createNativeFallbackTestError(
    enabledInTests: boolean,
    label: string,
    detail: string,
    cause?: unknown,
) {
    if (process.env.VITEST !== 'true' || !enabledInTests) {
        return null;
    }

    const suffix = cause === undefined ? '' : `: ${getErrorMessage(cause)}`;
    const error = new Error(`${label} fallback is not allowed in tests: ${detail}${suffix}`);
    if (cause !== undefined) {
        Object.defineProperty(error, 'cause', {
            value: cause,
            enumerable: false,
            configurable: true,
            writable: true,
        });
    }
    return error;
}
