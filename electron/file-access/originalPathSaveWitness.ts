import {createHash} from 'node:crypto';
import type {BigIntStats} from 'node:fs';
import {
    lstat,
    stat,
} from 'node:fs/promises';
import {
    getWorkingCopyBackingEntry,
    getWorkingCopyOriginalFileExpectation,
    refreshWorkingCopyOriginalFileExpectation,
    type IWorkingCopyOriginalFileExpectation,
} from '@electron/file-access/workingCopyStore';
import type * as v from 'valibot';
import type {originalSaveSnapshotSchema} from '@electron/file-access/readWorkingCopyManifest';
import {
    deserializeSnapshot,
    readPersistedWorkingCopyManifest,
} from '@electron/file-access/readWorkingCopyManifest';
import {createOriginalFileContentFingerprintHash} from '@electron/file-access/createOriginalFileContentFingerprintHash';
import {readFileChunk} from '@electron/file-access/readFileChunk';
import {isErrnoException} from '@contracts/runtimeGuards';
import {createLogger} from '@electron/utils/createLogger';

const log = createLogger('original-path-save-witness');
const SAVE_WITNESS_SAMPLE_BYTES = 64 * 1024;
const SAVE_WITNESS_HASH_CHUNK_BYTES = 1024 * 1024;

interface IOriginalPathSaveSnapshot {
    contentFingerprint?: string;
    ctimeNs: bigint;
    deviceId: bigint;
    inode: bigint;
    linkCount: bigint;
    mtimeNs: bigint;
    sampleSha256: string;
    size: bigint;
}

export interface IOriginalPathSaveJournalSnapshot extends v.InferOutput<typeof originalSaveSnapshotSchema> {}

export class OriginalPathSaveConflictError extends Error {
    constructor() {
        super('Original file changed on disk; save skipped to avoid overwriting external edits');
        this.name = 'OriginalPathSaveConflictError';
    }
}

export interface IOriginalPathSaveWitness {
    assertCurrent: (options?: {allowBackupMetadataChange?: boolean}) => Promise<void>;
    getOriginalFileExpectation: () => IWorkingCopyOriginalFileExpectation;
    getSnapshotForJournal: () => IOriginalPathSaveJournalSnapshot;
    rebaseOnUnchangedContent: () => Promise<void>;
    rebaseAfterPublish: () => Promise<void>;
}

function expectationMatchesStat(
    expected: IWorkingCopyOriginalFileExpectation,
    actual: BigIntStats,
) {
    if (getExpectationStatMismatches(expected, actual).length > 0) {
        return false;
    }

    return expected.mtimeNs !== undefined
        || Math.abs(Number(actual.mtimeNs) / 1_000_000 - expected.mtimeMs) < 1;
}

