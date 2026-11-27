import {createAbortError, isAbortError} from '@contracts/isAbortError';

export {createAbortError, isAbortError};

export function abortErrorFromSignal(signal: AbortSignal) {
    return signal.reason instanceof Error ? signal.reason : createAbortError();
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
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}
