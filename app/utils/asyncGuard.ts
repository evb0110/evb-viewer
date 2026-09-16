import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';

export type TGuardAsyncCategory = 'background-diagnostic' | 'user-visible-operation';

export interface IGuardAsyncOptions {
    category: TGuardAsyncCategory;
    scope: string;
    message: string;
    signal?: AbortSignal;
    onError?: (error: unknown) => void;
}

function isErrorWithName(error: unknown, name: string) {
    return error instanceof Error && error.name === name;
}

function isExpectedCancellation(error: unknown, options: IGuardAsyncOptions) {
    if (options.signal?.aborted) {
        return true;
    }

    if (
        isErrorWithName(error, 'AbortError')
        || isErrorWithName(error, 'RenderingCancelledException')
        || isErrorWithName(error, 'AbortException')
    ) {
        return true;
    }

    if (error && typeof error === 'object' && 'code' in error) {
        const code = (error as {code?: unknown}).code;
        return code === 'ABORT_ERR' || code === 'ERR_CANCELED';
    }

    return false;
}

function runGuardAsyncErrorHandler(
    error: unknown,
    options: IGuardAsyncOptions,
) {
    if (!options.onError) {
        return;
    }

    try {
        options.onError(error);
    } catch (onErrorError) {
        BrowserLogger.debug(
            options.scope,
            'Async guard onError handler failed',
            onErrorError,
        );
    }
}

function logGuardAsyncError(
    error: unknown,
    options: IGuardAsyncOptions,
) {
    if (isExpectedCancellation(error, options)) {
        BrowserLogger.debug(options.scope, options.message, {
            category: options.category,
            canceled: true,
            error,
        });
        return;
    }

    if (options.category === 'background-diagnostic') {
        // Console captures often serialize Error instances as `{}`; keep the
        // message as a plain string so the diagnostic stays readable there.
        BrowserLogger.warn(options.scope, options.message, {
            category: options.category,
            errorMessage: getErrorMessage(error),
            error,
        });
        return;
    }

    BrowserLogger.error(options.scope, options.message, {
        category: options.category,
        error,
    }, {
        code: 'RENDERER_ASYNC_GUARD_FAILED',
        context: {category: options.category},
    });
}

export function guardAsync(
    promise: Promise<unknown>,
    options: IGuardAsyncOptions,
) {
    void promise.catch((error) => {
        runGuardAsyncErrorHandler(error, options);
        logGuardAsyncError(error, options);
    });
}

export function runGuardedTask(
    task: () => Promise<unknown>,
    options: IGuardAsyncOptions,
) {
    try {
        guardAsync(task(), options);
    } catch (error) {
        runGuardAsyncErrorHandler(error, options);
        logGuardAsyncError(error, options);
    }
}

/** Runs intentionally unawaited work while keeping failures inside its owning subsystem. */
export function runDetached(
    task: () => Promise<unknown>,
    options: IGuardAsyncOptions,
): Promise<void> {
    let pending: Promise<unknown>;
    try {
        pending = task();
    } catch (error) {
        runGuardAsyncErrorHandler(error, options);
        logGuardAsyncError(error, options);
        return Promise.resolve();
    }

    return pending.then(
        () => undefined,
        (error) => {
            runGuardAsyncErrorHandler(error, options);
            logGuardAsyncError(error, options);
        },
    );
}
