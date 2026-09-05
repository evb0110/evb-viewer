import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {
    lstat,
    rm,
} from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {
    basename,
    dirname,
    isAbsolute,
} from 'node:path';
import type { IManagedTempFileHandle } from '@contracts/electronApiDocuments';
import {decodeManagedTempFileHandle} from '@contracts/electronApiDocuments';
import {
    decodeTypedStagedArtifact,
    type IStagedArtifactValidations,
    type ITypedStagedArtifact,
    type TArtifactFileIdentity,
} from '@contracts/stagedArtifacts';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';
import { readWorkingCopyRevisionSidecar } from '@electron/file-access/documentRevisionSidecar';
import {fingerprintFileWithUtilityProcess} from '@electron/features/documents/main/fingerprintFileWithUtilityProcess';
import {isAllowedOriginalSavePath} from '@electron/file-access/isAllowedOriginalSavePath';
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
    cleanupOnRelease: boolean;
    cleanupPending?: boolean;
    invalidated?: boolean;
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

const leases = new Map<string, IMainManagedTempFileLease | IMainStagedArtifactLease>();
const leaseIdsByCanonicalPath = new Map<string, string>();
let leaseSweepTimer: ReturnType<typeof setTimeout> | null = null;

function canonicalizeLeasePath(path: string) {
    try {
        return realpathSync.native(path);
    } catch {
        return path;
    }
}

function registerLeasePath(leaseId: string, path: string) {
    leaseIdsByCanonicalPath.set(canonicalizeLeasePath(path), leaseId);
}

