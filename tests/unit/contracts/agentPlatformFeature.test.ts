import {
    describe, expect, it, vi,
} from 'vitest';
import * as v from 'valibot';
import {AGENT_PLATFORM_FEATURE} from '@contracts/agentPlatformFeature';
import {
    ASSISTANT_INSTANCES_SCHEMA, type IAssistantState, type IAssistantItem,
} from '@contracts/assistant';
import {requireIsoTimestamp} from '@contracts/timestamps';
import {createPlatformFeaturePreloadClient} from '@electron/preload/ipcClient';
import type {IpcRenderer} from 'electron';

const selection = {
    instanceId: 'codex_proxy',
    model: 'gpt-5.4',
    effort: 'high',
    speedMode: 'standard',
} as const;
const scope = {
    kind: 'document',
    key: 'document:a',
    title: 'a.pdf',
} as const;
const item: IAssistantItem = {
    id: 'tool-1',
    kind: 'tool',
    turnId: 'turn-1',
    text: '',
    status: 'completed',
    createdAt: requireIsoTimestamp('2026-11-12T00:00:00.000Z'),
    toolName: 'evb_read_resource',
    toolDetail: 'Read page 1',
};
function createAssistantState(): IAssistantState {
    return {
        supported: true,
        enabled: true,
        selection,
        installProgress: null,
        instances: [{
            id: 'codex_proxy',
            driver: 'codex',
            label: 'Codex · Proxy',
            enabled: true,
            state: 'ready',
            auth: 'authenticated',
            binaryPath: '/bin/codex',
            version: '1.0',
            homePath: '/homes/proxy',
            customEndpoint: true,
            account: {type: 'apiKey'},
            models: [{
                id: 'gpt-5.4',
                label: 'GPT 5.4',
            }],
            defaultModel: 'gpt-5.4',
            checkedAt: requireIsoTimestamp('2026-11-12T00:00:00.000Z'),
            canInstall: false,
            canSignIn: true,
            loginPending: false,
        }],
        chat: {
            sessionKey: 'codex_proxy:document:a',
            scope,
            instanceId: 'codex_proxy',
            model: 'gpt-5.4',
            items: [item],
            turn: null,
        },
    };
}
const {
    methods, events, invokeChannels: channels,
} = AGENT_PLATFORM_FEATURE;

