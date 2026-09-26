import {
    isBrowserLegacyDocumentRef,
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {PDF_VALIDATION_RESULT_SCHEMA} from '@contracts/pdfConformance';
import {
    parseLeaseId,
    type TLeaseId,
} from '@contracts/shared';
import * as v from 'valibot';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DECIMAL_BIGINT_PATTERN = /^(?:0|[1-9]\d*)$/u;
const BROWSER_DOCUMENT_REF_PREFIX = 'browser://documents/';
const BROWSER_DOCUMENT_REF_MAX_LENGTH = 32_768;
const BROWSER_REVISION_TOKEN_MAX_LENGTH = 512;

const documentRefSchema = v.pipe(
    v.string(),
    v.check(value => parseDocumentRef(value) !== null),
    v.transform(value => parseDocumentRef(value) as TDocumentRef),
);
const browserDocumentRefSchema = v.pipe(
    v.string(),
    v.maxLength(BROWSER_DOCUMENT_REF_MAX_LENGTH),
    v.check(value => value !== BROWSER_DOCUMENT_REF_PREFIX && isBrowserLegacyDocumentRef(value)),
    v.transform(value => parseDocumentRef(value) as TDocumentRef),
);
const documentRevisionTokenSchema = v.pipe(
    v.string(),
    v.maxLength(BROWSER_REVISION_TOKEN_MAX_LENGTH),
    v.check(value => parseDocumentRevisionToken(value) !== null),
    v.transform(value => parseDocumentRevisionToken(value) as TDocumentRevisionToken),
);
const leaseIdSchema = v.pipe(
    v.string(),
    v.check(value => parseLeaseId(value) !== null),
    v.transform(value => parseLeaseId(value) as TLeaseId),
);
const sha256Schema = v.pipe(v.string(), v.regex(SHA256_PATTERN));
const nonNegativeSizeSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

const posixFileIdentitySchema = v.object({
    platform: v.literal('posix'),
    deviceId: v.pipe(v.string(), v.regex(DECIMAL_BIGINT_PATTERN)),
    inode: v.pipe(v.string(), v.regex(DECIMAL_BIGINT_PATTERN)),
});
const win32FileIdentitySchema = v.object({
    platform: v.literal('win32'),
    volumeId: v.pipe(v.string(), v.minLength(1)),
    fileId: v.pipe(v.string(), v.minLength(1)),
});
const browserStoreFileIdentitySchema = v.object({
    platform: v.literal('browser'),
    documentRef: browserDocumentRefSchema,
    revisionToken: documentRevisionTokenSchema,
});
const nativeFileIdentitySchema = v.union([
    posixFileIdentitySchema,
    win32FileIdentitySchema,
]);
const fileIdentitySchema = v.variant('platform', [
    posixFileIdentitySchema,
    win32FileIdentitySchema,
    browserStoreFileIdentitySchema,
]);

const stagedArtifactValidationsSchema = v.pipe(
    v.object({
        qpdfCheck: v.boolean(),
        tailCheck: v.boolean(),
        semanticCheck: v.boolean(),
        fsynced: v.boolean(),
        qpdfResult: v.exactOptional(PDF_VALIDATION_RESULT_SCHEMA),
        semanticScopeSha256: v.exactOptional(sha256Schema),
        changedObjectRefsSha256: v.exactOptional(sha256Schema),
    }),
    v.check(value =>
        (value.qpdfResult === undefined || value.qpdfResult.tool === 'qpdf')
        && (!value.qpdfCheck || value.qpdfResult?.isValid === true)
        && (!value.semanticCheck || value.semanticScopeSha256 !== undefined),
    ),
);

const stagedArtifactBaseShape = {
    artifactKind: v.literal('pdf'),
    path: documentRefSchema,
    size: nonNegativeSizeSchema,
    validations: stagedArtifactValidationsSchema,
    leaseId: leaseIdSchema,
};

const contentFingerprintStagedArtifactSchema = v.pipe(
    v.object({
        ...stagedArtifactBaseShape,
        receiptVersion: v.literal(1),
        sha256: sha256Schema,
        fileIdentity: fileIdentitySchema,
        revision: v.nullable(documentRevisionTokenSchema),
    }),
    v.check(value => value.fileIdentity.platform !== 'browser' || (
        value.fileIdentity.documentRef === value.path
        && value.revision !== null
        && value.fileIdentity.revisionToken === value.revision
    )),
);

const browserStoreStagedArtifactSchema = v.pipe(
    v.object({
        ...stagedArtifactBaseShape,
        receiptVersion: v.literal(1),
        sha256: sha256Schema,
        fileIdentity: browserStoreFileIdentitySchema,
        revision: documentRevisionTokenSchema,
    }),
    v.check(value =>
        value.fileIdentity.documentRef === value.path
        && value.fileIdentity.revisionToken === value.revision,
    ),
);

/** A native output authorized by its lease's file identity and private stat witness. */
const opaqueNativeStagedArtifactSchema = v.pipe(
    v.object({
        ...stagedArtifactBaseShape,
        receiptVersion: v.literal(2),
        sha256: v.exactOptional(v.undefined()),
        fileIdentity: nativeFileIdentitySchema,
        revision: v.nullable(documentRevisionTokenSchema),
    }),
    v.transform(({
        sha256: _sha256, ...artifact
    }) => artifact),
);

export const TYPED_STAGED_ARTIFACT_SCHEMA = v.union([
    contentFingerprintStagedArtifactSchema,
    opaqueNativeStagedArtifactSchema,
]);

export type TArtifactFileIdentity = v.InferOutput<typeof fileIdentitySchema>;
export type IBrowserStoreFileIdentity = v.InferOutput<typeof browserStoreFileIdentitySchema>;
export type IStagedArtifactValidations = v.InferOutput<typeof stagedArtifactValidationsSchema>;
export type IContentFingerprintStagedArtifact = v.InferOutput<typeof contentFingerprintStagedArtifactSchema>;
export type IOpaqueNativeStagedArtifact = v.InferOutput<typeof opaqueNativeStagedArtifactSchema>;
export type ITypedStagedArtifact = v.InferOutput<typeof TYPED_STAGED_ARTIFACT_SCHEMA>;
export type TBrowserStoreStagedArtifact = v.InferOutput<typeof browserStoreStagedArtifactSchema>;

export function isBrowserStoreFileIdentity(value: unknown): value is IBrowserStoreFileIdentity {
    return v.is(browserStoreFileIdentitySchema, value);
}

export function createBrowserStoreFileIdentity(
    documentRef: TDocumentRef,
    revisionToken: TDocumentRevisionToken,
): IBrowserStoreFileIdentity {
    const identity = v.safeParse(browserStoreFileIdentitySchema, {
        platform: 'browser',
        documentRef,
        revisionToken,
    }, {abortEarly: true});
    if (!identity.success) {
        throw new TypeError('Browser staged artifact identity requires a browser document ref and revision token');
    }
    return identity.output;
}

export function isTypedStagedArtifact(value: unknown): value is ITypedStagedArtifact {
    return v.is(TYPED_STAGED_ARTIFACT_SCHEMA, value);
}

export function isBrowserStoreStagedArtifact(value: unknown): value is TBrowserStoreStagedArtifact {
    return v.is(browserStoreStagedArtifactSchema, value);
}
