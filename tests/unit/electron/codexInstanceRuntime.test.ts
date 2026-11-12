import {
    afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
    mkdtemp, readFile, rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join, resolve,
} from 'node:path';
import type {IAssistantLaunchContext} from '@electron/features/agent/assistantInstances';
import {CodexInstanceRuntime} from '@electron/features/agent/codexInstanceRuntime';
import {
    CodexAppServerClient, CODEX_INITIALIZE_TIMEOUT_MS,
} from '@electron/features/agent/codexAppServerClient';

vi.mock('electron', () => ({
    app: {getVersion: () => 'unit-test'},
    shell: {openExternal: vi.fn()},
}));
// Execute the protocol fixture with this test runner's Node on every platform.
vi.mock('@electron/features/agent/codexProcessLaunch', () => ({resolveCodexProcessLaunch: (path: string, args: string[]) => ({
    command: process.execPath,
    args: [
        path,
        ...args,
    ],
    shell: false,
})}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));
const binary = resolve('tests/fixtures/electron/codex-unit-app-server.mjs');
let root: string;
const runtimes: CodexInstanceRuntime[] = [];
const clients: CodexAppServerClient[] = [];

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'codex-unit-')); });
afterEach(async () => {
    await Promise.all([
        ...runtimes.splice(0).map(runtime => runtime.shutdown()),
        ...clients.splice(0).map(client => client.shutdown()),
    ]);
    await rm(root, {
        recursive: true,
        force: true,
    });
});
function context(mode = 'responsive'): IAssistantLaunchContext {
    return {
        instance: {
            id: 'codex',
            driver: 'codex',
            displayName: 'Codex',
            enabled: true,
        },
        binaryPath: binary,
        env: {
            ...process.env,
            CODEX_UNIT_MODE: mode,
            CODEX_UNIT_PIDS: join(root, 'pids'),
            CODEX_UNIT_ARGV: join(root, 'argv.json'),
        },
        launchArgs: [],
        homePath: root,
        customEndpoint: false,
        claudeExtraArgs: {},
    };
}
function runtime(mode = 'responsive') {
    const instance = new CodexInstanceRuntime({
        resolveContext: async () => context(mode),
        cwd: async () => root,
        embeddedMcp: async () => ({
            url: 'http://127.0.0.1:1234/mcp',
            token: 'fixture-token',
        }),
        onLoginFinished: () => undefined,
    });
    runtimes.push(instance);
    return instance;
}
async function expectChildrenExited() {
    const pids = (await readFile(join(root, 'pids'), 'utf8')).trim().split('\n').map(Number);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({code: 'ESRCH'}));
    }
}

