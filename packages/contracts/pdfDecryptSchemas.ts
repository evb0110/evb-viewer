import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';

/** Request to decrypt a PDF working copy; the password is never stored. */
export interface IPdfDecryptRequest {password?: string;}

export interface IPdfDecryptResult {
    outcome: TPdfDecryptOutcome;
    wasEncrypted: boolean;
    /** Standard security handler revision that was decrypted, when known. */
    revision: number | null;
}

/** Outcome values the app can receive from the native/wasm decrypt operation. */
export const PDF_DECRYPT_OUTCOMES = [
    'opened',
    'rewritten',
    'needs-password',
    'unsupported-encryption',
] as const;
/**
 * Outcome of the native/wasm decrypt operation as the app sees it:
 * `opened` for a file that needed no password and no rewrite, `rewritten` for
 * a decrypted working copy, plus failures from the native error codes.
 */
export type TPdfDecryptOutcome = typeof PDF_DECRYPT_OUTCOMES[number];
/** Failures that the document-open caller can present to the user. */
export type TPdfDecryptFailureOutcome = Extract<
    TPdfDecryptOutcome,
    'needs-password' | 'unsupported-encryption'
>;

/** Leave room for the newline used to preserve passwords ending in a newline. */
export const PDF_DECRYPT_PASSWORD_MAX_BYTES = 4 * 1024 - 1;

export function isPdfDecryptPassword(value: unknown): value is string {
    return typeof value === 'string'
        && new TextEncoder().encode(value).byteLength <= PDF_DECRYPT_PASSWORD_MAX_BYTES;
}

export function isPdfDecryptOutcome(value: unknown): value is TPdfDecryptOutcome {
    return typeof value === 'string' && isOneOf(PDF_DECRYPT_OUTCOMES, value);
}

export function isPdfDecryptRequest(value: unknown): value is IPdfDecryptRequest {
    return value === undefined
        || (isRecord(value) && (value.password === undefined || isPdfDecryptPassword(value.password)));
}

/** Runtime guard for the decrypt result shared by the CLI and the wasm entry. */
export function isPdfDecryptResult(value: unknown): value is IPdfDecryptResult {
    if (!isRecord(value)
        || !isPdfDecryptOutcome(value.outcome)
        || typeof value.wasEncrypted !== 'boolean'
        || !(value.revision === null
            || (typeof value.revision === 'number'
                && Number.isSafeInteger(value.revision)
                && value.revision > 0))) {
        return false;
    }
    if (value.outcome === 'opened') {
        return value.wasEncrypted === false && value.revision === null;
    }
    if (value.outcome === 'rewritten') {
        return value.wasEncrypted === true
            && typeof value.revision === 'number'
            && Number.isSafeInteger(value.revision)
            && value.revision > 0;
    }
    return value.wasEncrypted === true && value.revision === null;
}
