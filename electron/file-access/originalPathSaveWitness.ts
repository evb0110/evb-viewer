import {createHash} from 'node:crypto';
import type {BigIntStats} from 'node:fs';
import {
    open,
    stat,
    type FileHandle,
} from 'node:fs/promises';
import {
    getWorkingCopyBackingEntry,
    getWorkingCopyOriginalFileExpectation,
    refreshWorkingCopyOriginalFileExpectation,
    type IWorkingCopyOriginalFileExpectation,
} from '@electron/file-access/workingCopyStore';
import {createOriginalFileContentFingerprintHash} from '@electron/file-access/createOriginalFileContentFingerprintHash';
import {isErrnoException} from '@contracts/runtimeGuards';

const SAVE_WITNESS_SAMPLE_BYTES = 64 * 1024;
// Windows does not expose a portable change-time signal that survives every
// same-size in-place rewrite. Hash small files fully, while keeping large
// document saves bounded by the existing sample strategy.
const SAVE_WITNESS_FULL_HASH_MAX_BYTES = 64 * 1024 * 1024;
const SAVE_WITNESS_HASH_CHUNK_BYTES = 1024 * 1024;

interface IOriginalPathSaveSnapshot {
    ctimeNs: bigint;
    deviceId: bigint;
    inode: bigint;
    linkCount: bigint;
    mtimeNs: bigint;
    fullSha256?: string;
    sampleSha256: string;
    size: bigint;
}

export interface IOriginalPathSaveJournalSnapshot {
    ctimeNs: string;
    deviceId: string;
    inode: string;
    linkCount: string;
    mtimeNs: string;
    fullSha256?: string;
    sampleSha256: string;
    size: string;
}

export class OriginalPathSaveConflictError extends Error {
    constructor() {
        super('Original file changed on disk; save skipped to avoid overwriting external edits');
        this.name = 'OriginalPathSaveConflictError';
    }
}

export interface IOriginalPathSaveWitness {
    assertCurrent: (options?: {allowBackupMetadataChange?: boolean}) => Promise<void>;
    close: () => Promise<void>;
    getSnapshotForJournal: () => IOriginalPathSaveJournalSnapshot;
    rebaseAfterBackup: () => Promise<void>;
    rebaseAfterPublish: () => Promise<void>;
}

function expectationMatchesStat(
    expected: IWorkingCopyOriginalFileExpectation,
    actual: BigIntStats,
) {
    const matches = {
        ctime: expected.ctimeNs === undefined || actual.ctimeNs.toString() === expected.ctimeNs,
        device: expected.deviceId === undefined || actual.dev.toString() === expected.deviceId,
        file: actual.isFile(),
        inode: expected.inode === undefined || actual.ino.toString() === expected.inode,
        mtime: expected.mtimeNs === undefined || actual.mtimeNs.toString() === expected.mtimeNs,
        size: actual.size === BigInt(expected.size),
    };
    if (Object.values(matches).includes(false)) {
        return false;
    }

    return expected.mtimeNs !== undefined
        || Math.abs(Number(actual.mtimeNs) / 1_000_000 - expected.mtimeMs) < 1;
}

function hasImmutablePosixExpectation(expected: IWorkingCopyOriginalFileExpectation) {
    return expected.deviceId !== undefined
        && expected.inode !== undefined
        && expected.ctimeNs !== undefined
        && expected.mtimeNs !== undefined;
}

function isExpectationUsableForCurrentPlatform(expected: IWorkingCopyOriginalFileExpectation) {
    // Older recovery checkpoints can contain only size and mtime. Those
    // fields cannot distinguish an unseen same-size interior edit on POSIX.
    // Windows retains its legacy compatibility path and its bounded full
    // fingerprint path where available.
    return process.platform === 'win32' || hasImmutablePosixExpectation(expected);
}

function snapshotsMatch(
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
        && (left.fullSha256 === undefined
            || right.fullSha256 === undefined
            || left.fullSha256 === right.fullSha256)
        && left.sampleSha256 === right.sampleSha256
        && left.size === right.size
        && (options.contentOnly === true || options.allowBackupMetadataChange === true || (
            left.ctimeNs === right.ctimeNs
            && left.linkCount === right.linkCount
        ));
}

