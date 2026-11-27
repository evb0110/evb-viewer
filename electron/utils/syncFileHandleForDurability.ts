import type {FileHandle} from 'node:fs/promises';
import {isErrnoException, type IErrnoLikeException} from '@contracts/runtimeGuards';

export interface IFileDurabilitySyncOptions {
    platform?: NodeJS.Platform;
    onSkipped?: (error: IErrnoLikeException) => void;
}

/** Flush a regular file before atomic publication. Windows may reject this
 * best-effort flush with EPERM/EINVAL even when the staged file is complete and
 * renameable. All other durability failures remain fatal. */
export async function syncFileHandleForDurability(handle: Pick<FileHandle, 'sync'>, options: IFileDurabilitySyncOptions = {}) {
    try {
        await handle.sync();
    } catch (error) {
        const platform = options.platform ?? process.platform;
        if (platform === 'win32' && isErrnoException(error) && (error.code === 'EPERM' || error.code === 'EINVAL')) {
            options.onSkipped?.(error);
            return;
        }
        throw error;
    }
}
