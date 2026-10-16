import {createHash} from 'node:crypto';
import type {BigIntStats} from 'node:fs';
import {lstat} from 'node:fs/promises';
import type * as v from 'valibot';
import type {originalSaveSnapshotSchema} from '@electron/file-access/readWorkingCopyManifest';
import {createOriginalFileContentFingerprintHash} from '@electron/file-access/createOriginalFileContentFingerprintHash';
import {readFileChunk} from '@electron/file-access/readFileChunk';

const SAVE_WITNESS_SAMPLE_BYTES = 64 * 1024;
const SAVE_WITNESS_HASH_CHUNK_BYTES = 1024 * 1024;

export interface IOriginalPathSaveJournalSnapshot extends v.InferOutput<typeof originalSaveSnapshotSchema> {}

export interface IOriginalPathSaveSnapshot {
    contentFingerprint?: string;
    ctimeNs: bigint;
    deviceId: bigint;
    inode: bigint;
    linkCount: bigint;
    mtimeNs: bigint;
    sampleSha256: string;
    size: bigint;
}

export class OriginalPathSaveConflictError extends Error {
    constructor(readonly keptFilePath?: string) {
        super(keptFilePath ? `The original changed elsewhere. A version was kept at ${keptFilePath}`
            : 'Original file changed on disk; save skipped to avoid overwriting external edits');
        this.name = 'OriginalPathSaveConflictError';
    }
}

export function snapshotsMatch(
    left: IOriginalPathSaveSnapshot,
    right: IOriginalPathSaveSnapshot,
    options: {
        allowBackupMetadataChange?: boolean;
        contentOnly?: boolean;
        ignoreIdentity?: boolean;
    } = {},
) {
    return (options.contentOnly === true || (
        (options.ignoreIdentity === true || left.deviceId === right.deviceId && left.inode === right.inode)
        && left.mtimeNs === right.mtimeNs
    ))
        && left.sampleSha256 === right.sampleSha256
        && left.size === right.size
        && (options.contentOnly === true || options.allowBackupMetadataChange === true || (
            left.ctimeNs === right.ctimeNs
            && left.linkCount === right.linkCount
        ));
}

async function sampleFilePath(originalPath: string, size: bigint) {
    const numericSize = Number(size);
    if (!Number.isSafeInteger(numericSize) || numericSize < 0) {
        throw new OriginalPathSaveConflictError();
    }
    const sampleLength = Math.min(numericSize, SAVE_WITNESS_SAMPLE_BYTES);
    const lastOffset = numericSize - sampleLength;
    const offsets = [...new Set([
        0,
        Math.floor(lastOffset / 2),
        lastOffset,
    ])];
    const hash = createHash('sha256');
    for (const offset of offsets) {
        const sample = Buffer.allocUnsafe(sampleLength);
        const bytesRead = await readFileChunk(originalPath, sample, offset);
        if (bytesRead !== sampleLength) {
            throw new OriginalPathSaveConflictError();
        }
        hash.update(`${offset}:${bytesRead}:`);
        hash.update(sample);
    }
    return hash.digest('hex');
}

async function hashFilePath(
    originalPath: string,
    size: bigint,
    hash: ReturnType<typeof createHash>,
    signal?: AbortSignal,
) {
    const numericSize = Number(size);
    if (!Number.isSafeInteger(numericSize) || numericSize < 0) {
        throw new OriginalPathSaveConflictError();
    }
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(numericSize, SAVE_WITNESS_HASH_CHUNK_BYTES)));
    let offset = 0;
    while (offset < numericSize) {
        signal?.throwIfAborted();
        const length = Math.min(buffer.byteLength, numericSize - offset);
        let readOffset = 0;
        while (readOffset < length) {
            const bytesRead = await readFileChunk(originalPath, buffer.subarray(readOffset, length), offset + readOffset);
            if (bytesRead <= 0) {
                throw new OriginalPathSaveConflictError();
            }
            hash.update(buffer.subarray(readOffset, readOffset + bytesRead));
            readOffset += bytesRead;
        }
        signal?.throwIfAborted();
        offset += length;
    }
    return hash.digest('hex');
}

export async function hashContentFingerprintFilePath(originalPath: string, size: bigint, signal?: AbortSignal) {
    const hash = createOriginalFileContentFingerprintHash(Number(size));
    return `sha256-full-v1:${await hashFilePath(originalPath, size, hash, signal)}`;
}

function createSnapshot(
    fileStat: BigIntStats,
    sampleSha256: string,
): IOriginalPathSaveSnapshot {
    return {
        ctimeNs: fileStat.ctimeNs,
        deviceId: fileStat.dev,
        inode: fileStat.ino,
        linkCount: fileStat.nlink,
        mtimeNs: fileStat.mtimeNs,
        sampleSha256,
        size: fileStat.size,
    };
}

