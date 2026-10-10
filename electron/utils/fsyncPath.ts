import { open } from 'node:fs/promises';
import {
    closeSync,
    fsyncSync,
    openSync,
} from 'node:fs';

/**
 * Flush a file's contents to disk. Opened read-write because Windows rejects
 * fsync on a read-only handle with EPERM; that made every temp-file flush a
 * no-op and every OCR catalog write fail there.
 */
export async function fsyncFile(filePath: string) {
    const handle = await open(filePath, process.platform === 'win32' ? 'r+' : 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/** Synchronous file flush for recovery writes, with the same Windows access. */
export function fsyncFileSync(filePath: string) {
    const fd = openSync(filePath, process.platform === 'win32' ? 'r+' : 'r');
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
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
