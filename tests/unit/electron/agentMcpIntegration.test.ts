import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const state = vi.hoisted(() => ({
    settings: {agentMcpEnabled: false},
    serverRunning: false,
}));

const mocks = vi.hoisted(() => ({
    loadSettings: vi.fn(async () => ({...state.settings})),
    updateSettings: vi.fn(async (mutate: (settings: Record<string, unknown>) => unknown) => {
        const next = {...state.settings};
        mutate(next);
        state.settings = {agentMcpEnabled: Boolean(next.agentMcpEnabled)};
        return {...state.settings};
    }),
    resolveCodexCliPath: vi.fn(async () => '/usr/bin/codex'),
    runCodexCli: vi.fn(),
    startLocalMcpServer: vi.fn(async () => {
        state.serverRunning = true;
    }),
    shutdownLocalMcpServer: vi.fn(async () => {
        state.serverRunning = false;
    }),
    showMessageBox: vi.fn(async () => ({response: 0})),
    openExternal: vi.fn(async () => undefined),
    logger: {
        error: vi.fn(),
        warn: vi.fn(),
    },
}));

const fileMocks = vi.hoisted(() => ({
    readFile: vi.fn(async () => '[mcp_servers.evb_viewer_dev.env]\nEVB_MCP_TOKEN = "__EVB_MCP_TOKEN_PLACEHOLDER__"\n'),
    writeFile: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    open: vi.fn(async () => ({
        sync: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
    })),
}));

const descriptor = {
    name: 'evb_viewer_dev',
    title: 'EVB Viewer Dev',
    host: '127.0.0.1',
    port: 38672,
    url: 'http://127.0.0.1:38672',
};

const launchConfig = {
    command: '/usr/bin/electron',
    args: ['/opt/evb/scripts/evb-mcp-proxy.mjs'],
    env: {
        ELECTRON_RUN_AS_NODE: '1',
        EVB_MCP_URL: descriptor.url,
        EVB_MCP_TOKEN: 'persisted-token',
    },
};

vi.mock('electron', () => ({
    dialog: {showMessageBox: mocks.showMessageBox},
    shell: {openExternal: mocks.openExternal},
}));

vi.mock('node:fs/promises', () => ({
    open: fileMocks.open,
    readFile: fileMocks.readFile,
    rename: fileMocks.rename,
    writeFile: fileMocks.writeFile,
}));

vi.mock('@electron/settings', () => ({
    loadSettings: mocks.loadSettings,
    updateSettings: mocks.updateSettings,
}));

vi.mock('@electron/features/agent/codexCli', () => ({
    CODEX_APP_INSTALL_URL: 'https://developers.openai.com/codex/app',
    resolveCodexCliPath: mocks.resolveCodexCliPath,
    runCodexCli: mocks.runCodexCli,
}));

vi.mock('@electron/features/agent/mcpServer', () => ({
    getLocalMcpServerDescriptor: () => descriptor,
    getLocalMcpSetupSnippets: vi.fn(async () => ({
        codex: 'codex snippet',
        claude: 'claude snippet',
        cursor: '{ "cursor": true }',
    })),
    getLocalMcpCodexRegistrationTransport: vi.fn(async () => ({
        descriptor,
        launchConfig,
        token: launchConfig.env.EVB_MCP_TOKEN,
    })),
    isLocalMcpServerRunning: () => state.serverRunning,
    startLocalMcpServer: mocks.startLocalMcpServer,
    shutdownLocalMcpServer: mocks.shutdownLocalMcpServer,
}));

