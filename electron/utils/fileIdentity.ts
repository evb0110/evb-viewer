import {
    lstat,
    stat,
} from 'fs/promises';
import {isErrnoException} from '@contracts/runtimeGuards';
import * as v from 'valibot';

// A bigint stat's fields as exact decimal strings: NTFS file IDs exceed 2^53, where a Number joins two files.
export interface IFileIdentity {
    dev: string;
    ino: string;
    size: string;
    mtimeNs: string;
}

// A recorded identity. One an older release recorded as Numbers proves nothing, so it reads as no identity.
export const fileIdentitySchema = v.union([
    v.object({
        dev: v.string(),
        ino: v.string(),
        size: v.string(),
        mtimeNs: v.string(),
    }),
    v.pipe(v.object({mtimeMs: v.number()}), v.transform(() => null)),
]);

// Null when nothing is at the path. A rename keeps this identity, so a file
// published from a stage is recognizable at its target afterwards. The entry
// itself is read, since a rename replaces the entry at the path.
export async function readFileIdentity(filePath: string): Promise<IFileIdentity | null> {
    try {
        const fileStat = await lstat(filePath, {bigint: true});
        return {
            dev: fileStat.dev.toString(),
            ino: fileStat.ino.toString(),
            size: fileStat.size.toString(),
            mtimeNs: fileStat.mtimeNs.toString(),
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
        && first.mtimeNs === second.mtimeNs;
}
