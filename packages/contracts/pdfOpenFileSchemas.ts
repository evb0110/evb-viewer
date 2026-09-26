import {parseDocumentRef} from '@contracts/documentRef';
import type {TDocumentRef} from '@contracts/documentRef';
import {runtimeSchema as s} from '@contracts/platformFeature';
import * as v from 'valibot';

const documentRefSchema = v.custom<TDocumentRef>(value => parseDocumentRef(value) !== null);
const openPdfResultSchema = v.object({
    kind: v.literal('pdf'),
    workingPath: documentRefSchema,
    originalPath: documentRefSchema,
    isGenerated: v.optional(v.boolean()),
    recoveryDirtyBaseline: v.optional(v.boolean()),
    wasEncrypted: v.optional(v.literal(true)),
});
const openDjvuResultSchema = v.object({
    kind: v.literal('djvu'),
    workingPath: v.literal(''),
    originalPath: documentRefSchema,
});
const needsPasswordResultSchema = v.object({
    kind: v.literal('pdf-needs-password'),
    originalPath: documentRefSchema,
});
const unsupportedEncryptionResultSchema = v.object({
    kind: v.literal('pdf-unsupported-encryption'),
    originalPath: documentRefSchema,
});

export const OPEN_FILE_RESULT_SCHEMA = v.nullable(v.variant('kind', [
    openPdfResultSchema,
    openDjvuResultSchema,
    needsPasswordResultSchema,
    unsupportedEncryptionResultSchema,
]));

export type TOpenFileResult = NonNullable<v.InferOutput<typeof OPEN_FILE_RESULT_SCHEMA>>;
export type IOpenPdfResult = Extract<TOpenFileResult, {kind: 'pdf'}>;
export type IOpenDjvuResult = Extract<TOpenFileResult, {kind: 'djvu'}>;
export type IPdfNeedsPasswordResult = Extract<TOpenFileResult, {kind: 'pdf-needs-password'}>;
export type IPdfUnsupportedEncryptionResult = Extract<TOpenFileResult, {kind: 'pdf-unsupported-encryption'}>;
export type TPdfOpenFileFailureResult = IPdfNeedsPasswordResult | IPdfUnsupportedEncryptionResult;

export function decodeOpenFileResult(value: unknown): TOpenFileResult | null {
    const result = v.safeParse(OPEN_FILE_RESULT_SCHEMA, value, {abortEarly: true});
    if (!result.success) {
        const kind = typeof value === 'object' && value !== null && 'kind' in value
            ? value.kind
            : undefined;
        throw new Error(kind === 'pdf-needs-password' || kind === 'pdf-unsupported-encryption'
            ? 'invalid encrypted PDF open-file result'
            : kind === 'djvu'
                ? 'invalid DjVu open-file result'
                : kind === 'pdf'
                    ? 'invalid PDF open-file result'
                    : 'invalid open-file result');
    }
    return result.output;
}

// Preserve the variant-specific legacy errors for callers of the shared document codec.
export const openFileResult = s.fromParser(decodeOpenFileResult, () => null);
