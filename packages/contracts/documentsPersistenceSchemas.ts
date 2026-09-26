import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import {normalizePdfNativeAnnotationIdentityBindings} from '@contracts/nativePdfMutations';
import {TYPED_STAGED_ARTIFACT_SCHEMA} from '@contracts/stagedArtifacts';
import * as v from 'valibot';

const pdfObjectRefPattern = /^\d+\s+\d+\s+R$/u;
const documentRevisionTokenSchema = v.pipe(
    v.string(),
    v.check(value => parseDocumentRevisionToken(value) !== null, 'invalid document revision options'),
    // Brand the normalized token returned at this persistence boundary.
    v.transform(value => parseDocumentRevisionToken(value) as NonNullable<ReturnType<typeof parseDocumentRevisionToken>>),
);
const changedObjectRefsSchema = v.pipe(
    v.unknown(),
    v.check(
        value => Array.isArray(value) && value.length <= 128,
        'invalid changed PDF object references',
    ),
    v.array(v.pipe(v.string(), v.regex(pdfObjectRefPattern)), 'invalid changed PDF object references'),
    v.transform(refs => [...new Set(refs)]),
);

const revisionOptionsShape = {
    expectedDocumentRevisionToken: documentRevisionTokenSchema,
    changedObjectRefs: v.exactOptional(changedObjectRefsSchema),
    workingCopyOnly: v.exactOptional(v.literal(true)),
};

export const PDF_REVISION_OPTIONS_SCHEMA = v.pipe(
    v.object(revisionOptionsShape),
    v.transform(({
        expectedDocumentRevisionToken, changedObjectRefs, workingCopyOnly,
    }) => ({
        expectedDocumentRevisionToken,
        ...(changedObjectRefs?.length ? {changedObjectRefs} : {}),
        ...(workingCopyOnly === true ? {workingCopyOnly: true as const} : {}),
    })),
);

export const PDF_SAVE_AS_OPTIONS_SCHEMA = v.object({
    optimizeLossless: v.exactOptional(v.boolean()),
    stagedOutput: v.exactOptional(v.message(TYPED_STAGED_ARTIFACT_SCHEMA, 'invalid PDF save-as staged output')),
});

const identityBindingsSchema = v.pipe(
    v.unknown(),
    // Native mutation identity bindings require canonical identity and reference checks.
    v.transform(value => normalizePdfNativeAnnotationIdentityBindings(
        value,
        'revisionOptions.identityBindings',
        {errorKind: 'error'},
    )),
);

export const PDF_NATIVE_STAGED_COMMIT_OPTIONS_SCHEMA = v.pipe(
    v.object({
        ...revisionOptionsShape,
        identityBindings: v.exactOptional(identityBindingsSchema),
    }),
    v.transform(({
        expectedDocumentRevisionToken, changedObjectRefs, workingCopyOnly, identityBindings,
    }) => ({
        expectedDocumentRevisionToken,
        ...(changedObjectRefs?.length ? {changedObjectRefs} : {}),
        ...(workingCopyOnly === true ? {workingCopyOnly: true as const} : {}),
        ...(identityBindings === undefined ? {} : {identityBindings}),
    })),
);

export const PDF_SAVE_AS_WARNING_SCHEMA = v.object({
    reason: v.literal('working-copy-sync-required'),
    message: v.string(),
});

export type IPdfSerializedSaveOptions = v.InferOutput<typeof PDF_REVISION_OPTIONS_SCHEMA>;
export type IPdfNativeStagedCommitOptions = v.InferOutput<typeof PDF_NATIVE_STAGED_COMMIT_OPTIONS_SCHEMA>;
export type IPdfSaveAsOptions = v.InferOutput<typeof PDF_SAVE_AS_OPTIONS_SCHEMA>;
export type IPdfSaveAsWarning = v.InferOutput<typeof PDF_SAVE_AS_WARNING_SCHEMA>;
