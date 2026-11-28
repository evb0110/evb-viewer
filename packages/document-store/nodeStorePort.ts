import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {constants, promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {contentWitness} from './contentWitness';
import type {IStoreFile, IStorePort, TExternalSource} from './storePort';

const hasCode = (error: unknown, code: string) => error instanceof Error && 'code' in error && error.code === code;
const isMissing = (error: unknown) => hasCode(error, 'ENOENT');
const apfsDeviceCache = new Map<number, boolean>();

function isApfsVolume(dev: number, directoryPath: string): Promise<boolean> {
    const cached = apfsDeviceCache.get(dev);
    if (cached !== undefined) {
        return Promise.resolve(cached);
    }
    return new Promise<boolean>((resolve) => {
        execFile('/bin/df', ['-T', 'apfs', directoryPath], (error) => {
            const isApfs = error === null;
            apfsDeviceCache.set(dev, isApfs);
            resolve(isApfs);
        });
    });
}

/**
 * Copies the file `source` to `target`, which must not exist yet: a clone on APFS, Btrfs and XFS, which writes no
 * bytes, and an ordinary copy elsewhere and across volumes. Libuv cannot clone on macOS, so there `/bin/cp -c`
 * clones into a private staging directory and `link(2)` installs `target` with kernel-atomic no-replace semantics.
 */
export async function copyNewFile(source: string, target: string) {
    if (process.platform === 'darwin') {
        await fs.lstat(target).then(
            () => {
                throw Object.assign(new Error(`File exists: ${target}`), {code: 'EEXIST'});
            },
            (error: unknown) => {
                if (!isMissing(error)) {
                    throw error;
                }
            },
        );
        const targetDir = path.dirname(target);
        const cloneTempRoot = tmpdir();
        const [sourceStat, targetDirStat, tempRootStat] = await Promise.all([
            fs.stat(source).catch(() => null),
            fs.stat(targetDir).catch(() => null),
            fs.stat(cloneTempRoot).catch(() => null),
        ]);
        // Stage clones in `os.tmpdir()` (when on the same APFS volume) rather than beside `target`,
        // so a crash or kill mid-clone never leaves an untracked hidden directory beside a user's PDF.
        if (
            sourceStat?.isFile() &&
            targetDirStat &&
            tempRootStat &&
            sourceStat.dev === targetDirStat.dev &&
            tempRootStat.dev === targetDirStat.dev &&
            (await isApfsVolume(targetDirStat.dev, targetDir))
        ) {
            const stagingDir = await fs.mkdtemp(path.join(cloneTempRoot, 'evb-clone-')).catch(() => null);
            if (stagingDir !== null) {
                const stagedFile = path.join(stagingDir, 'copy');
                try {
                    const cloned = await new Promise<boolean>((resolve) =>
                        execFile('/bin/cp', ['-c', '--', source, stagedFile], (error) => resolve(error === null)),
                    );
                    if (cloned) {
                        try {
                            await fs.link(stagedFile, target);
                            return;
                        } catch (error) {
                            if (hasCode(error, 'EEXIST')) {
                                throw error;
                            }
                            // Hard links unavailable on this volume; fall through to exclusive copyFile.
                        }
                    }
                } finally {
                    await fs.rm(stagingDir, {recursive: true, force: true}).catch(() => undefined);
                }
            }
        }
    }
    await fs.copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
}

/** Makes `dir`'s entries durable. Windows cannot open a directory for flushing; NTFS journals entries. */
async function syncDirectory(dir: string) {
    if (process.platform === 'win32') {
        return;
    }
    const handle = await fs.open(dir, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/**
 * Creates `dir` and its missing parents, each durably entered in its own parent. It climbs only while a parent is
 * missing, so it ends at the root at the latest; it never compares the paths Node names (Windows prefixes them).
 */
async function ensureDirectory(dir: string): Promise<void> {
    try {
        await fs.mkdir(dir);
    } catch (error) {
        if (hasCode(error, 'EEXIST')) {
            return;
        }
        if (!isMissing(error) || path.dirname(dir) === dir) {
            throw error;
        }
        await ensureDirectory(path.dirname(dir));
        await fs.mkdir(dir).catch((again: unknown) => {
            if (!hasCode(again, 'EEXIST')) {
                throw again;
            }
        });
    }
    await syncDirectory(path.dirname(dir));
}

function nodeStoreFile(handle: fs.FileHandle): IStoreFile {
    async function readAt(offset: number, length: number) {
        const bytes = new Uint8Array(length);
        let done = 0;
        while (done < length) {
            const {bytesRead} = await handle.read(bytes, done, length - done, offset + done);
            if (bytesRead === 0) {
                break;
            }
            done += bytesRead;
        }
        return bytes.subarray(0, done);
    }
    return {
        size: async () => (await handle.stat()).size,
        readAt,
        witness: (length) => contentWitness(length, readAt),
        async writeAt(offset, bytes) {
            let done = 0;
            while (done < bytes.byteLength) {
                const {bytesWritten} = await handle.write(bytes, done, bytes.byteLength - done, offset + done);
                if (bytesWritten === 0) {
                    throw new Error(`Short write at ${offset + done}`);
                }
                done += bytesWritten;
            }
        },
        truncate: (length) => handle.truncate(length),
        flush: () => handle.sync(),
        close: () => handle.close(),
    };
}

/** Native readers deny existing write access on Windows; retain only a reader between store writes. */
function nodeRevisionFile(target: string, reader: fs.FileHandle): IStoreFile {
    async function write<T>(task: (file: IStoreFile) => Promise<T>) {
        const file = nodeStoreFile(await fs.open(target, 'r+'));
        try {
            return await task(file);
        } finally {
            await file.close();
        }
    }
    return {
        ...nodeStoreFile(reader),
        writeAt: (offset, bytes) => write((file) => file.writeAt(offset, bytes)),
        truncate: (length) => write((file) => file.truncate(length)),
        flush: () => write((file) => file.flush()),
    };
}

/** The storage port over a directory of the local file system. */
export function createNodeStorePort(root: string): IStorePort {
    const resolve = (relative: string) => {
        const segments = relative.split('/');
        if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
            throw new Error(`Invalid store path: ${relative}`);
        }
        return path.join(root, ...segments);
    };

    async function copyIn(source: TExternalSource, relative: string) {
        const target = resolve(relative);
        await ensureDirectory(path.dirname(target));
        if (typeof source === 'string') {
            await copyNewFile(source, target);
        }
        const file = nodeStoreFile(await fs.open(target, typeof source === 'string' ? 'r+' : 'wx'));
        try {
            if (typeof source !== 'string') {
                let offset = 0;
                for await (const chunk of source.stream()) {
                    await file.writeAt(offset, chunk);
                    offset += chunk.byteLength;
                }
            }
            await file.flush();
        } finally {
            await file.close();
        }
        await syncDirectory(path.dirname(target));
    }

    return {
        async list(dir) {
            return fs.readdir(resolve(dir)).catch((error: unknown) => {
                if (isMissing(error)) {
                    return [];
                }
                throw error;
            });
        },
        read: async (file) => new Uint8Array(await fs.readFile(resolve(file))),
        async writeAtomic(file, bytes) {
            const target = resolve(file);
            const temp = `${target}.${randomUUID()}.tmp`;
            await ensureDirectory(path.dirname(target));
            try {
                const handle = await fs.open(temp, 'wx');
                try {
                    await handle.writeFile(bytes);
                    await handle.sync();
                } finally {
                    await handle.close();
                }
                await fs.rename(temp, target);
            } catch (error) {
                await fs.rm(temp, {force: true});
                throw error;
            }
            await syncDirectory(path.dirname(target));
        },
        async open(file) {
            const target = resolve(file);
            try {
                return nodeRevisionFile(target, await fs.open(target, 'r'));
            } catch (error) {
                if (!isMissing(error)) {
                    throw error;
                }
            }
            await ensureDirectory(path.dirname(target));
            const handle = await fs.open(target, 'wx+');
            await handle.close();
            await syncDirectory(path.dirname(target));
            return nodeRevisionFile(target, await fs.open(target, 'r'));
        },
        copyIn,
        copy: (from, to) => copyIn(resolve(from), to),
        async move(file, relative) {
            const target = resolve(relative);
            await ensureDirectory(path.dirname(target));
            await fs.link(file, target);
            await fs.rm(file, {force: true});
            const handle = await fs.open(target, 'r+');
            try {
                await handle.sync();
            } finally {
                await handle.close();
            }
            await syncDirectory(path.dirname(target));
        },
        remove: (file) => fs.rm(resolve(file), {recursive: true, force: true}),
    };
}
