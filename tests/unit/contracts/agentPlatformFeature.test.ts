import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAgentAssistantState } from '@contracts/agent';
import { AGENT_PLATFORM_FEATURE } from '@contracts/agentPlatformFeature';
import { requireIsoTimestamp } from '@contracts/timestamps';
import { createPlatformFeaturePreloadClient } from '@electron/preload/ipcClient';
import type { IpcRenderer } from 'electron';
import * as v from 'valibot';

type TIpcRendererFixture = Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener' | 'send'>;

function createAssistantState(): IAgentAssistantState {
    const provider = {
        id: 'codex',
        label: 'Codex',
        installState: 'installed',
        authState: 'signed-in',
        runtimeState: 'ready',
        models: [{
            id: 'gpt-5',
            label: 'GPT-5',
            reasoningEfforts: [{
                id: 'high',
                label: 'High',
                isDefault: true,
            }],
            defaultReasoningEffort: 'high',
            serviceTiers: [{
                id: 'fast',
                label: 'Fast',
            }],
            defaultServiceTier: 'fast',
        }],
        defaultModel: 'gpt-5',
        activeModel: 'gpt-5',
        modelSwitchMode: 'in-session',
        availableEfforts: ['high'],
        defaultEffort: 'high',
        activeEffort: 'high',
        availableSpeedModes: [
            'fast',
            'standard',
        ],
        defaultSpeedMode: 'fast',
        activeSpeedMode: 'fast',
        path: '/usr/local/bin/codex',
        version: '1.0.0',
        minimumVersion: '0.133.0',
        versionSupported: true,
        installUrl: 'https://example.test/install',
        account: {
            type: 'chatgpt',
            email: 'reader@example.test',
        },
    } as const;
    return {
        scope: null,
        status: {
            supported: true,
            platform: 'darwin',
            provider: 'codex',
            providerLabel: 'Codex',
            providers: [provider],
            model: 'gpt-5',
            modelLabel: 'GPT-5',
            models: provider.models,
            modelSwitchMode: 'in-session',
            effort: 'high',
            availableEfforts: ['high'],
            speedMode: 'fast',
            availableSpeedModes: [
                'fast',
                'standard',
            ],
            installState: 'installed',
            codexInstalled: true,
            codexPath: '/usr/local/bin/codex',
            codexVersion: '1.0.0',
            minimumCodexVersion: '0.133.0',
            codexVersionSupported: true,
            installUrl: 'https://example.test/install',
            installScriptUrl: 'https://example.test/install.sh',
            managedInstallDir: '/tmp/codex',
            authState: 'signed-in',
            account: provider.account,
            runtimeState: 'ready',
            mcp: {
                serverName: 'evb-viewer',
                serverUrl: 'http://127.0.0.1:3000',
                serverRunning: true,
                toolCount: 4,
            },
            turn: {
                id: null,
                phase: 'idle',
                reasoning: '',
                toolActivity: [],
                lastEventAtMs: null,
                usage: null,
            },
            lastCheckedAt: requireIsoTimestamp('2026-07-10T00:00:00.000Z'),
        },
        messages: [{
            id: 'message-1',
            role: 'assistant',
            text: 'Ready',
            createdAt: requireIsoTimestamp('2026-07-10T00:00:00.000Z'),
        }],
    };
}

const channels = AGENT_PLATFORM_FEATURE.invokeChannels;
const eventChannels = AGENT_PLATFORM_FEATURE.eventChannels;
const assistantStateResult = AGENT_PLATFORM_FEATURE.methods.getAssistantState.ipc.result;
const assistantInstallResult = AGENT_PLATFORM_FEATURE.methods.installAssistantCodex.ipc.result;
const assistantLoginResult = AGENT_PLATFORM_FEATURE.methods.startAssistantLogin.ipc.result;
const assistantMessageResult = AGENT_PLATFORM_FEATURE.methods.sendAssistantMessage.ipc.result;
const assistantEvent = AGENT_PLATFORM_FEATURE.events.onAssistantEvent.payload;

