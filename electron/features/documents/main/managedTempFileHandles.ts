import {realpathSync} from 'node:fs';
import {
    lstat,
    rm,
    stat,
} from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import type { IManagedTempFileHandle } from '@contracts/electronApiDocuments';
import {MANAGED_TEMP_FILE_HANDLE_SCHEMA} from '@contracts/electronApiDocuments';
import {parseDocumentRef} from '@contracts/documentRef';
import {
    createLeaseId,
    parseLeaseId,
    requireLeaseId,
    type TLeaseId,
} from '@contracts/shared';
import * as v from 'valibot';
import {
    TYPED_STAGED_ARTIFACT_SCHEMA,
    type IStagedArtifactValidations,
    type ITypedStagedArtifact,
    type TArtifactFileIdentity,
} from '@contracts/stagedArtifacts';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsContexts';
import {
    readWorkingCopyRevision,
} from '@electron/file-access/documentStore';
import {fingerprintFileWithUtilityProcess} from '@electron/features/documents/main/fingerprintFileWithUtilityProcess';
import {resolveDocumentReadTransport} from '@electron/features/documents/main/documentFileReadHandlers';
import {setManagedTempPathAccessValidator} from '@electron/utils/pathValidator';
import {
    resolveExistingReadableBinaryPath,
    resolveExistingReadableDocumentOrImagePath,
} from '@electron/features/documents/main/documentFilePathResolution';

const MANAGED_HANDLE_TTL_MS = 5 * 60 * 1_000;

interface IMainManagedTempFileLease {
    ownerId: number | undefined;
    path: string;
    expiresAt: number;
    /** What ending the lease does: deletes a temporary file, or cuts an append no commit claimed. */
    release?: (() => Promise<unknown>) | undefined;
    cleanupPending?: boolean;
    invalidated?: boolean;
}

/**
 * A managed binary handle: the one hash pass that minted `handle.sha256` was bracketed by these stat witnesses, so
 * resolving it checks the same file object and metadata instead of hashing the bytes again (ADR 0010).
 */
interface IMainManagedBinaryLease extends IMainManagedTempFileLease {
    handle: IManagedTempFileHandle;
    fileIdentity: TArtifactFileIdentity;
    statWitness: IArtifactStatWitness;
}

interface IMainStagedArtifactLease extends IMainManagedTempFileLease {
    artifact: ITypedStagedArtifact;
    statWitness: IArtifactStatWitness;
    immutable: true;
}

interface IArtifactStatWitness {
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
    linkCount: bigint;
}

type TMainLease = IMainManagedTempFileLease | IMainManagedBinaryLease | IMainStagedArtifactLease;

const leases = new Map<TLeaseId, TMainLease>();
const leaseIdsByCanonicalPath = new Map<string, TLeaseId>();
let leaseSweepTimer: ReturnType<typeof setTimeout> | null = null;

function canonicalizeLeasePath(path: string) {
    try {
        return realpathSync.native(path);
    } catch {
        return path;
    }
}

function registerLeasePath(leaseId: TLeaseId, path: string) {
    leaseIdsByCanonicalPath.set(canonicalizeLeasePath(path), leaseId);
}

function unregisterLease(leaseId: TLeaseId) {
    leases.delete(leaseId);
    for (const [
        canonicalPath,
        pathLeaseId,
    ] of leaseIdsByCanonicalPath) {
        if (pathLeaseId === leaseId) {
            leaseIdsByCanonicalPath.delete(canonicalPath);
        }
    }
}

/**
 * Returns null for a known path that this sender cannot use, undefined for an
 * unregistered path, and the canonical path for an active owned lease.
 */
export function assertManagedTempPathAccess(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
): string | null | undefined {
    if (typeof filePath !== 'string') {
        return null;
    }
    sweepExpiredLeases();
    const canonicalPath = canonicalizeLeasePath(filePath);
    const leaseId = leaseIdsByCanonicalPath.get(canonicalPath);
    if (!leaseId) {
        return undefined;
    }
    const lease = leases.get(leaseId);
    if (!lease) {
        leaseIdsByCanonicalPath.delete(canonicalPath);
        return undefined;
    }
    if (lease.invalidated || lease.ownerId !== context.senderId) {
        return null;
    }
    lease.expiresAt = Date.now() + MANAGED_HANDLE_TTL_MS;
    return canonicalPath;
}

setManagedTempPathAccessValidator(assertManagedTempPathAccess);

function registerLease(
    leaseId: TLeaseId,
    lease: TMainLease,
) {
    leases.set(leaseId, lease);
    registerLeasePath(leaseId, lease.path);
    ensureLeaseSweep();
}

