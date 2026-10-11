import {linkOrCopyFileDurably} from '@electron/file-access/documentFileWriteAtomic';
import type {IOriginalPathSaveWitness} from '@electron/file-access/originalPathSaveWitness';

/**
 * Links the save's backup of the original. The admitted witness must still match
 * with ctime and link count right before the link, so the only metadata move the
 * rebase after it accepts is this link's.
 */
export async function linkOriginalBackup(
    witness: IOriginalPathSaveWitness | null,
    originalPath: string,
    backupPath: string,
) {
    await witness?.assertCurrent();
    await linkOrCopyFileDurably(originalPath, backupPath);
}
