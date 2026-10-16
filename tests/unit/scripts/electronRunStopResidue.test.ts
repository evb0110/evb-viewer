import {spawn} from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {isProcessAlive} from '@scripts/electron-run/electronRunProcessTree';
import {
    electronAppTempDirPath,
    electronUserDataPath,
    sessionDir,
    sessionFilePath,
    sessionStartingFilePath,
} from '@scripts/electron-run/electronRunSessionPaths';
import {workspaceCrashCheckpointPath} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {pruneStaleE2ESessions} from '@scripts/electron-run/electronRunE2ESessionPrune';
import {cleanupStaleSessionArtifacts} from '@scripts/electron-run/electronRunSessionArtifacts';
import {stopSingleSession} from '@scripts/electron-run/stopSession';

// Above Linux's default pid_max, so it can never name a live host process.
const UNUSED_PID = 4_194_305;
const RECORDED_CDP_PORT = 65_001;
const STRAY_CDP_PORT = 65_002;

async function forceKillAndWait(child: ReturnType<typeof spawn>) {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    await new Promise<void>((resolve) => {
        const onExit = () => resolve();
        child.once('exit', onExit);
        if (!child.kill('SIGKILL')) {
            child.off('exit', onExit);
            resolve();
        }
    });
}

// Carries the session's automation entry and user-data directory like a real
// Electron main process, but a CDP port the session file never recorded: the
// shape of an Electron that outlived a restart with a fresh port.
function spawnStraySessionElectron(sessionName: string, cdpPort = STRAY_CDP_PORT) {
    const automationAppEntry = join(sessionDir(sessionName), 'automation-electron-app-entry', 'automation-app');
    const child = spawn(process.execPath, [
        '-e',
        'setInterval(() => {}, 1000); process.stdout.write("ready\\n");',
        '--',
        automationAppEntry,
        `--user-data-dir=${electronUserDataPath(sessionName)}`,
        `--remote-debugging-port=${String(cdpPort)}`,
    ], {stdio: [
        'ignore',
        'pipe',
        'ignore',
    ]});
    const ready = new Promise<void>((resolve, reject) => {
        child.stdout?.once('data', () => resolve());
        child.once('error', reject);
        child.once('exit', (code, signal) => reject(new Error(
            `stray child exited before readiness (code ${String(code)}, signal ${String(signal)})`,
        )));
    });
    return {
        child,
        ready,
    };
}

