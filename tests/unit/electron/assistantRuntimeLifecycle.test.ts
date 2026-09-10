import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createAssistantChatSessionStore } from '@electron/features/agent/assistantChatSessionStore';
import { createAssistantProviderRuntimeStates } from '@electron/features/agent/assistantProviderState';
import { createAssistantRuntimeLifecycle } from '@electron/features/agent/assistantRuntimeLifecycle';
import {
    claimAssistantTurn,
    supersedeAssistantTurn,
} from '@electron/features/agent/assistantTurnLifecycle';
import { requireTabId } from '@contracts/windowTabs';

interface IRuntimeRequest {
    method: string;
    params: unknown;
}

const mocks = vi.hoisted(() => ({refreshCodexAuthStateAndRuntimeAvailability: vi.fn(async () => undefined)}));
const runtimeMocks = vi.hoisted(() => ({
    getCodexCliInfo: vi.fn(async () => ({
        installed: true,
        path: '/usr/bin/codex',
        version: '0.133.0',
        minimumVersion: '0.133.0',
        isVersionSupported: true,
    })),
    shutdown: vi.fn(),
    requests: [] as IRuntimeRequest[],
    spawnCount: 0,
}));

vi.mock('electron', () => ({app: {
    getPath: () => '/tmp/evb-viewer',
    getVersion: () => 'test',
}}));

vi.mock('@electron/features/agent/assistantProviderAccounts', () => ({
    refreshCodexAuthState: vi.fn(async () => undefined),
    refreshCodexAuthStateAndRuntimeAvailability: mocks.refreshCodexAuthStateAndRuntimeAvailability,
    syncCodexRuntimeStateAfterAuthCheck: vi.fn(),
}));

vi.mock('@electron/features/agent/codexCli', () => ({
    getCodexCliInfo: runtimeMocks.getCodexCliInfo,
    runCodexCli: vi.fn(async () => ({ok: true})),
}));

vi.mock('@electron/features/agent/codexAppServerClient', () => ({CodexAppServerClient: class {
    private closed = false;
    constructor() {
        runtimeMocks.spawnCount += 1;
    }

    isClosed() {
        return this.closed;
    }

    hasProvenTermination() {
        return false;
    }

    async initialize() {}

    async shutdown() {
        this.closed = true;
        return runtimeMocks.shutdown();
    }

    async requestDecoded<T>(method: string, params: unknown): Promise<T> {
        runtimeMocks.requests.push({
            method,
            params,
        });
        if (method === 'model/list') {
            return [] as T;
        }
        if (method === 'thread/resume') {
            return {thread: {id: 'thread-preserved'}} as T;
        }
        return {data: []} as T;
    }
}}));

vi.mock('@electron/features/agent/mcpServer', () => ({
    getEmbeddedMcpServerDescriptor: () => ({
        name: 'evb-viewer',
        url: 'http://127.0.0.1:1/mcp',
    }),
    isEmbeddedMcpServerRunning: () => false,
    shutdownEmbeddedMcpServer: vi.fn(async () => undefined),
    startEmbeddedMcpServer: vi.fn(async () => ({
        descriptor: {
            name: 'evb-viewer',
            url: 'http://127.0.0.1:1/mcp',
        },
        token: 'test-token',
    })),
}));

