import {createHash} from 'node:crypto';
import {
    isAbsolute,
    dirname,
} from 'node:path';
import { isRecord } from '@contracts/runtimeGuards';
import {
    decodeTypedStagedArtifact,
    isBrowserStoreFileIdentity,
    type ITypedStagedArtifact,
} from '@contracts/stagedArtifacts';
import {nativePdfSemanticScope} from '@contracts/nativePdfSemanticScope';

export interface IDocumentSaveUtilityCommitRequest {
    type: 'commit';
    sourcePath: string;
    targetPath: string;
    expectedBytes: number;
    validationBinary?: string;
    changedObjectRefs?: string[];
    stagedArtifact?: ITypedStagedArtifact;
    validateOnly?: true;
}

export interface IDocumentSaveUtilityInspectRequest {
    type: 'inspect';
    sourcePath: string;
    expectedBytes: number;
}

export type TDocumentSaveUtilityRequest =
    | IDocumentSaveUtilityCommitRequest
    | IDocumentSaveUtilityInspectRequest;

const PDF_OBJECT_REF_PATTERN = /^\d+ \d+ R$/u;
const MAX_CHANGED_OBJECT_REFS = 128;

export interface IDocumentSaveUtilityReusePlan {
    fingerprint: boolean;
    tailCheck: boolean;
    qpdfCheck: boolean;
    nativeIncrementalCheck: boolean;
    changedObjectRefsCheck: boolean;
    fileSync: boolean;
}

export type TDocumentSaveUtilityResult =
    | {
        type: 'result';
        ok: true;
        bytes: number;
        sha256: string
    }
    | {
        type: 'result';
        ok: false;
        error: string
    };

export function decodeDocumentSaveUtilityRequest(value: unknown): TDocumentSaveUtilityRequest | null {
    if (isRecord(value)
        && value.type === 'inspect'
        && typeof value.sourcePath === 'string'
        && isAbsolute(value.sourcePath)
        && typeof value.expectedBytes === 'number'
        && Number.isSafeInteger(value.expectedBytes)
        && value.expectedBytes > 0) {
        return {
            type: 'inspect',
            sourcePath: value.sourcePath,
            expectedBytes: value.expectedBytes,
        };
    }
    if (!isRecord(value)
        || value.type !== 'commit'
        || typeof value.sourcePath !== 'string'
        || typeof value.targetPath !== 'string'
        || !isAbsolute(value.sourcePath)
        || !isAbsolute(value.targetPath)
        || dirname(value.sourcePath) !== dirname(value.targetPath)
        || value.sourcePath === value.targetPath
        || (value.validateOnly !== undefined && value.validateOnly !== true)
        || (value.validationBinary !== undefined && (typeof value.validationBinary !== 'string' || !isAbsolute(value.validationBinary)))
        || (value.changedObjectRefs !== undefined && (
            !Array.isArray(value.changedObjectRefs)
            || value.changedObjectRefs.length > MAX_CHANGED_OBJECT_REFS
            || !value.changedObjectRefs.every(ref => typeof ref === 'string' && PDF_OBJECT_REF_PATTERN.test(ref))
        ))
        || typeof value.expectedBytes !== 'number'
        || !Number.isSafeInteger(value.expectedBytes)
        || value.expectedBytes <= 0) {
        return null;
    }
    const stagedArtifact = value.stagedArtifact === undefined
        ? undefined
        : decodeTypedStagedArtifact(value.stagedArtifact);
    if (value.stagedArtifact !== undefined) {
        if (
            stagedArtifact === undefined
            || stagedArtifact === null
            || stagedArtifact.path !== value.sourcePath
            || stagedArtifact.size !== value.expectedBytes
        ) {
            return null;
        }
    }
    return {
        type: 'commit',
        sourcePath: value.sourcePath,
        targetPath: value.targetPath,
        expectedBytes: value.expectedBytes,
        ...(typeof value.validationBinary === 'string' ? {validationBinary: value.validationBinary} : {}),
        ...(Array.isArray(value.changedObjectRefs)
            && value.changedObjectRefs.every((entry): entry is string => typeof entry === 'string')
            ? {changedObjectRefs: [...value.changedObjectRefs]}
            : {}),
        ...(stagedArtifact === undefined || stagedArtifact === null
            ? {}
            : {stagedArtifact}),
        ...(value.validateOnly === true ? {validateOnly: true as const} : {}),
    };
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
        && artifact?.fileIdentity.platform === 'posix';
    const changedObjectRefs = request.changedObjectRefs ?? [];
    const nativeIncrementalCheck = receiptReuseEnabled
        && artifact?.validations.semanticCheck === true
        && artifact.validations.semanticScopeSha256
            === createNativeIncrementalMutationSemanticScopeSha256();
    return {
        fingerprint: receiptReuseEnabled,
        tailCheck: receiptReuseEnabled && artifact?.validations.tailCheck === true,
        qpdfCheck: receiptReuseEnabled && artifact?.validations.qpdfCheck === true,
        nativeIncrementalCheck,
        changedObjectRefsCheck: receiptReuseEnabled
            && changedObjectRefs.length > 0
            && artifact?.validations.changedObjectRefsSha256
                === createChangedObjectRefsSha256(changedObjectRefs),
        fileSync: receiptReuseEnabled && artifact?.validations.fsynced === true,
    };
}

export function decodeDocumentSaveUtilityResult(value: unknown): TDocumentSaveUtilityResult | null {
    if (!isRecord(value) || value.type !== 'result' || typeof value.ok !== 'boolean') {
        return null;
    }
    if (value.ok) {
        if (typeof value.bytes !== 'number'
            || !Number.isSafeInteger(value.bytes)
            || value.bytes <= 0
            || typeof value.sha256 !== 'string'
            || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
            return null;
        }
        return {
            type: 'result',
            ok: true,
            bytes: value.bytes,
            sha256: value.sha256,
        };
    }
    return typeof value.error === 'string'
        ? {
            type: 'result',
            ok: false,
            error: value.error,
        }
        : null;
}