describe('Electron automation stop residue', () => {
    it('removes the session-owned EVB temp namespace after a stopped session', async () => {
        const sessionName = `stop-temp-cleanup-${String(process.pid)}-${String(Date.now())}`;
        const appTempPath = electronAppTempDirPath(sessionName);
        mkdirSync(join(appTempPath, 'pdf-work-orphan'), {recursive: true});
        writeFileSync(join(appTempPath, 'pdf-work-orphan', 'document.pdf'), 'stale');
        try {
            mkdirSync(sessionDir(sessionName), {recursive: true});
            writeFileSync(sessionFilePath(sessionName), JSON.stringify({
                port: 45_001,
                pid: UNUSED_PID,
                cdpPort: 45_002,
                electronPid: null,
                nuxtPid: null,
                nuxtPort: 45_003,
            }));

            await expect(stopSingleSession(sessionName)).resolves.toBeUndefined();

            expect(existsSync(appTempPath)).toBe(false);
        } finally {
            rmSync(sessionDir(sessionName), {
                recursive: true,
                force: true,
            });
            rmSync(appTempPath, {
                recursive: true,
                force: true,
            });
        }
    });

    it('reclaims an abandoned startup namespace after stale startup metadata is cleaned', async () => {
        const sessionName = `stop-startup-recovery-${String(process.pid)}-${String(Date.now())}`;
        const appTempPath = electronAppTempDirPath(sessionName);
        mkdirSync(join(appTempPath, 'pdf-work-abandoned-start'), {recursive: true});
        try {
            mkdirSync(sessionDir(sessionName), {recursive: true});
            writeFileSync(sessionStartingFilePath(sessionName), JSON.stringify({
                pid: UNUSED_PID,
                startedAt: 1,
                electronPids: [],
                cdpPorts: [],
                electronUserDataDir: electronUserDataPath(sessionName),
                nuxtPid: null,
                nuxtPort: null,
                runId: null,
            }));

            await cleanupStaleSessionArtifacts(sessionName);

            expect(existsSync(sessionStartingFilePath(sessionName))).toBe(false);
            expect(existsSync(appTempPath), 'abandoned startup temp was reclaimed').toBe(false);
        } finally {
            rmSync(sessionDir(sessionName), {
                recursive: true,
                force: true,
            });
            rmSync(appTempPath, {
                recursive: true,
                force: true,
            });
        }
    });

    it('returns repeated session temp namespaces to the same bounded baseline', async () => {
        const appTempPaths: string[] = [];
        const sessionDirs: string[] = [];
        try {
            for (let index = 0; index < 4; index += 1) {
                const sessionName = `stop-temp-repeat-${String(process.pid)}-${String(Date.now())}-${String(index)}`;
                const appTempPath = electronAppTempDirPath(sessionName);
                appTempPaths.push(appTempPath);
                sessionDirs.push(sessionDir(sessionName));
                mkdirSync(join(appTempPath, `pdf-work-${String(index)}`), {recursive: true});
                writeFileSync(
                    join(appTempPath, `pdf-work-${String(index)}`, 'document.pdf'),
                    'small representative working copy',
                );
                mkdirSync(sessionDir(sessionName), {recursive: true});
                writeFileSync(sessionFilePath(sessionName), JSON.stringify({
                    port: 45_101 + index,
                    pid: UNUSED_PID,
                    cdpPort: 45_201 + index,
                    electronPid: null,
                    nuxtPid: null,
                    nuxtPort: 45_301 + index,
                }));

                await expect(stopSingleSession(sessionName)).resolves.toBeUndefined();
                expect(existsSync(appTempPath)).toBe(false);
            }

            expect(appTempPaths.filter(path => existsSync(path))).toHaveLength(0);
        } finally {
            for (const path of sessionDirs) {
                rmSync(path, {
                    recursive: true,
                    force: true,
                });
            }
            for (const appTempPath of appTempPaths) {
                rmSync(appTempPath, {
                    recursive: true,
                    force: true,
                });
            }
        }
    });

    it('keeps working-copy temp data when a stop preserves workspace recovery', async () => {
        const sessionName = `stop-temp-preserve-${String(process.pid)}-${String(Date.now())}`;
        const appTempPath = electronAppTempDirPath(sessionName);
        const checkpointPath = workspaceCrashCheckpointPath(sessionName);
        mkdirSync(join(appTempPath, 'pdf-work-recovery'), {recursive: true});
        writeFileSync(join(appTempPath, 'pdf-work-recovery', 'document.pdf'), 'recover me');
        try {
            mkdirSync(sessionDir(sessionName), {recursive: true});
            writeFileSync(sessionFilePath(sessionName), JSON.stringify({
                port: 45_401,
                pid: UNUSED_PID,
                cdpPort: 45_402,
                electronPid: null,
                nuxtPid: null,
                nuxtPort: 45_403,
            }));
            mkdirSync(electronUserDataPath(sessionName), {recursive: true});
            writeFileSync(checkpointPath, '{"checkpoint":true}');

            await expect(
                stopSingleSession(sessionName, {preserveWorkspaceCheckpoint: true}),
            ).resolves.toBeUndefined();

            expect(existsSync(appTempPath), 'recovery working copy is retained').toBe(true);
            expect(existsSync(checkpointPath), 'recovery checkpoint is retained').toBe(true);
        } finally {
            rmSync(sessionDir(sessionName), {
                recursive: true,
                force: true,
            });
            rmSync(appTempPath, {
                recursive: true,
                force: true,
            });
        }
    });

    it.runIf(process.platform !== 'win32')(
        'fails a stop that leaves a session-owned Electron process alive and retains the session',
        async () => {
            const sessionName = `stop-residue-${String(process.pid)}-${String(Date.now())}`;
            const appTempPath = electronAppTempDirPath(sessionName);
            mkdirSync(join(appTempPath, 'pdf-work-live'), {recursive: true});
            const stray = spawnStraySessionElectron(sessionName);
            try {
                await stray.ready;
                mkdirSync(sessionDir(sessionName), {recursive: true});
                writeFileSync(sessionFilePath(sessionName), JSON.stringify({
                    port: 1,
                    pid: UNUSED_PID,
                    cdpPort: RECORDED_CDP_PORT,
                    electronPid: null,
                    nuxtPid: null,
                    nuxtPort: 3_999,
                }));

                const failure = await stopSingleSession(sessionName).catch((error: unknown) => error);

                expect(failure).toBeInstanceOf(Error);
                expect((failure as Error).message).toContain(String(stray.child.pid));
                expect((failure as Error).message).toMatch(/Electron process/u);
                expect(existsSync(sessionFilePath(sessionName)), 'session artifacts are retained').toBe(true);
                expect(isProcessAlive(stray.child.pid ?? 0), 'the assertion reports residue, it does not hide it').toBe(true);
                expect(existsSync(appTempPath), 'active app temp is retained').toBe(true);
            } finally {
                await forceKillAndWait(stray.child);
                rmSync(sessionDir(sessionName), {
                    recursive: true,
                    force: true,
                });
                rmSync(appTempPath, {
                    recursive: true,
                    force: true,
                });
            }
        },
        30_000,
    );

    it.runIf(process.platform !== 'win32')(
        'reclaims a profile-owned orphan without metadata while leaving another active profile intact',
        async () => {
            const orphanName = `stop-orphan-no-metadata-${String(process.pid)}-${String(Date.now())}`;
            const activeName = `stop-active-profile-${String(process.pid)}-${String(Date.now())}`;
            const orphanTempPath = electronAppTempDirPath(orphanName);
            const activeTempPath = electronAppTempDirPath(activeName);
            mkdirSync(join(orphanTempPath, 'pdf-work-orphan'), {recursive: true});
            mkdirSync(join(activeTempPath, 'pdf-work-active'), {recursive: true});
            const orphan = spawnStraySessionElectron(orphanName, STRAY_CDP_PORT + 1);
            const active = spawnStraySessionElectron(activeName, STRAY_CDP_PORT + 2);
            try {
                await Promise.all([
                    orphan.ready,
                    active.ready,
                ]);

                await expect(stopSingleSession(orphanName)).resolves.toBeUndefined();

                expect(isProcessAlive(orphan.child.pid ?? 0), 'orphan process was reclaimed').toBe(false);
                expect(existsSync(orphanTempPath), 'orphan temp namespace was reclaimed').toBe(false);
                expect(isProcessAlive(active.child.pid ?? 0), 'active profile remains live').toBe(true);
                expect(existsSync(activeTempPath), 'active profile temp remains intact').toBe(true);
            } finally {
                await forceKillAndWait(orphan.child);
                await forceKillAndWait(active.child);
                rmSync(sessionDir(orphanName), {
                    recursive: true,
                    force: true,
                });
                rmSync(sessionDir(activeName), {
                    recursive: true,
                    force: true,
                });
                rmSync(orphanTempPath, {
                    recursive: true,
                    force: true,
                });
                rmSync(activeTempPath, {
                    recursive: true,
                    force: true,
                });
            }
        },
        30_000,
    );

    it.runIf(process.platform !== 'win32')(
        'E2E stale pruning finds a profile-owned orphan when session metadata is missing',
        async () => {
            const staleName = `e2e-orphan-no-metadata-${String(process.pid)}-${String(Date.now())}`;
            const activeName = `e2e-active-profile-${String(process.pid)}-${String(Date.now())}`;
            const staleTempPath = electronAppTempDirPath(staleName);
            const activeTempPath = electronAppTempDirPath(activeName);
            const staleDate = new Date(Date.now() - (48 * 60 * 60 * 1000));
            mkdirSync(join(staleTempPath, 'pdf-work-orphan'), {recursive: true});
            mkdirSync(join(activeTempPath, 'pdf-work-active'), {recursive: true});
            mkdirSync(sessionDir(staleName), {recursive: true});
            mkdirSync(sessionDir(activeName), {recursive: true});
            utimesSync(sessionDir(staleName), staleDate, staleDate);
            const stale = spawnStraySessionElectron(staleName, STRAY_CDP_PORT + 3);
            const active = spawnStraySessionElectron(activeName, STRAY_CDP_PORT + 4);
            try {
                await Promise.all([
                    stale.ready,
                    active.ready,
                ]);

                const result = await pruneStaleE2ESessions({
                    candidates: [{
                        name: staleName,
                        path: sessionDir(staleName),
                        mtimeMs: staleDate.getTime(),
                    }],
                    maxAgeMs: 60_000,
                });

                expect(result.stale).toEqual([staleName]);
                expect(result.removed).toEqual([staleName]);
                expect(result.refused).toEqual([]);
                expect(isProcessAlive(stale.child.pid ?? 0), 'stale orphan was terminated').toBe(false);
                expect(existsSync(staleTempPath), 'stale orphan temp was removed').toBe(false);
                expect(isProcessAlive(active.child.pid ?? 0), 'active profile remains live').toBe(true);
                expect(existsSync(activeTempPath), 'active profile temp remains intact').toBe(true);
            } finally {
                await forceKillAndWait(stale.child);
                await forceKillAndWait(active.child);
                rmSync(sessionDir(staleName), {
                    recursive: true,
                    force: true,
                });
                rmSync(sessionDir(activeName), {
                    recursive: true,
                    force: true,
                });
                rmSync(staleTempPath, {
                    recursive: true,
                    force: true,
                });
                rmSync(activeTempPath, {
                    recursive: true,
                    force: true,
                });
            }
        },
        30_000,
    );

    it('E2E stale pruning retains a namespace when a workspace checkpoint exists', async () => {
        const sessionName = `e2e-preserve-checkpoint-${String(process.pid)}-${String(Date.now())}`;
        const appTempPath = electronAppTempDirPath(sessionName);
        const checkpointPath = workspaceCrashCheckpointPath(sessionName);
        const staleDate = new Date(Date.now() - (48 * 60 * 60 * 1000));
        mkdirSync(join(appTempPath, 'pdf-work-recovery'), {recursive: true});
        mkdirSync(sessionDir(sessionName), {recursive: true});
        utimesSync(sessionDir(sessionName), staleDate, staleDate);
        mkdirSync(electronUserDataPath(sessionName), {recursive: true});
        writeFileSync(checkpointPath, '{"checkpoint":true}');
        try {
            const result = await pruneStaleE2ESessions({
                candidates: [{
                    name: sessionName,
                    path: sessionDir(sessionName),
                    mtimeMs: staleDate.getTime(),
                }],
                maxAgeMs: 60_000,
            });

            expect(result.stale).toEqual([sessionName]);
            expect(result.removed).toEqual([]);
            expect(result.refused).toEqual([{
                name: sessionName,
                reason: 'workspace recovery evidence is present; retained for later recovery',
            }]);
            expect(existsSync(appTempPath), 'checkpointed working copy remains').toBe(true);
            expect(existsSync(checkpointPath), 'checkpoint remains').toBe(true);
        } finally {
            rmSync(sessionDir(sessionName), {
                recursive: true,
                force: true,
            });
            rmSync(appTempPath, {
                recursive: true,
                force: true,
            });
        }
    });
});
