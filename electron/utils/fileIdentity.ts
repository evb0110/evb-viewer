import {
    lstat,
    stat,
} from 'fs/promises';
import {isErrnoException} from '@contracts/runtimeGuards';

export interface IFileIdentity {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
}

// Null when nothing is at the path. A rename keeps this identity, so a file
// published from a stage is recognizable at its target afterwards. The entry
// itself is read, since a rename replaces the entry at the path.
export async function readFileIdentity(filePath: string): Promise<IFileIdentity | null> {
    try {
        const fileStat = await lstat(filePath);
        return {
            dev: fileStat.dev,
            ino: fileStat.ino,
            size: fileStat.size,
            mtimeMs: fileStat.mtimeMs,
        };
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

// Whether two paths name one file, as a hard link or a crash-interrupted move leaves them. File IDs are compared as
// bigints: NTFS IDs exceed 2^53, so a Number can join two different files.
export async function isSameFile(path: string, otherPath: string) {
    const first = await stat(path, {bigint: true}).catch(() => null);
    const second = first && await stat(otherPath, {bigint: true}).catch(() => null);
    return first !== null && first.dev === second?.dev && first.ino === second.ino;
}

export function isSameFileIdentity(first: IFileIdentity | null, second: IFileIdentity | null) {
    return first !== null
        && second !== null
        && first.dev === second.dev
        && first.ino === second.ino
        && first.size === second.size
        && first.mtimeMs === second.mtimeMs;
}
