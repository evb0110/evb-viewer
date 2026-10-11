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
    constructor() {
        super('Original file changed on disk; save skipped to avoid overwriting external edits');
        this.name = 'OriginalPathSaveConflictError';
    }
}

export function snapshotsMatch(
    left: IOriginalPathSaveSnapshot,
    right: IOriginalPathSaveSnapshot,
    options: {
        allowBackupMetadataChange?: boolean;
        contentOnly?: boolean;
    } = {},
) {
    return (options.contentOnly === true || (
        left.deviceId === right.deviceId
        && left.inode === right.inode
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
    const numericSize = Number(size);
    if (!Number.isSafeInteger(numericSize) || numericSize < 0) {
        throw new OriginalPathSaveConflictError();
    }
    const hash = createOriginalFileContentFingerprintHash(numericSize);
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

export async function capturePathSnapshot(originalPath: string) {
    const before = await lstat(originalPath, {bigint: true});
    if (!before.isFile()) {
        throw new OriginalPathSaveConflictError();
    }
    const sampleSha256 = await sampleFilePath(originalPath, before.size);
    const after = await lstat(originalPath, {bigint: true});
    const snapshot = createSnapshot(after, sampleSha256);
    if (!after.isFile() || !snapshotsMatch(createSnapshot(before, sampleSha256), snapshot, {allowBackupMetadataChange: true})) {
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
        ctimeNs?: string
    },
    signal?: AbortSignal,
) {
    const snapshot = await capturePathSnapshot(originalPath);
    snapshot.contentFingerprint = baseline?.contentFingerprint !== undefined && baseline.ctimeNs === snapshot.ctimeNs.toString()
        ? baseline.contentFingerprint
        : await hashContentFingerprintFilePath(originalPath, snapshot.size, signal);
    return snapshot;
}

/**
 * What proves that a ctime move during a rebase left the content alone.
 *
 * - `own-backup-link`: the save's backup hard link. It adds exactly one name,
 *   and the admitted fingerprint stays valid because the save checked ctime
 *   right before linking; no byte is read.
 * - `open-copy`: an open's working copy moved the original's ctime while it was
 *   made. `source` is the copy's full-content fingerprint (eager copy) or the
 *   clone to hash (cloned copy); the original is read once and must match it.
 *   Without a source (a lazy copy) the move cannot be proven and is refused.
 * - `open-rewrite`: the working copy was rewritten from the original (qpdf).
 *   The rewrite's bytes are not the original's, so only the sampled check
 *   applies. A rewrite that reads every byte cannot give back a hash here.
 */
export type TOriginalRebaseProof =
    | {kind: 'own-backup-link'}
    | {
        kind: 'open-copy';
        source: {contentFingerprint: string} | {path: string} | null
    }
    | {kind: 'open-rewrite'};

/**
 * Rebases an admitted snapshot after a metadata change that is not a content
 * change. Sampling does not see an interior in-place edit, and that edit moves
 * ctime, so a moved ctime is accepted only with the proof its caller names.
 */
export async function rebaseUnchangedSnapshot(
    originalPath: string,
    admitted: IOriginalPathSaveSnapshot,
    proof: TOriginalRebaseProof,
): Promise<IOriginalPathSaveSnapshot> {
    const snapshot = await capturePathSnapshot(originalPath);
    if (!snapshotsMatch(admitted, snapshot, {allowBackupMetadataChange: true})) {
        throw new OriginalPathSaveConflictError();
    }
    const ctimeMoved = admitted.ctimeNs !== snapshot.ctimeNs;
    const linkCountMoved = admitted.linkCount !== snapshot.linkCount;
    if (proof.kind === 'own-backup-link') {
        if ((ctimeMoved || linkCountMoved) && snapshot.linkCount !== admitted.linkCount + 1n) {
            throw new OriginalPathSaveConflictError();
        }
        if (admitted.contentFingerprint !== undefined) {
            snapshot.contentFingerprint = admitted.contentFingerprint;
        }
        return snapshot;
    }
    if (linkCountMoved) {
        throw new OriginalPathSaveConflictError();
    }
    if (ctimeMoved && proof.kind === 'open-copy') {
        const source = proof.source;
        const sourceFingerprint = source === null
            ? undefined
            : 'contentFingerprint' in source
                ? source.contentFingerprint
                : await hashContentFingerprintFilePath(source.path, snapshot.size);
        if (sourceFingerprint === undefined || sourceFingerprint !== await hashContentFingerprintFilePath(originalPath, snapshot.size)) {
            throw new OriginalPathSaveConflictError();
        }
    }
    return snapshot;
}
