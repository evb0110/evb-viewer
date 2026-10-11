import {linkOrCopyFileDurably} from '@electron/file-access/documentFileWriteAtomic';
import type {IOriginalPathSaveWitness} from '@electron/file-access/originalPathSaveWitness';

/**
 * Links the save's backup of the original. The admitted witness must still match
 * with ctime and link count right before the link. The post-link rebase proves
 * content again because another writer can edit the shared inode during linking.
 */
export async function linkOriginalBackup(
    witness: IOriginalPathSaveWitness | null,
    originalPath: string,
    backupPath: string,
) {
    await witness?.assertCurrent();
    await linkOrCopyFileDurably(originalPath, backupPath);
}
