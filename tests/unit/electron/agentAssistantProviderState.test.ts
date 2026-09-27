import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    getAssistantProviderLabel,
    normalizeAssistantProviderId,
} from '@electron/features/agent/assistantProviderRegistry';
import {
    buildAssistantProviderStatuses,
    createAssistantProviderRuntimeStates,
    getAssistantProviderRuntimeState,
    reconcileTerminalAssistantProviderRuntimeState,
    updateAssistantProviderRuntimeState,
} from '@electron/features/agent/assistantProviderState';

vi.mock('electron', () => ({ app: {
    getPath: () => '/tmp/evb-viewer',
    getVersion: () => 'test',
} }));

vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}) }));

describe('agent assistant provider state', () => {
    it('keeps provider ids and labels centralized with Codex-biased normalization', () => {
        expect(normalizeAssistantProviderId('claude')).toBe('claude');
        expect(normalizeAssistantProviderId('codex')).toBe('codex');
        expect(normalizeAssistantProviderId('unknown')).toBe('codex');
        expect(normalizeAssistantProviderId(null)).toBe('codex');
        expect(getAssistantProviderLabel('codex')).toBe('Codex');
        expect(getAssistantProviderLabel('claude')).toBe('Claude');
    });

    it('creates independent mutable runtime records per provider', () => {
        const states = createAssistantProviderRuntimeStates({codex: {
            authState: 'signed-in',
            runtimeState: 'ready',
            lastError: 'Codex warning.',
        }});

        updateAssistantProviderRuntimeState(states, 'codex', {runtimeState: 'busy'});
        updateAssistantProviderRuntimeState(states, 'claude', {
            authState: 'signed-out',
            runtimeState: 'stopped',
            lastError: 'Claude needs login.',
        });

        expect(getAssistantProviderRuntimeState(states, 'codex')).toMatchObject({
            authState: 'signed-in',
            runtimeState: 'busy',
            lastError: 'Codex warning.',
        });
        expect(getAssistantProviderRuntimeState(states, 'claude')).toMatchObject({
            authState: 'signed-out',
            runtimeState: 'stopped',
            lastError: 'Claude needs login.',
        });
    });

    it('repairs an orphaned busy runtime after all provider work is terminal', () => {
        const states = createAssistantProviderRuntimeStates({codex: {
            authState: 'signed-in',
            runtimeState: 'busy',
        }});
        const runtime = getAssistantProviderRuntimeState(states, 'codex');

        expect(reconcileTerminalAssistantProviderRuntimeState(runtime, {
            hasRuntime: true,
            hasActiveWork: false,
        })).toBe(true);
        expect(runtime.runtimeState).toBe('ready');

        runtime.runtimeState = 'busy';
        expect(reconcileTerminalAssistantProviderRuntimeState(runtime, {
            hasRuntime: true,
            hasActiveWork: true,
        })).toBe(false);
        expect(runtime.runtimeState).toBe('busy');
    });

    it.each([
        {
            name: 'the provider runtime is unavailable',
            authState: 'signed-in' as const,
            hasRuntime: false,
        },
        {
            name: 'the provider is signed out',
            authState: 'signed-out' as const,
            hasRuntime: true,
        },
    ])('stops orphaned busy state when $name', ({
        authState,
        hasRuntime,
    }) => {
        const states = createAssistantProviderRuntimeStates({codex: {
            authState,
            runtimeState: 'busy',
        }});
        const runtime = getAssistantProviderRuntimeState(states, 'codex');

        expect(reconcileTerminalAssistantProviderRuntimeState(runtime, {
            hasRuntime,
            hasActiveWork: false,
        })).toBe(true);
        expect(runtime.runtimeState).toBe('stopped');
    });

    it('builds provider statuses from shared runtime state records', () => {
        const states = createAssistantProviderRuntimeStates({
            codex: {
                authState: 'signed-in',
                runtimeState: 'ready',
                account: {
                    type: 'chatgpt',
                    email: 'reader@example.com',
                },
                lastError: 'Codex warning.',
            },
            claude: {
                authState: 'signed-out',
                runtimeState: 'error',
                lastError: 'Claude needs login.',
            },
        });

        const statuses = buildAssistantProviderStatuses({
            platform: 'darwin',
            states,
            codexInfo: {
                installed: true,
                path: '/bin/codex',
                version: '1.0.0',
                isVersionSupported: true,
                minimumVersion: '0.133.0',
                managedInstallDir: '/tmp/evb-viewer/codex',
            },
            claudeInfo: {
                installed: true,
                version: '0.3.183',
                executablePath: '/bin/claude',
            },
            codexModels: [{
                id: 'gpt-6-astra',
                label: 'GPT-6-Astra',
            }],
            claudeModels: [{
                id: 'opus',
                label: 'Claude Opus',
            }],
            model: 'opus',
            effort: 'max',
            speedMode: 'fast',
        });

        expect(statuses).toHaveLength(2);
        expect(statuses.find(provider => provider.id === 'codex')).toMatchObject({
            label: 'Codex',
            authState: 'signed-in',
            runtimeState: 'ready',
            account: {
                type: 'chatgpt',
                email: 'reader@example.com',
            },
            activeModel: 'gpt-6-astra',
            activeEffort: 'medium',
            error: 'Codex warning.',
        });
        expect(statuses.find(provider => provider.id === 'claude')).toMatchObject({
            label: 'Claude',
            authState: 'signed-out',
            runtimeState: 'error',
            activeModel: 'opus',
            activeEffort: 'max',
            activeSpeedMode: 'fast',
            error: 'Claude needs login.',
        });
    });
});
