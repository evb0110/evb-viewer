import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { EventEmitter } from 'node:events';
import {
    mkdtemp,
    rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { BrowserWindow } from 'electron';
import type {
    IAgentAssistantChatScope,
    IAgentAssistantEvent,
} from '@contracts/agent';
import type * as CodexAssistantModule from '@electron/features/agent/codexAssistant';
import {
    runDualProviderCompletionDriver,
    waitForCodexRequest,
    waitForCodexRequestCount,
} from '@tests/unit/electron/helpers/dualProviderCompletionDriver';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireEpochMs} from '@contracts/timestamps';
import {requireTabId} from '@contracts/windowTabs';

function createAssistantWindow(send: (channel: string, event: IAgentAssistantEvent) => void): BrowserWindow {
    // The publisher only reads these lifecycle members; Electron types the mock as a full BrowserWindow.
    return {
        isDestroyed: () => false,
        webContents: {
            isDestroyed: () => false,
            send,
        },
    } as BrowserWindow;
}

const mocks = vi.hoisted(() => ({
    loadSettings: vi.fn(async () => ({assistantPanelEnabled: false})),
    getCodexCliInfo: vi.fn(),
    runCodexCli: vi.fn(async () => ({ok: true})),
    installManagedCodex: vi.fn(),
    spawn: vi.fn(),
    assistantDisabledMessage: 'Enable EVB Assistant in Settings to use assistant chat.',
    startEmbeddedMcpServer: vi.fn(),
    abortActiveEmbeddedMcpRequests: vi.fn(),
    shutdownEmbeddedMcpServer: vi.fn(async () => undefined),
    openExternal: vi.fn(),
    initializeGate: null as null | {
        promise: Promise<void>;
        resolve: () => void;
    },
    turnStartGate: null as null | {
        promise: Promise<void>;
        resolve: () => void;
    },
    turnStartResponseHook: null as null | (() => void),
    threadStartGate: null as null | {
        promise: Promise<void>;
        resolve: () => void;
    },
    loginStartGate: null as null | {
        promise: Promise<void>;
        resolve: () => void;
    },
    processKillGate: null as null | {
        promise: Promise<void>;
        resolve: () => void;
    },
    claudeRuntimeLoadGate: null as null | {
        promise: Promise<void>;
        resolve: () => void;
    },
    claudeSessionConstructor: vi.fn(),
    codexAccountReadMode: 'success',
    codexAuthStatusMode: 'signed-in',
    turnStartResponseId: undefined as unknown,
    malformedTurnStartResponse: false,
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
    assistantTurnBusyMessage: 'EVB Assistant is still working on the previous message for this document.',
    userDataPath: '',
}));

