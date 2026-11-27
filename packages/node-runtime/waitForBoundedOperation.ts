interface IBoundedWaitOptions {
    timeoutMs: number;
    /** Runs once when the deadline passes, before the wait settles. */
    onTimeout?: () => void;
    /** Lets the process exit while only this wait is pending. */
    unref?: boolean;
}

interface IBoundedWaitWithResult<TTimeout> extends IBoundedWaitOptions {
    /** The wait resolves with this value when the deadline passes. */
    timeoutResult: TTimeout;
}

interface IBoundedWaitWithError extends IBoundedWaitOptions {
    /** The wait rejects with this error when the deadline passes. */
    timeoutError: () => Error;
}

/** A function form receives a signal that aborts when the deadline passes. */
type TBoundedOperation<T> = Promise<T> | ((deadline: AbortSignal) => Promise<T>);

/**
 * Waits at most `timeoutMs` for an operation that may never settle. The
 * operation's own value or failure wins when it settles first; the timer is
 * cleared either way. IPC invokes, stream watchdogs, worker inactivity and
 * kill escalation keep their own owners.
 */
export function waitForBoundedOperation<T, TTimeout>(
    operation: TBoundedOperation<T>,
    options: IBoundedWaitWithResult<TTimeout>,
): Promise<T | TTimeout>;
export function waitForBoundedOperation<T>(operation: TBoundedOperation<T>, options: IBoundedWaitWithError): Promise<T>;
export async function waitForBoundedOperation<T, TTimeout>(
    operation: TBoundedOperation<T>,
    options: IBoundedWaitWithResult<TTimeout> | IBoundedWaitWithError,
): Promise<T | TTimeout> {
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<TTimeout>((resolve, reject) => {
        timer = setTimeout(() => {
            deadline.abort();
            options.onTimeout?.();
            if ('timeoutResult' in options) {
                resolve(options.timeoutResult);
            } else {
                reject(options.timeoutError());
            }
        }, options.timeoutMs);
        if (options.unref) {
            timer.unref();
        }
    });
    try {
        return await Promise.race([typeof operation === 'function' ? operation(deadline.signal) : operation, timeout]);
    } finally {
        clearTimeout(timer);
    }
}
