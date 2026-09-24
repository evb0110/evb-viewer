import { open } from 'node:fs/promises';

/**
 * Flush a file's contents to disk. Opened read-write because Windows rejects
 * fsync on a read-only handle with EPERM; that made every temp-file flush a
 * no-op and every OCR catalog write fail there.
 */
export async function fsyncFile(filePath: string) {
    const handle = await open(filePath, 'r+');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/**
 * Flush a directory entry list so a rename or create in it survives a crash.
 * Windows cannot open a directory for fsync (NTFS journals the metadata), so
 * this is a no-op there.
 */
export async function fsyncDirectory(directoryPath: string) {
    if (process.platform === 'win32') {
        return;
    }
    const handle = await open(directoryPath, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}