function unregisterLease(leaseId: string) {
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
    leaseId: string,
    lease: IMainManagedTempFileLease | IMainStagedArtifactLease,
) {
    leases.set(leaseId, lease);
    registerLeasePath(leaseId, lease.path);
    ensureLeaseSweep();
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

function invalidateStagedArtifactLease(leaseId: string) {
    const lease = leases.get(leaseId);
    if (lease?.cleanupOnRelease) {
        lease.invalidated = true;
        cleanupLeaseFile(leaseId, lease);
    } else {
        unregisterLease(leaseId);
    }
    sweepExpiredLeases();
}

function clearLeaseSweepIfIdle() {
    if (leases.size === 0 && leaseSweepTimer) {
        clearInterval(leaseSweepTimer);
        leaseSweepTimer = null;
    }
}

function cleanupLeaseFile(leaseId: string, lease: IMainManagedTempFileLease) {
    if (lease.cleanupPending) {
        return;
    }
    lease.cleanupPending = true;
    void rm(lease.path, {force: true}).then(() => {
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

function sweepExpiredLeases() {
    const now = Date.now();
    for (const [
        leaseId,
        lease,
    ] of leases) {
        if (lease.expiresAt <= now) {
            if (lease.cleanupOnRelease) {
                lease.invalidated = true;
                cleanupLeaseFile(leaseId, lease);
            } else {
                unregisterLease(leaseId);
            }
        }
    }
    clearLeaseSweepIfIdle();
}

function ensureLeaseSweep() {
    leaseSweepTimer ??= setInterval(sweepExpiredLeases, 30_000);
    leaseSweepTimer.unref?.();
}

export async function createManagedTempFileHandle(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    options: {cleanupOnRelease?: boolean} = {},
): Promise<IManagedTempFileHandle> {
    const path = await resolveExistingReadableDocumentOrImagePath(filePath, context.senderId);
    const [
        inspection,
        revisionSidecar,
    ] = await Promise.all([
        fingerprintFileWithUtilityProcess(path),
        readWorkingCopyRevisionSidecar(path),
    ]);
    const leaseId = randomUUID();
    registerLease(leaseId, {
        ownerId: context.senderId,
        path,
        expiresAt: Date.now() + MANAGED_HANDLE_TTL_MS,
        cleanupOnRelease: options.cleanupOnRelease === true,
    });
    ensureLeaseSweep();
    return {
        path,
        size: inspection.bytes,
        sha256: inspection.sha256,
        leaseId,
        revision: revisionSidecar?.token ?? null,
    };
}

interface ICreateTypedStagedArtifactOptions {
    cleanupOnRelease?: boolean;
    expectedFingerprint?: {
        bytes: number;
        sha256: string;
    };
    trustedFingerprint?: {
        bytes: number;
        sha256: string;
    };
}

interface IRegisterTypedStagedArtifactOptions {
    cleanupOnRelease: boolean;
    invalidReceiptMessage: string;
}

function registerTypedStagedArtifact(
    context: IDocumentsSenderIdContext,
    candidate: unknown,
    fileStat: BigIntStats,
    options: IRegisterTypedStagedArtifactOptions,
): ITypedStagedArtifact {
    // Decode once at the contract boundary. The canonical value is both the
    // lease authority and the return value; IPC provides renderer isolation.
    const artifact = decodeTypedStagedArtifact(candidate);
    if (artifact === null) {
        throw new Error(options.invalidReceiptMessage);
    }
    const authoritativeArtifact = freezeTypedStagedArtifact(artifact);
    registerLease(authoritativeArtifact.leaseId, {
        ownerId: context.senderId,
        path: authoritativeArtifact.path,
        expiresAt: Date.now() + MANAGED_HANDLE_TTL_MS,
        cleanupOnRelease: options.cleanupOnRelease === true,
        artifact: authoritativeArtifact,
        statWitness: createArtifactStatWitness(fileStat),
        immutable: true,
    });
    ensureLeaseSweep();
    return authoritativeArtifact;
}

async function createTypedStagedArtifactAtPath(
    context: IDocumentsSenderIdContext,
    path: string,
    validations: IStagedArtifactValidations,
    options: ICreateTypedStagedArtifactOptions,
): Promise<ITypedStagedArtifact> {
    const beforeStat = await statRegularArtifact(path);
    const expectedFingerprint = options.expectedFingerprint;
    const trustedFingerprint = options.trustedFingerprint;
    const invalidFingerprint = [
        expectedFingerprint,
        trustedFingerprint,
    ].some(fingerprint => fingerprint !== undefined && (
        !Number.isSafeInteger(fingerprint.bytes)
        || fingerprint.bytes < 0
        || !/^[a-f0-9]{64}$/u.test(fingerprint.sha256)
    ));
    if (invalidFingerprint) {
        throw new Error('Invalid trusted staged artifact fingerprint');
    }
    const [
        inspection,
        revisionSidecar,
    ] = await Promise.all([
        trustedFingerprint === undefined
            ? fingerprintFileWithUtilityProcess(path)
            : Promise.resolve(trustedFingerprint),
        readWorkingCopyRevisionSidecar(path),
    ]);
    const fileStat = await statRegularArtifact(path);
    if (
        expectedFingerprint !== undefined
        && (
            inspection.bytes !== expectedFingerprint.bytes
            || inspection.sha256 !== expectedFingerprint.sha256
        )
    ) {
        throw new Error('Copied staged artifact fingerprint does not match its authoritative source');
    }
    if (
        BigInt(inspection.bytes) !== fileStat.size
        || !isDeepStrictEqual(
            createArtifactFileIdentity(beforeStat),
            createArtifactFileIdentity(fileStat),
        )
        || !isSameArtifactStatWitness(
            createArtifactStatWitness(beforeStat),
            createArtifactStatWitness(fileStat),
        )
    ) {
        throw new Error('Staged artifact changed while its receipt was being created');
    }
    const fileIdentity = createArtifactFileIdentity(fileStat);
    const leaseId = randomUUID();
    return registerTypedStagedArtifact(context, {
        receiptVersion: 1,
        artifactKind: 'pdf',
        path,
        size: inspection.bytes,
        sha256: inspection.sha256,
        fileIdentity,
        validations,
        leaseId,
        revision: revisionSidecar?.token ?? null,
    }, fileStat, {
        cleanupOnRelease: options.cleanupOnRelease === true,
        invalidReceiptMessage: 'Invalid staged artifact validation receipt',
    });
}

export async function createTypedStagedArtifact(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    validations: IStagedArtifactValidations,
    options: ICreateTypedStagedArtifactOptions = {},
): Promise<ITypedStagedArtifact> {
    const path = await resolveExistingReadableBinaryPath(filePath, context.senderId);
    return createTypedStagedArtifactAtPath(context, path, validations, options);
}

/**
 * Creates a POSIX-only native staging capability without reading the whole
 * artifact to manufacture a reusable content digest. The authoritative lease
 * keeps the private stat witness; callers can only resolve the exact file
 * object produced and validated by the main-process native operation.
 */
export async function createOpaqueNativePdfStagedArtifact(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    validations: IStagedArtifactValidations,
    options: {cleanupOnRelease?: boolean} = {},
): Promise<ITypedStagedArtifact> {
    if (process.platform === 'win32') {
        return createTypedStagedArtifact(context, filePath, validations, options);
    }
    const path = await resolveExistingReadableBinaryPath(filePath, context.senderId);
    const beforeStat = await statRegularArtifact(path);
    const revisionSidecar = await readWorkingCopyRevisionSidecar(path);
    const fileStat = await statRegularArtifact(path);
    if (
        !isDeepStrictEqual(
            createArtifactFileIdentity(beforeStat),
            createArtifactFileIdentity(fileStat),
        )
        || !isSameArtifactStatWitness(
            createArtifactStatWitness(beforeStat),
            createArtifactStatWitness(fileStat),
        )
    ) {
        throw new Error('Native staged artifact changed while its lease was being created');
    }
    const fileIdentity = createArtifactFileIdentity(fileStat);
    if (fileIdentity.platform !== 'posix') {
        throw new Error('Opaque native staged artifacts require POSIX file identity');
    }
    const size = Number(fileStat.size);
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error('Native staged artifact size exceeds the supported integer range');
    }
    const leaseId = randomUUID();
    return registerTypedStagedArtifact(context, {
        receiptVersion: 2,
        artifactKind: 'pdf',
        path,
        size,
        fileIdentity,
        validations,
        leaseId,
        revision: revisionSidecar?.token ?? null,
    }, fileStat, {
        cleanupOnRelease: options.cleanupOnRelease === true,
        invalidReceiptMessage: 'Invalid opaque native staged artifact receipt',
    });
}

export async function createTypedStagedArtifactForTrustedSiblingCopy(
    context: IDocumentsSenderIdContext,
    sourceArtifact: ITypedStagedArtifact,
    copiedPath: string,
    originalPath: string,
    validations: IStagedArtifactValidations,
): Promise<ITypedStagedArtifact> {
    const authoritativeSource = await resolveTypedStagedArtifact(context, sourceArtifact);
    if (authoritativeSource.receiptVersion !== 1) {
        throw new Error('Opaque native staged artifacts cannot authorize trusted fingerprint copies');
    }
    if (
        !isAbsolute(copiedPath)
        || !isAllowedOriginalSavePath(originalPath)
        || dirname(copiedPath) !== dirname(originalPath)
        || !/^\.[a-f0-9]+\.tmp\.pdf$/u.test(basename(copiedPath))
    ) {
        throw new Error('Trusted staged PDF copy must be a generated sibling of the original path');
    }
    const expectedFingerprint = {
        bytes: authoritativeSource.size,
        sha256: authoritativeSource.sha256,
    };
    return createTypedStagedArtifactAtPath(context, copiedPath, validations, {expectedFingerprint});
}

export function releaseManagedTempFileHandle(
    context: IDocumentsSenderIdContext,
    leaseId: unknown,
) {
    if (typeof leaseId !== 'string' || leaseId.length === 0) {
        return false;
    }
    const lease = leases.get(leaseId);
    if (!lease || lease.ownerId !== context.senderId) {
        return false;
    }
    if (lease.cleanupOnRelease) {
        lease.invalidated = true;
        cleanupLeaseFile(leaseId, lease);
    } else {
        unregisterLease(leaseId);
    }
    sweepExpiredLeases();
    return true;
}

export async function resolveManagedTempFileHandle(
    context: IDocumentsSenderIdContext,
    value: unknown,
): Promise<IManagedTempFileHandle> {
    const handle = decodeManagedTempFileHandle(value);
    if (!handle) {
        throw new Error('Invalid managed binary handle');
    }
    sweepExpiredLeases();
    const lease = leases.get(handle.leaseId);
    if (!lease || lease.invalidated || 'artifact' in lease || lease.ownerId !== context.senderId || lease.path !== handle.path) {
        throw new Error('Managed binary handle lease is missing, expired, or belongs to another renderer');
    }
    const [
        inspection,
        revisionSidecar,
    ] = await Promise.all([
        fingerprintFileWithUtilityProcess(handle.path),
        readWorkingCopyRevisionSidecar(handle.path),
    ]);
    const revision = revisionSidecar?.token ?? null;
    if (inspection.bytes !== handle.size || inspection.sha256 !== handle.sha256 || revision !== handle.revision) {
        throw new Error('Managed binary handle content or revision changed after staging');
    }
    lease.expiresAt = Date.now() + MANAGED_HANDLE_TTL_MS;
    return handle;
}

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
    const revisionSidecar = await readWorkingCopyRevisionSidecar(lease.path);
    const revisionMatches = (revisionSidecar?.token ?? null) === lease.artifact.revision;
    if (!identityMatches || !witnessMatches || !revisionMatches) {
        invalidateStagedArtifactLease(artifact.leaseId);
        throw new Error('Staged artifact content, identity, or revision changed after staging');
    }
    if (process.platform === 'win32') {
        if (lease.artifact.receiptVersion !== 1) {
            invalidateStagedArtifactLease(artifact.leaseId);
            throw new Error('Opaque native staged artifacts are not supported on Windows');
        }
        const inspection = await fingerprintFileWithUtilityProcess(lease.path);
        if (
            inspection.bytes !== lease.artifact.size
            || inspection.sha256 !== lease.artifact.sha256
        ) {
            invalidateStagedArtifactLease(artifact.leaseId);
            throw new Error('Staged artifact content, identity, or revision changed after staging');
        }
    }
    lease.expiresAt = Date.now() + MANAGED_HANDLE_TTL_MS;
    return cloneTypedStagedArtifact(lease.artifact);
}

export async function rebindTypedStagedArtifactPath(
    context: IDocumentsSenderIdContext,
    artifact: ITypedStagedArtifact,
    nextFilePath: unknown,
): Promise<ITypedStagedArtifact> {
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
    const nextPath = await resolveExistingReadableBinaryPath(nextFilePath, context.senderId);
    const [
        fileStat,
        revisionSidecar,
    ] = await Promise.all([
        statRegularArtifact(nextPath),
        readWorkingCopyRevisionSidecar(nextPath),
    ]);
    const statWitness = createArtifactStatWitness(fileStat);
    const witnessMatches = isSameArtifactStatWitness(statWitness, lease.statWitness);
    if (
        !isDeepStrictEqual(createArtifactFileIdentity(fileStat), lease.artifact.fileIdentity)
        || (revisionSidecar?.token ?? null) !== lease.artifact.revision
    ) {
        invalidateStagedArtifactLease(artifact.leaseId);
        throw new Error('Renamed staged artifact no longer matches its authoritative receipt');
    }
    if (!witnessMatches || process.platform === 'win32') {
        if (lease.artifact.receiptVersion !== 1) {
            invalidateStagedArtifactLease(artifact.leaseId);
            throw new Error('Renamed opaque native staged artifact changed after staging');
        }
        const inspection = await fingerprintFileWithUtilityProcess(nextPath);
        if (
            inspection.bytes !== lease.artifact.size
            || inspection.sha256 !== lease.artifact.sha256
        ) {
            invalidateStagedArtifactLease(artifact.leaseId);
            throw new Error('Renamed staged artifact no longer matches its authoritative receipt');
        }
    }
    const reboundArtifact = cloneTypedStagedArtifact({
        ...lease.artifact,
        path: nextPath,
    });
    lease.path = nextPath;
    registerLeasePath(artifact.leaseId, nextPath);
    lease.artifact = freezeTypedStagedArtifact(cloneTypedStagedArtifact(reboundArtifact));
    lease.statWitness = statWitness;
    lease.expiresAt = Date.now() + MANAGED_HANDLE_TTL_MS;
    return reboundArtifact;
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
        if (lease.ownerId !== senderId) {
            continue;
        }
        if (lease.cleanupOnRelease) {
            lease.invalidated = true;
            cleanupLeaseFile(leaseId, lease);
        } else {
            unregisterLease(leaseId);
        }
    }
    sweepExpiredLeases();
}

export function getManagedTempFileCleanupStateForTests(leaseId: string) {
    const lease = leases.get(leaseId);
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
