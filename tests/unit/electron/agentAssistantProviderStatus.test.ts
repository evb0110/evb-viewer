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
            id: 'gpt-5.6-sol',
            label: 'GPT-5.6-Sol',
        }];

        expect(getProviderSpeedModes(models, 'codex', 'gpt-5.6-sol')).toEqual([
            'fast',
            'standard',
        ]);
        expect(resolveCodexServiceTier(models, 'gpt-5.6-sol', 'fast')).toBe('priority');
        expect(resolveCodexServiceTier(models, 'gpt-5.6-sol', 'standard')).toBeUndefined();
    });

    it('uses the fast service tier advertised by the Codex catalog', () => {
        const models = [
            {
                id: 'gpt-5.6-sol',
                label: 'GPT-5.6-Sol',
                serviceTiers: [{
                    id: 'priority',
                    label: 'Fast',
                }],
            },
            {
                id: 'gpt-5.4',
                label: 'GPT-5.4',
                serviceTiers: [{
                    id: 'fast',
                    label: 'Fast',
                }],
            },
        ];

        expect(resolveCodexServiceTier(models, 'gpt-5.6-sol', 'fast')).toBe('priority');
        expect(resolveCodexServiceTier(models, 'gpt-5.4', 'fast')).toBe('fast');
    });

    it('defaults Codex provider status to low reasoning and fast speed', () => {
        const status = buildCodexProviderStatus({
            platform: 'darwin',
            codexInfo: {
                installed: true,
                path: '/bin/codex',
                version: '1.0.0',
                isVersionSupported: true,
                minimumVersion: '0.133.0',
                managedInstallDir: '/tmp/evb-viewer/codex',
            },
            models: [{
                id: 'gpt-5.6-sol',
                label: 'GPT-5.6-Sol',
            }],
            model: 'gpt-5.6-sol',
            effort: 'low',
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
    });

    it('uses model-advertised Codex reasoning efforts instead of static provider values', () => {
        const models = [{
            id: 'gpt-5.6-sol',
            label: 'GPT-5.6-Sol',
            reasoningEfforts: [
                {
                    id: 'medium',
                    label: 'Medium',
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
            defaultReasoningEffort: 'medium',
        }];
        const status = buildCodexProviderStatus({
            platform: 'darwin',
            codexInfo: null,
            models,
            model: 'gpt-5.6-sol',
            effort: 'xhigh',
            speedMode: 'fast',
            authState: 'signed-in',
            runtimeState: 'ready',
            account: null,
        });

        expect(getProviderEfforts(models, 'codex', 'gpt-5.6-sol')).toEqual([
            'medium',
            'xhigh',
            'super-high',
        ]);
        expect(status.availableEfforts).toEqual([
            'medium',
            'xhigh',
            'super-high',
        ]);
        expect(status.defaultEffort).toBe('medium');
        expect(status.activeEffort).toBe('xhigh');
        expect(normalizeAssistantEffort(models, 'codex', 'gpt-5.6-sol', 'not-advertised')).toBe('medium');
    });

    it('advertises Claude speed tiers on every model in the shared capability catalog', () => {
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
                    label: 'Claude Opus',
                },
                {
                    id: 'sonnet',
                    label: 'Claude Sonnet',
                },
            ],
            model: 'opus',
            effort: 'low',
            speedMode: 'fast',
            authState: 'signed-in',
            runtimeState: 'ready',
            account: null,
        });

        expect(status.models.find(model => model.id === 'opus')?.serviceTiers?.map(tier => tier.id))
            .toEqual([
                'fast',
                'standard',
            ]);
        expect(status.models.find(model => model.id === 'sonnet')?.serviceTiers?.map(tier => tier.id))
            .toEqual(['standard']);
    });
});
