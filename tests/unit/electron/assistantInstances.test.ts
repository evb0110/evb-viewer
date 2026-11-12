import type * as AssistantInstancesModule from '@electron/features/agent/assistantInstances';
import {
    afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
    mkdtemp, mkdir, readFile, readdir, readlink, rm, writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {IAssistantInstanceConfig} from '@contracts/assistant';

const state = vi.hoisted(() => ({
    root: '',
    encryptionAvailable: true,
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
    it('maps a redacted T3 providerInstances settings shape', () => {
        // Redacted copy of the local T3 settings shape; paths and values are synthetic.
        const {
            instances: mapped, notices,
        } = instances.mapT3ProviderInstances({
            codex: {
                driver: 'codex',
                displayName: 'Codex',
                enabled: true,
                config: {binaryPath: '/bin/codex'},
                environment: [{
                    name: 'PATH',
                    value: '/bin',
                    sensitive: false,
                }],
            },
            codex_proxy: {
                driver: 'codex',
                displayName: 'Proxy',
                enabled: true,
                config: {
                    binaryPath: '/bin/codex',
                    shadowHomePath: '/homes/shadow',
                    launchArgs: '-c model_provider="proxy" --header "Authorization: Bearer fixture-token"',
                },
                environment: [{
                    name: 'PATH',
                    value: '/bin',
                    sensitive: false,
                }],
            },
            claudeAgent: {
                driver: 'claudeAgent',
                displayName: 'Claude',
                enabled: true,
                config: {binaryPath: '/bin/claude'},
                environment: [{
                    name: 'PATH',
                    value: '/bin',
                    sensitive: false,
                }],
            },
            claude_proxy: {
                driver: 'claudeAgent',
                displayName: 'Claude proxy',
                enabled: true,
                config: {
                    binaryPath: '/bin/wrapper',
                    homePath: '/homes/claude-proxy',
                },
                environment: [
                    {
                        name: 'PATH',
                        value: '/bin',
                        sensitive: false,
                    },
                    {
                        name: 'ANTHROPIC_AUTH_TOKEN',
                        value: 'fixture-auth',
                        sensitive: true,
                    },
                    {
                        name: 'ANTHROPIC_BASE_URL',
                        value: 'https://proxy.example.test',
                        sensitive: false,
                    },
                    {
                        name: 'T3_YOLO',
                        value: '1',
                        sensitive: false,
                    },
                    {
                        name: 'T3_CLAUDE_BINARY',
                        value: '/bin/claude',
                        sensitive: false,
                    },
                ],
            },
            managed: {
                driver: 'codex',
                config: {setupMode: 'managed'},
            },
        });
        expect(mapped.map(value => value.id)).toEqual([
            'codex',
            'codex_proxy',
            'claude',
            'claude_proxy',
        ]);
        expect(mapped[0]).toMatchObject({
            driver: 'codex',
            binaryPath: '/bin/codex',
        });
        expect(mapped[1]).toMatchObject({
            shadowHomePath: '/homes/shadow',
            launchArgsSecret: true,
        });
        expect(mapped[2]).toMatchObject({
            driver: 'claude',
            binaryPath: '/bin/claude',
        });
        expect(mapped[3]).toMatchObject({
            driver: 'claude',
            binaryPath: '/bin/claude',
            homePath: '/homes/claude-proxy',
        });
        expect(mapped[3]?.environment).toContainEqual({
            name: 'ANTHROPIC_AUTH_TOKEN',
            value: 'fixture-auth',
            secret: true,
        });
        expect(mapped[3]?.environment?.map(entry => entry.name)).toEqual([
            'PATH',
            'ANTHROPIC_AUTH_TOKEN',
            'ANTHROPIC_BASE_URL',
        ]);
        expect(notices.join('\n')).toContain('permission wrapper was replaced');
        expect(notices.join('\n')).toContain('T3-managed sign-in');
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
