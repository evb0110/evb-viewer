import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {rm} from 'node:fs/promises';
import {requireTabId} from '@contracts/windowTabs';

const observations = vi.hoisted(() => {
    const streamClosed = Promise.withResolvers<undefined>();
    return {
        sdkEvaluations: 0,
        userDataPath: `/tmp/evb-viewer-initialization-test-${process.pid}-${Date.now()}`,
        streamClosed,
    };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
    observations.sdkEvaluations += 1;
    return {query: vi.fn(() => ({
        interrupt: vi.fn(async () => undefined),
        close: vi.fn(() => observations.streamClosed.resolve(undefined)),
        setModel: vi.fn(async () => undefined),
        accountInfo: vi.fn(async () => null),
        supportedModels: vi.fn(async () => []),
        [Symbol.asyncIterator]: async function* () {
            await observations.streamClosed.promise;
            yield* [];
        },
    }))};
});

vi.mock('electron', () => ({
    app: {
        getVersion: () => 'test',
        isPackaged: false,
        getPath: () => observations.userDataPath,
    },
    BrowserWindow: {
        getAllWindows: () => [],
        fromId: () => null,
    },
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));
vi.mock('@electron/settings', () => ({loadSettings: vi.fn(async () => ({assistantPanelEnabled: true}))}));
vi.mock('@electron/features/agent/codexCli', async (importOriginal) => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const actual = await importOriginal<typeof import('@electron/features/agent/codexCli')>();
    return {
        ...actual,
        getCodexCliInfo: vi.fn(async () => ({
            installed: false,
            version: null,
            executablePath: null,
            error: 'test Codex is unavailable',
        })),
        installManagedCodex: vi.fn(),
    };
});
vi.mock('@electron/features/agent/claudeProviderMetadata', async () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const actual = await vi.importActual<typeof import('@electron/features/agent/claudeProviderMetadata')>('@electron/features/agent/claudeProviderMetadata');
    return {
        ...actual,
        getClaudeAgentSdkInfo: vi.fn(async () => ({
            installed: true,
            version: 'test',
            executablePath: '/usr/bin/claude',
        })),
        detectClaudeAuthState: vi.fn(async () => 'signed-in'),
    };
});
vi.mock('@electron/features/agent/mcpServer', () => ({
    getEmbeddedMcpServerDescriptor: vi.fn(() => null),
    isEmbeddedMcpServerRunning: vi.fn(() => false),
    startEmbeddedMcpServer: vi.fn(async () => ({
        descriptor: {
            name: 'test-mcp',
            url: 'http://127.0.0.1:1',
        },
        token: 'test-token',
    })),
    shutdownEmbeddedMcpServer: vi.fn(async () => undefined),
    abortActiveEmbeddedMcpRequests: vi.fn(),
}));

describe('assistant provider initialization boundaries', () => {
    afterEach(async () => {
        await rm(observations.userDataPath, {
            recursive: true,
            force: true,
        });
    });

    it('keeps SDK-free metadata and status imports separate from the Claude SDK', async () => {
        await import('@electron/features/agent/claudeProviderMetadata');
        await import('@electron/features/agent/assistantProviderStatus');
        expect(observations.sdkEvaluations).toBe(0);

    });

    it('tracks SDK evaluation through the real lazy facade and runtime state reader', async () => {
        vi.resetModules();
        observations.sdkEvaluations = 0;

        const lazyAssistant = await import('@electron/features/agent/lazyAgentAssistant');
        try {
            await lazyAssistant.getAgentAssistantState({provider: 'codex'});
            expect(observations.sdkEvaluations).toBe(0);

            await lazyAssistant.getAgentAssistantState({provider: 'claude'});
            expect(observations.sdkEvaluations).toBe(0);

            const claudeFirstUse = await lazyAssistant.sendAgentAssistantMessage({
                provider: 'claude',
                text: 'selected Claude first use',
                scope: {
                    kind: 'document',
                    key: 'document:initialization-test',
                    title: 'Initialization test',
                    tabId: requireTabId('tab-initialization-test'),
                },
            });
            expect(claudeFirstUse.ok).toBe(true);
            expect(observations.sdkEvaluations).toBe(1);
        } finally {
            await lazyAssistant.shutdownAgentAssistantIfLoaded();
        }
    });
});
