import {
    parseDocumentRef, type TDocumentRef,
} from '@contracts/documentRef';
import type {TOpenFileResult} from '@contracts/electronApiDocuments';
import {runtimeSchema as s} from '@contracts/platformFeature';
import * as v from 'valibot';

const documentRefSchema = v.custom<TDocumentRef>(value => parseDocumentRef(value) !== null);

export const openFileResultSchema = v.nullable(v.variant('kind', [
    v.object({
        kind: v.literal('pdf'),
        workingPath: documentRefSchema,
        originalPath: documentRefSchema,
        isGenerated: v.optional(v.boolean()),
        recoveryDirtyBaseline: v.optional(v.boolean()),
        wasEncrypted: v.optional(v.literal(true)),
    }),
    v.object({
        kind: v.literal('djvu'),
        workingPath: v.literal(''),
        originalPath: documentRefSchema,
    }),
    v.object({
        kind: v.literal('pdf-needs-password'),
        originalPath: documentRefSchema,
    }),
    v.object({
        kind: v.literal('pdf-unsupported-encryption'),
        originalPath: documentRefSchema,
    }),
]));

export function decodeOpenFileResult(value: unknown): TOpenFileResult | null {
    const result = v.safeParse(openFileResultSchema, value, {abortEarly: true});
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
    return result.output as TOpenFileResult | null;
}

export const openFileResult = s.fromParser(decodeOpenFileResult, () => null);
