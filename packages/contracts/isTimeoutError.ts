const ES_TOOLKIT_TIMEOUT_MESSAGE = 'The operation was timed out';

interface IErrorLike {
    constructor?: {name?: unknown};
    message?: unknown;
    name?: unknown;
}

function isErrorLike(error: unknown): error is IErrorLike {
    return typeof error === 'object' && error !== null;
}

export function isTimeoutError(error: unknown) {
    if (!isErrorLike(error)) {
        return false;
    }

    return (
        error.name === 'TimeoutError' ||
        error.constructor?.name === 'TimeoutError' ||
        (error.name === 'Error' && error.message === ES_TOOLKIT_TIMEOUT_MESSAGE)
    );
}
