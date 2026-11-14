import {createHash} from 'node:crypto';
import type {BigIntStats} from 'node:fs';
import {lstat} from 'node:fs/promises';
import * as v from 'valibot';
import {readFileChunk} from '@electron/file-access/readFileChunk';

const SAVE_WITNESS_SAMPLE_BYTES = 64 * 1024;

const journalSnapshotSchema = v.object({
    ctimeNs: v.string(),
    deviceId: v.string(),
    inode: v.string(),
    linkCount: v.string(),
    mtimeNs: v.string(),
    sampleSha256: v.string(),
    size: v.string(),
});

/** A file's identity and sampled content, as a replacement journal records it. */
export type IOriginalPathSaveJournalSnapshot = v.InferOutput<typeof journalSnapshotSchema>;

export interface IOriginalPathSaveSnapshot {
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

export function deserializeSnapshot(value: unknown): IOriginalPathSaveSnapshot | null {
    const parsed = v.safeParse(journalSnapshotSchema, value);
    if (!parsed.success) {
        return null;
    }
    const candidate = parsed.output;
    try {
        return {
            ctimeNs: BigInt(candidate.ctimeNs),
            deviceId: BigInt(candidate.deviceId),
            inode: BigInt(candidate.inode),
            linkCount: BigInt(candidate.linkCount),
            mtimeNs: BigInt(candidate.mtimeNs),
            sampleSha256: candidate.sampleSha256,
            size: BigInt(candidate.size),
        };
    } catch {
        return null;
    }
}