vi.mock('@electron/te', () => ({te: (_key: string, values?: Record<string, string>) => values?.server ?? 'translated'}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

describe('codexMcpIntegration', () => {
    beforeEach(() => {
        vi.resetModules();
        state.settings = {agentMcpEnabled: false};
        state.serverRunning = false;
        mocks.loadSettings.mockClear();
        mocks.updateSettings.mockClear();
        mocks.resolveCodexCliPath.mockClear();
        mocks.runCodexCli.mockReset();
        mocks.startLocalMcpServer.mockClear();
        mocks.shutdownLocalMcpServer.mockClear();
        mocks.showMessageBox.mockClear();
        mocks.openExternal.mockClear();
        mocks.logger.error.mockClear();
        mocks.logger.warn.mockClear();
        fileMocks.readFile.mockClear();
        fileMocks.writeFile.mockClear();
    });

    it('registers Codex against the durable stdio proxy transport', async () => {
        mocks.runCodexCli.mockImplementation(async (_codexPath: string, args: string[]) => {
            if (args[0] === 'mcp' && args[1] === 'remove') {
                return {
                    ok: true,
                    stdout: '',
                    stderr: '',
                };
            }
            if (args[0] === 'mcp' && args[1] === 'add') {
                return {
                    ok: true,
                    stdout: '',
                    stderr: '',
                };
            }
            throw new Error(`Unexpected Codex args: ${args.join(' ')}`);
        });

        const { setAgentMcpIntegrationEnabled } = await import('@electron/features/agent/codexMcpIntegration');
        const result = await setAgentMcpIntegrationEnabled(true);

        expect(result.ok).toBe(true);
        expect(mocks.startLocalMcpServer).toHaveBeenCalledOnce();
        expect(mocks.runCodexCli).toHaveBeenNthCalledWith(1, '/usr/bin/codex', [
            'mcp',
            'remove',
            descriptor.name,
        ]);
        expect(mocks.runCodexCli).toHaveBeenNthCalledWith(2, '/usr/bin/codex', [
            'mcp',
            'add',
            descriptor.name,
            '--env',
            'ELECTRON_RUN_AS_NODE=1',
            '--env',
            `EVB_MCP_URL=${descriptor.url}`,
            '--env',
            'EVB_MCP_TOKEN=__EVB_MCP_TOKEN_PLACEHOLDER__',
            '--',
            launchConfig.command,
            ...launchConfig.args,
        ]);
        // The real token reaches disk only through a staged file renamed over
        // the config, never through argv and never through a truncating write.
        expect(fileMocks.writeFile).toHaveBeenCalledWith(
            expect.stringMatching(/[\\/]\.codex[\\/]config\.toml\.evb-\d+\.tmp$/u),
            expect.stringContaining('EVB_MCP_TOKEN = "persisted-token"'),
            {
                encoding: 'utf8',
                mode: 0o600,
            },
        );
        expect(fileMocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(/\.tmp$/u),
            expect.stringMatching(/[\\/]\.codex[\\/]config\.toml$/u),
        );
        expect(state.settings.agentMcpEnabled).toBe(true);
    });

    it('classifies a failed integration action with its bounded action context', async () => {
        mocks.runCodexCli.mockResolvedValue({
            ok: false,
            stdout: '',
            stderr: 'EVB_MCP_TOKEN=persisted-token\nCodex registration refused',
        });

        const {setAgentMcpIntegrationEnabled} = await import('@electron/features/agent/codexMcpIntegration');
        const result = await setAgentMcpIntegrationEnabled(true);

        expect(result.ok).toBe(false);
        expect(result.error).toContain('Codex registration refused');
        expect(result.error).not.toContain('persisted-token');
        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Failed to enable Codex MCP integration'),
            {
                code: 'MAIN_CODEX_MCP_INTEGRATION_FAILED',
                context: {action: 'enable'},
                cause: expect.any(Error),
            },
        );
        expect(mocks.logger.error.mock.calls[0]?.[0]).not.toContain('persisted-token');
    });

    it('treats legacy URL-only Codex registrations as mismatched and preserves authenticated setup snippets', async () => {
        state.settings = {agentMcpEnabled: true};
        state.serverRunning = true;
        mocks.runCodexCli.mockResolvedValue({
            ok: true,
            stdout: JSON.stringify({
                enabled: true,
                transport: {
                    type: 'streamable_http',
                    url: descriptor.url,
                },
            }),
            stderr: '',
        });

        const { getAgentMcpIntegrationStatus } = await import('@electron/features/agent/codexMcpIntegration');
        const status = await getAgentMcpIntegrationStatus();

        expect(status.enabled).toBe(true);
        expect(status.serverRunning).toBe(true);
        expect(status.codexConfigured).toBe(false);
        expect(status.codexRegistrationState).toBe('mismatched');
        expect(status.setupSnippets).toEqual({
            codex: 'codex snippet',
            claude: 'claude snippet',
            cursor: '{ "cursor": true }',
        });
    });

    it.each([
        [
            'a conflicting listener',
            Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:38672'), {code: 'EADDRINUSE'}),
        ],
        [
            'a token-store failure',
            new Error('Unable to create a stable local MCP token file.'),
        ],
    ])('keeps bootstrap alive and preserves opt-in after %s', async (_label, startupError) => {
        state.settings = {agentMcpEnabled: true};
        mocks.startLocalMcpServer.mockRejectedValueOnce(startupError);
        mocks.runCodexCli.mockResolvedValue({
            ok: false,
            stdout: '',
            stderr: '',
        });

        const {
            getAgentMcpIntegrationStatus,
            syncAgentMcpServerWithSettings,
        } = await import('@electron/features/agent/codexMcpIntegration');

        await expect(syncAgentMcpServerWithSettings()).resolves.toBeUndefined();
        expect(state.settings.agentMcpEnabled).toBe(true);
        expect(mocks.shutdownLocalMcpServer).toHaveBeenCalledOnce();
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining(startupError.message));

        await expect(getAgentMcpIntegrationStatus()).resolves.toMatchObject({
            enabled: true,
            serverRunning: false,
            error: startupError.message,
        });

        await expect(syncAgentMcpServerWithSettings()).resolves.toBeUndefined();
        const recoveredStatus = await getAgentMcpIntegrationStatus();
        expect(recoveredStatus.serverRunning).toBe(true);
        expect(recoveredStatus.error).toBeUndefined();
    });

    it('does not misclassify a settings read failure as an MCP startup failure', async () => {
        mocks.loadSettings.mockRejectedValueOnce(new Error('settings database unavailable'));
        const {syncAgentMcpServerWithSettings} = await import('@electron/features/agent/codexMcpIntegration');

        await expect(syncAgentMcpServerWithSettings()).resolves.toBeUndefined();

        expect(mocks.startLocalMcpServer).not.toHaveBeenCalled();
        expect(mocks.shutdownLocalMcpServer).not.toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Failed to load external MCP setting'),
        );
    });

    it('returns a disable-capable status when token-backed setup snippets fail', async () => {
        state.settings = {agentMcpEnabled: true};
        const mcpModule = await import('@electron/features/agent/mcpServer');
        vi.mocked(mcpModule.getLocalMcpSetupSnippets).mockRejectedValueOnce(new Error('token store is read-only'));
        mocks.runCodexCli.mockResolvedValue({
            ok: false,
            stdout: '',
            stderr: '',
        });

        const {getAgentMcpIntegrationStatus} = await import('@electron/features/agent/codexMcpIntegration');
        const status = await getAgentMcpIntegrationStatus();

        expect(status).toMatchObject({
            enabled: true,
            serverRunning: false,
            error: 'token store is read-only',
        });
        expect(status.setupSnippets).toBeUndefined();
    });

    it('allows disabling the persisted integration while token storage remains unavailable', async () => {
        state.settings = {agentMcpEnabled: true};
        const mcpModule = await import('@electron/features/agent/mcpServer');
        vi.mocked(mcpModule.getLocalMcpSetupSnippets).mockRejectedValueOnce(new Error('token store is read-only'));
        mocks.runCodexCli.mockResolvedValue({
            ok: true,
            stdout: '',
            stderr: '',
        });

        const {setAgentMcpIntegrationEnabled} = await import('@electron/features/agent/codexMcpIntegration');
        const result = await setAgentMcpIntegrationEnabled(false);

        expect(result).toMatchObject({
            ok: true,
            status: {
                enabled: false,
                error: 'token store is read-only',
            },
        });
        expect(state.settings.agentMcpEnabled).toBe(false);
        expect(mocks.shutdownLocalMcpServer).toHaveBeenCalledOnce();
    });
});
