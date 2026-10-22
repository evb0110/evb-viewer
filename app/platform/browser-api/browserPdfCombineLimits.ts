import type {INativeErrorEnvelope} from '@contracts/nativeErrors';
import {SerializableError} from '@contracts/serializableError';

export function createBrowserPdfCombineOutputErrorEnvelope(): INativeErrorEnvelope {
    return {
        code: 'invalid-request',
        message: 'ERR_BROWSER_PDF_COMBINE_INVALID_OUTPUT',
    };
}

export function createBrowserPdfCombineOutputError() {
    return new SerializableError(createBrowserPdfCombineOutputErrorEnvelope());
}