async function sampleFileHandle(handle: FileHandle, size: bigint) {
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
        const {bytesRead} = await handle.read(sample, 0, sampleLength, offset);
        if (bytesRead !== sampleLength) {
            throw new OriginalPathSaveConflictError();
        }
        hash.update(`${offset}:${bytesRead}:`);
        hash.update(sample);
    }
    return hash.digest('hex');
}

async function hashWholeFileHandle(handle: FileHandle, size: bigint) {
    return hashFileHandle(handle, size, createHash('sha256'));
}

async function hashFileHandle(
    handle: FileHandle,
    size: bigint,
    hash: ReturnType<typeof createHash>,
) {
    const numericSize = Number(size);
    if (!Number.isSafeInteger(numericSize) || numericSize < 0) {
        throw new OriginalPathSaveConflictError();
    }
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(numericSize, SAVE_WITNESS_HASH_CHUNK_BYTES)));
    let offset = 0;
    while (offset < numericSize) {
        const length = Math.min(buffer.byteLength, numericSize - offset);
        let readOffset = 0;
        while (readOffset < length) {
            const {bytesRead} = await handle.read(buffer, readOffset, length - readOffset, offset + readOffset);
            if (bytesRead <= 0) {
                throw new OriginalPathSaveConflictError();
            }
            hash.update(buffer.subarray(readOffset, readOffset + bytesRead));
            readOffset += bytesRead;
        }
        offset += length;
    }
    return hash.digest('hex');
}

async function hashContentFingerprintFileHandle(handle: FileHandle, size: bigint) {
    const numericSize = Number(size);
    if (!Number.isSafeInteger(numericSize) || numericSize < 0) {
        throw new OriginalPathSaveConflictError();
    }
    const hash = createOriginalFileContentFingerprintHash(numericSize);
    return `sha256-full-v1:${await hashFileHandle(handle, size, hash)}`;
}

async function matchesExpectedContentFingerprint(
    originalPath: string,
    expected: IWorkingCopyOriginalFileExpectation,
    admittedStat: BigIntStats,
) {
    if (
        process.platform !== 'win32'
        || expected.contentFingerprint === undefined
        || admittedStat.size > BigInt(SAVE_WITNESS_FULL_HASH_MAX_BYTES)
    ) {
        return true;
    }
    if (!/^sha256-full-v1:[0-9a-f]{64}$/u.test(expected.contentFingerprint)) {
        return false;
    }

    let handle: FileHandle;
    try {
        handle = await open(originalPath, 'r');
    } catch {
        return false;
    }
    try {
        const before = await handle.stat({bigint: true});
        if (
            !before.isFile()
            || before.size !== admittedStat.size
            || before.dev !== admittedStat.dev
            || before.ino !== admittedStat.ino
        ) {
            return false;
        }
        const actualFingerprint = await hashContentFingerprintFileHandle(handle, before.size);
        const after = await handle.stat({bigint: true});
        if (
            after.size !== before.size
            || after.dev !== before.dev
            || after.ino !== before.ino
            || after.mtimeNs !== before.mtimeNs
            || after.ctimeNs !== before.ctimeNs
        ) {
            return false;
        }
        return actualFingerprint === expected.contentFingerprint;
    } catch {
        return false;
    } finally {
        await handle.close().catch(() => undefined);
    }
}

async function captureHandleSnapshot(handle: FileHandle): Promise<IOriginalPathSaveSnapshot> {
    const before = await handle.stat({bigint: true});
    if (!before.isFile()) {
        throw new OriginalPathSaveConflictError();
    }
    const sampleSha256 = await sampleFileHandle(handle, before.size);
    const fullSha256 = process.platform === 'win32' && before.size <= BigInt(SAVE_WITNESS_FULL_HASH_MAX_BYTES)
        ? await hashWholeFileHandle(handle, before.size)
        : undefined;
    const after = await handle.stat({bigint: true});
    const beforeSnapshot = createSnapshot(before, sampleSha256, fullSha256);
    const afterSnapshot = createSnapshot(after, sampleSha256, fullSha256);
    if (!snapshotsMatch(beforeSnapshot, afterSnapshot)) {
        throw new OriginalPathSaveConflictError();
    }
    return afterSnapshot;
}