function requireDocumentRef(value: unknown) {
    const documentRef = parseDocumentRef(value);
    if (documentRef === null) {
        throw new Error('Expected an absolute document ref');
    }
    return documentRef;
}

function cloneTypedStagedArtifact(artifact: ITypedStagedArtifact): ITypedStagedArtifact {
    const cloned = {
        ...artifact,
        fileIdentity: {...artifact.fileIdentity},
        validations: {
            ...artifact.validations,
            ...(artifact.validations.qpdfResult === undefined
                ? {}
                : {qpdfResult: {
                    ...artifact.validations.qpdfResult,
                    errors: [...artifact.validations.qpdfResult.errors],
                    warnings: [...artifact.validations.qpdfResult.warnings],
                }}),
        },
    };
    return artifact.receiptVersion === 1
        ? {
            ...cloned,
            receiptVersion: 1,
            sha256: artifact.sha256,
        }
        : {
            ...cloned,
            receiptVersion: 2,
            fileIdentity: {...artifact.fileIdentity},
        };
}

function createArtifactFileIdentity(fileStat: BigIntStats): TArtifactFileIdentity {
    return process.platform === 'win32'
        ? {
            platform: 'win32',
            volumeId: fileStat.dev.toString(),
            fileId: fileStat.ino.toString(),
        }
        : {
            platform: 'posix',
            deviceId: fileStat.dev.toString(),
            inode: fileStat.ino.toString(),
        };
}

function createArtifactStatWitness(fileStat: BigIntStats): IArtifactStatWitness {
    return {
        size: fileStat.size,
        mtimeNs: fileStat.mtimeNs,
        ctimeNs: fileStat.ctimeNs,
        linkCount: fileStat.nlink,
    };
}

/** Keeps the lease authority immutable without another in-process copy. */
function freezeTypedStagedArtifact(artifact: ITypedStagedArtifact): ITypedStagedArtifact {
    const qpdfResult = artifact.validations.qpdfResult;
    if (qpdfResult) {
        Object.freeze(qpdfResult.errors);
        Object.freeze(qpdfResult.warnings);
        Object.freeze(qpdfResult);
    }
    Object.freeze(artifact.validations);
    Object.freeze(artifact.fileIdentity);
    return Object.freeze(artifact);
}

function isSameArtifactStatWitness(
    left: IArtifactStatWitness,
    right: IArtifactStatWitness,
) {
    return left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs
        && left.linkCount === right.linkCount;
}

async function statRegularArtifact(path: string) {
    const fileStat = await lstat(path, {bigint: true});
    if (!fileStat.isFile()) {
        throw new Error('Staged artifact path no longer identifies a regular file');
    }
    return fileStat;
}

/**
 * The file a managed binary handle names. A direct path must itself be a regular file, so a symlink swapped in is
 * refused; an open document's original is followed as its admission check does, and that check guards its identity.
 */
async function statManagedBinary(path: string, originalBacked: boolean) {
    if (!originalBacked) return statRegularArtifact(path);
    const fileStat = await stat(path, {bigint: true});
    if (!fileStat.isFile()) {
        throw new Error('Managed binary path no longer identifies a regular file');
    }
    return fileStat;
}

function isSameArtifactFile(left: BigIntStats, right: BigIntStats) {
    return isDeepStrictEqual(createArtifactFileIdentity(left), createArtifactFileIdentity(right))
        && isSameArtifactStatWitness(createArtifactStatWitness(left), createArtifactStatWitness(right));
}

function invalidateStagedArtifactLease(leaseId: TLeaseId) {
    const lease = leases.get(leaseId);
    if (lease) endLease(leaseId, lease);
    sweepExpiredLeases();
}

const removeFile = (path: string) => () => rm(path, {force: true});

/**
 * Ends a lease however it ends (released, expired, invalid, its renderer gone): its release runs once, and one that
 * fails runs again on a later sweep.
 */
function endLease(leaseId: TLeaseId, lease: IMainManagedTempFileLease) {
    const {release} = lease;
    if (!release) {
        unregisterLease(leaseId);
        return;
    }
    lease.invalidated = true;
    if (lease.cleanupPending) {
        return;
    }
    lease.cleanupPending = true;
    void release().then(() => {
        if (leases.get(leaseId) === lease) {
            unregisterLease(leaseId);
        }
    }).catch(() => {
        if (leases.get(leaseId) === lease) {
            lease.cleanupPending = false;
            lease.expiresAt = Date.now() + 30_000;
        }
    }).finally(clearLeaseSweepIfIdle);
}

