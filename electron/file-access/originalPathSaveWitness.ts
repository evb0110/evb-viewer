import {isErrnoException} from '@contracts/runtimeGuards';
import {
    capturePathSnapshot,
    deserializeSnapshot,
    type IOriginalPathSaveJournalSnapshot,
    OriginalPathSaveConflictError,
    serializeSnapshot,
    snapshotsMatch,
} from '@electron/file-access/originalPathSnapshot';

/**
 * Throws `OriginalPathSaveConflictError` unless the file at `originalPath` is the one a replacement journal recorded:
 * the same identity and sampled content, or with `contentOnly` the same content.
 */
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
        if (!snapshotsMatch(expectedSnapshot, await capturePathSnapshot(originalPath), options)) {
            throw new OriginalPathSaveConflictError();
        }
    } catch (error) {
        if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
            throw new OriginalPathSaveConflictError();
        }
        throw error;
    }
}

/** The journal record of the file at `originalPath` now; `null` when it cannot be read. */
export async function capturePathSaveWitness(originalPath: string) {
    try {
        const snapshot = await capturePathSnapshot(originalPath);
        return {getSnapshotForJournal: () => serializeSnapshot(snapshot)};
    } catch {
        return null;
    }
}
