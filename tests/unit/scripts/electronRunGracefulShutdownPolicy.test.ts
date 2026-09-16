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
import {
    dirname,
    join,
} from 'node:path';
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

const projectRoot = process.cwd();

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

function readProjectSource(path: string) {
    return readFileSync(join(projectRoot, path), 'utf8');
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

    it('requests coordinated Electron quit before the process-tree fallback', () => {
        const sessionSource = readProjectSource('scripts/electron-run/sessionController.ts');
        const stopSource = readProjectSource('scripts/electron-run/stopSession.ts');
        const gracefulQuitIndex = sessionSource.indexOf('void state.browser.close().catch(error => {');
        const processWaitIndex = sessionSource.indexOf('waitForProcessExit(electronPid');
        const electronFallbackIndex = sessionSource.indexOf('killSpawnedProcessTree(state.electronProcess');
        const shutdownCommandIndex = stopSource.indexOf('info, \'shutdown\'');
        const controllerFallbackIndex = stopSource.indexOf('killVerifiedSessionProcess', shutdownCommandIndex);

        expect(gracefulQuitIndex).toBeGreaterThan(-1);
        expect(sessionSource).not.toContain('electronAPI?.windowTabs.closeCurrentWindow');
        expect(processWaitIndex).toBeGreaterThan(gracefulQuitIndex);
        expect(electronFallbackIndex).toBeGreaterThan(processWaitIndex);
        expect(shutdownCommandIndex).toBeGreaterThan(-1);
        expect(controllerFallbackIndex).toBeGreaterThan(shutdownCommandIndex);
        expect(sessionSource).toContain('Graceful app shutdown complete');
        expect(sessionSource).toContain('Graceful shutdown timed out; using process-tree fallback');
    });

    it('nests controller shutdown fallbacks inside the 15 second E2E stop budget', () => {
        const stopSource = readProjectSource('scripts/electron-run/stopSession.ts');
        const sessionRunnerSource = readProjectSource('tests/e2e/electron/helpers/startElectronE2ESession.ts');

        expect(stopSource).toContain('const SESSION_SHUTDOWN_COMMAND_TIMEOUT_MS = 2_000;');
        expect(stopSource).toContain('const SESSION_CONTROLLER_SHUTDOWN_TIMEOUT_MS = 9_000;');
        expect(stopSource).toContain('graceMs: 1500');
        expect(sessionRunnerSource).toContain('const SESSION_STOP_TIMEOUT_MS = 15_000;');
        expect(2_000 + 9_000 + 1_500).toBeLessThan(15_000);
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

    it('preserves crash recovery during a normal start until an explicit stop owns cleanup', () => {
        const sessionSource = readProjectSource('scripts/electron-run/sessionController.ts');
        const startBody = sessionSource.slice(
            sessionSource.indexOf('export async function startControlledSession('),
        );

        expect(startBody).not.toContain('clearAutomationWorkspaceCrashCheckpoint');
        expect(sessionSource).toContain('130,');
        expect(sessionSource).toContain('143,');
        expect(readProjectSource('scripts/electron-run/stopSession.ts'))
            .toContain('clearAutomationWorkspaceCrashCheckpoint(name)');
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

    it('keeps the E2E browser attached until the controller initiates app shutdown', () => {
        const source = readProjectSource('tests/e2e/electron/helpers/startElectronE2ESession.ts');
        const stopStart = source.indexOf('const stop = async (');
        expect(stopStart).toBeGreaterThan(-1);
        const stopBody = source.slice(
            stopStart,
            source.indexOf('return {', stopStart),
        );

        expect(stopBody).toContain('stopSingleSession(scopedSessionName');
        expect(stopBody).not.toContain('browser.disconnect()');
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

    it('waits for Windows termination to land before reporting a result', () => {
        // The forced-kill test above proves the POSIX branch only. Unit tests run
        // on Ubuntu and no lane runs this suite on Windows, so removing the win32
        // wait would leave every required check green. TerminateProcess is
        // asynchronous like SIGKILL, and both branches serve the same caller
        // contract: liveness is read as the result immediately afterwards.
        const source = readProjectSource('scripts/electron-run/electronRunProcessTree.ts');
        // Descendant collection carries its own win32 check, so the search has to
        // start inside the terminating function to reach the right branch.
        const killIndex = source.indexOf('export async function killProcessTree(');
        expect(killIndex, 'process-tree termination must stay in this module').toBeGreaterThan(-1);

        const branchIndex = source.indexOf('if (process.platform === \'win32\')', killIndex);
        expect(branchIndex, 'process-tree termination must still special-case Windows').toBeGreaterThan(-1);

        const taskkillIndex = source.indexOf('taskkill', branchIndex);
        const waitIndex = source.indexOf('await waitForProcessesExit(', branchIndex);
        const returnIndex = source.indexOf('return;', branchIndex);

        expect(taskkillIndex, 'the Windows branch must terminate the tree').toBeGreaterThan(branchIndex);
        expect(waitIndex, 'Windows termination must be awaited before its result is read').toBeGreaterThan(taskkillIndex);
        expect(returnIndex, 'the Windows branch must not return before the wait').toBeGreaterThan(waitIndex);
    });
});