function clearLeaseSweepIfIdle() {
    if (leases.size === 0 && leaseSweepTimer) {
        clearInterval(leaseSweepTimer);
        leaseSweepTimer = null;
    }
}

function sweepExpiredLeases() {
    const now = Date.now();
    for (const [
        leaseId,
        lease,
    ] of leases) {
        if (lease.expiresAt <= now) endLease(leaseId, lease);
    }
    clearLeaseSweepIfIdle();
}

function renewLeaseIfActive(leaseId: TLeaseId, lease: TMainLease) {
    sweepExpiredLeases();
    if (leases.get(leaseId) !== lease || lease.invalidated) {
        return false;
    }
    const now = Date.now();
    if (lease.expiresAt <= now) {
        endLease(leaseId, lease);
        return false;
    }
    lease.expiresAt = now + MANAGED_HANDLE_TTL_MS;
    return true;
}

function ensureLeaseSweep() {
    leaseSweepTimer ??= setInterval(sweepExpiredLeases, 30_000);
    leaseSweepTimer.unref();
}

export async function createManagedTempFileHandle(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    options: {cleanupOnRelease?: boolean} = {},
): Promise<IManagedTempFileHandle> {
    const path = await resolveExistingReadableDocumentOrImagePath(filePath, context.senderId);
    const originalBackedRead = resolveDocumentReadTransport(path, context.senderId);
    // The one hash pass the handle's digest needs, bracketed by stat witnesses that resolving checks instead. An
    // original-backed read checks the original unchanged after this returns, and reports that change itself.
    const inspect = async (physicalPath: string) => ({
        beforeStat: await statManagedBinary(physicalPath, originalBackedRead !== null),
        inspection: await fingerprintFileWithUtilityProcess(physicalPath),
        fileStat: await statManagedBinary(physicalPath, originalBackedRead !== null),
    });
    const [
        {beforeStat, inspection, fileStat},
        currentRevision,
    ] = await Promise.all([
        originalBackedRead ? originalBackedRead.read(inspect) : inspect(path),
        readWorkingCopyRevision(path),
    ]);
    if (BigInt(inspection.bytes) !== fileStat.size || !isSameArtifactFile(beforeStat, fileStat)) {
        throw new Error('Managed binary file changed while its handle was being created');
    }
    const leaseId = createLeaseId('managed-temp');
    const handle: IManagedTempFileHandle = Object.freeze({
        path: requireDocumentRef(path),
        size: inspection.bytes,
        sha256: inspection.sha256,
        leaseId,
        revision: currentRevision?.token ?? null,
    });
    registerLease(leaseId, {
        ownerId: context.senderId,
        path: handle.path,
        expiresAt: Date.now() + MANAGED_HANDLE_TTL_MS,
        release: options.cleanupOnRelease ? removeFile(path) : undefined,
        handle,
        fileIdentity: createArtifactFileIdentity(fileStat),
        statWitness: createArtifactStatWitness(fileStat),
    });
    ensureLeaseSweep();
    return {...handle};
}

interface ICreateTypedStagedArtifactOptions {
    cleanupOnRelease?: boolean;
    /** The digest of the byte pass that wrote the artifact; minting a receipt never hashes it again. */
    trustedFingerprint: {
        bytes: number;
        sha256: string;
        contentFingerprint?: string;
        /**
         * The writer's own open handle, statted after its last write and sync: the receipt names that file object
         * as it was then, so nothing put at the path after the writer closed it gets the writer's digest.
         */
        writtenFile: BigIntStats;
    };
}

interface IRegisterTypedStagedArtifactOptions {
    release?: (() => Promise<unknown>) | undefined;
    invalidReceiptMessage: string;
}

function registerTypedStagedArtifact(
    context: IDocumentsSenderIdContext,
    candidate: unknown,
    fileStat: BigIntStats,
    options: IRegisterTypedStagedArtifactOptions,
): ITypedStagedArtifact {
    // Parse once at the contract boundary. The canonical value is both the
    // lease authority and the return value; IPC provides renderer isolation.
    const artifact = v.safeParse(TYPED_STAGED_ARTIFACT_SCHEMA, candidate, {abortEarly: true});
    if (!artifact.success) {
        throw new Error(options.invalidReceiptMessage);
    }
    const authoritativeArtifact = freezeTypedStagedArtifact(artifact.output);
    registerLease(authoritativeArtifact.leaseId, {
        ownerId: context.senderId,
        path: authoritativeArtifact.path,
        expiresAt: Date.now() + MANAGED_HANDLE_TTL_MS,
        release: options.release,
        artifact: authoritativeArtifact,
        statWitness: createArtifactStatWitness(fileStat),
        immutable: true,
    });
    ensureLeaseSweep();
    return authoritativeArtifact;
}

