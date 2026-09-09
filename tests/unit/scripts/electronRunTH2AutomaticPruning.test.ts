import {spawn} from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {getAppTempDirPathForUserData} from '@electron/utils/appTempDir';
import {
    findFreePort,
    isProcessAlive,
} from '@scripts/electron-run/electronRunProcessTree';
import {projectRoot} from '@scripts/electron-run/projectRoot';
import {
    electronUserDataPath,
    sessionDir,
    sessionFilePath,
    sessionStartingFilePath,
} from '@scripts/electron-run/electronRunSessionPaths';
import {
    cleanupSessionStartingAttempt,
    cleanupStaleSessionArtifacts,
    classifySessionControllerOwnership,
    type IProcessIdentitySnapshot,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import {workspaceCrashCheckpointPath} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {pruneStaleE2ESessions} from '@scripts/electron-run/electronRunE2ESessionPrune';
import type {ISessionInfo} from '@scripts/electron-run/electronRunSessionTypes';

const UNUSED_PID = 4_194_305;
const STALE_MTIME_MS = 1_700_000_000_000;
const PRUNE_NOW_MS = STALE_MTIME_MS + (48 * 60 * 60 * 1000);
const PRUNE_MAX_AGE_MS = 60 * 60 * 1000;
const CONTROLLER_SENTINEL_SCRIPT = 'setInterval(() => {}, 1000); process.stdout.write("ready\\n");';
const NUXT_SENTINEL_SCRIPT = 'const http = require("node:http"); '
    + 'const server = http.createServer((_req, res) => res.end("ok")); '
    + 'server.listen(Number(process.env.PORT), "127.0.0.1", () => process.stdout.write("ready\\n")); '
    + 'setInterval(() => {}, 1000);';

let sessionSequence = 0;

interface ITestSessionInfoOptions {
    cdpPort?: number;
    controllerPort?: number;
    electronPid?: number | null;
    nuxtPid?: number | null;
    nuxtPort?: number;
}

function freshSessionName(label: string) {
    sessionSequence += 1;
    return `e2e-th2-${label}-${String(process.pid)}-${String(Date.now())}-${String(sessionSequence)}`;
}

function staleCandidate(name: string) {
    return {
        name,
        path: sessionDir(name),
        mtimeMs: STALE_MTIME_MS,
    };
}

function writeEvidence(name: string, fileName: string) {
    const evidencePath = join(sessionDir(name), 'evidence', fileName);
    mkdirSync(join(sessionDir(name), 'evidence'), {recursive: true});
    writeFileSync(evidencePath, 'keep this sentinel', 'utf8');
    return evidencePath;
}

async function writeSessionInfo(
    name: string,
    pid: number,
    options: ITestSessionInfoOptions = {},
): Promise<ISessionInfo> {
    const info: ISessionInfo = {
        port: options.controllerPort ?? await findFreePort(),
        pid,
        cdpPort: options.cdpPort ?? await findFreePort(),
        electronPid: options.electronPid ?? null,
        nuxtPid: options.nuxtPid ?? null,
        nuxtPort: options.nuxtPort ?? await findFreePort(),
        runId: null,
    };
    mkdirSync(sessionDir(name), {recursive: true});
    writeFileSync(sessionFilePath(name), JSON.stringify(info), 'utf8');
    return info;
}

function writeSessionStarting(
    name: string,
    pid: number,
    options: {
        nuxtPid?: number | null;
        nuxtPort?: number | null;
    } = {},
) {
    mkdirSync(sessionDir(name), {recursive: true});
    writeFileSync(sessionStartingFilePath(name), JSON.stringify({
        pid,
        startedAt: STALE_MTIME_MS,
        electronPids: [],
        cdpPorts: [],
        electronUserDataDir: electronUserDataPath(name),
        nuxtPid: options.nuxtPid ?? null,
        nuxtPort: options.nuxtPort ?? null,
        runId: null,
    }), 'utf8');
}

function disposeSession(name: string) {
    rmSync(sessionDir(name), {
        recursive: true,
        force: true,
    });
    rmSync(getAppTempDirPathForUserData(electronUserDataPath(name)), {
        recursive: true,
        force: true,
    });
}

function spawnReadyProcess(
    script: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
) {
    const child = spawn(process.execPath, [
        '-e',
        script,
        '--',
        ...args,
    ], {
        cwd: projectRoot,
        env,
        stdio: [
            'ignore',
            'pipe',
            'ignore',
        ],
    });
    const ready = new Promise<void>((resolve, reject) => {
        child.stdout?.once('data', () => resolve());
        child.once('error', reject);
        child.once('exit', (code, signal) => reject(new Error(
            `sentinel exited before readiness (code ${String(code)}, signal ${String(signal)})`,
        )));
    });
    return {
        child,
        ready,
    };
}

function spawnControllerSentinel(sessionName: string, startup: boolean) {
    const entry = startup
        ? join(projectRoot, 'scripts', 'electron-run', 'ephemeralSessionEntry.ts')
        : join(projectRoot, 'scripts', 'electronRun.ts');
    const args = startup
        ? [
            entry,
            sessionName,
        ]
        : [
            entry,
            `--session=${sessionName}`,
            'start',
        ];
    return spawnReadyProcess(CONTROLLER_SENTINEL_SCRIPT, args);
}

function spawnNuxtSentinel(port: number) {
    return spawnReadyProcess(
        NUXT_SENTINEL_SCRIPT,
        [
            'pnpm',
            'run',
            'dev:nuxt',
        ],
        {
            ...process.env,
            PORT: String(port),
        },
    );
}

function childPid(child: ReturnType<typeof spawn>) {
    if (!child.pid) {
        throw new Error('sentinel did not expose a PID');
    }
    return child.pid;
}

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

describe('TH-2 automatic E2E session pruning', () => {
    it.runIf(process.platform !== 'win32')(
        'retains an old E2E directory with a verified live controller',
        async () => {
            const name = freshSessionName('live-controller');
            const controller = spawnControllerSentinel(name, false);
            try {
                await controller.ready;
                const pid = childPid(controller.child);
                const evidencePath = writeEvidence(name, 'controller-live.txt');
                await writeSessionInfo(name, pid);

                const result = await pruneStaleE2ESessions({
                    candidates: [staleCandidate(name)],
                    nowMs: PRUNE_NOW_MS,
                    maxAgeMs: PRUNE_MAX_AGE_MS,
                });

                expect(result.stale).toEqual([name]);
                expect(result.removed).toEqual([]);
                expect(result.refused).toHaveLength(1);
                expect(result.refused[0]?.reason).toContain('verified live controller');
                expect(existsSync(sessionFilePath(name))).toBe(true);
                expect(existsSync(evidencePath)).toBe(true);
                expect(isProcessAlive(pid)).toBe(true);
            } finally {
                await forceKillAndWait(controller.child);
                disposeSession(name);
            }
        },
        30_000,
    );

    it.runIf(process.platform !== 'win32')(
        'retains an old E2E directory with a verified live startup-controller',
        async () => {
            const name = freshSessionName('live-startup-controller');
            const controller = spawnControllerSentinel(name, true);
            try {
                await controller.ready;
                const pid = childPid(controller.child);
                const evidencePath = writeEvidence(name, 'startup-live.txt');
                writeSessionStarting(name, pid);

                const result = await pruneStaleE2ESessions({
                    candidates: [staleCandidate(name)],
                    nowMs: PRUNE_NOW_MS,
                    maxAgeMs: PRUNE_MAX_AGE_MS,
                });

                expect(result.stale).toEqual([name]);
                expect(result.removed).toEqual([]);
                expect(result.refused).toHaveLength(1);
                expect(result.refused[0]?.reason).toContain('verified live startup-controller');
                expect(existsSync(sessionStartingFilePath(name))).toBe(true);
                expect(existsSync(evidencePath)).toBe(true);
                expect(isProcessAlive(pid)).toBe(true);
            } finally {
                await forceKillAndWait(controller.child);
                disposeSession(name);
            }
        },
        30_000,
    );

    it('retains a live PID when an injected identity probe reports PID reuse', async () => {
        const name = freshSessionName('pid-reuse');
        const pid = 73_001;
        const info = await writeSessionInfo(name, pid);
        const evidencePath = writeEvidence(name, 'pid-reuse.txt');
        const snapshot: IProcessIdentitySnapshot = {
            pid,
            platform: 'win32',
            command: 'unrelated.exe --session=reused',
            cwd: null,
            environment: '',
            descendantPids: [],
            pidsOnExpectedPort: [],
        };
        const isAlive = vi.fn(() => true);
        const inspect = vi.fn(() => snapshot);
        const matches = vi.fn(() => false);

        try {
            const ownership = classifySessionControllerOwnership(name, {
                info,
                starting: null,
                isProcessAlive: isAlive,
                inspectProcessIdentity: inspect,
                matchesSessionProcessIdentity: matches,
            });
            expect(ownership.status).toBe('ambiguous');
            expect(ownership.reason).toContain('PID may have been reused');

            const result = await cleanupStaleSessionArtifacts(name, {
                info,
                starting: null,
                isProcessAlive: isAlive,
                inspectProcessIdentity: inspect,
                matchesSessionProcessIdentity: matches,
            });
            expect(result.retained).toBe(true);
            expect(result.reason).toContain('identity probe failed');
            expect(existsSync(sessionFilePath(name))).toBe(true);
            expect(existsSync(evidencePath)).toBe(true);
            expect(matches).toHaveBeenCalled();
        } finally {
            disposeSession(name);
        }
    });

    it.runIf(process.platform !== 'win32')(
        'keeps a shared Nuxt server through global prune, list cleanup, and detached-start cleanup',
        async () => {
            const activeName = freshSessionName('shared-active');
            const globalName = freshSessionName('shared-global');
            const listName = freshSessionName('shared-list');
            const detachedName = freshSessionName('shared-detached');
            const nuxtPort = await findFreePort();
            const nuxt = spawnNuxtSentinel(nuxtPort);
            const activeController = spawnControllerSentinel(activeName, false);
            try {
                await Promise.all([
                    nuxt.ready,
                    activeController.ready,
                ]);
                const nuxtPid = childPid(nuxt.child);
                const activePid = childPid(activeController.child);
                await writeSessionInfo(activeName, activePid, {
                    nuxtPid,
                    nuxtPort,
                });
                await writeSessionInfo(globalName, UNUSED_PID, {
                    nuxtPid,
                    nuxtPort,
                });
                await writeSessionInfo(listName, UNUSED_PID, {
                    nuxtPid,
                    nuxtPort,
                });
                writeSessionStarting(detachedName, UNUSED_PID, {
                    nuxtPid,
                    nuxtPort,
                });

                const globalResult = await pruneStaleE2ESessions({
                    candidates: [staleCandidate(globalName)],
                    nowMs: PRUNE_NOW_MS,
                    maxAgeMs: PRUNE_MAX_AGE_MS,
                });
                expect(globalResult.removed).toEqual([globalName]);
                expect(globalResult.refused).toEqual([]);
                expect(isProcessAlive(nuxtPid)).toBe(true);
                expect(isProcessAlive(activePid)).toBe(true);

                const listCleanup = await cleanupStaleSessionArtifacts(listName);
                expect(listCleanup).toEqual({
                    retained: false,
                    reason: null,
                });
                expect(existsSync(sessionFilePath(listName))).toBe(false);
                expect(isProcessAlive(nuxtPid)).toBe(true);
                expect(isProcessAlive(activePid)).toBe(true);

                const detachedCleanup = await cleanupSessionStartingAttempt(detachedName);
                expect(detachedCleanup.completed).toBe(true);
                expect(existsSync(sessionStartingFilePath(detachedName))).toBe(false);
                expect(isProcessAlive(nuxtPid)).toBe(true);
                expect(isProcessAlive(activePid)).toBe(true);
            } finally {
                await forceKillAndWait(activeController.child);
                await forceKillAndWait(nuxt.child);
                disposeSession(activeName);
                disposeSession(globalName);
                disposeSession(listName);
                disposeSession(detachedName);
            }
        },
        30_000,
    );

    it('retains checkpoint bytes and session artifacts during stale pruning', async () => {
        const name = freshSessionName('recovery');
        const appTempPath = getAppTempDirPathForUserData(electronUserDataPath(name));
        const checkpointPath = workspaceCrashCheckpointPath(name);
        const workingCopyPath = join(appTempPath, 'pdf-work-recovery', 'document.pdf');
        await writeSessionInfo(name, UNUSED_PID);
        mkdirSync(join(appTempPath, 'pdf-work-recovery'), {recursive: true});
        mkdirSync(electronUserDataPath(name), {recursive: true});
        writeFileSync(workingCopyPath, 'recover this file', 'utf8');
        writeFileSync(checkpointPath, '{"checkpoint":true}', 'utf8');

        try {
            const result = await pruneStaleE2ESessions({
                candidates: [staleCandidate(name)],
                nowMs: PRUNE_NOW_MS,
                maxAgeMs: PRUNE_MAX_AGE_MS,
            });

            expect(result.removed).toEqual([]);
            expect(result.refused).toEqual([{
                name,
                reason: 'workspace recovery evidence is present; retained for later recovery',
            }]);
            expect(existsSync(sessionFilePath(name))).toBe(true);
            expect(existsSync(workingCopyPath)).toBe(true);
            expect(existsSync(checkpointPath)).toBe(true);
        } finally {
            disposeSession(name);
        }
    });

    it('retains malformed session metadata instead of treating age as abandonment proof', async () => {
        const name = freshSessionName('malformed');
        mkdirSync(sessionDir(name), {recursive: true});
        const evidencePath = writeEvidence(name, 'malformed-session.txt');
        writeFileSync(sessionFilePath(name), '{malformed json', 'utf8');

        try {
            const result = await pruneStaleE2ESessions({
                candidates: [staleCandidate(name)],
                nowMs: PRUNE_NOW_MS,
                maxAgeMs: PRUNE_MAX_AGE_MS,
            });

            expect(result.removed).toEqual([]);
            expect(result.refused).toHaveLength(1);
            expect(result.refused[0]?.reason).toContain('could not be read as valid controller metadata');
            expect(existsSync(sessionFilePath(name))).toBe(true);
            expect(existsSync(evidencePath)).toBe(true);
        } finally {
            disposeSession(name);
        }
    });

    it('removes an abandoned stale session after its owned cleanup checks pass', async () => {
        const name = freshSessionName('abandoned');
        const appTempPath = getAppTempDirPathForUserData(electronUserDataPath(name));
        const workingCopyPath = join(appTempPath, 'pdf-work-abandoned', 'document.pdf');
        await writeSessionInfo(name, UNUSED_PID);
        mkdirSync(join(appTempPath, 'pdf-work-abandoned'), {recursive: true});
        writeFileSync(workingCopyPath, 'stale and disposable', 'utf8');

        try {
            const result = await pruneStaleE2ESessions({
                candidates: [staleCandidate(name)],
                nowMs: PRUNE_NOW_MS,
                maxAgeMs: PRUNE_MAX_AGE_MS,
            });

            expect(result.removed).toEqual([name]);
            expect(result.refused).toEqual([]);
            expect(existsSync(sessionDir(name))).toBe(false);
            expect(existsSync(appTempPath)).toBe(false);
        } finally {
            disposeSession(name);
        }
    });
});
