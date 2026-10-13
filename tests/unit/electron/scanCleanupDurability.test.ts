import {
    access,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    symlink,
    utimes,
    writeFile,
} from 'node:fs/promises';
import {
    execFileSync,
    spawn,
} from 'node:child_process';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {
    dirname, join,
} from 'node:path';
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
    type IManagedProcessRegistryEntry,
} from '@electron/native-tools/managedProcessRegistry';
import {
    getOwnStartTime,
    type IProcessIdentity,
} from '@electron/utils/processIdentity';
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
        const identity = (pid: number): IProcessIdentity => ({
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

    it('reaps a tool an older build recorded once that build\'s run has ended', async () => {
        const namespacePath = await createTemporaryDirectory();
        const scratchPath = await createManagedScratchTempDir('native-command-', namespacePath);
        const binaryPath = process.platform === 'darwin'
            ? join(namespacePath, 'EVB Viewer.app', 'Contents', 'MacOS', 'node')
            : process.execPath;
        if (binaryPath !== process.execPath) {
            await mkdir(dirname(binaryPath), {recursive: true});
            await copyFile(process.execPath, binaryPath);
        }
        // runNativeCommand starts a tool in its own process group, with its
        // temporary folder at its scratch.
        const child = spawn(binaryPath, [
            '-e',
            'setInterval(() => {}, 1000)',
        ], {
            detached: process.platform !== 'win32',
            env: {
                ...process.env,
                TMPDIR: scratchPath,
                TMP: scratchPath,
                TEMP: scratchPath,
            },
            stdio: 'ignore',
            windowsHide: true,
        });
        try {
            await once(child, 'spawn');
            const registration = await registerManagedProcess(namespacePath, {
                pid: child.pid!,
                hasExited: () => child.exitCode !== null || child.signalCode !== null,
                binaryPath,
                scratchPath,
            });
            // What an older build recorded instead of the exact creation time:
            // bare Linux ticks, the macOS ps start to the second, a Windows
            // clock estimate to the millisecond. Its own run has ended since.
            const olderStartTime = (exact: string, pid: number) => process.platform === 'linux'
                ? exact.split(':')[1]!
                : process.platform === 'darwin'
                    ? execFileSync('/bin/ps', [
                        '-o',
                        'lstart=',
                        '-p',
                        String(pid),
                    ], {
                        encoding: 'utf8',
                        env: {
                            ...process.env,
                            LC_ALL: 'C',
                        },
                    }).trim().replace(/\s+/gu, ' ')
                    : new Date(Date.parse(exact)).toISOString();
            const entry = JSON.parse(await readFile(registration!.entryPath, 'utf8')) as IManagedProcessRegistryEntry;
            await writeFile(registration!.entryPath, JSON.stringify({
                ...entry,
                processStartTime: olderStartTime(entry.processStartTime!, child.pid!),
                ownerStartTime: olderStartTime(entry.ownerStartTime!, process.pid),
            }), 'utf8');
            const exited = once(child, 'exit');

            await expect(reapOrphanedManagedProcesses(namespacePath)).resolves.toBe(1);

            await exited;
            await expect(access(registration!.entryPath)).rejects.toMatchObject({code: 'ENOENT'});
            await expect(access(scratchPath)).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
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

    it('on Linux reaps a tool an older build recorded by bare start ticks, only at those ticks', async () => {
        const namespacePath = await createTemporaryDirectory();
        const registryDirectory = getManagedProcessRegistryDirectory(namespacePath);
        await mkdir(registryDirectory);
        const writeEntry = async (pid: number) => {
            const entryPath = join(registryDirectory, `${MANAGED_PROCESS_REGISTRY_ENTRY_PREFIX}${String(pid)}.json`);
            // Builds before the boot id recorded only the ticks since boot.
            await writeFile(entryPath, JSON.stringify({
                version: 1,
                pid,
                ownerPid: 4241,
                binaryPath: '/native/tesseract',
                processStartTime: '180000000',
                ownerStartTime: '170000000',
            }), 'utf8');
            return entryPath;
        };
        const orphanEntryPath = await writeEntry(4242);
        const reusedEntryPath = await writeEntry(4343);
        const terminate = vi.fn(async () => true);

        await expect(reapOrphanedManagedProcesses(namespacePath, {
            isProcessAlive: pid => pid !== 4241,
            readProcessIdentity: async pid => ({
                executablePath: '/native/tesseract',
                arguments: ['/native/tesseract'],
                startTime: `70d4911d-53e3-441e-b385-a64a34cae556:${pid === 4242 ? '180000000' : '180000001'}`,
            }),
            terminateProcessTree: terminate,
            platform: 'linux',
        })).resolves.toBe(1);

        expect(terminate).toHaveBeenCalledOnce();
        expect(terminate).toHaveBeenCalledWith(4242, expect.anything());
        await expect(access(orphanEntryPath)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(access(reusedEntryPath)).resolves.toBeUndefined();
    });

    it('on Windows reaps a tool at its exact recorded creation time and spares a pid reused 100 ns later', async () => {
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
                // Registration records the creation time Get-Process reports, to 100 ns.
                processStartTime: '2026-10-01T09:59:59.8123456Z',
                ownerStartTime: '2026-10-01T09:00:00.0000000Z',
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
                // pid 4343 now belongs to a process created 100 ns later.
                startTime: pid === 4242 ? '2026-10-01T09:59:59.8123456Z' : '2026-10-01T09:59:59.8123457Z',
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
        const ownStartTime = await getOwnStartTime();
        const writeEntry = (pid: number, ownerPid: number, scratchPath: string) => writeFile(
            pid === 2_147_483_644 ? liveEntryPath : pid === 2_147_483_643 ? otherProfileEntryPath : finishedEntryPath,
            JSON.stringify({
                version: 1,
                pid,
                ownerPid,
                binaryPath: '/native/tool',
                processStartTime: `process-${pid}`,
                // A live owner records its own creation time.
                ownerStartTime: ownerPid === process.pid ? ownStartTime! : 'dead-owner',
                scratchPath,
            } satisfies IManagedProcessRegistryEntry),
            'utf8',
        );
        await writeEntry(2_147_483_645, 2_147_483_647, finishedScratch);
        await writeEntry(2_147_483_644, process.pid, liveScratch);
        await writeEntry(2_147_483_643, 2_147_483_646, otherProfileScratch);
        const options = {
            isProcessAlive: (pid: number) => pid === process.pid,
            readProcessIdentity: async (): Promise<IProcessIdentity> => ({
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
            // This build's exact shape: a different value is another process.
            {processStartTime: '70d4911d-53e3-441e-b385-a64a34cae556:101'},
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
            processStartTime: '70d4911d-53e3-441e-b385-a64a34cae556:100',
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
                startTime: '70d4911d-53e3-441e-b385-a64a34cae556:100',
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
            hasExited: () => false,
            binaryPath: process.execPath,
            manifestPath,
        });

        expect(JSON.parse(await readFile(registration!.entryPath, 'utf8'))).toMatchObject({manifestPath});
        await expect(access(registration!.entryPath)).resolves.toBeUndefined();
        await registration!.unregister();
        await expect(access(registration!.entryPath)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(readdir(getManagedProcessRegistryDirectory(namespacePath))).resolves.toEqual([]);
    });

    it('records no marker for a child that exited before its registration read', async () => {
        const namespacePath = await createTemporaryDirectory();
        const child = spawn(process.execPath, [
            '-e',
            '',
        ], {stdio: 'ignore'});
        await once(child, 'exit');

        await expect(registerManagedProcess(namespacePath, {
            pid: child.pid!,
            hasExited: () => child.exitCode !== null || child.signalCode !== null,
            binaryPath: process.execPath,
        })).resolves.toBeNull();
        await expect(readdir(getManagedProcessRegistryDirectory(namespacePath))).rejects.toMatchObject({code: 'ENOENT'});
    });

    it.runIf(process.platform === 'linux')('records a child whose command line is still empty, as during its exec', async () => {
        const namespacePath = await createTemporaryDirectory();
        // Node's spawn returns once exec has closed the child's descriptors,
        // before the kernel has set up its arguments, so /proc shows no command
        // line for a moment. Emptying the title holds that state for the test.
        const child = spawn(process.execPath, [
            '-e',
            'process.title = ""; console.log("ready"); setInterval(() => {}, 1_000)',
        ], {stdio: [
            'ignore',
            'pipe',
            'ignore',
        ]});
        try {
            await once(child.stdout, 'data');
            const commandLine = await readFile(`/proc/${String(child.pid)}/cmdline`, 'utf8');
            expect(commandLine.split('\0').filter(Boolean)).toEqual([]);

            const registration = await registerManagedProcess(namespacePath, {
                pid: child.pid!,
                hasExited: () => child.exitCode !== null || child.signalCode !== null,
                binaryPath: process.execPath,
            });

            expect(JSON.parse(await readFile(registration!.entryPath, 'utf8'))).toMatchObject({
                pid: child.pid,
                processStartTime: expect.stringMatching(/^[\da-f-]+:\d+$/u),
            });
        } finally {
            child.kill();
        }
    });

    itPosix('records a child that has exited but is not reaped yet under its start time', async () => {
        const namespacePath = await createTemporaryDirectory();
        // Stop the shell before killing its child so SIGCHLD cannot make it
        // reap the child. An immediate exit can be reaped before exec sleep.
        // Resuming the shell in finally lets wait reap the zombie and exit.
        const parent = spawn('sh', [
            '-c',
            'sleep 30 & child=$!; echo "$child"; kill -STOP $$; wait "$child"',
        ], {
            detached: true,
            stdio: [
                'ignore',
                'pipe',
                'ignore',
            ],
        });
        const parentClosed = once(parent, 'close', {signal: AbortSignal.timeout(4_000)});
        let pid: number | undefined;
        try {
            const [pidText] = await once(parent.stdout, 'data', {signal: AbortSignal.timeout(1_000)}) as [Buffer];
            const childPid = Number(pidText.toString().trim());
            expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
            pid = childPid;
            await vi.waitFor(() => {
                expect(execFileSync('ps', [
                    '-o',
                    'stat=',
                    '-p',
                    String(parent.pid),
                ], {encoding: 'utf8'}).trim(), 'fixture parent must stop before its child exits').toMatch(/^T/u);
            }, {timeout: 1_000});
            process.kill(pid, 'SIGKILL');
            await vi.waitFor(() => {
                expect(execFileSync('ps', [
                    '-o',
                    'stat=',
                    '-p',
                    String(pid),
                ], {encoding: 'utf8'}).trim(), 'fixture child must remain an unreaped zombie').toMatch(/^Z/u);
            }, {timeout: 1_000});

            const registration = await registerManagedProcess(namespacePath, {
                pid,
                hasExited: () => false,
                binaryPath: '/native/tool',
            });

            expect(JSON.parse(await readFile(registration!.entryPath, 'utf8'))).toMatchObject({
                pid,
                processStartTime: expect.stringMatching(/\S/u),
            });
        } finally {
            if (pid !== undefined) {
                // Also release a still-running child if a fixture assertion failed.
                try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped. */ }
                parent.kill('SIGCONT');
            } else {
                process.kill(-parent.pid!, 'SIGKILL');
            }
            await parentClosed;
        }
    });

    it('registers a process while the time locale is not English', async () => {
        const namespacePath = await createTemporaryDirectory();
        const previousTimeLocale = process.env.LC_TIME;
        process.env.LC_TIME = 'ru_RU.UTF-8';
        try {
            const registration = await registerManagedProcess(namespacePath, {
                pid: process.pid,
                hasExited: () => false,
                binaryPath: process.execPath,
            });
            await expect(access(registration!.entryPath)).resolves.toBeUndefined();
            await registration!.unregister();
        } finally {
            if (previousTimeLocale === undefined) delete process.env.LC_TIME;
            else process.env.LC_TIME = previousTimeLocale;
        }
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
