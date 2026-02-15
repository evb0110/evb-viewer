import { BrowserLogger } from '@app/utils/browser-logger';

export interface IGuardAsyncOptions {
    scope: string;
    message: string;
    onError?: (error: unknown) => void;
}

export function guardAsync(
    promise: Promise<unknown>,
    options: IGuardAsyncOptions,
) {
    const {
        scope,
        message,
        onError,
    } = options;

    void promise.catch((error) => {
        if (onError) {
            try {
                onError(error);
            } catch (onErrorError) {
                BrowserLogger.debug(
                    scope,
                    'Async guard onError handler failed',
                    onErrorError,
                );
            }
        }
        BrowserLogger.error(scope, message, error);
    });
}

export function runGuardedTask(
    task: () => Promise<unknown>,
    options: IGuardAsyncOptions,
) {
    try {
        guardAsync(task(), options);
    } catch (error) {
        if (options.onError) {
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
        BrowserLogger.error(options.scope, options.message, error);
    }
}
