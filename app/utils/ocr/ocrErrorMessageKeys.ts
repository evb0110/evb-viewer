import type { TTranslationKey } from '@i18n-app';
import type { TOcrErrorCode } from '@contracts/electronApiOcr';

export const ocrErrorMessageKeys = [
    'errors.file.invalid',
    'errors.ocr.loadLanguages',
    'errors.ocr.noLanguages',
    'errors.ocr.noValidPages',
    'errors.ocr.timeout',
    'errors.ocr.start',
    'errors.ocr.noPdfData',
    'errors.ocr.createSearchablePdf',
    'errors.ocr.noText',
    'errors.ocr.exportDocx',
    'errors.ocr.cancel',
    'errors.ocr.alreadyRunning',
    'errors.ocr.disabled',
    'errors.ocr.noDocument',
    'errors.ocr.incomplete',
    'errors.ocr.errorCode.invalidPayload',
    'errors.ocr.errorCode.internal',
    'errors.ocr.errorCode.queueBackpressure',
    'errors.ocr.errorCode.workerUnavailable',
    'errors.ocr.errorCode.workerMessageError',
    'errors.ocr.errorCode.toolsValidationFailed',
] as const satisfies readonly TTranslationKey[];

export const ocrErrorCodeMessageKeys = {
    OCR_INVALID_PAYLOAD: 'errors.ocr.errorCode.invalidPayload',
    OCR_INTERNAL_ERROR: 'errors.ocr.errorCode.internal',
    OCR_QUEUE_BACKPRESSURE: 'errors.ocr.errorCode.queueBackpressure',
    OCR_WORKER_UNAVAILABLE: 'errors.ocr.errorCode.workerUnavailable',
    OCR_WORKER_MESSAGE_ERROR: 'errors.ocr.errorCode.workerMessageError',
    OCR_TOOLS_VALIDATION_FAILED: 'errors.ocr.errorCode.toolsValidationFailed',
} as const satisfies Record<TOcrErrorCode, TTranslationKey>;

export type TOcrErrorFallbackKey = (typeof ocrErrorMessageKeys)[number];
