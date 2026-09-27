import {createHash} from 'node:crypto';
import {
    isAbsolute,
    dirname,
} from 'node:path';
import {
    isBrowserStoreFileIdentity,
    TYPED_STAGED_ARTIFACT_SCHEMA,
} from '@contracts/stagedArtifacts';
import {nativePdfSemanticScope} from '@contracts/nativePdfSemanticScope';

import * as v from 'valibot';

const PDF_OBJECT_REF_PATTERN = /^\d+ \d+ R$/u;
const MAX_CHANGED_OBJECT_REFS = 128;

const positiveSafeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const absolutePathSchema = v.pipe(v.string(), v.check(isAbsolute));
const stagedArtifactSchema = TYPED_STAGED_ARTIFACT_SCHEMA;
const commitRequestSchema = v.pipe(v.object({
    type: v.literal('commit'),
    sourcePath: absolutePathSchema,
    targetPath: absolutePathSchema,
    expectedBytes: positiveSafeIntegerSchema,
    validationBinary: v.optional(absolutePathSchema),
    changedObjectRefs: v.optional(v.pipe(
        v.array(v.pipe(v.string(), v.regex(PDF_OBJECT_REF_PATTERN))),
        v.maxLength(MAX_CHANGED_OBJECT_REFS),
    )),
    stagedArtifact: v.optional(stagedArtifactSchema),
    validateOnly: v.optional(v.literal(true)),
}),
v.check(({
    sourcePath,
    targetPath,
    expectedBytes,
    stagedArtifact,
}) => (
    dirname(sourcePath) === dirname(targetPath)
    && sourcePath !== targetPath
    && (stagedArtifact === undefined
        || stagedArtifact.path === sourcePath && stagedArtifact.size === expectedBytes)
)),
// Keep optional protocol keys absent when in-process callers supply undefined.
v.transform(({
    type,
    sourcePath,
    targetPath,
    expectedBytes,
    validationBinary,
    changedObjectRefs,
    stagedArtifact,
    validateOnly,
}) => ({
    type,
    sourcePath,
    targetPath,
    expectedBytes,
    ...(validationBinary === undefined ? {} : {validationBinary}),
    ...(changedObjectRefs === undefined ? {} : {changedObjectRefs}),
    ...(stagedArtifact === undefined ? {} : {stagedArtifact}),
    ...(validateOnly === undefined ? {} : {validateOnly}),
})));
const inspectRequestSchema = v.object({
    type: v.literal('inspect'),
    sourcePath: absolutePathSchema,
    expectedBytes: positiveSafeIntegerSchema,
});
const documentSaveUtilityRequestSchema = v.variant('type', [
    inspectRequestSchema,
    commitRequestSchema,
]);

export type IDocumentSaveUtilityCommitRequest = Extract<
    v.InferOutput<typeof documentSaveUtilityRequestSchema>,
    {type: 'commit'}
>;
export type IDocumentSaveUtilityInspectRequest = Extract<
    v.InferOutput<typeof documentSaveUtilityRequestSchema>,
    {type: 'inspect'}
>;
export type TDocumentSaveUtilityRequest = v.InferOutput<typeof documentSaveUtilityRequestSchema>;

const shutdownRequestSchema = v.object({
    type: v.literal('shutdown'),
    requestId: v.pipe(v.string(), v.minLength(1)),
});
const shutdownResultSchema = v.object({
    type: v.literal('shutdown-complete'),
    requestId: v.pipe(v.string(), v.minLength(1)),
    terminated: v.boolean(),
});
export type IDocumentSaveUtilityShutdownRequest = v.InferOutput<typeof shutdownRequestSchema>;
export type IDocumentSaveUtilityShutdownResult = v.InferOutput<typeof shutdownResultSchema>;

export interface IDocumentSaveUtilityReusePlan {
    fingerprint: boolean;
    tailCheck: boolean;
    qpdfCheck: boolean;
    nativeIncrementalCheck: boolean;
    changedObjectRefsCheck: boolean;
    fileSync: boolean;
}

const documentSaveUtilityResultSchema = v.variant('ok', [
    v.object({
        type: v.literal('result'),
        ok: v.literal(true),
        bytes: positiveSafeIntegerSchema,
        sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
    }),
    v.object({
        type: v.literal('result'),
        ok: v.literal(false),
        error: v.string(),
    }),
]);
export type TDocumentSaveUtilityResult = v.InferOutput<typeof documentSaveUtilityResultSchema>;

export function decodeDocumentSaveUtilityRequest(value: unknown): TDocumentSaveUtilityRequest | null {
    const result = v.safeParse(documentSaveUtilityRequestSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

export function createChangedObjectRefsSha256(changedObjectRefs: readonly string[]) {
    const normalizedRefs = [...new Set(changedObjectRefs)].sort();
    return createHash('sha256')
        .update(JSON.stringify(normalizedRefs))
        .digest('hex');
}

export function createNativeIncrementalMutationSemanticScopeSha256() {
    return nativePdfSemanticScope;
}

export function getDocumentSaveUtilityReusePlan(
    request: IDocumentSaveUtilityCommitRequest,
): IDocumentSaveUtilityReusePlan {
    const artifact = request.stagedArtifact;
    if (artifact && isBrowserStoreFileIdentity(artifact.fileIdentity)) {
        return {
            fingerprint: false,
            tailCheck: false,
            qpdfCheck: false,
            nativeIncrementalCheck: false,
            changedObjectRefsCheck: false,
            fileSync: false,
        };
    }
    const receiptReuseEnabled = process.platform !== 'win32'
        && artifact?.receiptVersion === 1
        && artifact.fileIdentity.platform === 'posix';
    const changedObjectRefs = request.changedObjectRefs ?? [];
    const nativeIncrementalCheck = receiptReuseEnabled
        && artifact.validations.semanticCheck === true
        && artifact.validations.semanticScopeSha256
            === createNativeIncrementalMutationSemanticScopeSha256();
    return {
        fingerprint: receiptReuseEnabled,
        tailCheck: receiptReuseEnabled && artifact.validations.tailCheck === true,
        qpdfCheck: receiptReuseEnabled && artifact.validations.qpdfCheck === true,
        nativeIncrementalCheck,
        changedObjectRefsCheck: receiptReuseEnabled
            && changedObjectRefs.length > 0
            && artifact.validations.changedObjectRefsSha256
                === createChangedObjectRefsSha256(changedObjectRefs),
        fileSync: receiptReuseEnabled && artifact.validations.fsynced === true,
    };
}

export function decodeDocumentSaveUtilityResult(value: unknown): TDocumentSaveUtilityResult | null {
    const result = v.safeParse(documentSaveUtilityResultSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

export function decodeDocumentSaveUtilityShutdownResult(value: unknown): IDocumentSaveUtilityShutdownResult | null {
    const result = v.safeParse(shutdownResultSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

export function decodeDocumentSaveUtilityShutdownRequest(value: unknown): IDocumentSaveUtilityShutdownRequest | null {
    const result = v.safeParse(shutdownRequestSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}
