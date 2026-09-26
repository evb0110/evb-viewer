import * as v from 'valibot';

/** Leave room for the newline used to preserve passwords ending in a newline. */
export const PDF_DECRYPT_PASSWORD_MAX_BYTES = 4 * 1024 - 1;

export const PDF_DECRYPT_OUTCOMES = [
    'opened',
    'rewritten',
    'needs-password',
    'unsupported-encryption',
] as const;

export const PDF_DECRYPT_PASSWORD_SCHEMA = v.pipe(
    v.string(),
    v.check(value => new TextEncoder().encode(value).byteLength <= PDF_DECRYPT_PASSWORD_MAX_BYTES),
);
export const PDF_DECRYPT_REQUEST_SCHEMA = v.optional(v.object({password: v.optional(PDF_DECRYPT_PASSWORD_SCHEMA)}));
export const PDF_DECRYPT_OUTCOME_SCHEMA = v.picklist(PDF_DECRYPT_OUTCOMES);
export const PDF_DECRYPT_RESULT_SCHEMA = v.pipe(
    v.object({
        outcome: PDF_DECRYPT_OUTCOME_SCHEMA,
        wasEncrypted: v.boolean(),
        revision: v.nullable(v.pipe(v.number(), v.finite(), v.safeInteger(), v.minValue(1))),
    }),
    v.check(({
        outcome, wasEncrypted, revision,
    }) => {
        if (outcome === 'opened') return !wasEncrypted && revision === null;
        if (outcome === 'rewritten') return wasEncrypted && revision !== null;
        return wasEncrypted && revision === null;
    }),
);

export type IPdfDecryptRequest = v.InferOutput<typeof PDF_DECRYPT_REQUEST_SCHEMA>;
export type IPdfDecryptResult = v.InferOutput<typeof PDF_DECRYPT_RESULT_SCHEMA>;
export type TPdfDecryptOutcome = v.InferOutput<typeof PDF_DECRYPT_OUTCOME_SCHEMA>;
export type TPdfDecryptFailureOutcome = Extract<TPdfDecryptOutcome, 'needs-password' | 'unsupported-encryption'>;

export const isPdfDecryptPassword = (value: unknown): value is string =>
    v.is(PDF_DECRYPT_PASSWORD_SCHEMA, value);
export const isPdfDecryptOutcome = (value: unknown): value is TPdfDecryptOutcome =>
    v.is(PDF_DECRYPT_OUTCOME_SCHEMA, value);
export const isPdfDecryptRequest = (value: unknown): value is IPdfDecryptRequest =>
    v.is(PDF_DECRYPT_REQUEST_SCHEMA, value);
export const isPdfDecryptResult = (value: unknown): value is IPdfDecryptResult =>
    v.is(PDF_DECRYPT_RESULT_SCHEMA, value);
