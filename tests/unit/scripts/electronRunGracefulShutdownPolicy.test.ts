import {
    execFileSync,
    spawn,
} from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {dirname} from 'node:path';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    isElectronRunCommand,
    parseElectronRunCommandRequest,
} from '@scripts/electron-run/electronRunProtocol';
import {
    inspectProcessIdentity,
    killVerifiedSessionProcess,
} from '@scripts/electron-run/electronRunProcessIdentity';
import type * as TElectronRunProcessTree from '@scripts/electron-run/electronRunProcessTree';
import {
    shouldRemoveSessionStopArtifacts,
    stopSingleSession,
} from '@scripts/electron-run/stopSession';
import {
    clearAutomationWorkspaceCrashCheckpoint,
    workspaceCrashCheckpointPath,
} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {
    sessionDir,
    sessionFilePath,
} from '@scripts/electron-run/electronRunSessionPaths';
import {
    clearAutomationWorkspaceCrashCheckpointAfterSessionExit,
    shouldClearAutomationWorkspaceCrashCheckpointOnExit,
    shouldPreserveWorkspaceRecoveryArtifacts,
} from '@scripts/electron-run/sessionController';

const processTree = vi.hoisted(() => ({isProcessAlive: vi.fn<(pid: number) => boolean>()}));

vi.mock('@scripts/electron-run/electronRunProcessTree', async importOriginal => ({
    ...await importOriginal<typeof TElectronRunProcessTree>(),
    isProcessAlive: processTree.isProcessAlive,
}));

// Above Linux's default pid_max, so it can never name a live host process.
const UNUSED_PID = 4_194_305;

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

function readPosixProcessState(pid: number) {
    if (process.platform === 'linux') {
        const procStat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
        return procStat.slice(procStat.lastIndexOf(')') + 1).trimStart().charAt(0);
    }
    return execFileSync('ps', [
        '-p',
        String(pid),
        '-o',
        'stat=',
    ], {encoding: 'utf8'}).trim().charAt(0);
}

// A child that exited while its parent neither waits for it nor dies stays a
// zombie: `kill(pid, 0)` still succeeds and `ps` reports `<defunct>`.
async function spawnUnreapedZombie() {
    const parent = spawn('python3', [
        '-c',
        'import os,time\npid=os.fork()\nif pid == 0: os._exit(0)\nprint(pid, flush=True)\ntime.sleep(30)',
    ], {stdio: [
        'ignore',
        'pipe',
        'ignore',
    ]});
    const zombiePid = await new Promise<number>((resolve, reject) => {
        parent.stdout?.once('data', chunk => resolve(Number(String(chunk).trim())));
        parent.once('error', reject);
        parent.once('exit', (code, signal) => reject(new Error(
            `zombie parent exited before reporting its child (code ${String(code)}, signal ${String(signal)})`,
        )));
    });
    expect(zombiePid).toBeGreaterThan(0);
    await vi.waitFor(() => {
        expect(readPosixProcessState(zombiePid)).toBe('Z');
    });
    return {
        parent,
        zombiePid,
    };
}

