import {constants} from 'fs';
import {
    copyFile,
    open as openFileHandle,
    rename,
    unlink,
} from 'fs/promises';
import {dirname} from 'path';
import {fsyncFile} from '@electron/utils/fsyncPath';
import {syncFileHandleForDurability} from '@electron/utils/syncFileHandleForDurability';
import {assertNoSymlinkPathSegments} from '@electron/file-access/assertNoSymlinkPathSegments';
import {
    atomicReplace, makeSiblingTempPath,
} from '@electron/utils/atomicReplace';

const MAX_IPC_WRITE_BYTES = 16 * 1024 * 1024;
function assertWithinIpcWriteBudget(byteLength: number) {
    if (byteLength > MAX_IPC_WRITE_BYTES) {
        throw new Error(`Invalid data: exceeds max size (${MAX_IPC_WRITE_BYTES} bytes)`);
    }
}

export function normalizeIpcWritePayload(data: unknown) {
    if (!(data instanceof Uint8Array)) {
        throw new Error('Invalid data: must be a Uint8Array');
    }
    assertWithinIpcWriteBudget(data.byteLength);
    return data;
}

async function fsyncDirectoryBestEffort(directoryPath: string) {
    let directoryHandle;
    try {
        directoryHandle = await openFileHandle(directoryPath, 'r');
        await directoryHandle.sync();
    } catch {
        // Some platforms do not allow opening directories for fsync.
    } finally {
        await directoryHandle?.close().catch(() => undefined);
    }
}

export async function writeFileAtomic(resolvedPath: string, payload: Uint8Array) {
    assertNoSymlinkPathSegments(resolvedPath);

    const directoryPath = dirname(resolvedPath);
    const temporaryPath = makeSiblingTempPath(resolvedPath);

    const handle = await openFileHandle(temporaryPath, 'wx');
    try {
        await handle.writeFile(payload);
        await syncFileHandleForDurability(handle);
    } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }

    await handle.close();
    try {
        assertNoSymlinkPathSegments(resolvedPath);
        await rename(temporaryPath, resolvedPath);
        await fsyncDirectoryBestEffort(directoryPath);
    } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}

/** Replaces `resolvedTargetPath` with a copy of `resolvedSourcePath`, cloned where the volume can. */
export async function copyFileAtomic(
    resolvedSourcePath: string,
    resolvedTargetPath: string,
    options: {
        durable?: boolean;
        temporaryPath?: string;
    } = {},
) {
    assertNoSymlinkPathSegments(resolvedSourcePath);
    assertNoSymlinkPathSegments(resolvedTargetPath);

    const temporaryPath = options.temporaryPath ?? makeSiblingTempPath(resolvedTargetPath);
    try {
        await copyFile(resolvedSourcePath, temporaryPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
        if (options.durable !== false) {
            await fsyncFile(temporaryPath);
        }
        assertNoSymlinkPathSegments(resolvedTargetPath);
        await atomicReplace(temporaryPath, resolvedTargetPath, {
            durable: options.durable !== false,
            markMutationCommitStarted: false,
        });
    } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}