describe('Agent platform feature', () => {
    it('preserves invoke channels, four event channels, and descriptor metadata', () => {
        expect(channels).toEqual({
            getMcpIntegrationStatus: 'agent:getMcpIntegrationStatus',
            setMcpIntegrationEnabled: 'agent:setMcpIntegrationEnabled',
            getAssistantState: 'agent:getAssistantState',
            installAssistantCodex: 'agent:installAssistantCodex',
            startAssistantLogin: 'agent:startAssistantLogin',
            cancelAssistantLogin: 'agent:cancelAssistantLogin',
            sendAssistantMessage: 'agent:sendAssistantMessage',
            interruptAssistant: 'agent:interruptAssistant',
            resetAssistantChat: 'agent:resetAssistantChat',
            submitWorkspaceSnapshot: 'agent:submitWorkspaceSnapshot',
            submitCommandResponse: 'agent:submitCommandResponse',
        });
        expect(eventChannels).toEqual({
            onAssistantEvent: 'agent:assistantEvent',
            onWorkspaceSnapshotRequest: 'agent:workspaceSnapshotRequest',
            onCommandCancelRequest: 'agent:commandCancelRequest',
            onCommandRequest: 'agent:commandRequest',
        });
        expect(AGENT_PLATFORM_FEATURE.platformDescriptors.capabilities).toEqual([{
            path: ['agent'],
            required: {
                browser: true,
                electron: true,
            },
            manifestPath: ['agent'],
        }]);
        expect(AGENT_PLATFORM_FEATURE.platformDescriptors.methods).toHaveLength(15);
    });

    it('exhaustively reconstructs assistant state and nested provider data', () => {
        const state = createAssistantState();
        const payload = {
            ...state,
            ignored: true,
            status: {
                ...state.status,
                ignored: true,
                providers: state.status.providers.map(provider => ({
                    ...provider,
                    ignored: true,
                })),
            },
        };

        expect(v.parse(assistantStateResult, payload)).toEqual(state);
    });

    it('rejects malformed provider entries at the main result boundary and forwards trusted preload results', async () => {
        const state = createAssistantState();
        const malformedState = {
            ...state,
            status: {
                ...state.status,
                providers: [null],
            },
        };

        expect(() => v.parse(assistantStateResult, malformedState)).toThrow('invalid assistant state');
        expect(() => v.parse(assistantEvent, {
            type: 'state',
            state: malformedState,
        })).toThrow('invalid agent assistant event');
        expect(() => v.parse(assistantInstallResult, {
            ok: true,
            state: malformedState,
        })).toThrow('invalid assistant install');
        expect(() => v.parse(assistantLoginResult, {
            ok: true,
            state: malformedState,
        })).toThrow('invalid assistant login');
        expect(() => v.parse(assistantMessageResult, {
            ok: true,
            state: malformedState,
        })).toThrow('invalid assistant message');

        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                expect(channel).toBe(channels.getAssistantState);
                return malformedState;
            }),
            on: vi.fn(),
            removeListener: vi.fn(),
            send: vi.fn(),
        } satisfies TIpcRendererFixture;
        const client = createPlatformFeaturePreloadClient(
            ipcRenderer,
            AGENT_PLATFORM_FEATURE,
        );

        await expect(client.getAssistantState()).resolves.toBe(malformedState);
    });

    it('reconstructs assistant operation result variants', () => {
        const state = createAssistantState();

        expect(v.parse(assistantInstallResult, {
            ok: true,
            state,
            ignored: true,
        })).toEqual({
            ok: true,
            state,
        });
        expect(v.parse(assistantLoginResult, {
            ok: true,
            state,
            loginId: 'login-1',
            authUrl: 'https://example.test/auth',
            ignored: true,
        })).toEqual({
            ok: true,
            state,
            loginId: 'login-1',
            authUrl: 'https://example.test/auth',
        });
        expect(v.parse(assistantMessageResult, {
            ok: false,
            state,
            error: 'Unavailable',
            ignored: true,
        })).toEqual({
            ok: false,
            state,
            error: 'Unavailable',
        });
    });

    it('decodes reasoning, heartbeat, and typed tool activity without accepting malformed phases', () => {
        const binding = {
            scopeFingerprint: 'scope',
            sessionKey: 'codex:scope',
            turnGeneration: 2,
            windowId: 1,
        };
        expect(v.parse(assistantEvent, {
            type: 'reasoning-delta',
            reasoningDelta: 'Inspecting the page',
            phase: 'thinking',
            lastEventAtMs: 42,
            binding,
        })).toEqual({
            type: 'reasoning-delta',
            reasoningDelta: 'Inspecting the page',
            phase: 'thinking',
            lastEventAtMs: 42,
            binding,
        });
        expect(v.parse(assistantEvent, {
            type: 'turn-progress',
            phase: 'tool-running',
            toolActivity: {
                toolId: 'tool-1',
                name: 'document.search',
                phase: 'running',
                startedAtMs: 42,
            },
            binding,
        })).toMatchObject({type: 'turn-progress'});
        expect(() => v.parse(assistantEvent, {
            type: 'heartbeat',
            phase: 'hung',
            binding,
        })).toThrow('invalid agent assistant event');
        expect(() => v.parse(assistantEvent, {
            type: 'message-delta',
            delta: 'late',
        })).toThrow('invalid agent assistant event');
    });
});
