import { getErrorMessage } from '@contracts/getErrorMessage';
import { randomUUID } from 'node:crypto';
import {
    open,
    mkdir,
    readFile,
    rename,
    rm,
    stat,
} from 'node:fs/promises';
import path from 'node:path';
import type {FileHandle} from 'node:fs/promises';
import {
    isErrnoException,
    isRecord,
} from '@contracts/runtimeGuards';
import type { IHostProcessIdentityProbe } from '@scripts/windows-test/host/hostProcessIdentity';
import { ownershipMatches } from '@scripts/windows-test/host/hostProcessIdentity';

export interface IHostLockOwner {
    token: string;
    hostId: string;
    pid: number;
    startTime: string;
    acquiredAt: string;
}

export interface IHostLockHandle {
    lockDirectory: string;
    owner: IHostLockOwner;
    release(): Promise<void>;
}

export interface IHostLockDependencies {
    hostId: string;
    pid: number;
    probe: IHostProcessIdentityProbe;
    nowIso(): string;
    sleep(milliseconds: number): Promise<void>;
    createToken?(): string;
}

export interface IHostLockOptions {
    attempts?: number;
    retryDelayMs?: number;
}

export class HostLockBusyError extends Error {
    readonly owner: IHostLockOwner | null;

    constructor(lockDirectory: string, owner: IHostLockOwner | null) {
        super(owner === null
            ? `Windows test host lock ${lockDirectory} is held by another process.`
            : `Windows test host lock ${lockDirectory} is held by pid ${owner.pid} on ${owner.hostId} since ${owner.acquiredAt}.`);
        this.name = 'HostLockBusyError';
        this.owner = owner;
    }
}

/**
 * A competitor that created the directory a moment ago may not have renamed
 * its owner file into place yet; a directory this young without an owner is
 * treated as held rather than stale.
 */
const OWNER_FILE_GRACE_MS = 5_000;

function ownerFile(lockDirectory: string) {
    return path.join(lockDirectory, 'owner.json');
}

async function lockDirectoryAgeMs(lockDirectory: string) {
    const stats = await stat(lockDirectory).catch(() => null);
    return stats === null ? Number.POSITIVE_INFINITY : Date.now() - stats.mtimeMs;
}

export function isHostLockOwner(value: unknown): value is IHostLockOwner {
    return isRecord(value)
        && typeof value.token === 'string'
        && value.token.length > 0
        && typeof value.hostId === 'string'
        && typeof value.pid === 'number'
        && Number.isInteger(value.pid)
        && typeof value.startTime === 'string'
        && typeof value.acquiredAt === 'string';
}

export async function readHostLockOwner(lockDirectory: string): Promise<IHostLockOwner | null> {
    const target = await stat(lockDirectory).catch(() => null);
    const file = target?.isDirectory() === true ? ownerFile(lockDirectory) : lockDirectory;
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return null;
        }
        throw new Error(`Cannot read the host lock owner ${file}: ${getErrorMessage(error)}`);
    }
    if (text.trim().length === 0) {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error(`The host lock owner ${file} is not valid JSON (${getErrorMessage(error)}); inspect and remove it by hand.`);
    }
    if (!isHostLockOwner(parsed)) {
        throw new Error(`The host lock owner ${file} does not match the owner schema; inspect and remove it by hand.`);
    }
    return parsed;
}

async function tryCreateLockFile(lockDirectory: string): Promise<FileHandle | null> {
    try {
        return await open(lockDirectory, 'wx', 0o600);
    } catch (error) {
        const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
        if (code === 'EEXIST') {
            return null;
        }
        throw error;
    }
}

async function writeOwnerHandle(handle: FileHandle, owner: IHostLockOwner) {
    await handle.writeFile(`${JSON.stringify(owner, null, 4)}\n`, 'utf8');
    await handle.sync();
}

async function removeOwnedLock(lockDirectory: string, handle: FileHandle) {
    try {
        const owned = await handle.stat();
        const current = await stat(lockDirectory);
        if (owned.dev === current.dev && owned.ino === current.ino) {
            // Keep the descriptor open until unlink completes. A replacement
            // cannot create this path until this exact inode is gone.
            await rm(lockDirectory, {force: true});
        }
    } catch (error) {
        if (!isErrnoException(error) || typeof error.code !== 'string' || ![
            'ENOENT',
            'EEXIST',
        ].includes(error.code ?? '')) {
            throw error;
        }
    } finally {
        await handle.close();
    }
}

