const DEFAULT_ABORT_MESSAGE = 'The operation was aborted';

export function createAbortError(message = DEFAULT_ABORT_MESSAGE) {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

export function isAbortError(error: unknown) {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const errorLike = error as {
        code?: unknown;
        name?: unknown;
    };

    if (errorLike.name === 'AbortError') {
        return true;
    }

    return errorLike.code === 'ABORT_ERR';
}

export function abortErrorFromSignal(signal: AbortSignal) {
    return signal.reason instanceof Error
        ? signal.reason
        : createAbortError();
}

export function raceWithAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
        return promise;
    }
    if (signal.aborted) {
        void promise.catch(() => undefined);
        return Promise.reject(abortErrorFromSignal(signal));
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            void promise.catch(() => undefined);
            reject(abortErrorFromSignal(signal));
        };
        signal.addEventListener('abort', onAbort, {once: true});
        promise.then(
            value => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            error => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}
