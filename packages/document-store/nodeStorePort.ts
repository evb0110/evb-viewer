import { randomUUID } from 'node:crypto';
import {
    constants,
    promises as fs,
} from 'node:fs';
import path from 'node:path';
import type {
    IStoreFile,
    IStorePort,
    TExternalSource,
} from './storePort';

const hasCode = (error: unknown, code: string) => error instanceof Error && 'code' in error && error.code === code;
const isMissing = (error: unknown) => hasCode(error, 'ENOENT');

/** Makes `dir`'s entries durable. Windows cannot open a directory for flushing; NTFS journals entries. */
async function syncDirectory(dir: string) {
    if (process.platform === 'win32') return;
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
        if (hasCode(error, 'EEXIST')) return;
        if (!isMissing(error) || path.dirname(dir) === dir) throw error;
        await ensureDirectory(path.dirname(dir));
        await fs.mkdir(dir).catch((again: unknown) => {
            if (!hasCode(again, 'EEXIST')) throw again;
        });
    }
    await syncDirectory(path.dirname(dir));
}

function nodeStoreFile(handle: fs.FileHandle): IStoreFile {
    return {
        size: async () => (await handle.stat()).size,
        async readAt(offset, length) {
            const bytes = new Uint8Array(length);
            let done = 0;
            while (done < length) {
                const { bytesRead } = await handle.read(bytes, done, length - done, offset + done);
                if (bytesRead === 0) break;
                done += bytesRead;
            }
            return bytes.subarray(0, done);
        },
        async writeAt(offset, bytes) {
            let done = 0;
            while (done < bytes.byteLength) {
                const { bytesWritten } = await handle.write(bytes, done, bytes.byteLength - done, offset + done);
                if (bytesWritten === 0) throw new Error(`Short write at ${offset + done}`);
                done += bytesWritten;
            }
        },
        truncate: length => handle.truncate(length),
        flush: () => handle.sync(),
        close: () => handle.close(),
    };
}

/** The storage port over a directory of the local file system. */
export function createNodeStorePort(root: string): IStorePort {
    const resolve = (relative: string) => {
        const segments = relative.split('/');
        if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
            throw new Error(`Invalid store path: ${relative}`);
        }
        return path.join(root, ...segments);
    };

    async function copyIn(source: TExternalSource, relative: string) {
        const target = resolve(relative);
        await ensureDirectory(path.dirname(target));
        if (typeof source === 'string') {
            // A clone on APFS, Btrfs and XFS; Node falls back to an ordinary copy elsewhere.
            await fs.copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
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
                if (isMissing(error)) return [];
                throw error;
            });
        },
        read: async file => new Uint8Array(await fs.readFile(resolve(file))),
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
                await fs.rm(temp, { force: true });
                throw error;
            }
            await syncDirectory(path.dirname(target));
        },
        async open(file) {
            const target = resolve(file);
            try {
                return nodeStoreFile(await fs.open(target, 'r+'));
            } catch (error) {
                if (!isMissing(error)) throw error;
            }
            await ensureDirectory(path.dirname(target));
            const handle = await fs.open(target, 'wx+');
            await syncDirectory(path.dirname(target));
            return nodeStoreFile(handle);
        },
        copyIn,
        copy: (from, to) => copyIn(resolve(from), to),
        async move(file, relative) {
            const target = resolve(relative);
            await ensureDirectory(path.dirname(target));
            await fs.link(file, target);
            await fs.rm(file, { force: true });
            const handle = await fs.open(target, 'r+');
            try {
                await handle.sync();
            } finally {
                await handle.close();
            }
            await syncDirectory(path.dirname(target));
        },
        remove: file => fs.rm(resolve(file), { recursive: true, force: true }),
    };
}
