import {uniq} from 'es-toolkit/array';
import {addRecentFile} from '@electron/recentFiles';
import {updateRecentFilesMenu} from '@electron/menu';
import {allowOpenPaths} from '@electron/file-access/openPathCapabilities';
import type {TOpenPathOwner} from '@electron/features/documents/main/openPathOwner';

export async function addRecentInputs(paths: string[], owner?: TOpenPathOwner) {
    const uniquePaths = uniq(paths);
    allowOpenPaths(uniquePaths, owner);
    const senderWebContentsId = typeof owner === 'number' ? owner : owner?.id;
    for (const path of uniquePaths) {
        await addRecentFile(path, senderWebContentsId);
    }
    updateRecentFilesMenu();
}
