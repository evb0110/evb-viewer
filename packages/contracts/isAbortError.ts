import {
    isRecord,
    isSuppressedErrorLike,
} from '@contracts/runtimeGuards';

const DEFAULT_ABORT_MESSAGE = 'The operation was aborted';
const DOM_ABORT_ERR_CODE = typeof DOMException === 'function' && typeof DOMException.ABORT_ERR === 'number'
    ? DOMException.ABORT_ERR
    : 20;

export function createAbortError(message = DEFAULT_ABORT_MESSAGE) {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

export function isAbortError(error: unknown): boolean {
    const seen = new Set<object>();
    const stack: unknown[] = [error];

    while (stack.length > 0) {
        const candidate = stack.pop();
        if (!isRecord(candidate) || seen.has(candidate)) {
            continue;
        }
        seen.add(candidate);

        if (
            candidate.name === 'AbortError'
            || candidate.name === 'MainOperationUserCanceledError'
            || candidate.code === 'ABORT_ERR'
            || candidate.code === DOM_ABORT_ERR_CODE
        ) {
            return true;
        }

        if (isSuppressedErrorLike(candidate)) {
            if (candidate.error !== undefined && candidate.error !== null) {
                stack.push(candidate.error);
            }
            if (candidate.suppressed !== undefined && candidate.suppressed !== null) {
                stack.push(candidate.suppressed);
            }
        }
        if (candidate.cause !== undefined && candidate.cause !== null) {
            stack.push(candidate.cause);
        }
    }

    return false;
}