describe('assistant runtime lifecycle', () => {
    beforeEach(() => {
        runtimeMocks.shutdown.mockReset();
        runtimeMocks.requests = [];
        runtimeMocks.spawnCount = 0;
    });

    it('holds busy state for active work and repairs it after every session becomes terminal', async () => {
        const sessionStore = createAssistantChatSessionStore({persistence: false});
        const session = sessionStore.getSession({
            kind: 'document',
            key: 'document-a',
            title: 'Document A',
            tabId: requireTabId('tab-a'),
        }, {
            provider: 'codex',
            model: 'gpt-5.4',
            effort: 'medium',
            speedMode: 'standard',
        }, {create: true});
        const providerRuntime = createAssistantProviderRuntimeStates({codex: {
            authState: 'signed-in',
            runtimeState: 'busy',
        }}).codex;
        const logger = {
            info: vi.fn(),
            warn: vi.fn(),
        };
        const lifecycle = createAssistantRuntimeLifecycle({
            providerRuntime,
            sessionStore,
            getCodexModels: () => [],
            setCodexModels: vi.fn(),
            isAssistantFeatureEnabled: vi.fn(async () => true),
            createAssistantDisabledError: () => 'disabled',
            shutdownAssistant: vi.fn(async () => undefined),
            publishCodexState: vi.fn(),
            handleNotification: vi.fn(),
            handleExit: vi.fn(),
            logger,
        });

        session.sendInFlight = Promise.resolve();
        await lifecycle.refreshAuthStateAndRuntimeAvailability();
        expect(providerRuntime.runtimeState).toBe('busy');

        session.sendInFlight = null;
        session.turnOwner = claimAssistantTurn(session.turnOwner, {
            sessionKey: 'codex:document-a',
            scopeKey: 'document-a',
            provider: 'codex',
            windowId: 1,
            tabId: requireTabId('tab-a'),
            documentRef: null,
            documentIdentity: null,
        });
        await lifecycle.refreshAuthStateAndRuntimeAvailability();
        expect(providerRuntime.runtimeState).toBe('busy');

        session.turnOwner = supersedeAssistantTurn(session.turnOwner);
        await lifecycle.refreshAuthStateAndRuntimeAvailability();
        expect(providerRuntime.runtimeState).toBe('stopped');
        expect(logger.warn).toHaveBeenCalledWith(
            'Recovered an orphaned Codex busy state after all assistant turns became terminal.',
        );
    });

    it('retains a failed runtime owner and blocks replacement until a retry proves termination', async () => {
        const sessionStore = createAssistantChatSessionStore({persistence: false});
        const session = sessionStore.getSession({
            kind: 'document',
            key: 'document-a',
            title: 'Document A',
            tabId: requireTabId('tab-a'),
        }, {
            provider: 'codex',
            model: 'gpt-5.4',
            effort: 'medium',
            speedMode: 'standard',
        }, {create: true});
        session.providerThreadId = 'thread-preserved';
        const providerRuntime = createAssistantProviderRuntimeStates({codex: {
            authState: 'signed-in',
            runtimeState: 'stopped',
        }}).codex;
        const lifecycle = createAssistantRuntimeLifecycle({
            providerRuntime,
            sessionStore,
            getCodexModels: () => [],
            setCodexModels: vi.fn(),
            isAssistantFeatureEnabled: vi.fn(async () => true),
            createAssistantDisabledError: () => 'disabled',
            shutdownAssistant: vi.fn(async () => undefined),
            publishCodexState: vi.fn(),
            handleNotification: vi.fn(),
            handleExit: vi.fn(),
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
            },
        });

        const firstRuntime = await lifecycle.ensureRuntime();
        const terminationError = new Error('process tree did not terminate cleanly');
        runtimeMocks.shutdown.mockRejectedValueOnce(terminationError).mockResolvedValueOnce(undefined);

        await expect(lifecycle.shutdownCodexRuntime()).rejects.toBe(terminationError);
        expect(lifecycle.getRuntime()).toBe(firstRuntime);
        expect(providerRuntime.runtimeState).toBe('error');
        expect(runtimeMocks.spawnCount).toBe(1);

        const replacement = await lifecycle.ensureRuntime();

        expect(replacement).not.toBe(firstRuntime);
        expect(runtimeMocks.spawnCount).toBe(2);
        expect(providerRuntime.runtimeState).not.toBe('stopped');

        await expect(lifecycle.ensureThread(session)).resolves.toEqual({
            threadId: 'thread-preserved',
            created: false,
        });
        expect(session.providerThreadId).toBe('thread-preserved');
        expect(runtimeMocks.requests).toContainEqual({
            method: 'thread/resume',
            params: expect.objectContaining({threadId: 'thread-preserved'}),
        });
    });
});
