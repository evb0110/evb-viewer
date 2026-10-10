import {randomUUID} from 'node:crypto';
import {
    copyFile,
    open,
    rm,
    type FileHandle,
} from 'node:fs/promises';
import {join} from 'node:path';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {createOriginalFileContentFingerprintHash} from '@electron/file-access/createOriginalFileContentFingerprintHash';

/**
 * Read at most 1 MiB, closing before the caller hashes or checks metadata.
 * Node opens with read/write/delete sharing on Windows. A replacing rename
 * can still fail while its destination is open, so no witness retains it.
 */
export async function readFileChunk(path: string, buffer: Buffer, position: number) {
    const handle = await open(path, 'r');
    try {
        return (await handle.read(buffer, 0, Math.min(buffer.byteLength, 1024 * 1024), position)).bytesRead;
    } finally {
        await handle.close();
    }
}

/** Windows replacement cannot unlink an open destination, even with delete sharing. */
export async function usingFileReadSnapshot<T>(path: string, read: (handle: FileHandle) => Promise<T>) {
    const snapshot = process.platform === 'win32'
        ? join(getAppTempDir(), `original-fingerprint-${randomUUID()}.snapshot`)
        : path;
    let handle: FileHandle | undefined;
    try {
        if (snapshot !== path) {
            await copyFile(path, snapshot);
        }
        handle = await open(snapshot, 'r');
        return await read(handle);
    } finally {
        try {
            await handle?.close();
        } finally {
            if (snapshot !== path) {
                await rm(snapshot, {force: true});
            }
        }
    }
}

/** Hash one complete revision from an already owned read handle. */
export async function readOriginalFileContentFingerprint(handle: FileHandle, size: number, signal?: AbortSignal) {
    const hash = createOriginalFileContentFingerprintHash(size);
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(size, 1024 * 1024)));
    let offset = 0;
    while (offset < size) {
        signal?.throwIfAborted();
        const {bytesRead} = await handle.read(buffer, 0, Math.min(buffer.byteLength, size - offset), offset);
        signal?.throwIfAborted();
        if (bytesRead <= 0) {
            return undefined;
        }
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
    }
    return `sha256-full-v1:${hash.digest('hex')}`;
}
