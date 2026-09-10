import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAgentAssistantEvent } from '@contracts/agent';
import { FakeAssistantAppServerProcess } from '@tests/unit/electron/helpers/fakeAssistantAppServerProcess';
import { requireTabId } from '@contracts/windowTabs';
import { createAssistantChatSessionStore } from '@electron/features/agent/assistantChatSessionStore';
import { createAssistantSessionTurnCoordinator } from '@electron/features/agent/createAssistantSessionTurnCoordinator';
import { createAssistantAppServerNotificationController } from '@electron/features/agent/createAssistantAppServerNotificationController';
import { createAssistantProviderRuntimeStates } from '@electron/features/agent/assistantProviderState';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    terminate: vi.fn(),
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('child_process', () => ({
    execFile: vi.fn(),
    spawn: mocks.spawn,
}));
vi.mock('electron', () => ({app: {getVersion: () => '0.0.0-test'}}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));
vi.mock('@electron/utils/nativeChildProcess', () => ({
    createDetachedChildProcessSpawnOptions: (options: Record<string, unknown>) => options,
    terminateDetachedChildProcess: (...args: unknown[]) => mocks.terminate(...args),
}));

const scope = {
    kind: 'document',
    key: 'document-a',
    title: 'Document A',
    tabId: requireTabId('tab-a'),
} as const;
const selection = {
    provider: 'codex',
    model: 'gpt-5.4',
    effort: 'medium',
    speedMode: 'standard',
} as const;

