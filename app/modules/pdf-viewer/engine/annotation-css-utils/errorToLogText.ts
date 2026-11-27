import {getErrorMessage} from '@app/utils/error';

export function errorToLogText(error: unknown) {
    const message =
        error instanceof Error
            ? getErrorMessage(error)
            : typeof error === 'string'
              ? error
              : (() => {
                    try {
                        return JSON.stringify(error);
                    } catch {
                        return String(error);
                    }
                })();
    const stack = error instanceof Error ? (error.stack ?? '') : '';
    return stack ? `${message}\n${stack}` : message;
}
