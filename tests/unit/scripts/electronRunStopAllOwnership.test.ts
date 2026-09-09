import {
    execFileSync,
    spawn,
    type ChildProcess,
} from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as TElectronRunSessionArtifacts from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    cleanupOrphanedProjectNuxtRoots,
    probeNuxtListenersOnPort,
} from '@scripts/electron-run/electronRunNuxtServer';
import {
    DEFAULT_NUXT_PORT,
    setNuxtPort,
} from '@scripts/electron-run/electronRunPortConfig';
import {
    findFreePort,
    isProcessAlive,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import {projectRoot} from '@scripts/electron-run/projectRoot';
import {runCli} from '@scripts/electron-run/runCli';
import type {
    ISessionInfo,
    ISessionStartingInfo,
} from '@scripts/electron-run/electronRunSessionTypes';

const sessionArtifacts = vi.hoisted(() => ({
    getSessionInfo: vi.fn<() => ISessionInfo | null>(() => null),
    getSessionStartingInfo: vi.fn<() => ISessionStartingInfo | null>(() => null),
    listAllSessionNames: vi.fn<() => string[]>(() => []),
}));

vi.mock('@scripts/electron-run/electronRunSessionArtifacts', async importOriginal => ({
    ...await importOriginal<typeof TElectronRunSessionArtifacts>(),
    getSessionInfo: sessionArtifacts.getSessionInfo,
    getSessionStartingInfo: sessionArtifacts.getSessionStartingInfo,
    listAllSessionNames: sessionArtifacts.listAllSessionNames,
}));

interface IListenerFixture {
    root: string;
    server: ChildProcess;
    client: ChildProcess;
    serverPid: number;
    clientPid: number;
    signalPath: string;
}

interface IOrphanFixture {
    root: string;
    launcher: ChildProcess;
    signalPath: string;
    rootPidPath: string;
}

function writeListenerScript(root: string) {
    const scriptPath = join(root, 'unrelated-listener.cjs');
    writeFileSync(scriptPath, [
        'const http = require(\'node:http\');',
        'const fs = require(\'node:fs\');',
        'const port = Number(process.env.EVB_TH1_PORT);',
        'const readyPath = process.env.EVB_TH1_READY_PATH;',
        'const signalPath = process.env.EVB_TH1_SIGNAL_PATH;',
        'const recordSignal = signal => fs.appendFileSync(signalPath, signal + "\\n");',
        'for (const signal of [\'SIGTERM\', \'SIGINT\', \'SIGHUP\']) process.on(signal, () => recordSignal(signal));',
        'const server = http.createServer((_request, response) => { response.writeHead(200); response.end(\'still-serving\'); });',
        'server.listen(port, \'127.0.0.1\', () => fs.writeFileSync(readyPath, String(process.pid)));',
        'setInterval(() => {}, 1000);',
    ].join('\n'), 'utf8');
    return scriptPath;
}

function writeClientScript(root: string) {
    const scriptPath = join(root, 'unrelated-client.cjs');
    writeFileSync(scriptPath, [
        'const net = require(\'node:net\');',
        'const fs = require(\'node:fs\');',
        'const port = Number(process.env.EVB_TH1_PORT);',
        'const readyPath = process.env.EVB_TH1_READY_PATH;',
        'const signalPath = process.env.EVB_TH1_SIGNAL_PATH;',
        'const recordSignal = signal => fs.appendFileSync(signalPath, signal + "\\n");',
        'for (const signal of [\'SIGTERM\', \'SIGINT\', \'SIGHUP\']) process.on(signal, () => recordSignal(signal));',
        'const socket = net.createConnection({host: \'127.0.0.1\', port}, () => { socket.setKeepAlive(true); fs.writeFileSync(readyPath, String(process.pid)); });',
        'socket.on(\'error\', error => { fs.writeFileSync(process.env.EVB_TH1_ERROR_PATH, String(error)); process.exitCode = 1; });',
        'setInterval(() => {}, 1000);',
    ].join('\n'), 'utf8');
    return scriptPath;
}

function fixtureEnvironment(options: {
    port: number;
    readyPath: string;
    signalPath: string;
    errorPath: string;
}) {
    return {
        ...process.env,
        EVB_TH1_PORT: String(options.port),
        EVB_TH1_READY_PATH: options.readyPath,
        EVB_TH1_SIGNAL_PATH: options.signalPath,
        EVB_TH1_ERROR_PATH: options.errorPath,
    };
}

async function spawnListenerFixture(root: string, port: number): Promise<IListenerFixture> {
    const serverReadyPath = join(root, 'server-ready');
    const clientReadyPath = join(root, 'client-ready');
    const signalPath = join(root, 'signals.log');
    const errorPath = join(root, 'client-error.log');
    writeFileSync(signalPath, '', 'utf8');
    const serverScript = writeListenerScript(root);
    const clientScript = writeClientScript(root);
    const environment = fixtureEnvironment({
        port,
        readyPath: serverReadyPath,
        signalPath,
        errorPath,
    });
    const server = spawn(process.execPath, [serverScript], {
        cwd: root,
        env: environment,
        stdio: 'ignore',
    });
    await waitForFile(serverReadyPath);
    const client = spawn(process.execPath, [clientScript], {
        cwd: root,
        env: {
            ...environment,
            EVB_TH1_READY_PATH: clientReadyPath,
        },
        stdio: 'ignore',
    });
    return {
        root,
        server,
        client,
        serverPid: server.pid ?? 0,
        clientPid: client.pid ?? 0,
        signalPath,
    };
}

function writeOrphanPnpmScript(root: string) {
    const pnpmPath = join(root, 'pnpm');
    writeFileSync(pnpmPath, [
        '#!/bin/sh',
        'printf \'%s\' "$$" > "$EVB_TH1_ROOT_PID_PATH"',
        '"$EVB_TH1_NODE_PATH" "$EVB_TH1_SERVER_SCRIPT" &',
        'wait "$!"',
    ].join('\n'), 'utf8');
    chmodSync(pnpmPath, 0o755);
    return pnpmPath;
}

function canUseSystemdSystemService() {
    if (process.platform !== 'linux' || typeof process.getuid !== 'function') {
        return false;
    }

    try {
        execFileSync('sudo', [
            '-n',
            'systemd-run',
            '--system',
            '--wait',
            '--collect',
            `--uid=${String(process.getuid())}`,
            '/bin/true',
        ], {stdio: 'ignore'});
        return true;
    } catch {
        return false;
    }
}

function spawnOrphanFixture(root: string, port: number): IOrphanFixture {
    const signalPath = join(root, 'signals.log');
    const rootPidPath = join(root, 'orphan-root-pid');
    writeFileSync(signalPath, '', 'utf8');
    const serverScript = writeListenerScript(root);
    const pnpmPath = writeOrphanPnpmScript(root);
    const environment = fixtureEnvironment({
        port,
        readyPath: join(root, 'server-ready'),
        signalPath,
        errorPath: join(root, 'client-error.log'),
    });
    const orphanEnvironment = {
        ...environment,
        PORT: String(port),
        EVB_TH1_ROOT_PID_PATH: rootPidPath,
        EVB_TH1_SERVER_SCRIPT: serverScript,
        EVB_TH1_NODE_PATH: process.execPath,
    };
    const launcher = canUseSystemdSystemService()
        ? spawn('sudo', [
            '-n',
            'systemd-run',
            '--system',
            '--wait',
            '--collect',
            `--unit=evb-th1-${String(process.pid)}-${String(Date.now())}`,
            `--uid=${String(process.getuid?.() ?? '')}`,
            `--working-directory=${projectRoot}`,
            ...Object.entries(orphanEnvironment)
                .filter(([
                    , value,
                ]) => value !== undefined)
                .map(([
                    name,
                    value,
                ]) => `--setenv=${name}=${value}`),
            pnpmPath,
            'run',
            'dev:nuxt',
        ], {
            cwd: projectRoot,
            env: process.env,
            stdio: 'ignore',
        })
        : spawn('/bin/sh', [
            '-c',
            `'${pnpmPath.replaceAll('\'', '\'\\\'\'')}' run dev:nuxt &`,
        ], {
            cwd: projectRoot,
            env: orphanEnvironment,
            stdio: 'ignore',
        });
    return {
        root,
        launcher,
        signalPath,
        rootPidPath,
    };
}

async function waitForFile(path: string) {
    await vi.waitFor(() => {
        expect(existsSync(path), `fixture file ${path}`).toBe(true);
    }, {
        interval: 25,
        timeout: 5_000,
    });
}

async function forceKillAndWait(child: ChildProcess) {
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

async function runStopAllThroughCli() {
    const originalArgv = process.argv;
    process.argv = [
        process.execPath,
        join(projectRoot, 'scripts', 'electronRun.ts'),
        'stop',
        '--all',
    ];
    try {
        await runCli();
    } finally {
        process.argv = originalArgv;
    }
}

async function fetchFixture(port: number) {
    const response = await fetch(`http://127.0.0.1:${String(port)}/follow-up`);
    return {
        body: await response.text(),
        status: response.status,
    };
}

describe('Electron stop-all Nuxt ownership', () => {
    it.runIf(process.platform !== 'win32')(
        'leaves an unrelated listener and connected client untouched through CLI final cleanup',
        async () => {
            const root = mkdtempSync(join(tmpdir(), 'evb-th1-empty-stop-all-'));
            const port = await findFreePort();
            const fixture = await spawnListenerFixture(root, port);
            setNuxtPort(port);
            try {
                await waitForFile(join(root, 'server-ready'));
                await waitForFile(join(root, 'client-ready'));
                const listenerPids = probeNuxtListenersOnPort(port);
                expect(listenerPids.ok).toBe(true);
                expect(listenerPids.pids).toContain(fixture.serverPid);
                expect(listenerPids.pids).not.toContain(fixture.clientPid);

                await runStopAllThroughCli();

                expect(isProcessAlive(fixture.serverPid), 'unrelated listener survived').toBe(true);
                expect(isProcessAlive(fixture.clientPid), 'connected client survived').toBe(true);
                expect(readFileSync(fixture.signalPath, 'utf8')).toBe('');
                await expect(fetchFixture(port)).resolves.toEqual({
                    body: 'still-serving',
                    status: 200,
                });
            } finally {
                setNuxtPort(DEFAULT_NUXT_PORT);
                await forceKillAndWait(fixture.server);
                await forceKillAndWait(fixture.client);
                rmSync(root, {
                    recursive: true,
                    force: true,
                });
            }
        },
        30_000,
    );

    it.runIf(process.platform !== 'win32' && canUseSystemdSystemService())(
        'stops an owned orphan through CLI cleanup while preserving an unrelated listener tree',
        async () => {
            const root = mkdtempSync(join(tmpdir(), 'evb-th1-owned-orphan-'));
            const ownedPort = await findFreePort();
            const unrelatedRoot = mkdtempSync(join(tmpdir(), 'evb-th1-mixed-listener-'));
            const unrelatedPort = await findFreePort();
            const fixture = spawnOrphanFixture(root, ownedPort);
            const unrelated = await spawnListenerFixture(unrelatedRoot, unrelatedPort);
            const preservedPort = await findFreePort();
            setNuxtPort(preservedPort);
            let orphanRootPid = 0;
            let orphanDescendantPid = 0;
            try {
                await waitForFile(join(root, 'server-ready'));
                await waitForFile(join(root, 'orphan-root-pid'));
                await waitForFile(join(unrelatedRoot, 'server-ready'));
                await waitForFile(join(unrelatedRoot, 'client-ready'));
                orphanRootPid = Number(readFileSync(join(root, 'orphan-root-pid'), 'utf8'));
                orphanDescendantPid = Number(readFileSync(join(root, 'server-ready'), 'utf8'));
                expect(orphanRootPid).toBeGreaterThan(0);
                expect(orphanDescendantPid).toBeGreaterThan(0);
                expect(isProcessAlive(orphanRootPid)).toBe(true);
                expect(isProcessAlive(orphanDescendantPid)).toBe(true);
                await vi.waitFor(() => {
                    const orphanPpid = Number(execFileSync('ps', [
                        '-p',
                        String(orphanRootPid),
                        '-o',
                        'ppid=',
                    ], {encoding: 'utf8'}).trim());
                    expect(orphanPpid, 'orphan root was reparented').toBe(1);
                }, {
                    interval: 50,
                    timeout: 5_000,
                });

                await runStopAllThroughCli();

                await vi.waitFor(() => {
                    expect(isProcessAlive(orphanRootPid), 'owned orphan root was terminated').toBe(false);
                }, {timeout: 5_000});
                await vi.waitFor(() => {
                    expect(isProcessAlive(orphanDescendantPid), 'owned orphan descendant was terminated').toBe(false);
                }, {timeout: 5_000});
                expect(isProcessAlive(unrelated.serverPid), 'unrelated listener survived').toBe(true);
                expect(isProcessAlive(unrelated.clientPid), 'unrelated client survived').toBe(true);
                await expect(fetchFixture(unrelatedPort)).resolves.toEqual({
                    body: 'still-serving',
                    status: 200,
                });
            } finally {
                setNuxtPort(DEFAULT_NUXT_PORT);
                if (orphanRootPid > 0 && isProcessAlive(orphanRootPid)) {
                    await killProcessTree(orphanRootPid, 100);
                }
                if (orphanDescendantPid > 0 && isProcessAlive(orphanDescendantPid)) {
                    await killProcessTree(orphanDescendantPid, 100);
                }
                await forceKillAndWait(fixture.launcher);
                await forceKillAndWait(unrelated.server);
                await forceKillAndWait(unrelated.client);
                rmSync(root, {
                    recursive: true,
                    force: true,
                });
                rmSync(unrelatedRoot, {
                    recursive: true,
                    force: true,
                });
            }
        },
        30_000,
    );

    it('refuses an orphan when the listener probe fails before identity verification', async () => {
        const preservedPort = await findFreePort();
        const orphanPort = await findFreePort();
        const terminateRoot = vi.fn(async () => true);
        const verifyIdentity = vi.fn(() => true);
        const roots = [{
            pid: 700_001,
            ppid: 1,
            devServerPort: orphanPort,
            descendantPids: [700_002],
        }];
        setNuxtPort(preservedPort);
        try {
            await expect(cleanupOrphanedProjectNuxtRoots('injected listener failure', {
                roots,
                probeListeners: () => ({
                    ok: false,
                    pids: [],
                }),
                verifyIdentity,
                terminateRoot,
            })).resolves.toBe(false);
            expect(verifyIdentity).not.toHaveBeenCalled();
            expect(terminateRoot).not.toHaveBeenCalled();
        } finally {
            setNuxtPort(DEFAULT_NUXT_PORT);
        }
    });

    it('refuses an identity change at the signal boundary and retains the candidate', async () => {
        const preservedPort = await findFreePort();
        const orphanPort = await findFreePort();
        const orphanRootPid = 700_001;
        const listenerPid = 700_002;
        const terminateRoot = vi.fn(async () => true);
        const verifyIdentity = vi.fn(() => false);
        const roots = [{
            pid: orphanRootPid,
            ppid: 1,
            devServerPort: orphanPort,
            descendantPids: [listenerPid],
        }];
        setNuxtPort(preservedPort);
        try {
            await expect(cleanupOrphanedProjectNuxtRoots('injected identity change', {
                roots,
                probeListeners: port => ({
                    ok: true,
                    pids: port === orphanPort ? [listenerPid] : [],
                }),
                verifyIdentity,
                terminateRoot,
            })).resolves.toBe(false);
            expect(verifyIdentity).toHaveBeenCalledWith(orphanRootPid, expect.objectContaining({
                kind: 'nuxt',
                nuxtPort: orphanPort,
            }));
            expect(terminateRoot).not.toHaveBeenCalled();
        } finally {
            setNuxtPort(DEFAULT_NUXT_PORT);
        }
    });

    it('preserves a shared project Nuxt root on the configured listener port', async () => {
        const sharedPort = await findFreePort();
        const listenerPid = 700_002;
        const terminateRoot = vi.fn(async () => true);
        setNuxtPort(sharedPort);
        try {
            await expect(cleanupOrphanedProjectNuxtRoots('injected shared server', {
                roots: [{
                    pid: 700_001,
                    ppid: 1,
                    devServerPort: sharedPort,
                    descendantPids: [listenerPid],
                }],
                probeListeners: () => ({
                    ok: true,
                    pids: [listenerPid],
                }),
                terminateRoot,
            })).resolves.toBe(false);
            expect(terminateRoot).not.toHaveBeenCalled();
        } finally {
            setNuxtPort(DEFAULT_NUXT_PORT);
        }
    });
});
