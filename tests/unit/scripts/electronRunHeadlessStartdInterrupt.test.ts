import {spawn} from 'node:child_process';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {delay} from 'es-toolkit/promise';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {isProcessAlive} from '@scripts/electron-run/electronRunProcessTree';

const SESSION_NAME = 'startd-interrupt-probe';
const HEADLESS_SCRIPT = join(process.cwd(), 'scripts', 'electron-run-headless.sh');

interface IFakeHeadlessHost {
    root: string;
    binDir: string;
    scriptPath: string;
    pnpmLogPath: string;
    pnpmPidPath: string;
    xvfbPidPath: string;
    xvfbOwnerPath: string;
}

function writeExecutable(path: string, source: string) {
    writeFileSync(path, source);
    chmodSync(path, 0o755);
}

// The Linux branch of the headless runner is exercised with fakes so the
// interruption contract is checked on every host: `uname` claims Linux,
// `Xvfb` is a long sleep whose pid the runner records, and `pnpm` logs its
// argv, then idles on `startd` until it is signalled.
function createFakeHeadlessHost(): IFakeHeadlessHost {
    const root = mkdtempSync(join(tmpdir(), 'evb-viewer-headless-startd-'));
    const binDir = join(root, 'bin');
    const scriptDir = join(root, 'scripts');
    mkdirSync(binDir);
    mkdirSync(scriptDir);
    const scriptPath = join(scriptDir, 'electron-run-headless.sh');
    copyFileSync(HEADLESS_SCRIPT, scriptPath);
    chmodSync(scriptPath, 0o755);
    const pnpmLogPath = join(root, 'pnpm-calls.log');
    const pnpmPidPath = join(root, 'pnpm-startd.pid');
    writeExecutable(join(binDir, 'uname'), '#!/bin/bash\necho Linux\n');
    writeExecutable(join(binDir, 'Xvfb'), [
        '#!/bin/bash',
        'exec -a Xvfb bash -c \'while true; do sleep 1; done\' Xvfb "$@"',
        '',
    ].join('\n'));
    writeExecutable(join(binDir, 'pnpm'), [
        '#!/bin/bash',
        `printf '%s\\n' "$*" >> "${pnpmLogPath}"`,
        'case " $* " in',
        '  *" startd "*|*" restartd "*)',
        `    echo "$$" > "${pnpmPidPath}"`,
        '    trap \'exit 143\' TERM',
        '    while true; do sleep 0.1; done',
        '    ;;',
        '  *) exit 0 ;;',
        'esac',
        '',
    ].join('\n'));
    return {
        root,
        binDir,
        scriptPath,
        pnpmLogPath,
        pnpmPidPath,
        xvfbPidPath: join(root, '.devkit', 'headless-xvfb', SESSION_NAME, 'xvfb.pid'),
        xvfbOwnerPath: join(root, '.devkit', 'headless-xvfb', SESSION_NAME, 'xvfb-owner'),
    };
}

function readPid(path: string) {
    if (!existsSync(path)) {
        return null;
    }
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function readPnpmCalls(path: string) {
    return existsSync(path)
        ? readFileSync(path, 'utf8').split('\n').filter(Boolean)
        : [];
}

async function waitUntil(condition: () => boolean, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) {
            return true;
        }
        await delay(50);
    }
    return condition();
}

function killIfAlive(pid: number | null) {
    if (pid === null || !isProcessAlive(pid)) {
        return;
    }
    try {
        process.kill(pid, 'SIGKILL');
    } catch {
        // The process exited between the liveness check and the signal.
    }
}

function readProcessCommandline(pid: number) {
    return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8')
        .split('\0')
        .filter(Boolean)
        .join(' ');
}