export function serializeSnapshot(snapshot: IOriginalPathSaveSnapshot): IOriginalPathSaveJournalSnapshot {
    return {
        ...(snapshot.contentFingerprint ? {contentFingerprint: snapshot.contentFingerprint} : {}),
        ctimeNs: snapshot.ctimeNs.toString(),
        deviceId: snapshot.deviceId.toString(),
        inode: snapshot.inode.toString(),
        linkCount: snapshot.linkCount.toString(),
        mtimeNs: snapshot.mtimeNs.toString(),
        sampleSha256: snapshot.sampleSha256,
        size: snapshot.size.toString(),
    };
}

export async function capturePathSnapshot(originalPath: string, options: {ignoreIdentity?: boolean} = {}) {
    const before = await lstat(originalPath, {bigint: true});
    if (!before.isFile()) {
        throw new OriginalPathSaveConflictError();
    }
    const sampleSha256 = await sampleFilePath(originalPath, before.size);
    const after = await lstat(originalPath, {bigint: true});
    const snapshot = createSnapshot(after, sampleSha256);
    if (!after.isFile() || !snapshotsMatch(createSnapshot(before, sampleSha256), snapshot, {
        ...options,
        allowBackupMetadataChange: true,
    })) {
        throw new OriginalPathSaveConflictError();
    }
    return snapshot;
}

/**
 * A snapshot with the full-content fingerprint of the bytes it covers. A
 * baseline's fingerprint stands for the current bytes only while its ctime is
 * the current ctime, since every write moves ctime; otherwise the bytes are read.
 */
export async function captureAdmittedPathSnapshot(
    originalPath: string,
    baseline?: {
        contentFingerprint?: string;
        ctimeNs?: string;
        deviceId?: string;
        inode?: string;
        mtimeNs?: string;
        size?: number;
    },
    signal?: AbortSignal,
) {
    const options = {ignoreIdentity: baseline?.contentFingerprint !== undefined && (process.platform !== 'win32' || baseline.deviceId === undefined || baseline.inode === undefined)};
    const snapshot = await capturePathSnapshot(originalPath, options);
    const canReuse = baseline?.contentFingerprint !== undefined
        && baseline.ctimeNs === snapshot.ctimeNs.toString()
        && baseline.deviceId === snapshot.deviceId.toString()
        && baseline.inode === snapshot.inode.toString()
        && baseline.mtimeNs === snapshot.mtimeNs.toString()
        && baseline.size === Number(snapshot.size);
    snapshot.contentFingerprint = (canReuse ? baseline?.contentFingerprint : undefined)
        ?? await hashContentFingerprintFilePath(originalPath, snapshot.size, signal);
    if (!snapshotsMatch(snapshot, await capturePathSnapshot(originalPath, options), options)) {
        throw new OriginalPathSaveConflictError();
    }
    return snapshot;
}

/**
 * What proves that a ctime move during a rebase left the content alone.
 *
 * - `own-backup-link`: compare the original with its admitted full baseline.
 *   A hard link shares a writable inode and cannot prove unchanged content.
 * - `open-copy`: compare the raw copy's fingerprint (or hash its clone) with
 *   one fresh read of the original. Without raw proof, refuse a ctime move.
 */
export type TOriginalRebaseProof =
    | {kind: 'own-backup-link'}
    | {
        kind: 'open-copy';
        source: {contentFingerprint: string} | {path: string} | null
    };

/**
 * Rebases an admitted snapshot after a metadata change that is not a content
 * change. Sampling does not see an interior in-place edit, and that edit moves
 * ctime, so a moved ctime is accepted only with the proof its caller names.
 */
export async function rebaseUnchangedSnapshot(
    originalPath: string,
    admitted: IOriginalPathSaveSnapshot,
    proof: TOriginalRebaseProof,
    signal?: AbortSignal,
): Promise<IOriginalPathSaveSnapshot> {
    const options = {ignoreIdentity: admitted.contentFingerprint !== undefined
        || proof.kind === 'open-copy' && proof.source !== null};
    const snapshot = await capturePathSnapshot(originalPath, options);
    if (!snapshotsMatch(admitted, snapshot, {
        ...options,
        allowBackupMetadataChange: true,
    })) {
        throw new OriginalPathSaveConflictError();
    }
    const ctimeMoved = admitted.ctimeNs !== snapshot.ctimeNs;
    const identityMoved = admitted.deviceId !== snapshot.deviceId || admitted.inode !== snapshot.inode;
    const source = proof.kind === 'own-backup-link' ? {contentFingerprint: admitted.contentFingerprint} : proof.source;
    const fingerprint = admitted.contentFingerprint
        ?? (source && 'contentFingerprint' in source ? source.contentFingerprint : undefined);
    if (fingerprint !== undefined) snapshot.contentFingerprint = fingerprint;
    if (ctimeMoved || identityMoved) {
        const sourceFingerprint = source && ('contentFingerprint' in source
            ? source.contentFingerprint : await hashContentFingerprintFilePath(source.path, snapshot.size, signal));
        if (sourceFingerprint == null
            || sourceFingerprint !== await hashContentFingerprintFilePath(originalPath, snapshot.size, signal)
            || !snapshotsMatch(snapshot, await capturePathSnapshot(originalPath, options), options)) {
            throw new OriginalPathSaveConflictError();
        }
        snapshot.contentFingerprint = sourceFingerprint;
    }
    return snapshot;
}