async function reclaimStaleLock(lockDirectory: string, token: string) {
    const reclaimDirectory = `${lockDirectory}.reclaim-${token}`;
    try {
        await rename(lockDirectory, reclaimDirectory);
    } catch (error) {
        if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'EEXIST')) {
            return null;
        }
        throw error;
    }
    return reclaimDirectory;
}

export async function acquireHostLock(
    lockDirectory: string,
    dependencies: IHostLockDependencies,
    options: IHostLockOptions = {},
): Promise<IHostLockHandle> {
    const attempts = options.attempts ?? 3;
    const retryDelayMs = options.retryDelayMs ?? 100;
    await mkdir(path.dirname(lockDirectory), {recursive: true});
    const token = dependencies.createToken?.() ?? randomUUID();

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const handle = await tryCreateLockFile(lockDirectory);
        if (handle !== null) {
            try {
                const startTime = await dependencies.probe.startTime(dependencies.pid);
                if (startTime === null) {
                    throw new Error(`Cannot record the host lock owner: the start time of pid ${dependencies.pid} is unavailable.`);
                }
                const owner: IHostLockOwner = {
                    token,
                    hostId: dependencies.hostId,
                    pid: dependencies.pid,
                    startTime,
                    acquiredAt: dependencies.nowIso(),
                };
                await writeOwnerHandle(handle, owner);
                return {
                    lockDirectory,
                    owner,
                    release: () => removeOwnedLock(lockDirectory, handle),
                };
            } catch (error) {
                await removeOwnedLock(lockDirectory, handle).catch(() => undefined);
                throw error;
            }
        }

        const observedLockStat = await stat(lockDirectory).catch(() => null);
        const existing = await readHostLockOwner(lockDirectory);
        if (existing === null && await lockDirectoryAgeMs(lockDirectory) < OWNER_FILE_GRACE_MS) {
            if (attempt + 1 < attempts) {
                await dependencies.sleep(retryDelayMs);
                continue;
            }
            throw new HostLockBusyError(lockDirectory, null);
        }
        const stale = existing === null || !ownershipMatches({
            alive: dependencies.probe.isAlive(existing.pid),
            observedStartTime: await dependencies.probe.startTime(existing.pid),
        }, existing.startTime);
        if (stale) {
            const currentLockStat = await stat(lockDirectory).catch(() => null);
            if (observedLockStat === null
                || currentLockStat === null
                || observedLockStat.dev !== currentLockStat.dev
                || observedLockStat.ino !== currentLockStat.ino
            ) {
                continue;
            }
            const reclaimDirectory = await reclaimStaleLock(lockDirectory, token);
            if (reclaimDirectory === null) {
                continue;
            }
            const reclaimedOwner = await readHostLockOwner(reclaimDirectory);
            if (reclaimedOwner !== null) {
                const stillStale = !ownershipMatches({
                    alive: dependencies.probe.isAlive(reclaimedOwner.pid),
                    observedStartTime: await dependencies.probe.startTime(reclaimedOwner.pid),
                }, reclaimedOwner.startTime);
                if (!stillStale) {
                    // The owner became observable while we were deciding. Put
                    // it back only if the public path is still vacant.
                    await rename(reclaimDirectory, lockDirectory).catch(() => undefined);
                    throw new HostLockBusyError(lockDirectory, reclaimedOwner);
                }
            }
            await rm(reclaimDirectory, {
                force: true,
                recursive: true,
            });
            continue;
        }
        if (attempt + 1 < attempts) {
            await dependencies.sleep(retryDelayMs);
            continue;
        }
        throw new HostLockBusyError(lockDirectory, existing);
    }

    throw new HostLockBusyError(lockDirectory, await readHostLockOwner(lockDirectory));
}

export async function withHostLock<T>(
    lockDirectory: string,
    dependencies: IHostLockDependencies,
    action: (handle: IHostLockHandle) => Promise<T>,
    options: IHostLockOptions = {},
) {
    const handle = await acquireHostLock(lockDirectory, dependencies, options);
    try {
        return await action(handle);
    } finally {
        await handle.release();
    }
}