describe('Electron automation graceful shutdown policy', () => {
    it('exposes a controller-owned shutdown command', () => {
        expect(isElectronRunCommand('shutdown')).toBe(true);
        expect(parseElectronRunCommandRequest({
            command: 'shutdown',
            args: [],
        })).toEqual({
            command: 'shutdown',
            args: [],
        });
    });

    it('removes only the crash-recovery checkpoint on an intentional automation stop', () => {
        const sessionName = `checkpoint-policy-${String(process.pid)}-${String(Date.now())}`;
        const checkpointPath = workspaceCrashCheckpointPath(sessionName);
        try {
            mkdirSync(dirname(checkpointPath), {recursive: true});
            writeFileSync(checkpointPath, '{"checkpoint":true}', 'utf8');

            expect(clearAutomationWorkspaceCrashCheckpoint(sessionName)).toBe(true);
            expect(clearAutomationWorkspaceCrashCheckpoint(sessionName)).toBe(false);
        } finally {
            rmSync(sessionDir(sessionName), {
                recursive: true,
                force: true,
            });
        }
    });

    it('retains the crash-recovery checkpoint for a non-clean process restart', async () => {
        const sessionName = `checkpoint-restart-policy-${String(process.pid)}-${String(Date.now())}`;
        const checkpointPath = workspaceCrashCheckpointPath(sessionName);
        processTree.isProcessAlive.mockReset();
        processTree.isProcessAlive.mockReturnValue(false);
        try {
            mkdirSync(dirname(checkpointPath), {recursive: true});
            writeFileSync(checkpointPath, '{"checkpoint":true}', 'utf8');

            await stopSingleSession(sessionName, {preserveWorkspaceCheckpoint: true});

            expect(existsSync(checkpointPath)).toBe(true);
        } finally {
            rmSync(sessionDir(sessionName), {
                recursive: true,
                force: true,
            });
        }
    });

    it('clears restart checkpoints for controlled exits while retaining genuine crash recovery', () => {
        const sessionName = `restart-checkpoint-policy-${String(process.pid)}-${String(Date.now())}`;
        const checkpointPath = workspaceCrashCheckpointPath(sessionName);
        try {
            mkdirSync(dirname(checkpointPath), {recursive: true});
            writeFileSync(checkpointPath, '{"checkpoint":true}', 'utf8');

            expect(shouldClearAutomationWorkspaceCrashCheckpointOnExit(1)).toBe(false);
            expect(clearAutomationWorkspaceCrashCheckpointAfterSessionExit(1, sessionName)).toBe(false);
            expect(existsSync(checkpointPath)).toBe(true);

            expect(shouldClearAutomationWorkspaceCrashCheckpointOnExit(130)).toBe(true);
            expect(shouldClearAutomationWorkspaceCrashCheckpointOnExit(143)).toBe(true);
            expect(clearAutomationWorkspaceCrashCheckpointAfterSessionExit(143, sessionName)).toBe(true);
            expect(existsSync(checkpointPath)).toBe(false);
        } finally {
            rmSync(sessionDir(sessionName), {
                recursive: true,
                force: true,
            });
        }
    });

    it('retains the temp namespace when a crash checkpoint survives the controller exit', () => {
        expect(shouldPreserveWorkspaceRecoveryArtifacts(1, false, true)).toBe(true);
        expect(shouldPreserveWorkspaceRecoveryArtifacts(0, false, true)).toBe(false);
        expect(shouldPreserveWorkspaceRecoveryArtifacts(143, true, false)).toBe(true);
        expect(shouldPreserveWorkspaceRecoveryArtifacts(1, false, false)).toBe(false);
    });

    it('retains session artifacts whenever any verified termination is refused', async () => {
        expect(shouldRemoveSessionStopArtifacts([
            true,
            true,
            true,
        ])).toBe(true);
        expect(shouldRemoveSessionStopArtifacts([
            false,
            true,
            true,
        ])).toBe(false);
        expect(shouldRemoveSessionStopArtifacts([
            true,
            false,
            true,
        ])).toBe(false);
        expect(shouldRemoveSessionStopArtifacts([
            true,
            true,
            false,
        ])).toBe(false);

        const sessionName = `refused-stop-policy-${String(process.pid)}-${String(Date.now())}`;
        processTree.isProcessAlive.mockReset();
        processTree.isProcessAlive.mockImplementation(pid => pid === process.pid);
        try {
            mkdirSync(sessionDir(sessionName), {recursive: true});
            writeFileSync(sessionFilePath(sessionName), JSON.stringify({
                port: 45_001,
                pid: process.pid,
                cdpPort: 45_002,
                electronPid: null,
                nuxtPid: null,
                nuxtPort: 45_003,
            }), 'utf8');

            await expect(stopSingleSession(sessionName)).rejects.toThrow(
                'session artifacts were retained',
            );
            expect(existsSync(sessionFilePath(sessionName))).toBe(true);
        } finally {
            rmSync(sessionDir(sessionName), {
                recursive: true,
                force: true,
            });
        }
    });

    it('treats a process that exits while its identity is read as terminated, not refused', async () => {
        // A session process can exit between the liveness gate and the `ps`
        // read that establishes ownership, which makes it indistinguishable
        // from an unrelated PID. Reporting that as a refusal strands the
        // session directory and forces a second stop, so a PID that is gone
        // by the time identity is unavailable must count as terminated.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        processTree.isProcessAlive.mockReset();
        processTree.isProcessAlive.mockReturnValueOnce(true).mockReturnValue(false);

        try {
            await expect(killVerifiedSessionProcess({
                pid: UNUSED_PID,
                expectation: {
                    kind: 'controller',
                    sessionName: 'exit-during-identity-read',
                },
            })).resolves.toBe(true);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it('removes session artifacts when the controller exits while its identity is read', async () => {
        const sessionName = `stop-race-policy-${String(process.pid)}-${String(Date.now())}`;
        processTree.isProcessAlive.mockReset();
        processTree.isProcessAlive.mockReturnValueOnce(true).mockReturnValue(false);
        try {
            mkdirSync(sessionDir(sessionName), {recursive: true});
            writeFileSync(sessionFilePath(sessionName), JSON.stringify({
                port: 45_001,
                pid: UNUSED_PID,
                cdpPort: 45_002,
                electronPid: null,
                nuxtPid: null,
                nuxtPort: 45_003,
            }), 'utf8');

            await expect(stopSingleSession(sessionName)).resolves.toBeUndefined();
            expect(existsSync(sessionFilePath(sessionName))).toBe(false);
        } finally {
            rmSync(sessionDir(sessionName), {
                recursive: true,
                force: true,
            });
        }
    });

    it('refuses to terminate a live process whose identity does not match the session', async () => {
        // Exercised against a real, still-running process so the refusal comes
        // from a successfully read identity that fails ownership matching,
        // rather than from an absent PID that yields no identity at all. The
        // child runs from the project root, so it clears the project-identity
        // half of the controller check and can only be rejected on the
        // controller entry point itself.
        const {isProcessAlive} = await vi.importActual<typeof TElectronRunProcessTree>(
            '@scripts/electron-run/electronRunProcessTree',
        );
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        processTree.isProcessAlive.mockReset();
        processTree.isProcessAlive.mockImplementation(isProcessAlive);

        const unrelated = spawn(process.execPath, [
            '-e',
            'setTimeout(() => {}, 30000)',
        ], {stdio: 'ignore'});
        const unrelatedPid = unrelated.pid ?? 0;
        try {
            expect(unrelatedPid).toBeGreaterThan(0);
            await vi.waitFor(() => {
                expect(inspectProcessIdentity(unrelatedPid)).not.toBeNull();
            });

            await expect(killVerifiedSessionProcess({
                pid: unrelatedPid,
                expectation: {
                    kind: 'controller',
                    sessionName: 'unrelated-live-process',
                },
            })).resolves.toBe(false);
            expect(isProcessAlive(unrelatedPid)).toBe(true);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('Refused to terminate'));
        } finally {
            warn.mockRestore();
            await forceKillAndWait(unrelated);
        }
    });

    it('reports a force-killed process as terminated once it is actually gone', async () => {
        // SIGKILL only schedules teardown, so a process that ignores SIGTERM is
        // still visible to `kill(pid, 0)` when the signal is delivered. Every
        // caller reads the liveness check straight after termination as its
        // result, which turned a successfully killed session process into a
        // refusal that stranded the session directory and demanded a second
        // stop. The child confirms its handler is installed before termination
        // starts, so the forced-kill path is the one under test.
        const {
            isProcessAlive,
            killProcessTree,
        } = await vi.importActual<typeof TElectronRunProcessTree>(
            '@scripts/electron-run/electronRunProcessTree',
        );
        const stubborn = spawn(process.execPath, [
            '-e',
            'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("ready\\n");',
        ], {stdio: [
            'ignore',
            'pipe',
            'ignore',
        ]});
        const stubbornPid = stubborn.pid ?? 0;
        try {
            expect(stubbornPid).toBeGreaterThan(0);
            await new Promise<void>((resolve, reject) => {
                if (!stubborn.stdout) {
                    reject(new Error('stubborn child was spawned without stdout'));
                    return;
                }
                stubborn.stdout.once('data', () => resolve());
                stubborn.once('error', reject);
                // A child that starts and then dies emits neither, so without this
                // the suite would wait out its own timeout instead of reporting
                // that the fixture never became ready.
                stubborn.once('exit', (code, signal) => reject(new Error(
                    `stubborn child exited before readiness (code ${code}, signal ${signal})`,
                )));
            });

            await killProcessTree(stubbornPid, 150);

            expect(
                isProcessAlive(stubbornPid),
                'a force-killed process must be observed gone before termination reports its result',
            ).toBe(false);
        } finally {
            await forceKillAndWait(stubborn);
        }
    });

    it.runIf(process.platform !== 'win32')('treats an unreaped zombie as exited', async () => {
        // The Linux branch reads /proc for this. macOS has no procfs, and
        // `kill(pid, 0)` succeeds for a zombie there, so a session process that
        // exited but has not been reaped yet reported as alive.
        const {isProcessAlive} = await vi.importActual<typeof TElectronRunProcessTree>(
            '@scripts/electron-run/electronRunProcessTree',
        );
        const {
            parent,
            zombiePid,
        } = await spawnUnreapedZombie();
        try {
            expect(
                isProcessAlive(zombiePid),
                'a zombie has exited and must not block Electron session restart',
            ).toBe(false);
        } finally {
            await forceKillAndWait(parent);
        }
    });

    it.runIf(process.platform !== 'win32')('removes session artifacts when the controller is an unreaped zombie', async () => {
        // The E2E controller is a detached child of the vitest worker, so it
        // is reaped only when the worker's event loop turns. The non-clean
        // hard-restart stop kills Electron and then probes the controller's
        // identity in one synchronous stretch; a controller that exited on
        // Electron's death inside that stretch is a zombie whose `ps` command
        // is `<defunct>`. That failed ownership matching while liveness said
        // alive, which the stop reported as a refusal and retained artifacts.
        const {isProcessAlive} = await vi.importActual<typeof TElectronRunProcessTree>(
            '@scripts/electron-run/electronRunProcessTree',
        );
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        processTree.isProcessAlive.mockReset();
        processTree.isProcessAlive.mockImplementation(isProcessAlive);
        const sessionName = `zombie-controller-policy-${String(process.pid)}-${String(Date.now())}`;
        const {
            parent,
            zombiePid,
        } = await spawnUnreapedZombie();
        try {
            mkdirSync(sessionDir(sessionName), {recursive: true});
            writeFileSync(sessionFilePath(sessionName), JSON.stringify({
                port: 45_001,
                pid: zombiePid,
                cdpPort: 45_002,
                electronPid: null,
                nuxtPid: null,
                nuxtPort: 45_003,
            }), 'utf8');

            await expect(stopSingleSession(sessionName, {
                keepNuxt: true,
                preserveWorkspaceCheckpoint: true,
                crashElectronBeforeStop: true,
            })).resolves.toBeUndefined();
            expect(existsSync(sessionFilePath(sessionName))).toBe(false);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
            await forceKillAndWait(parent);
            rmSync(sessionDir(sessionName), {
                recursive: true,
                force: true,
            });
        }
    });
});