function createSnapshot(
    fileStat: BigIntStats,
    sampleSha256: string,
    fullSha256?: string,
): IOriginalPathSaveSnapshot {
    return {
        ctimeNs: fileStat.ctimeNs,
        deviceId: fileStat.dev,
        inode: fileStat.ino,
        linkCount: fileStat.nlink,
        mtimeNs: fileStat.mtimeNs,
        ...(fullSha256 === undefined ? {} : {fullSha256}),
        sampleSha256,
        size: fileStat.size,
    };
}

function serializeSnapshot(snapshot: IOriginalPathSaveSnapshot): IOriginalPathSaveJournalSnapshot {
    return {
        ctimeNs: snapshot.ctimeNs.toString(),
        deviceId: snapshot.deviceId.toString(),
        inode: snapshot.inode.toString(),
        linkCount: snapshot.linkCount.toString(),
        mtimeNs: snapshot.mtimeNs.toString(),
        ...(snapshot.fullSha256 === undefined ? {} : {fullSha256: snapshot.fullSha256}),
        sampleSha256: snapshot.sampleSha256,
        size: snapshot.size.toString(),
    };
}

function deserializeSnapshot(value: unknown): IOriginalPathSaveSnapshot | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const candidate = value as Record<string, unknown>;
    const fields = [
        'ctimeNs',
        'deviceId',
        'inode',
        'linkCount',
        'mtimeNs',
        'sampleSha256',
        'size',
    ] as const;
    if (fields.some(field => typeof candidate[field] !== 'string')) {
        return null;
    }
    if (candidate.fullSha256 !== undefined && typeof candidate.fullSha256 !== 'string') {
        return null;
    }
    try {
        return {
            ctimeNs: BigInt(candidate.ctimeNs as string),
            deviceId: BigInt(candidate.deviceId as string),
            inode: BigInt(candidate.inode as string),
            linkCount: BigInt(candidate.linkCount as string),
            mtimeNs: BigInt(candidate.mtimeNs as string),
            ...(candidate.fullSha256 === undefined ? {} : {fullSha256: candidate.fullSha256}),
            sampleSha256: candidate.sampleSha256 as string,
            size: BigInt(candidate.size as string),
        };
    } catch {
        return null;
    }
}

async function capturePathSnapshot(originalPath: string) {
    const pathHandle = await open(originalPath, 'r');
    try {
        return await captureHandleSnapshot(pathHandle);
    } finally {
        await pathHandle.close().catch(() => undefined);
    }
}

function rethrowWitnessSnapshotError(error: unknown): never {
    if (error instanceof OriginalPathSaveConflictError) {
        throw error;
    }
    if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        throw new OriginalPathSaveConflictError();
    }
    throw error;
}

class OriginalPathSaveWitness implements IOriginalPathSaveWitness {
    private snapshot: IOriginalPathSaveSnapshot;

    constructor(
        private readonly originalPath: string,
        private handle: FileHandle,
        snapshot: IOriginalPathSaveSnapshot,
    ) {
        this.snapshot = snapshot;
    }

    async assertCurrent(options: {allowBackupMetadataChange?: boolean} = {}) {
        try {
            const [
                handleSnapshot,
                pathSnapshot,
            ] = await Promise.all([
                captureHandleSnapshot(this.handle),
                capturePathSnapshot(this.originalPath),
            ]);
            if (
                !snapshotsMatch(this.snapshot, handleSnapshot, options)
                || !snapshotsMatch(this.snapshot, pathSnapshot, options)
            ) {
                throw new OriginalPathSaveConflictError();
            }
        } catch (error) {
            rethrowWitnessSnapshotError(error);
        }
    }