describe('assistant app-server pipeline', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        mocks.terminate.mockImplementation(async (process: FakeAssistantAppServerProcess) => {
            process.emit('close', 0);
            return true;
        });
    });

    afterEach(async () => {
        const { resetMainOperationLifecycleForTests } = await import('@electron/operation-lifecycle/mainOperationLifecycle');
        resetMainOperationLifecycleForTests();
    });

    it('drives split app-server frames through the real controller, coordinator, and store', async () => {
        const process = new FakeAssistantAppServerProcess((_line, callback) => {
            callback?.();
            return true;
        });
        mocks.spawn.mockReturnValue(process);
        const events: IAgentAssistantEvent[] = [];
        const store = createAssistantChatSessionStore({
            persistence: false,
            onSessionMessageEvent: event => events.push(event),
        });
        const coordinator = createAssistantSessionTurnCoordinator({sessionStore: store});
        const session = store.getSession(scope, selection, {create: true});
        session.providerThreadId = 'thread-1';
        session.lastSenderWindowId = 17;
        store.setActiveSession(session);
        coordinator.claimSessionTurn(session);
        const runtimes = createAssistantProviderRuntimeStates({codex: {
            authState: 'signed-in',
            runtimeState: 'busy',
        }});
        const clearLoginState = vi.fn();
        const controller = createAssistantAppServerNotificationController({
            addMessage: store.addMessage,
            appendAssistantDelta: store.appendAssistantDelta,
            clearLoginState,
            clearRuntimeForExit: vi.fn(),
            codexProviderRuntime: runtimes.codex,
            completeSessionTurn: coordinator.completeSessionTurn,
            currentCodexSelection: () => selection,
            getPendingLoginId: () => 'login-2',
            errorSessionTurn: coordinator.errorSessionTurn,
            getActiveChatSession: () => store.getActiveSession('codex'),
            getAuthReturnWindow: () => null,
            getChatSessionByThreadId: store.getSessionByThreadId,
            getRememberedScope: () => scope,
            logger: mocks.logger,
            markSessionTurnRunning: coordinator.markSessionTurnRunning,
            noFocus: true,
            publishAssistantEvent: event => events.push(event),
            publishState: vi.fn(),
            reconcileFailedTurnMessages: vi.fn(),
            refreshAuthStateAndRuntimeAvailability: vi.fn(async () => undefined),
            sessionStore: store,
            supersedeSessionTurn: coordinator.supersedeSessionTurn,
            upsertAssistantMessage: store.upsertAssistantMessage,
        });
        const { CodexAppServerClient } = await import('@electron/features/agent/codexAppServerClient');
        const client = new CodexAppServerClient(
            '/usr/bin/codex',
            {},
            '/tmp',
            controller.handleNotification,
            controller.handleExit,
        );

        process.emitJson({
            jsonrpc: '2.0',
            method: 'account/login/completed',
            params: {
                loginId: 'login-1',
                success: true,
            },
        });
        expect(clearLoginState).not.toHaveBeenCalled();
        expect(runtimes.codex.authState).toBe('signed-in');

        process.emitJson({
            jsonrpc: '2.0',
            method: 'account/login/completed',
            params: {
                loginId: 'login-2',
                success: true,
            },
        });
        expect(clearLoginState).toHaveBeenCalledOnce();

        process.stdout.write('{malformed frame}\n');
        process.emitJson({
            jsonrpc: '2.0',
            method: 'turn/started',
            params: {
                threadId: 'thread-1',
                turn: {id: 'turn-1'},
            },
        });
        process.emitJson({
            jsonrpc: '2.0',
            method: 'item/reasoning/summaryTextDelta',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                delta: 'Inspect pages.',
            },
        }, 37);
        process.emitJson({
            jsonrpc: '2.0',
            method: 'item/created',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: {
                    id: 'tool-1',
                    type: 'mcpToolCall',
                    name: 'document.search',
                },
            },
        });
        process.emitJson({
            jsonrpc: '2.0',
            method: 'item/completed',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: {
                    id: 'tool-1',
                    type: 'mcpToolCall',
                    name: 'document.search',
                },
            },
        });
        process.emitJson({
            jsonrpc: '2.0',
            method: 'item/agentMessage/delta',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                itemId: 'assistant-1',
                delta: 'Answer',
            },
        });
        // Completion is deliberately delivered without waiting for a turn/start RPC response.
        process.emitJson({
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: {
                threadId: 'thread-1',
                turn: {
                    id: 'turn-1',
                    usage: {
                        inputTokens: 21,
                        outputTokens: 9,
                        cachedInputTokens: 4,
                    },
                },
            },
        });

        expect(session.turnPresentation).toMatchObject({
            phase: 'done',
            reasoning: 'Inspect pages.',
            usage: {
                inputTokens: 21,
                outputTokens: 9,
                cachedInputTokens: 4,
            },
            toolActivity: [{
                toolId: 'tool-1',
                name: 'document.search',
                phase: 'completed',
            }],
        });
        expect(session.messages).toEqual([expect.objectContaining({
            id: 'assistant-1',
            text: 'Answer',
            pending: false,
        })]);
        expect(events.map(event => event.type)).toEqual(expect.arrayContaining([
            'turn-started',
            'reasoning-delta',
            'turn-progress',
            'message-delta',
            'turn-completed',
        ]));
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('non-JSON'));

        coordinator.claimSessionTurn(session);
        store.addMessage(session, {
            role: 'assistant',
            text: 'partial response',
            pending: true,
        });
        const clearRuntimeForExit = vi.fn();
        const exitController = createAssistantAppServerNotificationController({
            addMessage: store.addMessage,
            appendAssistantDelta: store.appendAssistantDelta,
            clearLoginState,
            clearRuntimeForExit,
            codexProviderRuntime: runtimes.codex,
            completeSessionTurn: coordinator.completeSessionTurn,
            currentCodexSelection: () => selection,
            getPendingLoginId: () => 'login-2',
            errorSessionTurn: coordinator.errorSessionTurn,
            getActiveChatSession: () => store.getActiveSession('codex'),
            getAuthReturnWindow: () => null,
            getChatSessionByThreadId: store.getSessionByThreadId,
            getRememberedScope: () => scope,
            logger: mocks.logger,
            markSessionTurnRunning: coordinator.markSessionTurnRunning,
            noFocus: true,
            publishAssistantEvent: event => events.push(event),
            publishState: vi.fn(),
            reconcileFailedTurnMessages: (target, error) => {
                for (const message of target.messages) {
                    if (message.role === 'assistant' && message.pending) {
                        message.pending = false;
                    }
                }
                target.lastError = error;
            },
            refreshAuthStateAndRuntimeAvailability: vi.fn(async () => undefined),
            sessionStore: store,
            supersedeSessionTurn: coordinator.supersedeSessionTurn,
            upsertAssistantMessage: store.upsertAssistantMessage,
        });

        exitController.handleExit('Codex app-server exited.');

        expect(clearRuntimeForExit).toHaveBeenCalledOnce();
        expect(session.turnOwner.phase).toBe('error');
        expect(session.providerThreadId).toBe('thread-1');
        expect(session.messages.at(-1)).toMatchObject({
            text: 'partial response',
            pending: false,
        });

        await client.shutdown();
    });
});
