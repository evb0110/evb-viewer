import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    buildCodexProviderStatus,
    buildClaudeProviderStatus,
    getProviderEfforts,
    getProviderSpeedModes,
    normalizeAssistantEffort,
    resolveCodexServiceTier,
} from '@electron/features/agent/assistantProviderStatus';

vi.mock('electron', () => ({ app: {
    getPath: () => '/tmp/evb-viewer',
    getVersion: () => 'test',
} }));

vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}) }));

describe('agent assistant provider status', () => {
    it('keeps Codex fast and slow modes visible when runtime model metadata omits service tiers', () => {
        const models = [{
            id: 'gpt-6-astra',
            label: 'GPT-6-Astra',
        }];

        expect(getProviderSpeedModes(models, 'codex', 'gpt-6-astra')).toEqual([
            'fast',
            'standard',
        ]);
        expect(resolveCodexServiceTier(models, 'gpt-6-astra', 'fast')).toBe('priority');
        expect(resolveCodexServiceTier(models, 'gpt-6-astra', 'standard')).toBeUndefined();
    });

    it('uses the fast service tier advertised by the Codex catalog', () => {
        const models = [
            {
                id: 'gpt-6-astra',
                label: 'GPT-6-Astra',
                serviceTiers: [{
                    id: 'priority',
                    label: 'Fast',
                }],
            },
            {
                id: 'gpt-6-sol',
                label: 'GPT-6-Sol',
                serviceTiers: [{
                    id: 'fast',
                    label: 'Fast',
                }],
            },
        ];

        expect(resolveCodexServiceTier(models, 'gpt-6-astra', 'fast')).toBe('priority');
        expect(resolveCodexServiceTier(models, 'gpt-6-sol', 'fast')).toBe('fast');
    });

    it('defaults Codex provider status to medium reasoning and fast speed', () => {
        const status = buildCodexProviderStatus({
            platform: 'darwin',
            codexInfo: {
                installed: true,
                path: '/bin/codex',
                version: '1.0.0',
                isVersionSupported: true,
                minimumVersion: '0.157.1',
                managedInstallDir: '/tmp/evb-viewer/codex',
            },
            models: [{
                id: 'gpt-6-astra',
                label: 'GPT-6-Astra',
                defaultReasoningEffort: 'medium',
            }],
            model: 'gpt-6-astra',
            effort: 'medium',
            speedMode: 'fast',
            authState: 'signed-in',
            runtimeState: 'ready',
            account: null,
        });

        expect(status.availableSpeedModes).toEqual([
            'fast',
            'standard',
        ]);
        expect(status.defaultSpeedMode).toBe('fast');
        expect(status.activeSpeedMode).toBe('fast');
        expect(status.defaultEffort).toBe('medium');
    });

    it('uses the backend Codex reasoning default when it differs from the app default', () => {
        const models = [{
            id: 'gpt-6-astra',
            label: 'GPT-6-Astra',
            reasoningEfforts: [
                {
                    id: 'medium',
                    label: 'Medium',
                },
                {
                    id: 'high',
                    label: 'High',
                    isDefault: true,
                },
                {
                    id: 'xhigh',
                    label: 'Extra High',
                },
                {
                    id: 'super-high',
                    label: 'Super High',
                },
            ],
            defaultReasoningEffort: 'high',
        }];
        const status = buildCodexProviderStatus({
            platform: 'darwin',
            codexInfo: null,
            models,
            model: 'gpt-6-astra',
            effort: 'xhigh',
            speedMode: 'fast',
            authState: 'signed-in',
            runtimeState: 'ready',
            account: null,
        });

        expect(getProviderEfforts(models, 'codex', 'gpt-6-astra'))
            .toEqual([
                'medium',
                'high',
                'xhigh',
                'super-high',
            ]);
        expect(status.availableEfforts).toEqual([
            'medium',
            'high',
            'xhigh',
            'super-high',
        ]);
        expect(status.defaultEffort).toBe('high');
        expect(status.activeEffort).toBe('xhigh');
        expect(normalizeAssistantEffort(models, 'codex', 'gpt-6-astra', 'not-advertised')).toBe('high');
    });

    it('defaults Claude to the current Opus row and uses its advertised reasoning levels', () => {
        const status = buildClaudeProviderStatus({
            platform: 'darwin',
            claudeInfo: {
                installed: true,
                version: '1.0.0',
                executablePath: '/bin/claude',
            },
            models: [
                {
                    id: 'opus',
                    resolvedModel: 'claude-opus-5-5',
                    label: 'Claude Opus 5.5',
                    reasoningEfforts: [
                        {
                            id: 'medium',
                            label: 'Medium',
                        },
                        {
                            id: 'high',
                            label: 'High',
                        },
                    ],
                },
                {
                    id: 'fable',
                    label: 'Claude Fable 5.1',
                },
            ],
            model: 'removed-opus-selection',
            effort: 'low',
            speedMode: 'fast',
            authState: 'signed-in',
            runtimeState: 'ready',
            account: null,
        });

        expect(status.defaultModel).toBe('opus');
        expect(status.activeModel).toBe('opus');
        expect(status.models.map(model => model.id)).toEqual([
            'opus',
            'fable',
        ]);
        expect(status.models.find(model => model.id === 'opus')?.serviceTiers?.map(tier => tier.id))
            .toEqual([
                'fast',
                'standard',
            ]);
        expect(status.models.find(model => model.id === 'fable')?.serviceTiers?.map(tier => tier.id))
            .toEqual(['standard']);
        expect(status.availableEfforts).toEqual([
            'medium',
            'high',
        ]);
        expect(status.defaultEffort).toBe('medium');
        expect(status.activeEffort).toBe('medium');
    });
});