    async rebaseAfterBackup() {
        try {
            const [
                handleSnapshot,
                pathSnapshot,
            ] = await Promise.all([
                captureHandleSnapshot(this.handle),
                capturePathSnapshot(this.originalPath),
            ]);
            if (
                !snapshotsMatch(this.snapshot, handleSnapshot, {allowBackupMetadataChange: true})
                || !snapshotsMatch(handleSnapshot, pathSnapshot)
            ) {
                throw new OriginalPathSaveConflictError();
            }
            this.snapshot = handleSnapshot;
        } catch (error) {
            rethrowWitnessSnapshotError(error);
        }
    }

    async rebaseAfterPublish() {
        let nextHandle: FileHandle | null = null;
        try {
            nextHandle = await open(this.originalPath, 'r');
            const nextSnapshot = await captureHandleSnapshot(nextHandle);
            const pathSnapshot = await capturePathSnapshot(this.originalPath);
            if (!snapshotsMatch(nextSnapshot, pathSnapshot)) {
                throw new OriginalPathSaveConflictError();
            }
            const previousHandle = this.handle;
            this.handle = nextHandle;
            this.snapshot = nextSnapshot;
            nextHandle = null;
            await previousHandle.close().catch(() => undefined);
        } catch (error) {
            await nextHandle?.close().catch(() => undefined);
            rethrowWitnessSnapshotError(error);
        }
    }

    getSnapshotForJournal() {
        return serializeSnapshot(this.snapshot);
    }

    async close() {
        await this.handle.close().catch(() => undefined);
    }
}

export async function assertPathMatchesSaveWitnessSnapshot(
    originalPath: string,
    expected: IOriginalPathSaveJournalSnapshot,
    options: {
        allowBackupMetadataChange?: boolean;
        contentOnly?: boolean;
    } = {},
) {
    const expectedSnapshot = deserializeSnapshot(expected);
    if (!expectedSnapshot) {
        throw new OriginalPathSaveConflictError();
    }
    try {
        const actualSnapshot = await capturePathSnapshot(originalPath);
        if (!snapshotsMatch(expectedSnapshot, actualSnapshot, options)) {
            throw new OriginalPathSaveConflictError();
        }
    } catch (error) {
        rethrowWitnessSnapshotError(error);
    }
}

export async function capturePathSaveWitness(
    originalPath: string,
): Promise<IOriginalPathSaveWitness | null> {
    let handle: FileHandle;
    try {
        handle = await open(originalPath, 'r');
    } catch {
        return null;
    }
    try {
        const snapshot = await captureHandleSnapshot(handle);
        const pathSnapshot = await capturePathSnapshot(originalPath);
        if (!snapshotsMatch(snapshot, pathSnapshot)) {
            throw new OriginalPathSaveConflictError();
        }
        return new OriginalPathSaveWitness(originalPath, handle, snapshot);
    } catch {
        await handle.close().catch(() => undefined);
        return null;
    }
}

export async function captureOriginalPathSaveWitness(
    workingPath: string,
    originalPath: string,
    senderWebContentsId: number,
): Promise<IOriginalPathSaveWitness | null> {
    let expected = getWorkingCopyOriginalFileExpectation(workingPath, senderWebContentsId);
    if (!expected || !isExpectationUsableForCurrentPlatform(expected)) {
        return null;
    }

    let handle: FileHandle;
    try {
        handle = await open(originalPath, 'r');
    } catch {
        return null;
    }
    try {
        const snapshot = await captureHandleSnapshot(handle);
        const handleStat = await handle.stat({bigint: true});
        let contentFingerprintVerified = false;
        if (!expectationMatchesStat(expected, handleStat)) {
            if (
                process.platform === 'win32'
                && expected.contentFingerprint !== undefined
                && handleStat.isFile()
                && handleStat.size <= BigInt(SAVE_WITNESS_FULL_HASH_MAX_BYTES)
            ) {
                contentFingerprintVerified = await matchesExpectedContentFingerprint(
                    originalPath,
                    expected,
                    handleStat,
                );
            }
            if (!contentFingerprintVerified) {
                const restored = await restoreAppPublishedOriginalExpectation(
                    workingPath,
                    originalPath,
                    senderWebContentsId,
                    expected,
                    handleStat,
                );
                if (!restored) {
                    await handle.close().catch(() => undefined);
                    return null;
                }
                expected = restored;
            }
        }
        if (!contentFingerprintVerified && !await matchesExpectedContentFingerprint(originalPath, expected, handleStat)) {
            await handle.close().catch(() => undefined);
            return null;
        }
        const pathSnapshot = await capturePathSnapshot(originalPath);
        if (!snapshotsMatch(snapshot, pathSnapshot)) {
            await handle.close().catch(() => undefined);
            return null;
        }
        return new OriginalPathSaveWitness(originalPath, handle, snapshot);
    } catch {
        await handle.close().catch(() => undefined);
        return null;
    }
}