function getExpectationStatMismatches(
    expected: IWorkingCopyOriginalFileExpectation,
    actual: BigIntStats,
) {
    return [
        expected.ctimeNs !== undefined && actual.ctimeNs.toString() !== expected.ctimeNs ? 'ctimeNs' : null,
        expected.deviceId !== undefined && actual.dev.toString() !== expected.deviceId ? 'deviceId' : null,
        !actual.isFile() ? 'fileType' : null,
        expected.inode !== undefined && actual.ino.toString() !== expected.inode ? 'inode' : null,
        expected.mtimeNs !== undefined && actual.mtimeNs.toString() !== expected.mtimeNs ? 'mtimeNs' : null,
        actual.size !== BigInt(expected.size) ? 'size' : null,
        expected.mtimeNs === undefined
            && Math.abs(Number(actual.mtimeNs) / 1_000_000 - expected.mtimeMs) >= 1
            ? 'mtimeMs'
            : null,
    ].filter((field): field is string => field !== null);
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
    // Windows can use the full baseline where one has been captured.
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

async function hashContentFingerprintFilePath(originalPath: string, size: bigint, signal?: AbortSignal) {
    const numericSize = Number(size);
    if (!Number.isSafeInteger(numericSize) || numericSize < 0) {
        throw new OriginalPathSaveConflictError();
    }
    const hash = createOriginalFileContentFingerprintHash(numericSize);
    return `sha256-full-v1:${await hashFilePath(originalPath, size, hash, signal)}`;
}

async function matchesBaselineOnWitnessPath(
    originalPath: string,
    expected: IWorkingCopyOriginalFileExpectation,
    snapshot: IOriginalPathSaveSnapshot,
    signal?: AbortSignal,
) {
    if (
        expected.contentFingerprint === undefined
        || !/^sha256-full-v1:[0-9a-f]{64}$/u.test(expected.contentFingerprint)
        || snapshot.size !== BigInt(expected.size)
    ) {
        return false;
    }
    try {
        signal?.throwIfAborted();
        const pathBefore = await capturePathSnapshot(originalPath);
        if (!snapshotsMatch(snapshot, pathBefore)) {
            return false;
        }
        const actualFingerprint = await hashContentFingerprintFilePath(originalPath, snapshot.size, signal);
        signal?.throwIfAborted();
        const pathAfter = await capturePathSnapshot(originalPath);
        return snapshotsMatch(snapshot, pathAfter)
            && actualFingerprint === expected.contentFingerprint;
    } catch {
        return false;
    }
}

async function matchesExpectedContentFingerprint(
    originalPath: string,
    expected: IWorkingCopyOriginalFileExpectation,
    admittedStat: BigIntStats,
    signal?: AbortSignal,
) {
    if (
        process.platform !== 'win32'
        || expected.contentFingerprint === undefined
    ) {
        return true;
    }
    if (!/^sha256-full-v1:[0-9a-f]{64}$/u.test(expected.contentFingerprint)) {
        return false;
    }

    try {
        const before = await lstat(originalPath, {bigint: true});
        if (!before.isFile() || before.size !== admittedStat.size || before.dev !== admittedStat.dev || before.ino !== admittedStat.ino) {
            return false;
        }
        const actualFingerprint = await hashContentFingerprintFilePath(originalPath, before.size, signal);
        const after = await lstat(originalPath, {bigint: true});
        return after.isFile()
            && after.size === before.size && after.dev === before.dev && after.ino === before.ino
            && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs
            && actualFingerprint === expected.contentFingerprint;
    } catch {
        return false;
    }
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

function serializeSnapshot(snapshot: IOriginalPathSaveSnapshot): IOriginalPathSaveJournalSnapshot {
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

async function capturePathSnapshot(originalPath: string) {
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
    constructor(
        private readonly originalPath: string,
        private snapshot: IOriginalPathSaveSnapshot,
    ) {}

    async assertCurrent(options: {allowBackupMetadataChange?: boolean} = {}) {
        try {
            if (!snapshotsMatch(this.snapshot, await capturePathSnapshot(this.originalPath), options)) {
                throw new OriginalPathSaveConflictError();
            }
        } catch (error) {
            rethrowWitnessSnapshotError(error);
        }
    }

    async rebaseOnUnchangedContent() {
        try {
            const snapshot = await capturePathSnapshot(this.originalPath);
            if (!snapshotsMatch(this.snapshot, snapshot, {allowBackupMetadataChange: true})) {
                throw new OriginalPathSaveConflictError();
            }
            this.snapshot = snapshot;
        } catch (error) {
            rethrowWitnessSnapshotError(error);
        }
    }

    async rebaseAfterPublish() {
        try {
            const snapshot = await capturePathSnapshot(this.originalPath);
            snapshot.contentFingerprint = await hashContentFingerprintFilePath(this.originalPath, snapshot.size);
            if (!snapshotsMatch(snapshot, await capturePathSnapshot(this.originalPath))) {
                throw new OriginalPathSaveConflictError();
            }
            this.snapshot = snapshot;
        } catch (error) {
            rethrowWitnessSnapshotError(error);
        }
    }

    getSnapshotForJournal() {
        return serializeSnapshot(this.snapshot);
    }

    /** The witnessed revision as the save baseline a working copy registers. */
    getOriginalFileExpectation(): IWorkingCopyOriginalFileExpectation {
        return {
            ctimeNs: this.snapshot.ctimeNs.toString(),
            deviceId: this.snapshot.deviceId.toString(),
            inode: this.snapshot.inode.toString(),
            mtimeMs: Number(this.snapshot.mtimeNs) / 1_000_000,
            mtimeNs: this.snapshot.mtimeNs.toString(),
            size: Number(this.snapshot.size),
        };
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
        if (expectedSnapshot.contentFingerprint !== undefined) {
            if (!await matchesBaselineOnWitnessPath(originalPath, {
                mtimeMs: Number(expectedSnapshot.mtimeNs) / 1_000_000,
                size: Number(expectedSnapshot.size),
                contentFingerprint: expectedSnapshot.contentFingerprint,
            }, actualSnapshot)) {
                throw new OriginalPathSaveConflictError();
            }
        }
    } catch (error) {
        rethrowWitnessSnapshotError(error);
    }
}

async function captureRequiredPathSaveWitness(originalPath: string): Promise<IOriginalPathSaveWitness> {
    return new OriginalPathSaveWitness(originalPath, await capturePathSnapshot(originalPath));
}

export async function capturePathSaveWitness(
    originalPath: string,
): Promise<IOriginalPathSaveWitness | null> {
    try {
        return await captureRequiredPathSaveWitness(originalPath);
    } catch {
        return null;
    }
}

/**
 * Captures an open's source before its bytes are read and checks its named
 * revision again before registration without retaining a handle. Only a real
 * snapshot mismatch is a conflict; an unreadable or vanished source keeps its error.
 */
export function captureOpenSourceWitness(originalPath: string) {
    return captureRequiredPathSaveWitness(originalPath);
}

export async function captureOriginalPathSaveWitness(
    workingPath: string,
    originalPath: string,
    senderWebContentsId: number,
    signal?: AbortSignal,
): Promise<IOriginalPathSaveWitness | null> {
    if (signal?.aborted) {
        return null;
    }
    let expected = getWorkingCopyOriginalFileExpectation(workingPath, senderWebContentsId);
    if (!expected || !isExpectationUsableForCurrentPlatform(expected)) {
        return null;
    }

    try {
        const snapshot = await capturePathSnapshot(originalPath);
        const originalStat = await lstat(originalPath, {bigint: true});
        const expectationStatMatches = expectationMatchesStat(expected, originalStat);
        let contentFingerprintVerified = false;
        if (!expectationStatMatches || process.platform === 'win32') {
            if (originalStat.isFile()) {
                contentFingerprintVerified = await matchesBaselineOnWitnessPath(
                    originalPath,
                    expected,
                    snapshot,
                    signal,
                );
                if (signal?.aborted) {
                    return null;
                }
            }
            if (
                expectationStatMatches
                && process.platform === 'win32'
                && expected.contentFingerprint !== undefined
                && !contentFingerprintVerified
            ) {
                return null;
            }
            if (!expectationStatMatches && !contentFingerprintVerified) {
                const restored = await restoreAppPublishedOriginalExpectation(
                    workingPath,
                    originalPath,
                    senderWebContentsId,
                    expected,
                    originalStat,
                );
                if (!restored) {
                    log.debug('Original save witness rejected a changed file expectation', {
                        fields: getExpectationStatMismatches(expected, originalStat),
                        originalPath,
                        expected,
                        actual: {
                            ctimeNs: originalStat.ctimeNs.toString(),
                            deviceId: originalStat.dev.toString(),
                            inode: originalStat.ino.toString(),
                            linkCount: originalStat.nlink.toString(),
                            mtimeNs: originalStat.mtimeNs.toString(),
                            size: originalStat.size.toString(),
                        },
                        workingPath,
                    });
                    return null;
                }
                expected = restored;
            }
        }
        if (!contentFingerprintVerified && !await matchesExpectedContentFingerprint(originalPath, expected, originalStat, signal)) {
            return null;
        }
        if (signal?.aborted) {
            return null;
        }
        const pathSnapshot = await capturePathSnapshot(originalPath);
        if (!snapshotsMatch(snapshot, pathSnapshot)) {
            return null;
        }
        return new OriginalPathSaveWitness(originalPath, snapshot);
    } catch {
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
    const registration = getWorkingCopyBackingEntry(workingPath, senderWebContentsId);
    if (!registration || registration.originalPath !== originalPath) {
        return null;
    }
    const saved = (await readPersistedWorkingCopyManifest(workingPath).catch(error => {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }))?.originalSaveBase;
    if (saved) {
        if (saved.path !== originalPath) {
            return null;
        }
        // The revision commit retains the journal's witnessed publication.
        // A stale workspace checkpoint cannot erase this save baseline.
        await assertPathMatchesSaveWitnessSnapshot(originalPath, saved.snapshot, {allowBackupMetadataChange: saved.snapshot.contentFingerprint !== undefined});
    } else {
        // Older saved copies prove publication only through their shared inode.
        const workingStat = await stat(workingPath, {bigint: true});
        if (!workingStat.isFile() || workingStat.dev !== originalStat.dev
            || workingStat.ino !== originalStat.ino || originalStat.nlink < 2n
            || expected.deviceId === undefined || expected.inode === undefined
            || expected.deviceId === originalStat.dev.toString() && expected.inode === originalStat.ino.toString()) {
            return null;
        }
    }
    if (getWorkingCopyBackingEntry(workingPath, senderWebContentsId)?.registrationId !== registration.registrationId
        || !await refreshWorkingCopyOriginalFileExpectation(workingPath, senderWebContentsId)) {
        return null;
    }
    const restored = getWorkingCopyOriginalFileExpectation(workingPath, senderWebContentsId);
    return restored && expectationMatchesStat(restored, originalStat)
        ? restored
        : null;
}

/** Checks the current original against its captured stat and content witnesses. */
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
    ) {
        return false;
    }
    return matchesExpectedContentFingerprint(originalPath, expected, actual);
}
