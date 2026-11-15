import type * as AssistantInstancesModule from '@electron/features/agent/assistantInstances';
import {
    afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
    chmod, mkdtemp, mkdir, readFile, readdir, readlink, rm, writeFile,
} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import type {IAssistantInstanceConfig} from '@contracts/assistant';

const state = vi.hoisted(() => ({
    root: '',
    encryptionAvailable: true,
    local: [] as IAssistantInstanceConfig[],
}));
vi.mock('@electron/features/agent/assistantLocalSetups', async importOriginal => ({
    ...await importOriginal(),
    discoverAssistantLocalSetups: async () => state.local,
}));
vi.mock('@electron/te', async () => {
    const {default: en} = await import('@i18n-app/messages/en');
    return {te: (key: string, params: Record<string, unknown> = {}) => {
        const text: unknown = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);
        return String(text).replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name]));
    }};
});
vi.mock('electron', () => ({default: {
    app: {getPath: () => state.root},
    safeStorage: {
        isEncryptionAvailable: () => state.encryptionAvailable,
        getSelectedStorageBackend: () => 'keychain',
        encryptString: (value: string) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
        decryptString: (value: Buffer) => Buffer.from(value.toString().slice('encrypted:'.length), 'base64').toString(),
    },
}}));

const resolvers = {
    codex: async () => '/resolved/codex',
    claude: async () => '/resolved/claude',
};
let instances: typeof AssistantInstancesModule;

beforeEach(async () => {
    vi.resetModules();
    state.root = await mkdtemp(join(tmpdir(), 'assistant-instances-'));
    state.encryptionAvailable = true;
    state.local = [];
    instances = await import('@electron/features/agent/assistantInstances');
});
afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(state.root, {
        recursive: true,
        force: true,
    });
});

async function save(config: Partial<IAssistantInstanceConfig> = {}) {
    const result = await instances.saveAssistantInstanceConfigs([{
        id: 'codex',
        driver: 'codex',
        displayName: 'Codex',
        enabled: true,
        ...config,
    }]);
    expect(result.ok, result.error).toBe(true);
    return result.instances[0]!;
}

