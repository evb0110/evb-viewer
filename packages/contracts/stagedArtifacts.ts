import {
    isBrowserLegacyDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { isPdfValidationResult } from '@contracts/pdfConformance';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import { isRecord } from '@contracts/runtimeGuards';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DECIMAL_BIGINT_PATTERN = /^(?:0|[1-9]\d*)$/u;
const BROWSER_DOCUMENT_REF_PREFIX = 'browser://documents/';

export type TArtifactFileIdentity =
    | {
        platform: 'posix';
        deviceId: string;
        inode: string;
    }
    | {
        platform: 'win32';
        volumeId: string;
        fileId: string;
    }
    /**
     * Identity for an artifact held by the browser document store. Browser
     * documents have no operating-system inode or volume, so the store ref and
     * its content revision identify the exact record without inventing one.
     */
    | IBrowserStoreFileIdentity;

export interface IBrowserStoreFileIdentity {
    platform: 'browser';
    documentRef: TDocumentRef;
    revisionToken: TDocumentRevisionToken;
}

export interface IStagedArtifactValidations {
    qpdfCheck: boolean;
    tailCheck: boolean;
    semanticCheck: boolean;
    fsynced: boolean;

    /** Required when qpdfCheck is true; preserves warnings. */
    qpdfResult?: IPdfValidationResult;

    /** Hash of the mutation/postcondition program proven by semanticCheck. */
    semanticScopeSha256?: string;

    changedObjectRefsSha256?: string;
}

interface ITypedStagedArtifactBase {
    artifactKind: 'pdf';
    path: TDocumentRef;
    size: number;
    fileIdentity: TArtifactFileIdentity;
    validations: IStagedArtifactValidations;
    leaseId: string;
    revision: TDocumentRevisionToken | null;
}

export interface IContentFingerprintStagedArtifact extends ITypedStagedArtifactBase {
    receiptVersion: 1;
    sha256: string;
}

/**
 * Main-process-owned native output. The lease's file identity and private stat
 * witness authorize promotion; this receipt is never a reusable content hash.
 */
export interface IOpaqueNativeStagedArtifact extends ITypedStagedArtifactBase {
    receiptVersion: 2;
    fileIdentity: Extract<TArtifactFileIdentity, {platform: 'posix'}>;
}

export type ITypedStagedArtifact =
    | IContentFingerprintStagedArtifact
    | IOpaqueNativeStagedArtifact;

export type TBrowserStoreStagedArtifact = Omit<
    IContentFingerprintStagedArtifact,
    'fileIdentity' | 'revision'
> & {
    fileIdentity: IBrowserStoreFileIdentity;
    revision: TDocumentRevisionToken;
};

const BROWSER_DOCUMENT_REF_MAX_LENGTH = 32_768;
const BROWSER_REVISION_TOKEN_MAX_LENGTH = 512;

function decodeBrowserStoreFileIdentity(value: unknown): IBrowserStoreFileIdentity | null {
    if (!isRecord(value)
        || value.platform !== 'browser'
        || typeof value.documentRef !== 'string'
        || value.documentRef.length === 0
        || value.documentRef === BROWSER_DOCUMENT_REF_PREFIX
        || value.documentRef.length > BROWSER_DOCUMENT_REF_MAX_LENGTH
        || !isBrowserLegacyDocumentRef(value.documentRef)) {
        return null;
    }
    const revisionToken = parseDocumentRevisionToken(value.revisionToken);
    if (
        revisionToken === null
        || revisionToken.length > BROWSER_REVISION_TOKEN_MAX_LENGTH
    ) {
        return null;
    }
    return {
        platform: 'browser',
        documentRef: value.documentRef,
        revisionToken,
    };
}

export function isBrowserStoreFileIdentity(value: unknown): value is IBrowserStoreFileIdentity {
    return decodeBrowserStoreFileIdentity(value) !== null;
}

export function createBrowserStoreFileIdentity(
    documentRef: TDocumentRef,
    revisionToken: TDocumentRevisionToken,
): IBrowserStoreFileIdentity {
    const identity = decodeBrowserStoreFileIdentity({
        platform: 'browser',
        documentRef,
        revisionToken,
    });
    if (identity === null) {
        throw new TypeError('Browser staged artifact identity requires a browser document ref and revision token');
    }
    return identity;
}

function decodeFileIdentity(value: unknown): TArtifactFileIdentity | null {
    if (!isRecord(value)) {
        return null;
    }
    if (
        value.platform === 'posix'
        && typeof value.deviceId === 'string'
        && DECIMAL_BIGINT_PATTERN.test(value.deviceId)
        && typeof value.inode === 'string'
        && DECIMAL_BIGINT_PATTERN.test(value.inode)
    ) {
        return {
            platform: 'posix',
            deviceId: value.deviceId,
            inode: value.inode,
        };
    }
    if (
        value.platform === 'win32'
        && typeof value.volumeId === 'string'
        && value.volumeId.length > 0
        && typeof value.fileId === 'string'
        && value.fileId.length > 0
    ) {
        return {
            platform: 'win32',
            volumeId: value.volumeId,
            fileId: value.fileId,
        };
    }
    return decodeBrowserStoreFileIdentity(value);
}

function decodeValidations(value: unknown): IStagedArtifactValidations | null {
    if (
        !isRecord(value)
        || typeof value.qpdfCheck !== 'boolean'
        || typeof value.tailCheck !== 'boolean'
        || typeof value.semanticCheck !== 'boolean'
        || typeof value.fsynced !== 'boolean'
        || (value.qpdfResult !== undefined && !isPdfValidationResult(value.qpdfResult))
        || (value.qpdfResult !== undefined && value.qpdfResult.tool !== 'qpdf')
        || (value.qpdfCheck && value.qpdfResult === undefined)
        || (value.qpdfCheck && value.qpdfResult?.isValid !== true)
        || (value.semanticScopeSha256 !== undefined && (
            typeof value.semanticScopeSha256 !== 'string'
            || !SHA256_PATTERN.test(value.semanticScopeSha256)
        ))
        || (value.semanticCheck && value.semanticScopeSha256 === undefined)
        || (value.changedObjectRefsSha256 !== undefined && (
            typeof value.changedObjectRefsSha256 !== 'string'
            || !SHA256_PATTERN.test(value.changedObjectRefsSha256)
        ))
    ) {
        return null;
    }
    return {
        qpdfCheck: value.qpdfCheck,
        tailCheck: value.tailCheck,
        semanticCheck: value.semanticCheck,
        fsynced: value.fsynced,
        ...(value.qpdfResult === undefined ? {} : {qpdfResult: {
            isValid: value.qpdfResult.isValid,
            tool: value.qpdfResult.tool,
            errors: [...value.qpdfResult.errors],
            warnings: [...value.qpdfResult.warnings],
        }}),
        ...(value.semanticScopeSha256 === undefined
            ? {}
            : {semanticScopeSha256: value.semanticScopeSha256}),
        ...(value.changedObjectRefsSha256 === undefined
            ? {}
            : {changedObjectRefsSha256: value.changedObjectRefsSha256}),
    };
}

export function decodeTypedStagedArtifact(value: unknown): ITypedStagedArtifact | null {
    if (
        !isRecord(value)
        || (value.receiptVersion !== 1 && value.receiptVersion !== 2)
        || value.artifactKind !== 'pdf'
        || typeof value.path !== 'string'
        || value.path.length === 0
        || typeof value.size !== 'number'
        || !Number.isSafeInteger(value.size)
        || value.size < 0
        || (value.receiptVersion === 1 && (
            typeof value.sha256 !== 'string'
            || !SHA256_PATTERN.test(value.sha256)
        ))
        || (value.receiptVersion === 2 && value.sha256 !== undefined)
        || typeof value.leaseId !== 'string'
        || value.leaseId.length === 0
        || (value.revision !== null && typeof value.revision !== 'string')
    ) {
        return null;
    }
    const fileIdentity = decodeFileIdentity(value.fileIdentity);
    const validations = decodeValidations(value.validations);
    const revision = value.revision === null ? null : parseDocumentRevisionToken(value.revision);
    if (fileIdentity === null || validations === null || revision === null && value.revision !== null) {
        return null;
    }
    if (
        fileIdentity.platform === 'browser'
        && (
            fileIdentity.documentRef !== value.path
            || revision === null
            || fileIdentity.revisionToken !== revision
        )
    ) {
        return null;
    }
    if (value.receiptVersion === 2 && fileIdentity.platform !== 'posix') {
        return null;
    }
    if (value.receiptVersion === 2) {
        const posixIdentity = fileIdentity as Extract<TArtifactFileIdentity, {platform: 'posix'}>;
        return {
            receiptVersion: 2,
            artifactKind: 'pdf',
            path: value.path,
            size: value.size,
            fileIdentity: posixIdentity,
            validations,
            leaseId: value.leaseId,
            revision,
        };
    }
    return {
        receiptVersion: 1,
        artifactKind: 'pdf',
        path: value.path,
        size: value.size,
        sha256: value.sha256 as string,
        fileIdentity,
        validations,
        leaseId: value.leaseId,
        revision,
    };
}

export function isTypedStagedArtifact(value: unknown): value is ITypedStagedArtifact {
    return decodeTypedStagedArtifact(value) !== null;
}

export function isBrowserStoreStagedArtifact(value: unknown): value is TBrowserStoreStagedArtifact {
    const artifact = decodeTypedStagedArtifact(value);
    return artifact !== null
        && artifact.receiptVersion === 1
        && artifact.fileIdentity.platform === 'browser'
        && artifact.revision !== null;
}