describe('Codex real subprocess transport and instance runtime', () => {
    it('passes extra arguments before --listen to the executable', async () => {
        const launch = context();
        const client = new CodexAppServerClient(binary, [
            '-c',
            'model_provider="fixture"',
        ], launch.env, root, () => undefined, () => undefined);
        clients.push(client);
        await client.initialize();
        expect(JSON.parse(await readFile(join(root, 'argv.json'), 'utf8'))).toEqual([
            'app-server',
            '-c',
            'model_provider="fixture"',
            '--listen',
            'stdio://',
        ]);
    });
    it('rejects a silent initialize at the configured deadline with stderr diagnostics', async () => {
        const launch = context('hang');
        const client = new CodexAppServerClient(binary, [], launch.env, root, () => undefined, () => undefined);
        clients.push(client);
        const started = performance.now();
        await expect(client.initialize()).rejects.toThrow(/Codex did not start within 10 seconds.*fixture login refresh is blocked/u);
        expect(performance.now() - started).toBeLessThan(CODEX_INITIALIZE_TIMEOUT_MS + 1_500);
        expect(client.diagnostic()).toBe('fixture login refresh is blocked');
        await client.shutdown();
        await expectChildrenExited();
    }, 13_000);
    it('probes models and auth without starting an embedded MCP server and exits its child', async () => {
        const embeddedMcp = vi.fn(async () => ({
            url: 'http://127.0.0.1:1234/mcp',
            token: 'fixture-token',
        }));
        const instance = new CodexInstanceRuntime({
            resolveContext: async () => context(),
            cwd: async () => root,
            embeddedMcp,
            onLoginFinished: () => undefined,
        });
        runtimes.push(instance);
        expect(await instance.probe()).toMatchObject({
            auth: 'authenticated',
            account: {
                type: 'chatgpt',
                email: 'reader@example.test',
                planType: 'plus',
            },
            models: [{
                id: 'gpt-5.4',
                label: 'GPT 5.4',
            }],
        });
        expect(embeddedMcp).not.toHaveBeenCalled();
        await expectChildrenExited();
    });
    it('settles a never-initialized probe inside its 15 second budget and leaves no child', async () => {
        const started = performance.now();
        await expect(runtime('hang').probe()).rejects.toThrow(/Codex did not start within 10 seconds.*fixture login refresh is blocked/u);
        expect(performance.now() - started).toBeLessThan(15_000);
        await expectChildrenExited();
    }, 16_000);
    it('fails closed before opening a chat when another server exposes tools', async () => {
        await expect(runtime('leak').openThread(null, 'gpt-5.4', {
            onNotification: () => undefined,
            onExit: () => undefined,
        })).rejects.toThrow(/cannot restrict \(leaking-server\)/u);
        await expectChildrenExited();
    });
    it('stops a chat start that is still waiting for Codex when the instance shuts down', async () => {
        const instance = runtime('hang');
        const pending = instance.openThread(null, 'model-1', {
            onNotification: () => undefined,
            onExit: () => undefined,
        });
        await vi.waitFor(() => readFile(join(root, 'pids'), 'utf8'));
        const stoppedAt = Date.now();
        await instance.shutdown();
        await expect(pending).rejects.toThrow();
        expect(Date.now() - stoppedAt).toBeLessThan(3_000);
        await expectChildrenExited();
    });

    it('spawns nothing for a probe whose setup finishes after shutdown', async () => {
        let releaseContext: () => void = () => undefined;
        const held = new Promise<void>(resolveHeld => { releaseContext = resolveHeld; });
        const instance = new CodexInstanceRuntime({
            resolveContext: async () => {
                await held;
                return context();
            },
            cwd: async () => root,
            embeddedMcp: async () => ({
                url: 'http://127.0.0.1:1234/mcp',
                token: 'fixture-token',
            }),
            onLoginFinished: () => undefined,
        });
        runtimes.push(instance);
        const probe = instance.probe();
        await instance.shutdown();
        releaseContext();
        await expect(probe).rejects.toThrow('EVB Assistant stopped.');
        await expect(readFile(join(root, 'pids'), 'utf8')).rejects.toThrow();
    });

    it('spawns nothing for a chat start whose setup finishes after shutdown', async () => {
        let releaseContext: () => void = () => undefined;
        const held = new Promise<void>(resolveHeld => { releaseContext = resolveHeld; });
        const instance = new CodexInstanceRuntime({
            resolveContext: async () => {
                await held;
                return context();
            },
            cwd: async () => root,
            embeddedMcp: async () => ({
                url: 'http://127.0.0.1:1234/mcp',
                token: 'fixture-token',
            }),
            onLoginFinished: () => undefined,
        });
        runtimes.push(instance);
        const opening = instance.openThread(null, 'model-1', {
            onNotification: () => undefined,
            onExit: () => undefined,
        });
        await instance.shutdown();
        releaseContext();
        await expect(opening).rejects.toThrow('EVB Assistant stopped.');
        await expect(readFile(join(root, 'pids'), 'utf8')).rejects.toThrow();
    });

    it('tells open threads about a shutdown only after their process has exited', async () => {
        const instance = runtime();
        const aliveAtExit: boolean[] = [];
        let pids: number[] = [];
        await instance.openThread(null, 'model-1', {
            onNotification: () => undefined,
            onExit: () => {
                aliveAtExit.push(pids.some(pid => {
                    try {
                        process.kill(pid, 0);
                        return true;
                    } catch {
                        return false;
                    }
                }));
            },
        });
        pids = (await readFile(join(root, 'pids'), 'utf8')).trim().split('\n').map(Number);
        await instance.shutdown();
        expect(aliveAtExit).toEqual([false]);
    });

    it('does not refresh after a shutdown cancels a pending sign-in', async () => {
        const onLoginFinished = vi.fn();
        const instance = new CodexInstanceRuntime({
            resolveContext: async () => context(),
            cwd: async () => root,
            embeddedMcp: async () => ({
                url: 'http://127.0.0.1:1234/mcp',
                token: 'fixture-token',
            }),
            onLoginFinished,
        });
        runtimes.push(instance);
        await instance.startLogin('chatgpt');
        expect(instance.isLoginPending()).toBe(true);
        await instance.shutdown();
        expect(instance.isLoginPending()).toBe(false);
        expect(onLoginFinished).not.toHaveBeenCalled();
        await expectChildrenExited();
    });

    it('returns from an overlapping shutdown only after the process has exited', async () => {
        const instance = runtime();
        await instance.openThread(null, 'model-1', {
            onNotification: () => undefined,
            onExit: () => undefined,
        });
        const first = instance.shutdown();
        await instance.shutdown();
        await expectChildrenExited();
        await first;
    });

    it('starts a fresh thread when a stored native thread cannot be resumed', async () => {
        const instance = runtime('resume-error');
        expect(await instance.openThread('old-thread', 'gpt-5.4', {
            onNotification: () => undefined,
            onExit: () => undefined,
        })).toEqual({
            threadId: 'fresh-thread',
            resumed: false,
        });
        await instance.shutdown();
        await expectChildrenExited();
    });
});
