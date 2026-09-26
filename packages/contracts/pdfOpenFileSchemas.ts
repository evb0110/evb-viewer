import {parseDocumentRef} from '@contracts/documentRef';
import type {TDocumentRef} from '@contracts/documentRef';
import {isRecord} from '@contracts/runtimeGuards';
import * as v from 'valibot';

const documentRefSchema = v.custom<TDocumentRef>(value => parseDocumentRef(value) !== null);
const openPdfResultSchema = v.object({
    kind: v.literal('pdf'),
    workingPath: documentRefSchema,
    originalPath: documentRefSchema,
    isGenerated: v.exactOptional(v.boolean()),
    recoveryDirtyBaseline: v.exactOptional(v.boolean()),
    wasEncrypted: v.exactOptional(v.literal(true)),
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

const openFileResultDataSchema = v.nullable(v.variant('kind', [
    openPdfResultSchema,
    openDjvuResultSchema,
    needsPasswordResultSchema,
    unsupportedEncryptionResultSchema,
]));

// Preserve the existing variant-specific IPC errors while Valibot validates each result shape.
export const OPEN_FILE_RESULT_SCHEMA = v.pipe(
    v.unknown(),
    v.transform((value) => {
        const result = v.safeParse(openFileResultDataSchema, value, {abortEarly: true});
        if (result.success) {
            return result.output;
        }
        const kind = isRecord(value) ? value.kind : undefined;
        const message = kind === 'pdf-needs-password' || kind === 'pdf-unsupported-encryption'
            ? 'invalid encrypted PDF open-file result'
            : kind === 'djvu'
                ? 'invalid DjVu open-file result'
                : kind === 'pdf'
                    ? 'invalid PDF open-file result'
                    : 'invalid open-file result';
        throw new Error(message);
    }),
);

export type TOpenFileResult = NonNullable<v.InferOutput<typeof OPEN_FILE_RESULT_SCHEMA>>;
export type IOpenPdfResult = Extract<TOpenFileResult, {kind: 'pdf'}>;
export type IOpenDjvuResult = Extract<TOpenFileResult, {kind: 'djvu'}>;
export type IPdfNeedsPasswordResult = Extract<TOpenFileResult, {kind: 'pdf-needs-password'}>;
export type IPdfUnsupportedEncryptionResult = Extract<TOpenFileResult, {kind: 'pdf-unsupported-encryption'}>;
export type TPdfOpenFileFailureResult = IPdfNeedsPasswordResult | IPdfUnsupportedEncryptionResult;
