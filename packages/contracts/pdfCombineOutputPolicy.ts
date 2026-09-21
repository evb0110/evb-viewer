import {isNativeErrorEnvelope} from '@contracts/nativeErrors';
import {
    findSerializableErrorEnvelope,
    SerializableError,
} from '@contracts/serializableError';

/**
 * The maximum number of bytes a PDF image combiner may return as one value.
 * A validated file-backed output path has a separate resource budget because
 * it does not cross the byte-returning transport boundary.
 */
export const PDF_COMBINE_OUTPUT_POLICY = Object.freeze({
    maxBytes: 16 * 1024 * 1024,
    tooLargeCode: 'too-large',
});

export const PDF_COMBINE_MAX_OUTPUT_BYTES = PDF_COMBINE_OUTPUT_POLICY.maxBytes;

export function normalizePdfCombineOutputLimit(value: number | undefined) {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 1
        ? Math.min(value, PDF_COMBINE_MAX_OUTPUT_BYTES)
        : PDF_COMBINE_MAX_OUTPUT_BYTES;
}

export function createPdfCombineOutputTooLargeError() {
    return new SerializableError({
        code: PDF_COMBINE_OUTPUT_POLICY.tooLargeCode,
        message: `Combined PDF output is too large to return safely (shared ${PDF_COMBINE_MAX_OUTPUT_BYTES / (1024 * 1024)}MiB PDF combine cap)`,
    });
}

export function isPdfCombineOutputTooLargeError(error: unknown) {
    const envelope = findSerializableErrorEnvelope(error, isNativeErrorEnvelope);
    return envelope?.code === PDF_COMBINE_OUTPUT_POLICY.tooLargeCode;
}