describe('Agent platform feature with assistant instances', () => {
    it('exposes the complete caller method and event set', () => {
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
            getAssistantInstances: 'agent:getAssistantInstances',
            saveAssistantInstances: 'agent:saveAssistantInstances',
            importAssistantInstancesFromT3: 'agent:importAssistantInstancesFromT3',
            submitWorkspaceSnapshot: 'agent:submitWorkspaceSnapshot',
            submitCommandResponse: 'agent:submitCommandResponse',
        });
        expect(AGENT_PLATFORM_FEATURE.eventChannels).toEqual({
            onMcpIntegrationChanged: 'agent:mcpIntegrationChanged',
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
        expect(AGENT_PLATFORM_FEATURE.platformDescriptors.methods).toHaveLength(19);
    });
    it('reconstructs state and nested instances and items at the main IPC boundary', () => {
        const state = createAssistantState();
        expect(v.parse(methods.getAssistantState.ipc.result, {
            ...state,
            ignored: true,
            instances: state.instances.map(instance => ({
                ...instance,
                ignored: true,
            })),
            chat: {
                ...state.chat,
                items: [{
                    ...item,
                    ignored: true,
                }],
            },
        })).toEqual(state);
        expect(() => v.parse(methods.getAssistantState.ipc.result, {
            ...state,
            instances: [null],
        })).toThrow('invalid assistant state');
    });
    it('decodes required instance selection and chat/login request payloads', () => {
        expect(v.parse(methods.sendAssistantMessage.ipc.args, [{
            text: 'Inspect',
            scope,
            selection,
        }])).toEqual([{
            text: 'Inspect',
            scope,
            selection,
        }]);
        expect(() => v.parse(methods.sendAssistantMessage.ipc.args, [{
            text: 'Inspect',
            scope,
        }])).toThrow();
        expect(v.parse(methods.interruptAssistant.ipc.args, [{
            scope,
            instanceId: 'codex_proxy',
        }])).toEqual([{
            scope,
            instanceId: 'codex_proxy',
        }]);
        expect(v.parse(methods.startAssistantLogin.ipc.args, [{
            instanceId: 'codex_proxy',
            mode: 'device-code',
        }])).toEqual([{
            instanceId: 'codex_proxy',
            mode: 'device-code',
        }]);
        expect(() => v.parse(methods.cancelAssistantLogin.ipc.args, [])).toThrow();
    });
    it('reconstructs operation, login and instance-save results', () => {
        const state = createAssistantState();
        const error = {
            code: 'RUNTIME_UNAVAILABLE',
            message: 'Unavailable',
            retryable: false,
            details: {timestamp: 0},
        };
        expect(v.parse(methods.sendAssistantMessage.ipc.result, {
            ok: false,
            state,
            error,
            ignored: true,
        })).toEqual({
            ok: false,
            state,
            error,
        });
        expect(v.parse(methods.installAssistantCodex.ipc.result, {
            ok: true,
            state,
            ignored: true,
        })).toEqual({
            ok: true,
            state,
        });
        expect(v.parse(methods.startAssistantLogin.ipc.result, {
            ok: true,
            state,
            authUrl: 'https://auth.example.test',
            userCode: 'ABCD',
            ignored: true,
        })).toEqual({
            ok: true,
            state,
            authUrl: 'https://auth.example.test',
            userCode: 'ABCD',
        });
        expect(v.parse(methods.saveAssistantInstances.ipc.result, {
            ok: true,
            instances: [],
            notices: [],
            ignored: true,
        })).toEqual({
            ok: true,
            instances: [],
            notices: [],
        });
    });
    it('accepts the ordered timeline event variants and rejects old or malformed payloads', () => {
        const state = createAssistantState();
        const payloads = [
            {
                type: 'instances',
                instances: state.instances,
            },
            {
                type: 'chat',
                chat: state.chat,
            },
            {
                type: 'item',
                sessionKey: 'codex_proxy:document:a',
                item,
            },
            {
                type: 'item-delta',
                sessionKey: 'codex_proxy:document:a',
                itemId: 'reasoning-1',
                delta: 'Inspecting',
            },
            {
                type: 'turn',
                sessionKey: 'codex_proxy:document:a',
                turn: {
                    id: 'turn-1',
                    phase: 'thinking',
                    startedAtMs: 42,
                    usage: null,
                },
            },
            {
                type: 'install-progress',
                progress: null,
            },
        ];
        for (const payload of payloads) expect(v.parse(events.onAssistantEvent.payload, payload)).toEqual(payload);
        expect(() => v.parse(events.onAssistantEvent.payload, {type: 'heartbeat'})).toThrow('invalid assistant event');
        expect(() => v.parse(events.onAssistantEvent.payload, {
            type: 'item-delta',
            delta: 'late',
        })).toThrow();
        expect(() => v.parse(events.onAssistantEvent.payload, {
            type: 'item',
            sessionKey: 'scope',
            item: {
                ...item,
                status: 'hung',
            },
        })).toThrow();
    });
    it('validates instance identity and preserves redaction metadata', () => {
        const config = {
            id: 'codex_proxy',
            driver: 'codex',
            displayName: 'Proxy',
            enabled: true,
            launchArgs: '',
            launchArgsSecret: true,
            launchArgsConfigured: true,
            environment: [{
                name: 'API_KEY',
                value: '',
                secret: true,
                configured: true,
            }],
        };
        expect(v.parse(ASSISTANT_INSTANCES_SCHEMA, [config])).toEqual([config]);
        expect(() => v.parse(ASSISTANT_INSTANCES_SCHEMA, [
            config,
            config,
        ])).toThrow('unique');
        expect(() => v.parse(ASSISTANT_INSTANCES_SCHEMA, [{
            ...config,
            id: '../escape',
        }])).toThrow();
        expect(() => v.parse(ASSISTANT_INSTANCES_SCHEMA, [{
            ...config,
            environment: [{
                name: 'INVALID NAME',
                value: '',
                secret: false,
            }],
        }])).toThrow();
    });
    it('forwards trusted main results through preload unchanged', async () => {
        const state = createAssistantState();
        const ipcRenderer = {
            invoke: vi.fn(async () => state),
            on: vi.fn(),
            removeListener: vi.fn(),
            send: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener' | 'send'>;
        const client = createPlatformFeaturePreloadClient(ipcRenderer, AGENT_PLATFORM_FEATURE);
        await expect(client.getAssistantState({selection})).resolves.toBe(state);
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(channels.getAssistantState, {selection});
    });
});
