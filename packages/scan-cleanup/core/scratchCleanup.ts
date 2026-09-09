import {
    lstat,
    mkdtemp,
    readdir,
    rm,
} from 'node:fs/promises';
import {join} from 'node:path';
import {getErrorMessage} from '@contracts/getErrorMessage';

export const SCAN_CLEANUP_SCRATCH_PREFIX = 'scan-cleanup-';
// Preview raster retention roots are the only scratch directories whose
// trailing digits identify the owning process. Other scratch directories use
// mkdtemp's random suffix and must never be mistaken for pid-owned roots.
export const SCAN_CLEANUP_PID_ROOT_PREFIX = `${SCAN_CLEANUP_SCRATCH_PREFIX}rasters-`;
export const SCAN_CLEANUP_SCRATCH_STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface IScanCleanupScratchDirectoryEntry {
    name: string;
    isDirectory: () => boolean;
}

export interface IScanCleanupScratchFileSystem {
    lstat: (path: string) => Promise<{
        isDirectory: () => boolean;
        isSymbolicLink: () => boolean;
        mtimeMs: number
    }>;
    readdir: (path: string) => Promise<readonly IScanCleanupScratchDirectoryEntry[]>;
    rm: (path: string, options: {
        force: boolean;
        recursive: boolean
    }) => Promise<void>;
}

export interface IScanCleanupScratchSweepOptions {
    fileSystem?: Partial<IScanCleanupScratchFileSystem>;
    isProcessAlive?: (pid: number) => boolean;
    log?: (level: 'debug' | 'warn', message: string) => void;
    maxAgeMs?: number;
    now?: () => number;
}

const defaultFileSystem: IScanCleanupScratchFileSystem = {
    lstat: async path => lstat(path),
    readdir: path => readdir(path, {withFileTypes: true}),
    rm: async (path, options) => rm(path, options),
};

function defaultIsProcessAlive(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

// Session-lifetime cache roots (the preview raster retention) carry their
// owning pid as a trailing "-<pid>". A root whose owner is still running is
// live regardless of its age: an app session older than the stale window must
// not have its caches deleted out from under it by another instance's sweep.
function ownerPidOf(name: string) {
    if (!name.startsWith(SCAN_CLEANUP_PID_ROOT_PREFIX)) {
        return null;
    }
    const match = /-(\d+)$/.exec(name);
    return match ? Number.parseInt(match[1]!, 10) : null;
}

export async function sweepStaleScanCleanupScratchDirs(
    parentPath: string,
    options: IScanCleanupScratchSweepOptions = {},
) {
    const fileSystem: IScanCleanupScratchFileSystem = {
        ...defaultFileSystem,
        ...options.fileSystem,
    };
    const log = options.log ?? (() => undefined);
    const now = options.now ?? Date.now;
    const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    const maxAgeMs = options.maxAgeMs ?? SCAN_CLEANUP_SCRATCH_STALE_MAX_AGE_MS;
    let entries: readonly IScanCleanupScratchDirectoryEntry[];
    try {
        entries = await fileSystem.readdir(parentPath);
    } catch (error) {
        log('warn', `Could not sweep scan-cleanup scratch parent "${parentPath}": ${getErrorMessage(error)}`);
        return 0;
    }

    let removedCount = 0;
    for (const entry of entries) {
        if (!entry.name.startsWith(SCAN_CLEANUP_SCRATCH_PREFIX) || !entry.isDirectory()) {
            continue;
        }
        const ownerPid = ownerPidOf(entry.name);
        if (ownerPid !== null && isProcessAlive(ownerPid)) {
            continue;
        }
        const scratchPath = join(parentPath, entry.name);
        try {
            const scratchStat = await fileSystem.lstat(scratchPath);
            if (
                !scratchStat.isDirectory()
                || scratchStat.isSymbolicLink()
                || now() - scratchStat.mtimeMs < maxAgeMs
            ) {
                continue;
            }
            await fileSystem.rm(scratchPath, {
                force: true,
                recursive: true,
            });
            removedCount += 1;
            log('debug', `Removed stale scan-cleanup scratch directory "${scratchPath}"`);
        } catch (error) {
            log('warn', `Could not remove stale scan-cleanup scratch directory "${scratchPath}": ${getErrorMessage(error)}`);
        }
    }
    return removedCount;
}

export async function createScanCleanupScratchDir(
    parentPath: string,
    prefix = SCAN_CLEANUP_SCRATCH_PREFIX,
) {
    return mkdtemp(join(parentPath, prefix));
}