describe('electron-run-headless.sh startd interruption', () => {
    it.runIf(process.platform === 'linux')(
        'stops Xvfb and the session when a detached start is interrupted',
        async () => {
            const host = createFakeHeadlessHost();
            let xvfbPid: number | null = null;
            let pnpmPid: number | null = null;
            const runner = spawn('bash', [
                host.scriptPath,
                '--session',
                SESSION_NAME,
                'startd',
            ], {
                cwd: host.root,
                env: {
                    ...process.env,
                    PATH: `${host.binDir}:${process.env.PATH ?? ''}`,
                },
                stdio: [
                    'ignore',
                    'pipe',
                    'pipe',
                ],
            });
            let stderr = '';
            runner.stderr.on('data', (chunk: Buffer) => {
                stderr += chunk.toString();
            });
            const exit = new Promise<{
                code: number | null;
                signal: NodeJS.Signals | null
            }>((resolve) => {
                runner.once('exit', (code, signal) => resolve({
                    code,
                    signal,
                }));
            });

            try {
                expect(await waitUntil(() => {
                    xvfbPid = readPid(host.xvfbPidPath);
                    pnpmPid = readPid(host.pnpmPidPath);
                    return xvfbPid !== null && pnpmPid !== null;
                }, 10_000), stderr).toBe(true);
                expect(isProcessAlive(xvfbPid!)).toBe(true);
                expect(existsSync(host.xvfbOwnerPath)).toBe(true);

                runner.kill('SIGTERM');
                const outcome = await exit;

                expect(outcome.code ?? 1).not.toBe(0);
                expect(await waitUntil(() => !isProcessAlive(xvfbPid!), 5_000)).toBe(true);
                expect(await waitUntil(() => !isProcessAlive(pnpmPid!), 5_000)).toBe(true);
                expect(existsSync(host.xvfbPidPath)).toBe(false);
                expect(existsSync(host.xvfbOwnerPath)).toBe(false);
                const stopCalls = readPnpmCalls(host.pnpmLogPath)
                    .filter(call => /(^|\s)stop(\s|$)/u.test(call));
                expect(stopCalls.some(call => call.includes(SESSION_NAME))).toBe(true);
                expect(stderr).toContain(SESSION_NAME);
            } finally {
                killIfAlive(runner.pid ?? null);
                killIfAlive(pnpmPid);
                killIfAlive(xvfbPid);
                rmSync(host.root, {
                    force: true,
                    recursive: true,
                });
            }
        },
        30_000,
    );

    it.runIf(process.platform === 'linux')(
        'refuses a mismatched persisted owner without signalling the live PID',
        async () => {
            const host = createFakeHeadlessHost();
            const fixture = spawn('sleep', ['300'], {
                stdio: 'ignore',
            });
            const fixturePid = fixture.pid;
            let runner: ReturnType<typeof spawn> | null = null;

            try {
                if (fixturePid === undefined) {
                    throw new Error('Expected the fixture process to have a PID');
                }
                expect(await waitUntil(() => existsSync(`/proc/${String(fixturePid)}/stat`), 2_000)).toBe(true);
                const executable = readlinkSync(`/proc/${String(fixturePid)}/exe`);
                const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
                mkdirSync(join(host.root, '.devkit', 'headless-xvfb', SESSION_NAME), {
                    recursive: true,
                });
                writeFileSync(host.xvfbOwnerPath, [
                    `pid=${String(fixturePid)}`,
                    `executable=${executable}`,
                    `start_time=wrong-start-time`,
                    `boot_id=${bootId}`,
                    'display=:99',
                    'screen_spec=1440x1000x24',
                    `session=${SESSION_NAME}`,
                    'run_id=fixture-run',
                    `commandline=${readProcessCommandline(fixturePid)}`,
                    '',
                ].join('\n'));

                for (const stopArgs of [['stop'], ['stop', '--all']]) {
                    runner = spawn('bash', [
                        host.scriptPath,
                        '--session',
                        SESSION_NAME,
                        ...stopArgs,
                    ], {
                        cwd: host.root,
                        env: {
                            ...process.env,
                            PATH: `${host.binDir}:${process.env.PATH ?? ''}`,
                        },
                        stdio: ['ignore', 'pipe', 'pipe'],
                    });
                    let stderr = '';
                    runner.stderr!.on('data', (chunk: Buffer) => {
                        stderr += chunk.toString();
                    });
                    const outcome = await new Promise<{code: number | null}>((resolve) => {
                        runner!.once('exit', (code) => resolve({code}));
                    });

                    expect(outcome.code).not.toBe(0);
                    expect(isProcessAlive(fixturePid!)).toBe(true);
                    expect(existsSync(host.xvfbOwnerPath)).toBe(true);
                    expect(stderr).toContain('process start time mismatch');
                }
            } finally {
                if (runner && runner.exitCode === null) {
                    runner.kill('SIGKILL');
                }
                killIfAlive(fixturePid ?? null);
                rmSync(host.root, {
                    force: true,
                    recursive: true,
                });
            }
        },
        15_000,
    );

    it.runIf(process.platform === 'linux')(
        'leaves legacy PID-only evidence and its live process untouched',
        async () => {
            const host = createFakeHeadlessHost();
            const fixture = spawn('sleep', ['300'], {
                stdio: 'ignore',
            });
            const fixturePid = fixture.pid;
            let runner: ReturnType<typeof spawn> | null = null;

            try {
                if (fixturePid === undefined) {
                    throw new Error('Expected the fixture process to have a PID');
                }
                expect(await waitUntil(() => existsSync(`/proc/${String(fixturePid)}/stat`), 2_000)).toBe(true);
                mkdirSync(join(host.root, '.devkit', 'headless-xvfb', SESSION_NAME), {
                    recursive: true,
                });
                writeFileSync(host.xvfbPidPath, `${String(fixturePid)}\n`);
                writeFileSync(join(host.root, '.devkit', 'headless-xvfb', SESSION_NAME, 'xvfb-display'), ':99\n');
                runner = spawn('bash', [
                    host.scriptPath,
                    '--session',
                    SESSION_NAME,
                    'stop',
                ], {
                    cwd: host.root,
                    env: {
                        ...process.env,
                        PATH: `${host.binDir}:${process.env.PATH ?? ''}`,
                    },
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                let stderr = '';
                runner.stderr!.on('data', (chunk: Buffer) => {
                    stderr += chunk.toString();
                });
                const outcome = await new Promise<{code: number | null}>((resolve) => {
                    runner!.once('exit', (code) => resolve({code}));
                });

                expect(outcome.code).not.toBe(0);
                expect(isProcessAlive(fixturePid!)).toBe(true);
                expect(readFileSync(host.xvfbPidPath, 'utf8')).toBe(`${String(fixturePid)}\n`);
                expect(stderr).toContain('no atomic Xvfb ownership record');
            } finally {
                if (runner && runner.exitCode === null) {
                    runner.kill('SIGKILL');
                }
                killIfAlive(fixturePid ?? null);
                rmSync(host.root, {
                    force: true,
                    recursive: true,
                });
            }
        },
        15_000,
    );
});
