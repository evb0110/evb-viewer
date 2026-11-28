import {BROWSER_QPDF_ENGINE_ERROR_CODES} from '@contracts/browserQpdfEngine';
import {SerializableError} from '@contracts/serializableError';
export {isBrowserFullReadTooLargeError} from '@app/platform/browser/browserDocumentReadError';

const BROWSER_FILE_PICKER_SETUP_DENIED_CODE = 'browser-file-picker-setup-denied';

export class BrowserFilePickerSetupDeniedError extends Error {
    public constructor() {
        super(BROWSER_FILE_PICKER_SETUP_DENIED_CODE);
        this.name = 'BrowserFilePickerSetupDeniedError';
    }
}

export function isBrowserFilePickerSetupDeniedError(error: unknown): error is BrowserFilePickerSetupDeniedError {
    return error instanceof BrowserFilePickerSetupDeniedError;
}

export class BrowserQpdfEngineTimeoutError extends Error {
    public constructor(public readonly timeoutMs: number) {
        super(`qpdf did not finish within ${timeoutMs}ms`);
        this.name = 'BrowserQpdfEngineTimeoutError';
    }
}

export class BrowserQpdfEngineUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserQpdfEngineUnavailableError';
    }
}

/** The engine could not be downloaded or started, so nothing judged the PDF. */
export function isBrowserQpdfEngineUnavailableError(error: unknown) {
    return (
        error instanceof BrowserQpdfEngineUnavailableError ||
        (error instanceof SerializableError && error.code === BROWSER_QPDF_ENGINE_ERROR_CODES.unavailable)
    );
}
