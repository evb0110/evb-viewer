import { NativeToolBuildMismatchError } from '@electron/native-tools/runNativeToolCommand';
import { getErrorMessage } from '@electron/utils/error';

/**
 * The error to throw instead of falling back from a native engine, or null
 * when the fallback may run. A stale development binary is always thrown, so
 * every feature refuses it the same way; tests that enable a native path may
 * also forbid its fallback.
 */
export function createNativeFallbackTestError(
    enabledInTests: boolean,
    label: string,
    detail: string,
    cause?: unknown,
) {
    if (cause instanceof NativeToolBuildMismatchError) {
        return cause;
    }
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