describe('assistant instance configuration', () => {
    it('tokenizes quoted, escaped, concatenated and empty arguments without evaluation', () => {
        expect(instances.tokenizeLaunchArgs(String.raw` -c 'model_provider="proxy"' "two words" a"b c" '' "$HOME" `)).toEqual([
            '-c',
            'model_provider="proxy"',
            'two words',
            'ab c',
            '',
            '$HOME',
        ]);
        expect(instances.tokenizeLaunchArgs(String.raw`"a\"b\\c"`)).toEqual(['a"b\\c']);
        if (process.platform !== 'win32') {
            expect(instances.tokenizeLaunchArgs(String.raw`one\ two three\\four`)).toEqual([
                'one two',
                'three\\four',
            ]);
        }
    });
    it.each([
        '"unfinished',
        '\'unfinished',
    ])('rejects an unmatched quote: %s', value => {
        expect(() => instances.tokenizeLaunchArgs(value)).toThrow('unmatched quote');
    });
    it('passes Claude launch flags as SDK extra arguments', () => {
        expect(instances.parseClaudeExtraArgs([
            '--fallback-model',
            'opus',
            '--debug',
            '--betas=one,two',
        ], 'Claude · B')).toEqual({
            'fallback-model': 'opus',
            debug: null,
            betas: 'one,two',
        });
    });
    it.each([
        ['--dangerously-skip-permissions'],
        [
            '--mcp-config',
            'servers.json',
        ],
        ['--allowedTools=Bash'],
        ['positional'],
    ])('refuses a Claude launch argument that would change EVB restrictions: %s', (...tokens) => {
        expect(() => instances.parseClaudeExtraArgs(tokens, 'Claude · B')).toThrow('is not supported in EVB');
    });
    it('resolves a Codex home and configured executable with custom endpoint arguments', async () => {
        const home = join(state.root, 'base');
        await save({
            homePath: home,
            binaryPath: '/configured/codex',
            launchArgs: '-c model_provider="proxy"',
        });
        const context = await instances.resolveAssistantLaunchContext('codex', resolvers);
        expect(context).toMatchObject({
            binaryPath: '/configured/codex',
            homePath: home,
            customEndpoint: true,
            env: {CODEX_HOME: home},
        });
    });
    it('refuses Codex launch arguments that enable features outside EVB isolation', async () => {
        await save({launchArgs: '--enable shell_tool'});
        await expect(instances.resolveAssistantLaunchContext('codex', resolvers)).rejects.toThrow('is not supported in EVB');
    });
    it('creates a shadow home linking shared configuration but keeping credentials and scratch private', async () => {
        const home = join(state.root, 'base');
        const shadow = join(state.root, 'shadow');
        await mkdir(home);
        for (const name of [
            'config.toml',
            'sessions',
            'auth.json',
            'auth.lock',
            'models_cache.json',
            'log',
            'memories',
            'tmp',
        ]) {
            await writeFile(join(home, name), name);
        }
        await save({
            homePath: home,
            shadowHomePath: shadow,
        });
        expect(await instances.resolveAssistantLaunchContext('codex', resolvers)).toMatchObject({
            homePath: shadow,
            env: {CODEX_HOME: shadow},
        });
        expect((await readdir(shadow)).sort()).toEqual([
            'config.toml',
            'sessions',
        ]);
        expect(await readlink(join(shadow, 'config.toml'))).toBe(join(home, 'config.toml'));
        expect(await readFile(join(shadow, 'sessions'), 'utf8')).toBe('sessions');
        await writeFile(join(shadow, 'auth.json'), 'shadow login');
        await instances.resolveAssistantLaunchContext('codex', resolvers);
        expect(await readFile(join(shadow, 'auth.json'), 'utf8')).toBe('shadow login');
    });
    it('resolves Claude home and removes host Claude session markers', async () => {
        for (const name of [
            'CLAUDECODE',
            'CLAUDE_CODE_ENTRYPOINT',
            'CLAUDE_CODE_SESSION_ID',
            'CLAUDE_CODE_SSE_PORT',
            'ELECTRON_RUN_AS_NODE',
        ]) vi.stubEnv(name, 'host-session');
        const home = join(state.root, 'claude');
        await save({
            id: 'claude',
            driver: 'claude',
            displayName: 'Claude',
            homePath: home,
            binaryPath: '/configured/claude',
            environment: [{
                name: 'ANTHROPIC_BASE_URL',
                value: 'https://proxy.example.test',
                secret: false,
            }],
        });
        const context = await instances.resolveAssistantLaunchContext('claude', resolvers);
        expect(context).toMatchObject({
            binaryPath: '/configured/claude',
            homePath: home,
            customEndpoint: true,
            env: {CLAUDE_CONFIG_DIR: home},
        });
        expect(context.env.CLAUDECODE).toBeUndefined();
        expect(context.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
        expect(context.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
        expect(context.env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
        expect(context.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    });
    it('keeps the native default Claude login identity without stamping a config override', async () => {
        vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
        await save({id: 'claude', driver: 'claude', homePath: join(homedir(), '.claude')});
        const context = await instances.resolveAssistantLaunchContext('claude', resolvers);
        expect(context.homePath).toBe(join(homedir(), '.claude'));
        expect(context.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    });
    it('uses fallback binary resolvers when an instance has no configured executable', async () => {
        await save();
        expect((await instances.resolveAssistantLaunchContext('codex', resolvers)).binaryPath).toBe('/resolved/codex');
        await save({
            id: 'claude',
            driver: 'claude',
        });
        expect((await instances.resolveAssistantLaunchContext('claude', resolvers)).binaryPath).toBe('/resolved/claude');
    });
    it('redacts secrets and preserves their ciphertext when saving empty redacted values', async () => {
        const redacted = await save({
            launchArgs: '--token fixture-bearer',
            launchArgsSecret: true,
            environment: [
                {
                    name: 'API_KEY',
                    value: 'fixture-secret',
                    secret: true,
                },
                {
                    name: 'REGION',
                    value: 'eu',
                    secret: false,
                },
            ],
        });
        const path = join(state.root, 'assistant', 'providers.json');
        const before = await readFile(path, 'utf8');
        expect(before).not.toContain('fixture-secret');
        expect(before).not.toContain('fixture-bearer');
        expect(JSON.stringify(await instances.getAssistantInstanceConfigs())).not.toContain('fixture-');
        expect(redacted).toMatchObject({
            launchArgs: '',
            launchArgsConfigured: true,
            environment: [
                {
                    name: 'API_KEY',
                    value: '',
                    configured: true,
                },
                {
                    name: 'REGION',
                    value: 'eu',
                },
            ],
        });
        expect((await instances.saveAssistantInstanceConfigs([redacted])).ok).toBe(true);
        expect(await readFile(path, 'utf8')).toBe(before);
        vi.resetModules();
        instances = await import('@electron/features/agent/assistantInstances');
        const context = await instances.resolveAssistantLaunchContext('codex', resolvers);
        expect(context.env.API_KEY).toBe('fixture-secret');
        expect(context.launchArgs).toEqual([
            '--token',
            'fixture-bearer',
        ]);
    });
    it('refuses to persist a secret when secure storage is unavailable', async () => {
        state.encryptionAvailable = false;
        const result = await instances.saveAssistantInstanceConfigs([{
            id: 'codex',
            driver: 'codex',
            displayName: 'Codex',
            enabled: true,
            environment: [{
                name: 'API_KEY',
                value: 'fixture-secret',
                secret: true,
            }],
        }]);
        expect(result.ok).toBe(false);
        expect(result.error).toContain('Secure credential storage is unavailable');
        await expect(readFile(join(state.root, 'assistant', 'providers.json'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    });
});


describe('local assistant setups', () => {
    it('keeps two explicit homes and their IDs for the same executable', async () => {
        const configs: IAssistantInstanceConfig[] = ['one', 'two'].map(name => ({
            id: `account-${name}`, driver: 'codex', displayName: name, enabled: true,
            binaryPath: '/installed/codex', homePath: join(state.root, name),
        }));
        expect((await instances.saveAssistantInstanceConfigs(configs)).ok).toBe(true);
        state.local = [{...configs[0]!, id: 'discovered-duplicate'}];
        expect((await instances.getAssistantInstanceConfigs()).map(config => config.id)).toEqual(['account-one', 'account-two']);
        for (const config of configs) {
            expect(await instances.resolveAssistantLaunchContext(config.id, resolvers)).toMatchObject({
                binaryPath: '/installed/codex', homePath: config.homePath,
                env: {CODEX_HOME: config.homePath},
            });
        }
    });
    it('reports an absent installed executable without creating an installer fallback', async () => {
        await save();
        expect((await instances.resolveAssistantLaunchContext('codex', {codex: async () => null, claude: async () => null})).binaryPath).toBeNull();
    });
    it('discovers independently named wrappers and preserves each executable and inherited environment', async () => {
        const {discoverAssistantLocalSetups} = await vi.importActual<typeof import('@electron/features/agent/assistantLocalSetups')>('@electron/features/agent/assistantLocalSetups');
        const bin = join(state.root, 'bin');
        await mkdir(bin);
        async function launcher(name: string, version: string) {
            const path = join(bin, process.platform === 'win32' ? `${name}.cmd` : name);
            if (process.platform === 'win32') {
                await writeFile(path, '@echo off');
                await writeFile(path.replace(/\.cmd$/u, '.ps1'), `Write-Output '${version}'`);
            } else {
                await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
                await chmod(path, 0o700);
            }
            return path;
        }
        const codex = await launcher('codex', 'codex-cli 0.169.0');
        const claude = await launcher('claude', '2.1.325 (Claude Code)');
        const wrapper = await launcher('codex-proxy', 'codex-cli 0.169.0');
        const claudeWrapper = await launcher('claude-proxy', '2.1.325 (Claude Code)');
        await launcher('codex-unrelated', 'unrelated program 1.0.0');
        const env = {...process.env, PATH: bin, HOME: state.root, CODEX_CLI_PATH: codex, CLAUDE_CODE_PATH: claude};
        state.local = await discoverAssistantLocalSetups(env);
        expect(state.local.map(config => config.displayName).sort()).toEqual(['Claude', 'Codex', 'claude-proxy', 'codex-proxy']);
        expect(state.local.find(config => config.id === 'codex')).toMatchObject({binaryPath: codex, homePath: join(state.root, '.codex')});
        const config = state.local.find(config => config.binaryPath === wrapper)!;
        vi.stubEnv('EVB_DISCOVERY_FIXTURE', 'inherited-fixture');
        expect(await instances.resolveAssistantLaunchContext(config.id, resolvers)).toMatchObject({
            binaryPath: wrapper, env: {EVB_DISCOVERY_FIXTURE: 'inherited-fixture'},
        });
        expect((await instances.resolveAssistantLaunchContext(state.local.find(config => config.binaryPath === claudeWrapper)!.id, resolvers)).binaryPath).toBe(claudeWrapper);
        expect((await discoverAssistantLocalSetups(env)).map(config => config.id)).toEqual(state.local.map(config => config.id));
    });
});