export async function createTypedStagedArtifact(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    validations: IStagedArtifactValidations,
    options: ICreateTypedStagedArtifactOptions,
): Promise<ITypedStagedArtifact> {
    const path = await resolveExistingReadableBinaryPath(filePath, context.senderId);
    const {trustedFingerprint} = options;
    if (
        !Number.isSafeInteger(trustedFingerprint.bytes)
        || trustedFingerprint.bytes < 0
        || !/^[a-f0-9]{64}$/u.test(trustedFingerprint.sha256)
    ) {
        throw new Error('Invalid trusted staged artifact fingerprint');
    }
    const fileStat = await statRegularArtifact(path);
    const currentRevision = readWorkingCopyRevision(path);
    if (BigInt(trustedFingerprint.bytes) !== fileStat.size || !isSameArtifactFile(trustedFingerprint.writtenFile, fileStat)) {
        throw new Error('Staged artifact changed while its receipt was being created');
    }
    const leaseId = createLeaseId('staged-artifact');
    return registerTypedStagedArtifact(context, {
        receiptVersion: 1,
        artifactKind: 'pdf',
        path: requireDocumentRef(path),
        size: trustedFingerprint.bytes,
        sha256: trustedFingerprint.sha256,
        ...(trustedFingerprint.contentFingerprint === undefined ? {} : {contentFingerprint: trustedFingerprint.contentFingerprint}),
        fileIdentity: createArtifactFileIdentity(fileStat),
        validations,
        leaseId,
        revision: currentRevision?.token ?? null,
    }, fileStat, {
        release: options.cleanupOnRelease ? removeFile(path) : undefined,
        invalidReceiptMessage: 'Invalid staged artifact validation receipt',
    });
}

/**
 * Creates a native staging capability without reading the whole artifact to
 * manufacture a reusable content digest. The lease keeps the private stat
 * witness; callers can only resolve the exact file object produced and
 * validated by the main-process native operation.
 */
export async function createOpaqueNativePdfStagedArtifact(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    validations: IStagedArtifactValidations,
    options: {release?: () => Promise<unknown>} = {},
): Promise<ITypedStagedArtifact> {
    const path = await resolveExistingReadableBinaryPath(filePath, context.senderId);
    const beforeStat = await statRegularArtifact(path);
    const currentRevision = await readWorkingCopyRevision(path);
    const fileStat = await statRegularArtifact(path);
    if (!isSameArtifactFile(beforeStat, fileStat)) {
        throw new Error('Native staged artifact changed while its lease was being created');
    }
    const fileIdentity = createArtifactFileIdentity(fileStat);
    if (fileIdentity.platform === 'browser') {
        throw new Error('Native staged artifacts require operating-system file identity');
    }
    const size = Number(fileStat.size);
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error('Native staged artifact size exceeds the supported integer range');
    }
    const leaseId = createLeaseId('staged-artifact');
    return registerTypedStagedArtifact(context, {
        receiptVersion: 2,
        artifactKind: 'pdf',
        path: requireDocumentRef(path),
        size,
        fileIdentity,
        validations,
        leaseId,
        revision: currentRevision?.token ?? null,
    }, fileStat, {
        release: options.release,
        invalidReceiptMessage: 'Invalid opaque native staged artifact receipt',
    });
}

export function releaseManagedTempFileHandle(
    context: IDocumentsSenderIdContext,
    leaseId: unknown,
) {
    const parsedLeaseId = parseLeaseId(leaseId);
    if (parsedLeaseId === null) {
        return false;
    }
    const lease = leases.get(parsedLeaseId);
    if (!lease || lease.ownerId !== context.senderId) {
        return false;
    }
    endLease(parsedLeaseId, lease);
    sweepExpiredLeases();
    return true;
}

/**
 * Resolves a handle without hashing it again: the lease's file object, stat witness and revision must be what the
 * minting hash pass saw. Any difference, or a file that cannot be checked, ends the lease.
 */
