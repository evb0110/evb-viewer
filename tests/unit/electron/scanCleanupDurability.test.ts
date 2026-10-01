import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    symlink,
    utimes,
    writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
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
    SCAN_CLEANUP_RUN_PREFIX,
    SCAN_CLEANUP_SCRATCH_PREFIX,
    sweepStaleScanCleanupScratchDirs,
} from '@evb/scan-cleanup/core/scratchCleanup';
import {
    getManagedProcessRegistryDirectory,
    registerManagedProcess,
    reapOrphanedManagedProcesses,
    MANAGED_PROCESS_REGISTRY_ENTRY_PREFIX,
    type IManagedProcessIdentity,
    type IManagedProcessRegistryEntry,
} from '@electron/native-tools/managedProcessRegistry';
import { terminateProcessTree } from '@electron/utils/processTree';
import { createManagedScratchTempDir } from '@electron/utils/managedScratchTemp';

const temporaryDirectories: string[] = [];
const itPosix = process.platform === 'win32' ? it.skip : it;

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

    it('keeps a stale main-owned run scratch directory while its process is alive', async () => {
        const parentPath = await createTemporaryDirectory();
        const now = Date.now();
        const livePath = join(parentPath, `${SCAN_CLEANUP_RUN_PREFIX}4242-live`);
        const deadPath = join(parentPath, `${SCAN_CLEANUP_RUN_PREFIX}4243-dead`);
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

    it('reaps only an orphan whose executable, manifest, and process start identity match', async () => {
        const namespacePath = await createTemporaryDirectory();
        const registryDirectory = getManagedProcessRegistryDirectory(namespacePath);
        const scratchPath = await createManagedScratchTempDir('native-command-', namespacePath);
        await mkdir(registryDirectory);
        const entry: IManagedProcessRegistryEntry = {
            version: 1,
            pid: 4242,
            ownerPid: 4241,
            binaryPath: '/native/evb-scan-cleanup',
            manifestPath: '/scratch/manifest.json',
            scratchPath,
            processStartTime: 'child-start',
            ownerStartTime: 'owner-start',
        };
        const entryPath = join(
            registryDirectory,
            `${MANAGED_PROCESS_REGISTRY_ENTRY_PREFIX}test.json`,
        );
        await writeFile(entryPath, JSON.stringify(entry), 'utf8');
        const identity = (pid: number): IManagedProcessIdentity => ({
            executablePath: pid === 4242 ? '/native/evb-scan-cleanup' : '/electron',
            arguments: pid === 4242
                ? [
                    'evb-scan-cleanup',
                    '--manifest',
                    '/scratch/manifest.json',
                ]
                : ['electron'],
            startTime: pid === 4242 ? 'child-start' : 'owner-start',
        });
        const terminate = vi.fn(async () => true);
        const readIdentity = vi.fn(async (pid: number) => identity(pid));

        await expect(reapOrphanedManagedProcesses(namespacePath, {
            isProcessAlive: pid => pid === 4242,
            readProcessIdentity: readIdentity,
            terminateProcessTree: terminate,
            platform: 'linux',
        })).resolves.toBe(1);

        expect(terminate).toHaveBeenCalledWith(4242, expect.objectContaining({preferProcessGroup: true}));
        expect(readIdentity).not.toHaveBeenCalledWith(4241);
        await expect(access(entryPath)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(access(scratchPath)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('reaps a managed tool by executable path and process start identity', async () => {
        const namespacePath = await createTemporaryDirectory();
        const registryDirectory = getManagedProcessRegistryDirectory(namespacePath);
        await mkdir(registryDirectory);
        const entryPath = join(registryDirectory, `${MANAGED_PROCESS_REGISTRY_ENTRY_PREFIX}tesseract.json`);
        const entry: IManagedProcessRegistryEntry = {
            version: 1,
            pid: 4242,
            ownerPid: 4241,
            binaryPath: '/native/tesseract',
            processStartTime: 'child-start',
            ownerStartTime: 'owner-start',
        };
        await writeFile(entryPath, JSON.stringify(entry), 'utf8');
        const terminate = vi.fn(async () => true);

        await expect(reapOrphanedManagedProcesses(namespacePath, {
            isProcessAlive: pid => pid === 4242,
            readProcessIdentity: async pid => ({
                executablePath: pid === 4242 ? '/native/tesseract' : '/electron',
                arguments: pid === 4242
                    ? [
                        '/native/tesseract',
                        '/tmp/page.png',
                    ]
                    : ['electron'],
                startTime: pid === 4242 ? 'child-start' : 'owner-start',
            }),
            terminateProcessTree: terminate,
            platform: 'linux',
        })).resolves.toBe(1);

        expect(terminate).toHaveBeenCalledWith(4242, expect.objectContaining({preferProcessGroup: true}));
        await expect(access(entryPath)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('on Windows reaps a tool started at its recorded spawn time and spares a reused pid', async () => {
        const namespacePath = await createTemporaryDirectory();
        const registryDirectory = getManagedProcessRegistryDirectory(namespacePath);
        await mkdir(registryDirectory);
        const writeEntry = async (pid: number) => {
            const entryPath = join(registryDirectory, `${MANAGED_PROCESS_REGISTRY_ENTRY_PREFIX}${String(pid)}.json`);
            const entry: IManagedProcessRegistryEntry = {
                version: 1,
                pid,
                ownerPid: 4241,
                binaryPath: '/native/qpdf.exe',
                // Registration records the clock right after spawn returns.
                processStartTime: '2026-10-01T10:00:00.000Z',
                ownerStartTime: '2026-10-01T09:00:00.000Z',
            };
            await writeFile(entryPath, JSON.stringify(entry), 'utf8');
            return entryPath;
        };
        const orphanEntryPath = await writeEntry(4242);
        const reusedEntryPath = await writeEntry(4343);
        const terminate = vi.fn(async () => true);

        await expect(reapOrphanedManagedProcesses(namespacePath, {
            isProcessAlive: pid => pid !== 4241,
            readProcessIdentity: async pid => ({
                executablePath: '/native/QPDF.EXE',
                arguments: ['/native/qpdf.exe'],
                // PowerShell reports the creation time, which precedes the
                // recorded spawn time; pid 4343 now belongs to a later process.
                startTime: pid === 4242 ? '2026-10-01T09:59:59.8123456Z' : '2026-10-01T11:00:00.0000000Z',
            }),
            terminateProcessTree: terminate,
            platform: 'win32',
        })).resolves.toBe(1);

        expect(terminate).toHaveBeenCalledOnce();
        expect(terminate).toHaveBeenCalledWith(4242, expect.objectContaining({preferProcessGroup: false}));
        await expect(access(orphanEntryPath)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(access(reusedEntryPath)).resolves.toBeUndefined();
    });

    itPosix('keeps native scratch while a process group has a live descendant', async () => {
        const namespacePath = await createTemporaryDirectory();
        const registryDirectory = getManagedProcessRegistryDirectory(namespacePath);
        const child = spawn('sh', [
            '-c',
            'sleep 30 & exit 0',
        ], {
            detached: true,
            stdio: 'ignore',
        });
        const pid = child.pid;
        if (typeof pid !== 'number') {
            throw new Error('Expected a process id for the detached group');
        }
        await new Promise<void>(resolve => child.once('close', () => resolve()));

        const scratchPath = await createManagedScratchTempDir('native-command-', namespacePath);
        const entryPath = join(registryDirectory, `${MANAGED_PROCESS_REGISTRY_ENTRY_PREFIX}descendant.json`);
        const entry: IManagedProcessRegistryEntry = {
            version: 1,
            pid,
            ownerPid: 2_147_483_647,
            binaryPath: '/native/tool',
            processStartTime: 'leader-start',
            scratchPath,
        };
        await mkdir(registryDirectory);
        await writeFile(entryPath, JSON.stringify(entry), 'utf8');
        const options = {
            isProcessAlive: () => false,
            platform: 'linux' as NodeJS.Platform,
        };

        try {
            await expect(reapOrphanedManagedProcesses(namespacePath, options)).resolves.toBe(0);
            await expect(access(scratchPath)).resolves.toBeUndefined();
            await expect(access(entryPath)).resolves.toBeUndefined();

            await expect(terminateProcessTree(pid, {
                graceMs: 1_000,
                platform: 'linux',
                preferProcessGroup: true,
            })).resolves.toBe(true);
            await reapOrphanedManagedProcesses(namespacePath, options);

            await expect(access(scratchPath)).rejects.toMatchObject({code: 'ENOENT'});
            await expect(access(entryPath)).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            try {
                process.kill(-pid, 'SIGKILL');
            } catch {
                // The process group was already reaped.
            }
        }
    });

    it('reaps only finished invocations in the selected profile namespace', async () => {
        const firstNamespace = await createTemporaryDirectory();
        const secondNamespace = await createTemporaryDirectory();
        const finishedScratch = await createManagedScratchTempDir('native-command-', firstNamespace);
        const liveScratch = await createManagedScratchTempDir('native-command-', firstNamespace);
        const otherProfileScratch = await createManagedScratchTempDir('native-command-', secondNamespace);
        const finishedEntryPath = join(getManagedProcessRegistryDirectory(firstNamespace), `${MANAGED_PROCESS_REGISTRY_ENTRY_PREFIX}finished.json`);
        const liveEntryPath = join(getManagedProcessRegistryDirectory(firstNamespace), `${MANAGED_PROCESS_REGISTRY_ENTRY_PREFIX}live.json`);
        const otherProfileEntryPath = join(getManagedProcessRegistryDirectory(secondNamespace), `${MANAGED_PROCESS_REGISTRY_ENTRY_PREFIX}other-profile.json`);
        for (const directory of [
            getManagedProcessRegistryDirectory(firstNamespace),
            getManagedProcessRegistryDirectory(secondNamespace),
        ]) {
            await mkdir(directory);
        }
        const writeEntry = (pid: number, ownerPid: number, scratchPath: string) => writeFile(
            pid === 2_147_483_644 ? liveEntryPath : pid === 2_147_483_643 ? otherProfileEntryPath : finishedEntryPath,
            JSON.stringify({
                version: 1,
                pid,
                ownerPid,
                binaryPath: '/native/tool',
                processStartTime: `process-${pid}`,
                ownerStartTime: ownerPid === process.pid ? 'live-owner' : 'dead-owner',
                scratchPath,
            } satisfies IManagedProcessRegistryEntry),
            'utf8',
        );
        await writeEntry(2_147_483_645, 2_147_483_647, finishedScratch);
        await writeEntry(2_147_483_644, process.pid, liveScratch);
        await writeEntry(2_147_483_643, 2_147_483_646, otherProfileScratch);
        const options = {
            isProcessAlive: (pid: number) => pid === process.pid,
            readProcessIdentity: async (): Promise<IManagedProcessIdentity> => ({
                executablePath: '/electron',
                arguments: ['electron'],
                startTime: 'live-owner',
            }),
            platform: 'linux' as NodeJS.Platform,
        };

        await reapOrphanedManagedProcesses(firstNamespace, options);

        await expect(access(finishedScratch)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(access(finishedEntryPath)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(access(liveScratch)).resolves.toBeUndefined();
        await expect(access(liveEntryPath)).resolves.toBeUndefined();
        await expect(access(otherProfileScratch)).resolves.toBeUndefined();
        await expect(access(otherProfileEntryPath)).resolves.toBeUndefined();

        await reapOrphanedManagedProcesses(secondNamespace, options);
        await expect(access(otherProfileScratch)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(access(otherProfileEntryPath)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it.each([
        [
            'process start time',
            {processStartTime: 'other-child-start'},
        ],
        [
            'binary path',
            {binaryPath: '/native/other-scan-cleanup'},
        ],
        [
            'manifest path',
            {manifestPath: '/scratch/other-manifest.json'},
        ],
    ] as const)('retains an orphan marker when the live process identity mismatches by %s', async (_label, change) => {
        const namespacePath = await createTemporaryDirectory();
        const registryDirectory = getManagedProcessRegistryDirectory(namespacePath);
        await mkdir(registryDirectory);
        const entry: IManagedProcessRegistryEntry = {
            version: 1,
            pid: 4242,
            ownerPid: 4241,
            binaryPath: '/native/evb-scan-cleanup',
            manifestPath: '/scratch/manifest.json',
            processStartTime: 'child-start',
            ownerStartTime: 'owner-start',
            ...change,
        };
        const entryPath = join(
            registryDirectory,
            `${MANAGED_PROCESS_REGISTRY_ENTRY_PREFIX}${_label.replaceAll(' ', '-')}.json`,
        );
        await writeFile(entryPath, JSON.stringify(entry), 'utf8');
        const terminate = vi.fn(async () => true);

        await expect(reapOrphanedManagedProcesses(namespacePath, {
            isProcessAlive: pid => pid === 4242,
            readProcessIdentity: async () => ({
                executablePath: '/native/evb-scan-cleanup',
                arguments: [
                    'evb-scan-cleanup',
                    '--manifest',
                    '/scratch/manifest.json',
                ],
                startTime: 'child-start',
            }),
            terminateProcessTree: terminate,
            platform: 'linux',
        })).resolves.toBe(0);

        expect(terminate).not.toHaveBeenCalled();
        await expect(access(entryPath)).resolves.toBeUndefined();
    });

    it('removes a sidecar marker when its owner closes it normally', async () => {
        const namespacePath = await createTemporaryDirectory();
        const manifestPath = join(namespacePath, 'manifest.json');
        const registration = await registerManagedProcess(namespacePath, {
            pid: process.pid,
            binaryPath: process.execPath,
            manifestPath,
        });

        expect(JSON.parse(await readFile(registration.entryPath, 'utf8'))).toMatchObject({manifestPath});
        await expect(access(registration.entryPath)).resolves.toBeUndefined();
        await registration.unregister();
        await expect(access(registration.entryPath)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(readdir(getManagedProcessRegistryDirectory(namespacePath))).resolves.toEqual([]);
    });

    it('leaves a marker for a live owning worker and never signals its sidecar', async () => {
        const namespacePath = await createTemporaryDirectory();
        const registryDirectory = getManagedProcessRegistryDirectory(namespacePath);
        await mkdir(registryDirectory);
        const entry: IManagedProcessRegistryEntry = {
            version: 1,
            pid: 4242,
            ownerPid: 4241,
            binaryPath: '/native/evb-scan-cleanup',
            manifestPath: '/scratch/manifest.json',
            processStartTime: 'child-start',
            ownerStartTime: 'owner-start',
        };
        const entryPath = join(
            registryDirectory,
            `${MANAGED_PROCESS_REGISTRY_ENTRY_PREFIX}live.json`,
        );
        await writeFile(entryPath, JSON.stringify(entry), 'utf8');
        const terminate = vi.fn(async () => true);

        await expect(reapOrphanedManagedProcesses(namespacePath, {
            isProcessAlive: () => true,
            readProcessIdentity: async () => ({
                executablePath: '/electron',
                arguments: ['electron'],
                startTime: 'owner-start',
            }),
            terminateProcessTree: terminate,
            platform: 'linux',
        })).resolves.toBe(0);

        expect(terminate).not.toHaveBeenCalled();
        await expect(access(entryPath)).resolves.toBeUndefined();
    });
});
