import {
    isBrowserLegacyDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    decodeTypedStagedArtifact,
    createBrowserStoreFileIdentity,
    isBrowserStoreStagedArtifact,
    type IStagedArtifactValidations,
    type TBrowserStoreStagedArtifact,
} from '@contracts/stagedArtifacts';
import {
    parseDocumentRevisionToken,
    type IDocumentRevisionInfo,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';

export interface IBrowserStagedArtifactStore {
    getDocumentRevision(ref: TDocumentRef): Promise<IDocumentRevisionInfo>;
    stat(ref: TDocumentRef): Promise<{
        size: number;
        modifiedAt: number;
    }>;
    read(ref: TDocumentRef): Promise<Uint8Array>;
    commitStagedDocument(
        stagedRef: TDocumentRef,
        targetRef: TDocumentRef,
        data: Uint8Array,
        expectedStagedRevisionToken: TDocumentRevisionToken,
        expectedTargetRevisionToken: TDocumentRevisionToken,
    ): Promise<boolean>;
}

export interface ICreateBrowserStoreStagedArtifactOptions {
    leaseId: string;
    sha256: string;
    validations: IStagedArtifactValidations;
}

function toArrayBuffer(bytes: Uint8Array) {
    return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
}

async function sha256Hex(bytes: Uint8Array) {
    const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes)),
    );
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Mints the browser form of a staged receipt from a store record. The store
 * revision is copied into both identity fields so a receipt cannot refer to a
 * different record or to bytes from an earlier revision.
 */
export async function createBrowserStoreStagedArtifact(
    store: IBrowserStagedArtifactStore,
    stagedRef: TDocumentRef,
    options: ICreateBrowserStoreStagedArtifactOptions,
): Promise<TBrowserStoreStagedArtifact> {
    if (!isBrowserLegacyDocumentRef(stagedRef)) {
        throw new TypeError('Browser staged artifacts require a browser document ref');
    }

    const [
        metadata,
        revision,
    ] = await Promise.all([
        store.stat(stagedRef),
        store.getDocumentRevision(stagedRef),
    ]);
    if (revision.documentRef !== stagedRef) {
        throw new Error('Browser staged artifact revision belongs to a different document');
    }
    const candidate = {
        receiptVersion: 1 as const,
        artifactKind: 'pdf' as const,
        path: stagedRef,
        size: metadata.size,
        sha256: options.sha256,
        fileIdentity: createBrowserStoreFileIdentity(stagedRef, revision.token),
        validations: options.validations,
        leaseId: options.leaseId,
        revision: revision.token,
    };
    const artifact = decodeTypedStagedArtifact(candidate);
    if (!artifact || !isBrowserStoreStagedArtifact(artifact)) {
        throw new Error('Invalid browser staged artifact receipt');
    }
    return artifact;
}

/**
 * Commits a browser-store staged receipt into a revision-checked target. The
 * staged record is removed only after the target write succeeds. A browser
 * receipt never enters the native path and never needs an invented OS id.
 */
export async function commitBrowserStoreStagedArtifact(
    store: IBrowserStagedArtifactStore,
    stagedArtifact: unknown,
    targetRef: TDocumentRef,
    expectedTargetRevisionToken: TDocumentRevisionToken,
): Promise<boolean> {
    const decoded = decodeTypedStagedArtifact(stagedArtifact);
    if (!decoded || !isBrowserStoreStagedArtifact(decoded)) {
        throw new Error('Expected a browser-store staged artifact');
    }
    if (!isBrowserLegacyDocumentRef(targetRef) || targetRef === decoded.path) {
        throw new Error('Browser staged commit requires a different browser target ref');
    }
    const expectedRevision = parseDocumentRevisionToken(expectedTargetRevisionToken);
    if (expectedRevision === null) {
        throw new Error('Browser staged commit requires a document revision token');
    }

    const initialRevision = await store.getDocumentRevision(decoded.path);
    const initialMetadata = await store.stat(decoded.path);
    if (
        initialRevision.documentRef !== decoded.path
        || initialRevision.token !== decoded.revision
        || initialRevision.token !== decoded.fileIdentity.revisionToken
        || initialMetadata.size !== decoded.size
    ) {
        throw new Error('Browser staged artifact content or revision changed after staging');
    }

    const bytes = await store.read(decoded.path);
    if (bytes.byteLength !== decoded.size || await sha256Hex(bytes) !== decoded.sha256) {
        throw new Error('Browser staged artifact content does not match its receipt');
    }

    const finalRevision = await store.getDocumentRevision(decoded.path);
    if (finalRevision.token !== initialRevision.token) {
        throw new Error('Browser staged artifact content or revision changed during commit');
    }

    return store.commitStagedDocument(
        decoded.path,
        targetRef,
        bytes,
        decoded.revision,
        expectedRevision,
    );
}
