import {
    createOriginalFileExpectationFromStat,
    expectationMatchesStat,
    getExpectationStatMismatches,
} from '@electron/file-access/originalFileExpectation';
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
import {
    deserializeSnapshot,
    readPersistedWorkingCopyManifest,
} from '@electron/file-access/readWorkingCopyManifest';
import {isErrnoException} from '@contracts/runtimeGuards';
import {
    captureAdmittedPathSnapshot,
    capturePathSnapshot,
    hashContentFingerprintFilePath,
    type IOriginalPathSaveJournalSnapshot,
    type IOriginalPathSaveSnapshot,
    OriginalPathSaveConflictError,
    rebaseUnchangedSnapshot,
    serializeSnapshot,
    snapshotsMatch,
} from '@electron/file-access/originalPathSnapshot';
import {createLogger} from '@electron/utils/createLogger';

const log = createLogger('original-path-save-witness');

export interface IOriginalPathSaveWitness {
    assertCurrent: (options?: {allowBackupMetadataChange?: boolean}) => Promise<void>;
    getOriginalFileExpectation: () => IWorkingCopyOriginalFileExpectation;
    getSnapshotForJournal: () => IOriginalPathSaveJournalSnapshot;
    rebaseOnUnchangedContent: (proof?: Parameters<typeof rebaseUnchangedSnapshot>[2], signal?: AbortSignal) => Promise<void>;
    rebaseAfterPublish: () => Promise<void>;
}

function hasImmutablePosixExpectation(expected: IWorkingCopyOriginalFileExpectation) {
    return expected.deviceId !== undefined
        && expected.inode !== undefined
        && expected.ctimeNs !== undefined
        && expected.mtimeNs !== undefined;
}

function isExpectationUsableForCurrentPlatform(expected: IWorkingCopyOriginalFileExpectation) {
    return process.platform === 'win32'
        ? /^sha256-full-v1:[0-9a-f]{64}$/u.test(expected.contentFingerprint ?? '')
        : hasImmutablePosixExpectation(expected);
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
        const pathBefore = await capturePathSnapshot(originalPath, {ignoreIdentity: true});
        if (!snapshotsMatch(snapshot, pathBefore, {ignoreIdentity: true})) {
            return false;
        }
        const actualFingerprint = snapshot.contentFingerprint
            ?? await hashContentFingerprintFilePath(originalPath, snapshot.size, signal);
        signal?.throwIfAborted();
        const pathAfter = await capturePathSnapshot(originalPath, {ignoreIdentity: true});
        return snapshotsMatch(snapshot, pathAfter, {ignoreIdentity: true})
            && actualFingerprint === expected.contentFingerprint;
    } catch {
        return false;
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
    constructor(
        private readonly originalPath: string,
        private snapshot: IOriginalPathSaveSnapshot,
    ) {}

    async assertCurrent(options: {allowBackupMetadataChange?: boolean} = {}) {
        try {
            const actual = await capturePathSnapshot(this.originalPath, {ignoreIdentity: this.snapshot.contentFingerprint !== undefined});
            if (!snapshotsMatch(this.snapshot, actual)
                && !(snapshotsMatch(this.snapshot, actual, {
                    ...options,
                    ignoreIdentity: true,
                })
                    && await matchesBaselineOnWitnessPath(this.originalPath, this.getOriginalFileExpectation(), actual))) {
                throw new OriginalPathSaveConflictError();
            }
        } catch (error) {
            rethrowWitnessSnapshotError(error);
        }
    }

    async rebaseOnUnchangedContent(proof: Parameters<typeof rebaseUnchangedSnapshot>[2] = {kind: 'own-backup-link'}, signal?: AbortSignal) {
        try {
            this.snapshot = await rebaseUnchangedSnapshot(this.originalPath, this.snapshot, proof, signal);
        } catch (error) {
            rethrowWitnessSnapshotError(error);
        }
    }

    async rebaseAfterPublish() {
        try {
            const snapshot = await captureAdmittedPathSnapshot(this.originalPath);
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

    getOriginalFileExpectation(): IWorkingCopyOriginalFileExpectation {
        const {
            deviceId: dev, inode: ino, contentFingerprint, ...snapshot
        } = this.snapshot;
        return {
            ...createOriginalFileExpectationFromStat({
                ...snapshot,
                dev,
                ino,
            }),
            ...(contentFingerprint ? {contentFingerprint} : {}),
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
        const snapshot = await captureAdmittedPathSnapshot(originalPath, process.platform === 'win32' ? undefined : expected, signal);
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
        if (!contentFingerprintVerified && process.platform === 'win32' && expected.contentFingerprint
            && !await matchesBaselineOnWitnessPath(originalPath, expected, snapshot, signal)) {
            return null;
        }
        if (signal?.aborted) {
            return null;
        }
        const pathSnapshot = await capturePathSnapshot(originalPath, {ignoreIdentity: contentFingerprintVerified});
        if (!snapshotsMatch(snapshot, pathSnapshot, {ignoreIdentity: contentFingerprintVerified})) {
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
        if (process.platform !== 'win32') return true;
    }
    if (!actual.isFile() || !expected.contentFingerprint) {
        return false;
    }
    try {
        return await matchesBaselineOnWitnessPath(originalPath, expected,
            await captureAdmittedPathSnapshot(originalPath, {contentFingerprint: expected.contentFingerprint}));
    } catch {
        return false;
    }
}