async function restoreAppPublishedOriginalExpectation(
    workingPath: string,
    originalPath: string,
    senderWebContentsId: number,
    expected: IWorkingCopyOriginalFileExpectation,
    originalStat: BigIntStats,
) {
    if (
        expected.deviceId === undefined
        || expected.inode === undefined
        || (
            expected.deviceId === originalStat.dev.toString()
            && expected.inode === originalStat.ino.toString()
        )
    ) {
        return null;
    }

    const registration = getWorkingCopyBackingEntry(workingPath, senderWebContentsId);
    if (!registration || registration.originalPath !== originalPath) {
        return null;
    }

    let workingStat: BigIntStats;
    try {
        workingStat = await stat(workingPath, {bigint: true});
    } catch {
        return null;
    }
    // The transition publishes a new inode, then links that immutable inode
    // into the managed working-copy path. A restored checkpoint may still name
    // the pre-publication inode. Recover only that exact pair. An in-place edit
    // keeps the expected inode, while an external replacement leaves the
    // working copy on a different inode, so both remain conflicts.
    if (
        !workingStat.isFile()
        || workingStat.dev !== originalStat.dev
        || workingStat.ino !== originalStat.ino
        || originalStat.nlink < 2n
    ) {
        return null;
    }
    if (!await refreshWorkingCopyOriginalFileExpectation(workingPath, senderWebContentsId)) {
        return null;
    }
    const currentRegistration = getWorkingCopyBackingEntry(workingPath, senderWebContentsId);
    if (
        !currentRegistration
        || currentRegistration.registrationId !== registration.registrationId
        || currentRegistration.originalPath !== originalPath
    ) {
        return null;
    }
    const restored = getWorkingCopyOriginalFileExpectation(workingPath, senderWebContentsId);
    return restored && expectationMatchesStat(restored, originalStat)
        ? restored
        : null;
}

/**
 * Fences an original-path save without an unbounded document read.
 *
 * The expectation captures filesystem identity and change timestamps when the
 * source is opened or last published. On Windows, small files with a stored
 * content fingerprint are hashed to catch same-size edits whose metadata is
 * unchanged. On POSIX, ctime cannot be restored by an ordinary writer, so
 * same-size and backdated external edits still fail the fence. Older restored
 * registrations may only have size and mtime; those stay compatible without a
 * whole-document comparison.
 */
export async function originalPathSaveBaseMatches(
    workingPath: string,
    originalPath: string,
    senderWebContentsId: number,
) {
    const expected = getWorkingCopyOriginalFileExpectation(workingPath, senderWebContentsId);
    if (!expected || !isExpectationUsableForCurrentPlatform(expected)) {
        return false;
    }

    let actual;
    try {
        actual = await stat(originalPath, {bigint: true});
    } catch {
        return false;
    }
    if (expectationMatchesStat(expected, actual)) {
        return matchesExpectedContentFingerprint(originalPath, expected, actual);
    }
    if (
        process.platform !== 'win32'
        || expected.contentFingerprint === undefined
        || !actual.isFile()
        || actual.size > BigInt(SAVE_WITNESS_FULL_HASH_MAX_BYTES)
    ) {
        return false;
    }
    return matchesExpectedContentFingerprint(originalPath, expected, actual);
}