class FakeCodexAppServerProcess extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly requestMethods: string[] = [];
    readonly stdin = Object.assign(new EventEmitter(), {write: (
        line: string,
        callback?: (error?: Error | null) => void,
    ) => {
        this.handleRequestLine(line);
        callback?.();
        return true;
    }});

    private threadCount = 0;
    private turnCount = 0;

    kill = vi.fn(() => {
        const close = () => this.emit('close', 0);
        if (mocks.processKillGate) {
            void mocks.processKillGate.promise.then(close);
        } else {
            close();
        }
        return true;
    });

    notifyAppServer(method: string, params: unknown) {
        this.notify(method, params);
    }

    private handleRequestLine(line: string) {
        const request = JSON.parse(line) as {
            id?: number;
            method?: string;
            params?: {
                threadId?: string;
                input?: Array<{ text?: string }>;
            };
        };
        if (request.id === undefined) {
            return;
        }
        if (request.method) {
            this.requestMethods.push(request.method);
            this.emit('codex-request', request.method);
        }

        switch (request.method) {
            case 'initialize':
                if (mocks.initializeGate) {
                    void mocks.initializeGate.promise.then(() => this.respond(request.id!, {}));
                    return;
                }
                this.respond(request.id, {});
                return;
            case 'account/read':
                if (mocks.codexAccountReadMode === 'error') {
                    this.respondError(request.id, 'account/read timed out after 8000ms.');
                    return;
                }
                if (mocks.codexAccountReadMode === 'signed-out') {
                    this.respond(request.id, {requiresOpenaiAuth: true});
                    return;
                }
                this.respond(request.id, {account: {
                    type: 'chatgpt',
                    email: 'reader@example.com',
                }});
                return;
            case 'getAuthStatus':
                if (mocks.codexAuthStatusMode === 'error') {
                    this.respondError(request.id, 'getAuthStatus timed out after 8000ms.');
                    return;
                }
                this.respond(request.id, mocks.codexAuthStatusMode === 'signed-out'
                    ? {
                        requiresOpenaiAuth: true,
                        authMethod: null,
                    }
                    : {
                        requiresOpenaiAuth: false,
                        authMethod: 'chatgpt',
                    });
                return;
            case 'account/login/start': {
                const respondToLogin = () => this.respond(request.id!, {
                    type: 'chatgpt',
                    loginId: 'login-1',
                    authUrl: 'https://auth.example.test/start',
                });
                if (mocks.loginStartGate) {
                    void mocks.loginStartGate.promise.then(respondToLogin);
                    return;
                }
                respondToLogin();
                return;
            }
            case 'mcpServerStatus/list':
                this.respond(request.id, {data: [{
                    name: 'evb_viewer_embedded',
                    tools: {},
                }]});
                return;
            case 'thread/start': {
                this.threadCount += 1;
                const respond = () => this.respond(request.id!, { thread: { id: `thread-${this.threadCount}` } });
                if (mocks.threadStartGate) {
                    void mocks.threadStartGate.promise.then(respond);
                    return;
                }
                respond();
                return;
            }
            case 'thread/resume':
                this.respond(request.id, { thread: { id: request.params?.threadId } });
                return;
            case 'turn/start': {
                this.turnCount += 1;
                const turnNumber = this.turnCount;
                const turnId = `turn-${turnNumber}`;
                const assistantId = `assistant-${turnNumber}`;
                const text = request.params?.input?.find(item => typeof item.text === 'string')?.text ?? '';
                if (text.includes('timeout')) {
                    return;
                }
                const finishTurnStart = () => {
                    if (text.includes('completed-before-turn-response')) {
                        this.notify('item/completed', {
                            threadId: request.params?.threadId,
                            item: {
                                type: 'agentMessage',
                                id: assistantId,
                                text: 'Done before turn response',
                            },
                        });
                        this.notify('turn/completed', {threadId: request.params?.threadId});
                        this.respond(request.id!, { turn: { id: turnId } });
                        this.notify('turn/started', {
                            threadId: request.params?.threadId,
                            turn: { id: turnId },
                        });
                        return;
                    }
                    if (text.includes('early-delta')) {
                        this.notify('item/agentMessage/delta', {
                            threadId: request.params?.threadId,
                            turnId,
                            itemId: assistantId,
                            delta: 'Early ',
                        });
                        this.notify('item/completed', {
                            threadId: request.params?.threadId,
                            turnId,
                            item: {
                                type: 'agentMessage',
                                id: assistantId,
                                text: 'Early answer',
                            },
                        });
                        this.notify('turn/completed', {
                            threadId: request.params?.threadId,
                            turnId,
                        });
                    }
                    this.respond(request.id!, mocks.malformedTurnStartResponse
                        ? {turn: {id: mocks.turnStartResponseId}}
                        : {turn: {id: turnId}});
                    if (mocks.malformedTurnStartResponse) {
                        return;
                    }
                    mocks.turnStartResponseHook?.();
                    this.notify('turn/started', {
                        threadId: request.params?.threadId,
                        turn: { id: turnId },
                    });
                    if (text.includes('hold-active') || text.includes('early-delta')) {
                        return;
                    }
                    if (text.includes('stream')) {
                        this.notify('item/agentMessage/delta', {
                            threadId: request.params?.threadId,
                            itemId: assistantId,
                            delta: 'Hello ',
                        });
                        this.notify('item/agentMessage/delta', {
                            threadId: request.params?.threadId,
                            itemId: assistantId,
                            delta: 'there',
                        });
                        this.notify('item/completed', {
                            threadId: request.params?.threadId,
                            item: {
                                type: 'agentMessage',
                                id: assistantId,
                                text: 'Hello there',
                            },
                        });
                    }
                    this.notify('turn/completed', { threadId: request.params?.threadId });
                };
                if (mocks.turnStartGate) {
                    void mocks.turnStartGate.promise.then(finishTurnStart);
                    return;
                }
                finishTurnStart();
                return;
            }
            case 'turn/interrupt':
                this.respond(request.id, {});
                return;
            default:
                this.respond(request.id, {});
        }
    }

    private respond(id: number, result: unknown) {
        this.stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id,
            result,
        })}\n`);
    }

    private respondError(id: number, message: string) {
        this.stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { message },
        })}\n`);
    }

    private notify(method: string, params: unknown) {
        this.stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            method,
            params,
        })}\n`);
    }
}

vi.mock('electron', () => ({
    app: {
        focus: vi.fn(),
        getVersion: vi.fn(() => '0.0.0-test'),
        getPath: vi.fn(() => mocks.userDataPath),
    },
    BrowserWindow: {
        getAllWindows: vi.fn(() => []),
        getFocusedWindow: vi.fn(() => null),
    },
    shell: {openExternal: mocks.openExternal},
}));

vi.mock('child_process', () => ({
    spawn: mocks.spawn,
    execFile: vi.fn(),
}));

vi.mock('@electron/settings', () => ({loadSettings: mocks.loadSettings}));

vi.mock('@electron/te', () => ({te: (key: string) => {
    if (key === 'dialogs.agentAssistant.disabledMessage') {
        return mocks.assistantDisabledMessage;
    }
    if (key === 'dialogs.agentAssistant.turnBusy') {
        return mocks.assistantTurnBusyMessage;
    }
    return key;
}}));

vi.mock('@electron/config', () => ({config: {automation: {noFocus: true}}}));

vi.mock('@electron/features/agent/codexCli', () => ({
    CODEX_APP_INSTALL_URL: 'https://developers.openai.com/codex/app',
    CODEX_STANDALONE_INSTALL_URL: 'https://example.test/install-codex',
    getCodexCliInfo: mocks.getCodexCliInfo,
    runCodexCli: mocks.runCodexCli,
    installManagedCodex: mocks.installManagedCodex,
}));

vi.mock('@electron/features/agent/claudeProviderMetadata', async (importOriginal) => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const actual = await importOriginal<typeof import('@electron/features/agent/claudeProviderMetadata')>();
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

vi.mock('@electron/features/agent/claudeAgentSdkAssistant', async () => {
    await mocks.claudeRuntimeLoadGate?.promise;
    return {ClaudeAgentAssistantSession: mocks.claudeSessionConstructor};
});

vi.mock('@electron/features/agent/mcpServer', () => ({
    abortActiveEmbeddedMcpRequests: mocks.abortActiveEmbeddedMcpRequests,
    getEmbeddedMcpServerDescriptor: vi.fn(() => null),
    isEmbeddedMcpServerRunning: vi.fn(() => false),
    shutdownEmbeddedMcpServer: mocks.shutdownEmbeddedMcpServer,
    startEmbeddedMcpServer: mocks.startEmbeddedMcpServer,
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

function createInitializeGate() {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((next) => {
        resolve = next;
    });
    return {
        promise,
        resolve,
    };
}

async function settleAsyncTicks(count = 3) {
    for (let index = 0; index < count; index += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

function configureEnabledAssistantRuntime() {
    mocks.loadSettings.mockResolvedValue({assistantPanelEnabled: true});
    mocks.getCodexCliInfo.mockResolvedValue({
        installed: true,
        path: '/Applications/Codex.app/Contents/Resources/codex',
        version: '0.133.0',
        minimumVersion: '0.133.0',
        isVersionSupported: true,
        managedInstallDir: '/tmp/codex',
    });
    mocks.startEmbeddedMcpServer.mockResolvedValue({
        descriptor: {
            name: 'evb_viewer_embedded',
            url: 'http://127.0.0.1:9876',
        },
        token: requireDocumentRevisionToken('test-mcp-token'),
    });
}

function enableAssistantRuntime(process = new FakeCodexAppServerProcess()) {
    configureEnabledAssistantRuntime();
    mocks.spawn.mockImplementation(() => process);
    return process;
}

function createDocumentScope(
    fileName: string,
    key = `document:/tmp/${fileName}`,
    documentRef = `/tmp/${fileName}`,
): IAgentAssistantChatScope {
    return {
        kind: 'document',
        key,
        tabId: requireTabId('tab-1'),
        title: fileName,
        documentRef: requireDocumentRef(documentRef),
    };
}

describe('agent assistant opt-in gating', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.userDataPath = await mkdtemp(join(tmpdir(), 'evb-viewer-agent-test-'));
        mocks.loadSettings.mockResolvedValue({assistantPanelEnabled: false});
        mocks.initializeGate = null;
        mocks.turnStartGate = null;
        mocks.turnStartResponseHook = null;
        mocks.threadStartGate = null;
        mocks.loginStartGate = null;
        mocks.processKillGate = null;
        mocks.claudeRuntimeLoadGate = createInitializeGate();
        mocks.claudeSessionConstructor.mockReset();
        mocks.codexAccountReadMode = 'success';
        mocks.codexAuthStatusMode = 'signed-in';
        mocks.turnStartResponseId = undefined;
        mocks.malformedTurnStartResponse = false;
        mocks.runCodexCli.mockResolvedValue({ok: true});
    });

    afterEach(async () => {
        const {shutdownAgentAssistant}: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');
        await shutdownAgentAssistant();
        vi.useRealTimers();
        vi.unstubAllEnvs();
        await rm(mocks.userDataPath, {
            force: true,
            maxRetries: 10,
            recursive: true,
            retryDelay: 20,
        });
    });

    it('lets lifecycle waiters continue when a queued shutdown rejects', async () => {
        const {createAssistantFeatureLifecycle} = await import('@electron/features/agent/assistantRuntimeLifecycle');
        const gate = createInitializeGate();
        const lifecycle = createAssistantFeatureLifecycle({
            isEnabled: async () => true,
            createDisabledError: () => 'disabled',
        });
        const operationGeneration = lifecycle.captureGeneration();
        const shutdown = lifecycle.shutdown(async () => {
            await gate.promise;
            throw new Error('teardown failed');
        });
        const waiter = lifecycle.waitForShutdown();
        const enabled = lifecycle.isEnabled(operationGeneration);

        gate.resolve();

        await expect(shutdown).rejects.toThrow('teardown failed');
        await expect(waiter).resolves.toBeUndefined();
        await expect(enabled).resolves.toBe(false);
    });

    it('does not discover Codex or start MCP when disabled state is requested', async () => {
        const { getAgentAssistantState }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const state = await getAgentAssistantState();

        expect(state.status.runtimeState).toBe('stopped');
        expect(state.status.mcp.serverRunning).toBe(false);
        expect(mocks.getCodexCliInfo).not.toHaveBeenCalled();
        expect(mocks.startEmbeddedMcpServer).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('reports fresh installed Codex authentication without starting its runtime', async () => {
        configureEnabledAssistantRuntime();
        mocks.runCodexCli.mockResolvedValue({ok: true});
        const {getAgentAssistantState}: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const state = await getAgentAssistantState({provider: 'codex'});

        expect(state.status.authState).toBe('signed-in');
        expect(state.status.runtimeState).toBe('ready');
        expect(mocks.runCodexCli).toHaveBeenCalledWith(
            '/Applications/Codex.app/Contents/Resources/codex',
            [
                'login',
                'status',
            ],
            expect.objectContaining({env: expect.objectContaining({CODEX_HOME: join(mocks.userDataPath, 'assistant', 'codex-home')})}),
        );
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.startEmbeddedMcpServer).not.toHaveBeenCalled();
    });

    it('rejects assistant chat actions while disabled', async () => {
        const { sendAgentAssistantMessage }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const result = await sendAgentAssistantMessage({text: 'Summarize this document'});

        expect(result.ok).toBe(false);
        expect(result.error).toBe(mocks.assistantDisabledMessage);
        expect(result.errorEnvelope).toMatchObject({
            code: 'INTERNAL',
            message: mocks.assistantDisabledMessage,
            retryable: false,
        });
        expect(mocks.getCodexCliInfo).not.toHaveBeenCalled();
        expect(mocks.startEmbeddedMcpServer).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('falls back to Codex auth status when account profile read fails', async () => {
        configureEnabledAssistantRuntime();
        mocks.codexAccountReadMode = 'error';
        mocks.codexAuthStatusMode = 'signed-in';
        mocks.spawn.mockImplementation(() => new FakeCodexAppServerProcess());

        const {
            getAgentAssistantState,
            sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        await sendAgentAssistantMessage({
            text: 'Check auth',
            scope: createDocumentScope('auth-error.pdf'),
        });
        const state = await getAgentAssistantState();

        expect(state.status.authState).toBe('signed-in');
        expect(state.status.runtimeState).toBe('ready');
        expect(state.status.account).toBeNull();
        expect(state.status.error).toBeUndefined();
        expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining('auth status fallback succeeded'));
        expect(mocks.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('falling back to auth status'));
    });

    it('preserves signed-out Codex state and its error after a later state read', async () => {
        configureEnabledAssistantRuntime();
        mocks.codexAccountReadMode = 'error';
        mocks.codexAuthStatusMode = 'error';
        mocks.spawn.mockImplementation(() => new FakeCodexAppServerProcess());

        const {
            getAgentAssistantState,
            sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        await sendAgentAssistantMessage({
            text: 'Check auth',
            scope: createDocumentScope('auth-error.pdf'),
        });
        const state = await getAgentAssistantState();

        expect(state.status.authState).toBe('signed-out');
        expect(state.status.runtimeState).toBe('stopped');
        expect(state.status.error).toContain('Could not verify Codex authentication');
        expect(state.status.error).toContain('account/read timed out');
        expect(state.status.error).toContain('getAuthStatus timed out');

        const stateAfterRead = await getAgentAssistantState();
        expect(stateAfterRead.status.authState).toBe('signed-out');
        expect(stateAfterRead.status.runtimeState).toBe('stopped');
        expect(stateAfterRead.status.error).toBe(state.status.error);
    });

    it('waits for in-flight Codex runtime startup before reusing the app-server client', async () => {
        configureEnabledAssistantRuntime();
        mocks.initializeGate = createInitializeGate();
        const process = new FakeCodexAppServerProcess();
        mocks.spawn.mockImplementation(() => process);

        const { sendAgentAssistantMessage }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const firstState = sendAgentAssistantMessage({
            text: 'Start runtime',
            scope: createDocumentScope('startup-wait.pdf'),
        });
        await waitForCodexRequest(process, 'initialize');
        const secondState = sendAgentAssistantMessage({
            text: 'Reuse runtime',
            scope: createDocumentScope('startup-wait-2.pdf'),
        });
        await settleAsyncTicks();

        expect(process.requestMethods).toEqual(['initialize']);
        mocks.initializeGate.resolve();

        await expect(Promise.all([
            firstState,
            secondState,
        ])).resolves.toHaveLength(2);
        expect(mocks.spawn).toHaveBeenCalledOnce();
    });

    it('cancels an in-flight Codex startup when the assistant is disabled', async () => {
        configureEnabledAssistantRuntime();
        mocks.initializeGate = createInitializeGate();
        const process = new FakeCodexAppServerProcess();
        mocks.spawn.mockImplementation(() => process);

        const {
            sendAgentAssistantMessage,
            shutdownAgentAssistant,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const statePromise = sendAgentAssistantMessage({
            text: 'Cancel startup',
            scope: createDocumentScope('cancel-startup.pdf'),
        });
        await waitForCodexRequest(process, 'initialize');
        mocks.loadSettings.mockResolvedValue({assistantPanelEnabled: false});
        await shutdownAgentAssistant();
        mocks.initializeGate.resolve();
        await statePromise;

        expect(process.kill).toHaveBeenCalled();
        expect(process.requestMethods).toEqual(['initialize']);
    });

    it('does not start a provider turn when opt-out wins during thread creation', async () => {
        const documentScope = createDocumentScope('disable-during-send.pdf');
        const process = enableAssistantRuntime();
        mocks.threadStartGate = createInitializeGate();
        const {
            sendAgentAssistantMessage,
            shutdownAgentAssistant,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const sendPromise = sendAgentAssistantMessage({
            text: 'Do not send this after opt-out',
            scope: documentScope,
        });
        await waitForCodexRequest(process, 'thread/start');
        mocks.loadSettings.mockResolvedValue({assistantPanelEnabled: false});
        await shutdownAgentAssistant();
        mocks.threadStartGate.resolve();

        await expect(sendPromise).resolves.toMatchObject({ok: false});
        expect(process.requestMethods).not.toContain('turn/start');
        expect(process.kill).toHaveBeenCalled();
    });

    it('does not resurrect a reset turn after Codex runtime initialization returns', async () => {
        configureEnabledAssistantRuntime();
        mocks.initializeGate = createInitializeGate();
        const process = new FakeCodexAppServerProcess();
        mocks.spawn.mockImplementation(() => process);

        const {
            getAgentAssistantState,
            resetAgentAssistantChat,
            sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const sendPromise = sendAgentAssistantMessage({
            text: 'Do not restore this after reset',
            scope: createDocumentScope('reset-during-initialize.pdf'),
        });
        await waitForCodexRequest(process, 'initialize');
        await resetAgentAssistantChat({scope: createDocumentScope('reset-during-initialize.pdf')});
        mocks.initializeGate.resolve();

        await expect(sendPromise).resolves.toMatchObject({ok: false});
        const state = await getAgentAssistantState({scope: createDocumentScope('reset-during-initialize.pdf')});
        expect(state.messages).toEqual([]);
        expect(process.requestMethods).not.toContain('turn/start');
    });

    it('archives a Codex thread created for a reset generation without starting its turn', async () => {
        const documentScope = createDocumentScope('reset-during-thread-start.pdf');
        const process = enableAssistantRuntime();
        mocks.threadStartGate = createInitializeGate();

        const {
            getAgentAssistantState,
            resetAgentAssistantChat,
            sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const sendPromise = sendAgentAssistantMessage({
            text: 'Do not send this after reset',
            scope: documentScope,
        });
        await waitForCodexRequest(process, 'thread/start');
        await resetAgentAssistantChat({scope: documentScope});
        mocks.threadStartGate.resolve();

        await expect(sendPromise).resolves.toMatchObject({ok: false});
        const state = await getAgentAssistantState({scope: documentScope});
        expect(state.messages).toEqual([]);
        expect(process.requestMethods).not.toContain('turn/start');
        expect(process.requestMethods).toContain('thread/archive');

        await expect(sendAgentAssistantMessage({
            text: 'Intentional send after reset',
            scope: documentScope,
        })).resolves.toMatchObject({ok: true});
        expect(process.requestMethods.filter(method => method === 'turn/start')).toHaveLength(1);
    });

    it('returns a terminal canceled result when Stop wins during Codex thread creation', async () => {
        const documentScope = createDocumentScope('stop-during-thread-start.pdf');
        const process = enableAssistantRuntime();
        mocks.threadStartGate = createInitializeGate();

        const {
            getAgentAssistantState,
            interruptAgentAssistant,
            sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const sendPromise = sendAgentAssistantMessage({
            text: 'Do not send this after stop',
            scope: documentScope,
        });
        await waitForCodexRequest(process, 'thread/start');
        const stoppedState = await interruptAgentAssistant({scope: documentScope});
        expect(stoppedState.status.turn.phase).toBe('cancelled');
        mocks.threadStartGate.resolve();

        await expect(sendPromise).resolves.toMatchObject({
            ok: false,
            error: 'Assistant turn was canceled before provider setup completed.',
        });
        const state = await getAgentAssistantState({scope: documentScope});
        expect(state.messages).toEqual([]);
        expect(process.requestMethods).not.toContain('turn/start');
        expect(process.requestMethods).toContain('thread/archive');
    });

    it('interrupts a provider turn submitted before reset wins its response fence', async () => {
        const documentScope = createDocumentScope('reset-after-turn-submit.pdf');
        const process = enableAssistantRuntime();
        const {
            resetAgentAssistantChat,
            sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        mocks.turnStartResponseHook = () => {
            void resetAgentAssistantChat({scope: documentScope});
        };

        await expect(sendAgentAssistantMessage({
            text: 'Reset after provider submission',
            scope: documentScope,
        })).resolves.toMatchObject({ok: false});
        expect(process.requestMethods).toContain('turn/interrupt');
        expect(process.requestMethods).toContain('thread/archive');
    });

    it.each([
        undefined,
        null,
        42,
        '',
        '   ',
    ])('settles a malformed Codex turn-start success without leaving a stale claim (%s)', async (turnStartResponseId) => {
        const documentScope = createDocumentScope(`malformed-turn-${String(turnStartResponseId)}.pdf`);
        const process = enableAssistantRuntime();
        mocks.turnStartResponseId = turnStartResponseId;
        mocks.malformedTurnStartResponse = true;

        const {
            getAgentAssistantState,
            sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const failed = await sendAgentAssistantMessage({
            text: 'Malformed turn response',
            scope: documentScope,
        });

        expect(failed).toMatchObject({
            ok: false,
            error: 'Codex returned an invalid turn/start response.',
        });
        const failedState = await getAgentAssistantState({scope: documentScope});
        expect(failedState.status.turn.phase).toBe('failed');

        mocks.turnStartResponseId = undefined;
        mocks.malformedTurnStartResponse = false;
        const recovered = await sendAgentAssistantMessage({
            text: 'Valid replacement turn',
            scope: documentScope,
        });

        expect(recovered.ok).toBe(true);
        expect(process.requestMethods.filter(method => method === 'turn/start')).toHaveLength(2);
    });

    it('does not create a Claude session when opt-out wins during adapter loading', async () => {
        configureEnabledAssistantRuntime();
        const documentScope = createDocumentScope('disable-during-claude-load.pdf');
        const {
            sendAgentAssistantMessage,
            shutdownAgentAssistant,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const sendPromise = sendAgentAssistantMessage({
            provider: 'claude',
            text: 'Do not create this session',
            scope: documentScope,
        });
        await settleAsyncTicks();
        expect(mocks.claudeRuntimeLoadGate).toBeTruthy();
        expect(mocks.claudeSessionConstructor).not.toHaveBeenCalled();

        mocks.loadSettings.mockResolvedValue({assistantPanelEnabled: false});
        await shutdownAgentAssistant();
        mocks.claudeRuntimeLoadGate?.resolve();

        await expect(sendPromise).resolves.toMatchObject({ok: false});
        expect(mocks.claudeSessionConstructor).not.toHaveBeenCalled();
    });

    it('does not create a Claude session after Reset wins during adapter loading', async () => {
        configureEnabledAssistantRuntime();
        const documentScope = createDocumentScope('reset-during-claude-load.pdf');
        const {
            getAgentAssistantState,
            resetAgentAssistantChat,
            sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const sendPromise = sendAgentAssistantMessage({
            provider: 'claude',
            text: 'Do not create this session after reset',
            scope: documentScope,
        });
        await settleAsyncTicks();
        expect(mocks.claudeRuntimeLoadGate).toBeTruthy();
        await resetAgentAssistantChat({
            provider: 'claude',
            scope: documentScope,
        });
        mocks.claudeRuntimeLoadGate?.resolve();

        await expect(sendPromise).resolves.toMatchObject({ok: false});
        const state = await getAgentAssistantState({scope: documentScope});
        expect(state.messages).toEqual([]);
        expect(mocks.claudeSessionConstructor).not.toHaveBeenCalled();
    });

    it('completes through each selected backend with provider-specific drivers', async () => {
        const {sendAgentAssistantMessage}: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');
        const driver = await runDualProviderCompletionDriver({
            startCodex: () => enableAssistantRuntime(),
            installClaudeSession: constructor => mocks.claudeSessionConstructor.mockImplementation(constructor),
            resolveClaudeRuntime: () => mocks.claudeRuntimeLoadGate?.resolve(),
            send: sendAgentAssistantMessage,
            createScope: createDocumentScope,
        });

        expect(driver.codexResult.ok).toBe(true);
        expect(driver.codexResult.state.messages.map(message => message.text)).toContain('Hello there');
        expect(driver.codexProcess.requestMethods).toContain('turn/start');

        expect(driver.claudeResult.ok).toBe(true);
        expect(driver.claudeResult.state.messages.map(message => message.text)).toContain('Claude completed: claude completion');
        expect(driver.claudeSessions).toHaveLength(1);
        expect(driver.claudeSessions[0]?.completedMessages).toEqual(['Claude completed: claude completion']);
        expect(mocks.spawn).toHaveBeenCalledOnce();
    });

    it('does not turn an idle Claude stream exit into a duplicate failed chat turn', async () => {
        const {
            getAgentAssistantState, sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');
        const driver = await runDualProviderCompletionDriver({
            startCodex: () => enableAssistantRuntime(),
            installClaudeSession: constructor => mocks.claudeSessionConstructor.mockImplementation(constructor),
            resolveClaudeRuntime: () => mocks.claudeRuntimeLoadGate?.resolve(),
            send: sendAgentAssistantMessage,
            createScope: createDocumentScope,
        });
        const scope = createDocumentScope('dual-provider-claude.pdf');
        const session = driver.claudeSessions[0];

        expect(session).toBeTruthy();
        session?.callbacks.onError(null, 'Claude assistant session ended.');

        const state = await getAgentAssistantState({
            provider: 'claude',
            scope,
        });
        expect(state.status.runtimeState).toBe('error');
        expect(state.messages.filter(message => message.error).map(message => message.text)).toEqual([]);
    });

    it('waits for an old client shutdown before starting again after rapid re-enable', async () => {
        const process = enableAssistantRuntime();
        const {
            sendAgentAssistantMessage,
            shutdownAgentAssistant,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');
        await sendAgentAssistantMessage({
            text: 'Start runtime',
            scope: createDocumentScope('rapid-reenable-start.pdf'),
        });
        expect(mocks.spawn).toHaveBeenCalledOnce();

        mocks.processKillGate = createInitializeGate();
        mocks.loadSettings.mockResolvedValue({assistantPanelEnabled: false});
        const shutdown = shutdownAgentAssistant();
        await vi.waitFor(() => {
            expect(process.kill).toHaveBeenCalled();
        });

        mocks.loadSettings.mockResolvedValue({assistantPanelEnabled: true});
        const restartedSend = sendAgentAssistantMessage({
            text: 'Run only after the old runtime is gone',
            scope: createDocumentScope('rapid-reenable.pdf'),
        });
        await settleAsyncTicks();
        expect(mocks.spawn).toHaveBeenCalledOnce();

        mocks.processKillGate.resolve();
        mocks.processKillGate = null;
        await shutdown;
        await expect(restartedSend).resolves.toMatchObject({ok: true});
        expect(mocks.spawn).toHaveBeenCalledTimes(2);
    });

    it('restarts a running assistant after installing a newer Codex runtime', async () => {
        const oldProcess = enableAssistantRuntime();
        const newProcess = new FakeCodexAppServerProcess();
        const {
            sendAgentAssistantMessage,
            installAgentAssistantCodex,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');
        await sendAgentAssistantMessage({
            text: 'Start runtime',
            scope: createDocumentScope('install-start.pdf'),
        });
        expect(mocks.spawn).toHaveBeenCalledOnce();

        mocks.installManagedCodex.mockResolvedValue({
            installed: true,
            path: '/Applications/Codex.app/Contents/Resources/codex',
            version: '0.150.1',
            minimumVersion: '0.150.1',
            isVersionSupported: true,
            managedInstallDir: '/tmp/codex',
        });
        mocks.spawn.mockImplementation(() => newProcess);

        await expect(installAgentAssistantCodex()).resolves.toMatchObject({ok: true});
        expect(oldProcess.kill).toHaveBeenCalledOnce();
        expect(mocks.spawn).toHaveBeenCalledTimes(2);
        expect(newProcess.requestMethods).toContain('initialize');

        await expect(sendAgentAssistantMessage({
            text: 'Use the updated runtime',
            scope: createDocumentScope('updated-runtime.pdf'),
        })).resolves.toMatchObject({ok: true});
        expect(newProcess.requestMethods).toEqual(expect.arrayContaining([
            'thread/start',
            'turn/start',
        ]));
    });

    it('runs every shutdown cleanup request when shutdowns overlap', async () => {
        const process = enableAssistantRuntime();
        const {
            sendAgentAssistantMessage,
            shutdownAgentAssistant,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');
        await sendAgentAssistantMessage({
            text: 'Start runtime',
            scope: createDocumentScope('shutdown-start.pdf'),
        });

        mocks.processKillGate = createInitializeGate();
        mocks.loadSettings.mockResolvedValue({assistantPanelEnabled: false});
        const firstShutdown = shutdownAgentAssistant();
        const secondShutdown = shutdownAgentAssistant();
        await vi.waitFor(() => {
            expect(process.kill).toHaveBeenCalled();
        });
        mocks.processKillGate.resolve();
        mocks.processKillGate = null;

        await expect(Promise.all([
            firstShutdown,
            secondShutdown,
        ])).resolves.toHaveLength(2);
        expect(mocks.shutdownEmbeddedMcpServer).toHaveBeenCalledTimes(2);
    });

    it('drops a login response that arrives after opt-out', async () => {
        const process = enableAssistantRuntime();
        mocks.loginStartGate = createInitializeGate();
        const {
            startAgentAssistantLogin,
            shutdownAgentAssistant,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const login = startAgentAssistantLogin({mode: 'chatgpt'});
        await waitForCodexRequest(process, 'account/login/start');
        mocks.loadSettings.mockResolvedValue({assistantPanelEnabled: false});
        mocks.loginStartGate.resolve();

        await expect(login).resolves.toMatchObject({
            ok: false,
            error: mocks.assistantDisabledMessage,
        });
        expect(mocks.openExternal).not.toHaveBeenCalled();
        await shutdownAgentAssistant();
    });

    it('drops a turn response that arrives after opt-out', async () => {
        const process = enableAssistantRuntime();
        mocks.turnStartGate = createInitializeGate();
        const {
            sendAgentAssistantMessage,
            shutdownAgentAssistant,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const send = sendAgentAssistantMessage({
            text: 'Do not acknowledge this turn after opt-out',
            scope: createDocumentScope('turn-response-after-opt-out.pdf'),
        });
        await waitForCodexRequest(process, 'turn/start');
        mocks.loadSettings.mockResolvedValue({assistantPanelEnabled: false});
        mocks.turnStartGate.resolve();

        await expect(send).resolves.toMatchObject({
            ok: false,
            error: mocks.assistantDisabledMessage,
        });
        await shutdownAgentAssistant();
    });

    it('keeps assistant chat messages scoped to the selected document', async () => {
        const documentA = createDocumentScope('a.pdf', 'document-session:session-a', '/tmp/shared.pdf');
        const documentB = createDocumentScope('a.pdf', 'document-session:session-b', '/tmp/shared.pdf');
        enableAssistantRuntime();

        const codexAssistantModule: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');
        const {
            getAgentAssistantState,
            sendAgentAssistantMessage,
        } = codexAssistantModule;

        const firstResult = await sendAgentAssistantMessage({
            text: 'Question for A',
            scope: documentA,
        });
        expect(firstResult.ok).toBe(true);
        expect(firstResult.state.scope?.key).toBe(documentA.key);
        expect(firstResult.state.messages.map(message => message.text)).toContain('Question for A');

        const emptyDocumentB = await getAgentAssistantState({ scope: documentB });
        expect(emptyDocumentB.scope?.key).toBe(documentB.key);
        expect(emptyDocumentB.messages).toEqual([]);

        const secondResult = await sendAgentAssistantMessage({
            text: 'Question for B',
            scope: documentB,
        });
        expect(secondResult.ok).toBe(true);
        expect(secondResult.state.messages.map(message => message.text)).toContain('Question for B');
        expect(secondResult.state.messages.map(message => message.text)).not.toContain('Question for A');

        const restoredDocumentA = await getAgentAssistantState({ scope: documentA });
        expect(restoredDocumentA.messages.map(message => message.text)).toContain('Question for A');
        expect(restoredDocumentA.messages.map(message => message.text)).not.toContain('Question for B');
    });

    it('rejects concurrent sends for the same document session', async () => {
        const documentScope = createDocumentScope('busy.pdf');
        const process = enableAssistantRuntime();
        mocks.turnStartGate = createInitializeGate();

        const { sendAgentAssistantMessage }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const firstSend = sendAgentAssistantMessage({
            text: 'Hold this turn',
            scope: documentScope,
        });
        await waitForCodexRequestCount(process, 'turn/start', 1);

        const secondResult = await sendAgentAssistantMessage({
            text: 'Second message',
            scope: documentScope,
        });

        expect(secondResult.ok).toBe(false);
        expect(secondResult.error).toBe(mocks.assistantTurnBusyMessage);
        expect(process.requestMethods.filter(method => method === 'turn/start')).toHaveLength(1);

        mocks.turnStartGate.resolve();
        mocks.turnStartGate = null;
        await expect(firstSend).resolves.toMatchObject({ ok: true });
    });

    it('rejects sends while the previous Codex turn is still active after setup', async () => {
        const documentScope = createDocumentScope('active-turn.pdf');
        const process = enableAssistantRuntime();

        const {
            getAgentAssistantState,
            sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        await expect(sendAgentAssistantMessage({
            text: 'hold-active',
            scope: documentScope,
        })).resolves.toMatchObject({ ok: true });

        const runningState = await getAgentAssistantState({ scope: documentScope });
        expect(runningState.status.turn.phase).toBe('thinking');

        const secondResult = await sendAgentAssistantMessage({
            text: 'Second message after setup',
            scope: documentScope,
        });

        expect(secondResult.ok).toBe(false);
        expect(secondResult.error).toBe(mocks.assistantTurnBusyMessage);
        expect(process.requestMethods.filter(method => method === 'turn/start')).toHaveLength(1);
    });

    it('interrupts a stale Codex turn before superseding it for a newer document revision', async () => {
        const documentScopeV1 = {
            kind: 'document',
            key: 'document:/tmp/revision-shift.pdf',
            tabId: requireTabId('tab-1'),
            title: 'revision-shift.pdf',
            documentRef: requireDocumentRef('/tmp/revision-shift.pdf'),
            documentIdentity: {
                version: 1,
                documentRef: requireDocumentRef('/tmp/revision-shift.pdf'),
                authority: 'electron-working-copy',
                token: requireDocumentRevisionToken('revision-1'),
                contentRevision: 1,
                mintedAt: requireEpochMs(1),
            },
        } as const satisfies IAgentAssistantChatScope;
        const documentScopeV2 = {
            ...documentScopeV1,
            documentIdentity: {
                ...documentScopeV1.documentIdentity,
                token: requireDocumentRevisionToken('revision-2'),
                contentRevision: 2,
                mintedAt: requireEpochMs(2),
            },
        } as const satisfies IAgentAssistantChatScope;
        const process = enableAssistantRuntime();

        const {
            getAgentAssistantState,
            sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        await expect(sendAgentAssistantMessage({
            text: 'hold-active',
            scope: documentScopeV1,
        })).resolves.toMatchObject({ ok: true });
        await waitForCodexRequestCount(process, 'turn/start', 1);

        const secondResult = await sendAgentAssistantMessage({
            text: 'replacement turn',
            scope: documentScopeV2,
        });

        await waitForCodexRequestCount(process, 'turn/interrupt', 1);
        expect(secondResult.ok).toBe(false);
        expect(secondResult.error).toBe(mocks.assistantTurnBusyMessage);
        expect(process.requestMethods.filter(method => method === 'turn/interrupt')).toHaveLength(1);
        expect(process.requestMethods.filter(method => method === 'turn/start')).toHaveLength(1);

        process.notifyAppServer('turn/completed', {
            threadId: 'thread-1',
            turnId: 'turn-1',
        });
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const currentState = await getAgentAssistantState({scope: documentScopeV2});
            if (currentState.status.turn.phase === 'done') {
                break;
            }
            await settleAsyncTicks();
        }
        expect((await getAgentAssistantState({scope: documentScopeV2})).status.turn.phase).toBe('done');

        await expect(sendAgentAssistantMessage({
            text: 'replacement turn retry',
            scope: documentScopeV2,
        })).resolves.toMatchObject({ok: true});
        await waitForCodexRequestCount(process, 'turn/start', 2);
    });

    it('binds early Codex deltas before turn-started arrives', async () => {
        const documentScope = createDocumentScope('early-delta.pdf');
        enableAssistantRuntime();

        const { sendAgentAssistantMessage }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const result = await sendAgentAssistantMessage({
            text: 'early-delta',
            scope: documentScope,
        });

        expect(result.ok).toBe(true);
        expect(result.state.status.turn.phase).toBe('done');
        expect(result.state.messages.map(message => message.text)).toContain('Early answer');
    });

    it('settles thread-scoped providerless completion before turn-start responds', async () => {
        const documentScope = createDocumentScope('providerless-completion.pdf');
        enableAssistantRuntime();

        const { sendAgentAssistantMessage }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const result = await sendAgentAssistantMessage({
            text: 'completed-before-turn-response',
            scope: documentScope,
        });

        expect(result.ok).toBe(true);
        expect(result.state.status.runtimeState).toBe('ready');
        expect(result.state.status.turn.phase).toBe('done');
        expect(result.state.messages).toContainEqual(expect.objectContaining({
            role: 'assistant',
            text: 'Done before turn response',
            pending: false,
        }));
    });

    it('keeps interrupted Codex turns busy until a terminal provider event arrives', async () => {
        const documentScope = createDocumentScope('interrupt.pdf');
        const process = enableAssistantRuntime();

        const {
            getAgentAssistantState,
            interruptAgentAssistant,
            sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        await expect(sendAgentAssistantMessage({
            text: 'hold-active',
            scope: documentScope,
        })).resolves.toMatchObject({ ok: true });

        const interruptedState = await interruptAgentAssistant({ scope: documentScope });
        expect(interruptedState.status.turn.phase).toBe('interrupting');
        expect(interruptedState.status.runtimeState).toBe('busy');

        const blockedResult = await sendAgentAssistantMessage({
            text: 'new turn too early',
            scope: documentScope,
        });
        expect(blockedResult.ok).toBe(false);
        expect(blockedResult.error).toBe(mocks.assistantTurnBusyMessage);

        process.notifyAppServer('turn/completed', {
            threadId: 'thread-1',
            turnId: 'turn-1',
        });
        await settleAsyncTicks();

        const completedState = await getAgentAssistantState({ scope: documentScope });
        expect(completedState.status.turn.phase).toBe('done');
    });

    it('ignores no-thread Codex completion while a new turn is starting', async () => {
        const documentScope = createDocumentScope('no-thread-completion.pdf');
        const process = enableAssistantRuntime();

        const {
            getAgentAssistantState,
            resetAgentAssistantChat,
            sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        await expect(sendAgentAssistantMessage({
            text: 'First completed turn',
            scope: documentScope,
        })).resolves.toMatchObject({ ok: true });
        await resetAgentAssistantChat({ scope: documentScope });

        mocks.turnStartGate = createInitializeGate();
        const secondSend = sendAgentAssistantMessage({
            text: 'Second starting turn',
            scope: documentScope,
        });
        await waitForCodexRequestCount(process, 'turn/start', 2);

        process.notifyAppServer('turn/completed', {});
        await settleAsyncTicks();

        const state = await getAgentAssistantState({ scope: documentScope });
        expect(state.status.turn.phase).toBe('queued');

        mocks.turnStartGate.resolve();
        mocks.turnStartGate = null;
        await expect(secondSend).resolves.toMatchObject({ ok: true });
    });

    it('archives timed-out Codex turns and ignores late notifications for the old thread', async () => {
        vi.useFakeTimers();
        const documentScope = createDocumentScope('timeout.pdf');
        const process = enableAssistantRuntime();

        const {
            getAgentAssistantState,
            sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const resultPromise = sendAgentAssistantMessage({
            text: 'please timeout',
            scope: documentScope,
        });
        await waitForCodexRequestCount(process, 'turn/start', 1);
        await vi.advanceTimersByTimeAsync(30_000);

        const result = await resultPromise;
        expect(result.ok).toBe(false);
        expect(result.error).toBe('turn/start timed out after 30000ms.');
        expect(process.requestMethods).toContain('thread/archive');
        vi.useRealTimers();

        process.notifyAppServer('item/completed', {
            threadId: 'thread-1',
            item: {
                type: 'agentMessage',
                id: 'late-message',
                text: 'late text',
            },
        });
        process.notifyAppServer('turn/completed', { threadId: 'thread-1' });
        await settleAsyncTicks();

        const state = await getAgentAssistantState({ scope: documentScope });
        expect(state.messages.map(message => message.text)).not.toContain('late text');
    });

    it('resumes Codex threads for inactive document sessions after app-server exit', async () => {
        const documentA = createDocumentScope('a.pdf');
        const documentB = createDocumentScope('b.pdf');
        configureEnabledAssistantRuntime();
        const processes: FakeCodexAppServerProcess[] = [];
        mocks.spawn.mockImplementation(() => {
            const process = new FakeCodexAppServerProcess();
            processes.push(process);
            return process;
        });

        const { sendAgentAssistantMessage }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        await expect(sendAgentAssistantMessage({
            text: 'Question for A',
            scope: documentA,
        })).resolves.toMatchObject({ ok: true });
        await expect(sendAgentAssistantMessage({
            text: 'Question for B',
            scope: documentB,
        })).resolves.toMatchObject({ ok: true });
        expect(processes).toHaveLength(1);

        processes[0]?.emit('close', 1);
        await settleAsyncTicks();

        await expect(sendAgentAssistantMessage({
            text: 'Follow-up for A',
            scope: documentA,
        })).resolves.toMatchObject({ ok: true });

        expect(processes).toHaveLength(2);
        const restartedMethods = processes[1]?.requestMethods ?? [];
        expect(restartedMethods).toContain('thread/resume');
        expect(restartedMethods.indexOf('thread/resume')).toBeLessThan(restartedMethods.indexOf('turn/start'));
    });

    it('evicts least-recently-used idle document chat sessions', async () => {
        vi.stubEnv('EVB_ASSISTANT_CHAT_SESSION_MAX_ENTRIES', '2');
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const documentA = createDocumentScope('a.pdf');
        const documentB = createDocumentScope('b.pdf');
        const documentC = createDocumentScope('c.pdf');
        enableAssistantRuntime();

        try {
            const codexAssistantModule: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');
            const {
                getAgentAssistantState,
                interruptAgentAssistant,
                sendAgentAssistantMessage,
            } = codexAssistantModule;

            await sendAgentAssistantMessage({
                text: 'Question for A',
                scope: documentA,
            });
            await interruptAgentAssistant({ scope: documentA });
            nowSpy.mockReturnValue(1_000_100);
            await sendAgentAssistantMessage({
                text: 'Question for B',
                scope: documentB,
            });
            await interruptAgentAssistant({ scope: documentB });
            nowSpy.mockReturnValue(1_000_200);
            await getAgentAssistantState({ scope: documentA });
            nowSpy.mockReturnValue(1_000_300);
            await sendAgentAssistantMessage({
                text: 'Question for C',
                scope: documentC,
            });

            nowSpy.mockReturnValue(1_000_400);
            const restoredDocumentA = await getAgentAssistantState({ scope: documentA });
            expect(restoredDocumentA.messages.map(message => message.text)).toContain('Question for A');

            nowSpy.mockReturnValue(1_000_500);
            const restoredDocumentB = await getAgentAssistantState({ scope: documentB });
            expect(restoredDocumentB.messages).toEqual([]);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('sanitizes assistant login URLs before opening them externally', async () => {
        enableAssistantRuntime();

        const { startAgentAssistantLogin }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const result = await startAgentAssistantLogin({mode: 'chatgpt'});

        expect(result.ok).toBe(true);
        expect(mocks.openExternal).toHaveBeenCalledWith('https://auth.example.test/start');
    });

    it('keeps streaming assistant deltas lean while boundary events carry state', async () => {
        enableAssistantRuntime();
        const send = vi.fn<(channel: string, event: IAgentAssistantEvent) => void>();
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([createAssistantWindow(send)]);
        const documentScope = createDocumentScope('stream.pdf');

        const { sendAgentAssistantMessage }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');
        const result = await sendAgentAssistantMessage({
            text: 'please stream',
            scope: documentScope,
        });

        expect(result.ok).toBe(true);
        let deltaEvents: IAgentAssistantEvent[] = [];
        await vi.waitFor(() => {
            const events = send.mock.calls.map((call) => call[1]);
            deltaEvents = events.filter(event => event.type === 'message-delta');
            expect(deltaEvents).toHaveLength(2);
        }, {timeout: 5_000});
        expect(deltaEvents.every(event => event.state === undefined)).toBe(true);
        const events = send.mock.calls.map((call) => call[1]);
        expect(events.find(event => event.type === 'turn-completed')?.state).toBeDefined();
    });

    it('publishes safe assistant turn progress for non-message item notifications', async () => {
        const process = enableAssistantRuntime();
        const send = vi.fn<(channel: string, event: IAgentAssistantEvent) => void>();
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([createAssistantWindow(send)]);
        const documentScope = createDocumentScope('progress.pdf');

        const { sendAgentAssistantMessage }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');
        await expect(sendAgentAssistantMessage({
            text: 'hold-active',
            scope: documentScope,
        })).resolves.toMatchObject({ok: true});

        process.notifyAppServer('item/created', {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
                type: 'toolCall',
                name: 'evb_read_action',
                arguments: {hidden: 'not forwarded'},
            },
        });

        let progressEvent: IAgentAssistantEvent | undefined;
        await vi.waitFor(() => {
            progressEvent = send.mock.calls
                .map((call) => call[1])
                .find(event => event.type === 'turn-progress' && event.progress !== undefined);
            expect(progressEvent).toMatchObject({
                type: 'turn-progress',
                progress: 'Tool evb_read_action running',
            });
        }, {timeout: 5_000});
        expect(progressEvent?.state).toBeUndefined();
    });
});