export async function resolveManagedTempFileHandle(
    context: IDocumentsSenderIdContext,
    value: unknown,
): Promise<IManagedTempFileHandle> {
    const parsed = v.safeParse(MANAGED_TEMP_FILE_HANDLE_SCHEMA, value, {abortEarly: true});
    if (!parsed.success) {
        throw new Error('Invalid managed binary handle');
    }
    const handle = parsed.output;
    sweepExpiredLeases();
    const lease = leases.get(handle.leaseId);
    if (
        !lease
        || lease.invalidated
        || !('handle' in lease)
        || lease.ownerId !== context.senderId
        || !isDeepStrictEqual(handle, lease.handle)
    ) {
        throw new Error('Managed binary handle lease is missing, expired, or belongs to another renderer');
    }
    const changed = () => {
        invalidateStagedArtifactLease(handle.leaseId);
        return new Error('Managed binary handle content or revision changed after staging');
    };
    let fileStat: BigIntStats;
    try {
        // An original another program changed or removed fails here, and ends the lease like any other change.
        const originalBackedRead = resolveDocumentReadTransport(lease.handle.path, context.senderId);
        const statLeaseFile = (physicalPath: string) => statManagedBinary(physicalPath, originalBackedRead !== null);
        fileStat = await (originalBackedRead ? originalBackedRead.read(statLeaseFile) : statLeaseFile(lease.handle.path));
    } catch {
        throw changed();
    }
    const currentRevision = readWorkingCopyRevision(lease.handle.path);
    if (
        BigInt(lease.handle.size) !== fileStat.size
        || !isDeepStrictEqual(createArtifactFileIdentity(fileStat), lease.fileIdentity)
        || !isSameArtifactStatWitness(createArtifactStatWitness(fileStat), lease.statWitness)
        || (currentRevision?.token ?? null) !== lease.handle.revision
    ) {
        throw changed();
    }
    // A release, an expiry or the renderer's end during the check above ended the lease: it grants nothing now.
    if (!renewLeaseIfActive(handle.leaseId, lease)) {
        throw new Error('Managed binary handle lease is missing, expired, or belongs to another renderer');
    }
    return {...lease.handle};
}

/**
 * Resolves a receipt by its file object (device and inode, or NTFS volume and file id), stat witness and document
 * revision, the same on every platform and for both receipt versions: the bytes are never hashed again (ADR 0010).
 */
export async function resolveTypedStagedArtifact(
    context: IDocumentsSenderIdContext,
    artifact: ITypedStagedArtifact,
): Promise<ITypedStagedArtifact> {
    if (artifact.fileIdentity.platform === 'browser') {
        throw new Error('Browser-store staged artifacts must use the browser document store commit path');
    }
    sweepExpiredLeases();
    const lease = leases.get(artifact.leaseId);
    if (
        !lease
        || lease.invalidated
        || !('artifact' in lease)
        || lease.ownerId !== context.senderId
        || !isDeepStrictEqual(artifact, lease.artifact)
    ) {
        throw new Error('Staged artifact lease is missing, expired, altered, or belongs to another renderer');
    }
    let fileStat: BigIntStats;
    try {
        fileStat = await statRegularArtifact(lease.path);
    } catch {
        invalidateStagedArtifactLease(artifact.leaseId);
        throw new Error('Staged artifact content, identity, or revision changed after staging');
    }
    const statWitness = createArtifactStatWitness(fileStat);
    const identityMatches = isDeepStrictEqual(
        createArtifactFileIdentity(fileStat),
        lease.artifact.fileIdentity,
    );
    const witnessMatches = isSameArtifactStatWitness(statWitness, lease.statWitness);
    const currentRevision = await readWorkingCopyRevision(lease.path);
    const revisionMatches = (currentRevision?.token ?? null) === lease.artifact.revision;
    if (!identityMatches || !witnessMatches || !revisionMatches) {
        invalidateStagedArtifactLease(artifact.leaseId);
        throw new Error('Staged artifact content, identity, or revision changed after staging');
    }
    // A release, an expiry or the renderer's end during the check above ended the lease: it grants nothing now.
    if (!renewLeaseIfActive(artifact.leaseId, lease)) {
        throw new Error('Staged artifact lease is missing, expired, altered, or belongs to another renderer');
    }
    return cloneTypedStagedArtifact(lease.artifact);
}

export function clearManagedTempFileHandlesForTests() {
    leases.clear();
    leaseIdsByCanonicalPath.clear();
    if (leaseSweepTimer) {
        clearInterval(leaseSweepTimer);
        leaseSweepTimer = null;
    }
}

export function revokeManagedTempFileHandlesForSender(senderId: number) {
    for (const [
        leaseId,
        lease,
    ] of leases) {
        if (lease.ownerId === senderId) endLease(leaseId, lease);
    }
    sweepExpiredLeases();
}

export function getManagedTempFileCleanupStateForTests(leaseId: string) {
    const lease = leases.get(requireLeaseId(leaseId));
    return lease
        ? {
            exists: true,
            pending: lease.cleanupPending === true,
        }
        : {
            exists: false,
            pending: false,
        };
}
