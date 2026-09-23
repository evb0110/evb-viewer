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

/** Native output mode for a combine that writes a file path and never returns its bytes. */
export const PDF_COMBINE_FILE_BACKED_OUTPUT_MODE = 'file-backed';

/**
 * Environment for a native combine whose output stays a file. The byte cap
 * above protects values returned into JavaScript; outside file-backed mode the
 * combiner clamps any larger cap back to it, so a file writer that omits the
 * mode fails on ordinary book-length output. Disk admission, not this cap,
 * bounds such a file unless the caller has a budget of its own.
 */
export function createFileBackedPdfCombineEnv({
    maxPages,
    maxOutputBytes = Number.MAX_SAFE_INTEGER,
}: {
    maxPages: number;
    maxOutputBytes?: number;
}) {
    return {
        EVB_PDF_COMBINE_MAX_PAGES: String(Math.max(maxPages, 1)),
        EVB_PDF_COMBINE_MAX_OUTPUT_BYTES: String(maxOutputBytes),
        EVB_PDF_COMBINE_OUTPUT_MODE: PDF_COMBINE_FILE_BACKED_OUTPUT_MODE,
    };
}

export function normalizePdfCombineOutputLimit(value: number | undefined) {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 1
        ? Math.min(value, PDF_COMBINE_MAX_OUTPUT_BYTES)
        : PDF_COMBINE_MAX_OUTPUT_BYTES;
}

/**
 * A combine refused by a size limit. Byte-returning callers report the shared
 * cap; a file-backed caller passes the native reason, since its refusal comes
 * from a page, pixel or output ceiling rather than from that cap.
 */
export function createPdfCombineOutputTooLargeError(
    message = `Combined PDF output is too large to return safely (shared ${PDF_COMBINE_MAX_OUTPUT_BYTES / (1024 * 1024)}MiB PDF combine cap)`,
) {
    return new SerializableError({
        code: PDF_COMBINE_OUTPUT_POLICY.tooLargeCode,
        message,
    });
}

export function isPdfCombineOutputTooLargeError(error: unknown) {
    const envelope = findSerializableErrorEnvelope(error, isNativeErrorEnvelope);
    return envelope?.code === PDF_COMBINE_OUTPUT_POLICY.tooLargeCode;
}
