import {BROWSER_PAGE_OPS_MAX_OUTPUT_BYTES} from '@contracts/browserPageOpsLimits';
import {
    isBrowserLegacyDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    createBrowserStoreFileIdentity,
    isBrowserStoreStagedArtifact,
    TYPED_STAGED_ARTIFACT_SCHEMA,
    type IStagedArtifactValidations,
    type TBrowserStoreStagedArtifact,
} from '@contracts/stagedArtifacts';
import {
    type IDocumentRevisionInfo,
} from '@contracts/documentRevision';
import * as v from 'valibot';
import {SerializableError} from '@contracts/serializableError';

export interface IBrowserStagedArtifactStore {
    getDocumentRevision(ref: TDocumentRef): Promise<IDocumentRevisionInfo>;
    stat(ref: TDocumentRef): Promise<{
        size: number;
        modifiedAt: number;
    }>;
    read(ref: TDocumentRef, options?: {maxBytes?: number}): Promise<Uint8Array>;
}

export interface ICreateBrowserStoreStagedArtifactOptions {
    leaseId: string;
    sha256: string;
    validations: IStagedArtifactValidations;
    /** An edit appended to the record in place: its staged length, past the revision the record names. */
    size?: number;
}

function toArrayBuffer(bytes: Uint8Array) {
    return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
}

export async function sha256Hex(bytes: Uint8Array) {
    const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes)),
    );
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Mints the browser form of a staged receipt from a store record. The store
 * revision is copied into both identity fields so a receipt cannot refer to a
 * different record or to bytes from an earlier revision. A native edit
 * appended in place names its own record, its staged size and the SHA-256 of
 * the appended bytes; its lease, not a reread, admits its commit.
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
        size: options.size ?? metadata.size,
        sha256: options.sha256,
        fileIdentity: createBrowserStoreFileIdentity(stagedRef, revision.token),
        validations: options.validations,
        leaseId: options.leaseId,
        revision: revision.token,
    };
    const artifact = v.safeParse(TYPED_STAGED_ARTIFACT_SCHEMA, candidate, {abortEarly: true});
    if (!artifact.success || !isBrowserStoreStagedArtifact(artifact.output)) {
        throw new Error('Invalid browser staged artifact receipt');
    }
    return artifact.output;
}

/**
 * Reads one immutable, admitted receipt for publication or revision-checked
 * commit. Staged outputs come from the in-process engine, so they read up to
 * the engine's own output ceiling.
 */
export async function readBrowserStoreStagedArtifact(
    store: IBrowserStagedArtifactStore,
    stagedArtifact: unknown,
    {maxBytes = BROWSER_PAGE_OPS_MAX_OUTPUT_BYTES}: {maxBytes?: number} = {},
) {
    const parsed = v.safeParse(TYPED_STAGED_ARTIFACT_SCHEMA, stagedArtifact, {abortEarly: true});
    if (!parsed.success || !isBrowserStoreStagedArtifact(parsed.output)) {
        throw new Error('Expected a browser-store staged artifact');
    }
    const decoded = parsed.output;
    if (decoded.size > maxBytes) {
        throw new SerializableError({
            code: 'browser-byte-limit',
            maxBytes,
            message: `Browser staged PDF output exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB browser read limit`,
        });
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

    const bytes = await store.read(decoded.path, {maxBytes});
    if (bytes.byteLength !== decoded.size || await sha256Hex(bytes) !== decoded.sha256) {
        throw new Error('Browser staged artifact content does not match its receipt');
    }

    const finalRevision = await store.getDocumentRevision(decoded.path);
    if (finalRevision.token !== initialRevision.token) {
        throw new Error('Browser staged artifact content or revision changed during commit');
    }

    return {
        artifact: decoded,
        bytes,
    };
}
