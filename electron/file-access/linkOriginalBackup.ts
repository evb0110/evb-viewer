import {linkOrCopyFileDurably} from '@electron/file-access/documentFileWriteAtomic';
import {attemptWorkingCopyClone} from '@electron/file-access/workingCopyDirectory';
import type {TOriginalRebaseProof} from '@electron/file-access/originalPathSnapshot';
import type {IOriginalPathSaveWitness} from '@electron/file-access/originalPathSaveWitness';

/**
 * Keep an independent clone where possible, preserving source ctime. Else
 * retain the original inode with a hard link and prove the moved-ctime bytes.
 * Publication later replaces this slot with the actual displaced revision.
 */
export async function linkOriginalBackup(
    witness: IOriginalPathSaveWitness | null,
    originalPath: string,
    backupPath: string,
): Promise<TOriginalRebaseProof> {
    await witness?.assertCurrent();
    if (await attemptWorkingCopyClone(originalPath, backupPath) !== 'known-unsupported') {
        return {
            kind: 'open-copy',
            source: {path: backupPath},
        };
    }
    await linkOrCopyFileDurably(originalPath, backupPath);
    return {kind: 'own-backup-link'};
}
