import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    utimes,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    SCAN_CLEANUP_PID_ROOT_PREFIX,
    SCAN_CLEANUP_SCRATCH_PREFIX,
    sweepStaleScanCleanupScratchDirs,
} from '@evb/scan-cleanup/core/scratchCleanup';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory() {
    const directory = await mkdtemp(join(tmpdir(), 'scan-cleanup-durability-test-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
        force: true,
        recursive: true,
    })));
});

describe('scan-cleanup durability', () => {
    it('sweeps stale scan-cleanup directories without following symlinks', async () => {
        const parentPath = await createTemporaryDirectory();
        const outsidePath = await createTemporaryDirectory();
        const now = Date.now();
        const stalePath = join(parentPath, `${SCAN_CLEANUP_SCRATCH_PREFIX}stale`);
        const freshPath = join(parentPath, `${SCAN_CLEANUP_SCRATCH_PREFIX}fresh`);
        const unrelatedPath = join(parentPath, 'unrelated-stale');
        const linkPath = join(parentPath, `${SCAN_CLEANUP_SCRATCH_PREFIX}link`);
        await mkdir(stalePath);
        await mkdir(freshPath);
        await mkdir(unrelatedPath);
        await writeFile(join(outsidePath, 'keep.txt'), 'keep', 'utf8');
        await symlink(outsidePath, linkPath, 'dir');
        const staleTime = new Date(now - 120_000);
        await utimes(stalePath, staleTime, staleTime);
        await utimes(unrelatedPath, staleTime, staleTime);

        const log = vi.fn();
        await expect(sweepStaleScanCleanupScratchDirs(parentPath, {
            log,
            maxAgeMs: 60_000,
            now: () => now,
        })).resolves.toBe(1);

        await expect(readFile(join(outsidePath, 'keep.txt'), 'utf8')).resolves.toBe('keep');
        await expect(access(stalePath)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(rm(freshPath, {
            force: true,
            recursive: true,
        })).resolves.toBeUndefined();
        await expect(rm(unrelatedPath, {
            force: true,
            recursive: true,
        })).resolves.toBeUndefined();
        await expect(rm(linkPath, {
            force: true,
            recursive: true,
        })).resolves.toBeUndefined();
        expect(log).toHaveBeenCalledWith(
            'debug',
            `Removed stale scan-cleanup scratch directory "${stalePath}"`,
        );
    });

    it('tolerates parent and per-entry sweep errors', async () => {
        const parentPath = await createTemporaryDirectory();
        const permissionError = Object.assign(new Error('permission denied'), {code: 'EPERM'});
        const log = vi.fn();

        await expect(sweepStaleScanCleanupScratchDirs(parentPath, {
            fileSystem: {readdir: async () => {
                throw permissionError;
            }},
            log,
        })).resolves.toBe(0);
        await expect(sweepStaleScanCleanupScratchDirs(parentPath, {
            fileSystem: {
                readdir: async () => [{
                    isDirectory: () => true,
                    name: `${SCAN_CLEANUP_SCRATCH_PREFIX}entry-error`,
                }],
                lstat: async () => {
                    throw permissionError;
                },
            },
            log,
        })).resolves.toBe(0);

        expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('permission denied'));
    });

    it('never removes a pid-suffixed root whose owner is still running', async () => {
        const parentPath = await createTemporaryDirectory();
        const now = Date.now();
        const livePath = join(parentPath, `${SCAN_CLEANUP_PID_ROOT_PREFIX}4242`);
        const deadPath = join(parentPath, `${SCAN_CLEANUP_PID_ROOT_PREFIX}4243`);
        await mkdir(livePath);
        await mkdir(deadPath);
        const staleTime = new Date(now - 120_000);
        await utimes(livePath, staleTime, staleTime);
        await utimes(deadPath, staleTime, staleTime);

        await expect(sweepStaleScanCleanupScratchDirs(parentPath, {
            isProcessAlive: pid => pid === 4242,
            maxAgeMs: 60_000,
            now: () => now,
        })).resolves.toBe(1);

        await expect(access(livePath)).resolves.toBeUndefined();
        await expect(access(deadPath)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('does not treat random scratch suffixes as pid ownership markers', async () => {
        const parentPath = await createTemporaryDirectory();
        const now = Date.now();
        const conversionPath = join(parentPath, `${SCAN_CLEANUP_SCRATCH_PREFIX}482913`);
        const detectionPath = join(parentPath, `${SCAN_CLEANUP_SCRATCH_PREFIX}detect-482913`);
        await mkdir(conversionPath);
        await mkdir(detectionPath);
        const staleTime = new Date(now - 120_000);
        await utimes(conversionPath, staleTime, staleTime);
        await utimes(detectionPath, staleTime, staleTime);

        await expect(sweepStaleScanCleanupScratchDirs(parentPath, {
            isProcessAlive: pid => pid === 482913,
            maxAgeMs: 60_000,
            now: () => now,
        })).resolves.toBe(2);

        await expect(access(conversionPath)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(access(detectionPath)).rejects.toMatchObject({code: 'ENOENT'});
    });
});
