import {lstat} from 'fs/promises';
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

export function isSameFileIdentity(first: IFileIdentity | null, second: IFileIdentity | null) {
    return first !== null
        && second !== null
        && first.dev === second.dev
        && first.ino === second.ino
        && first.size === second.size
        && first.mtimeMs === second.mtimeMs;
}
