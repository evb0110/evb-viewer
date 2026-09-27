import { readFileSync } from 'node:fs';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    normalizeCodexAssistantModelFromCatalog,
    normalizeCodexModelListResponse,
    resolveCodexModelStatus,
} from '@electron/features/agent/assistantModelCatalog';

describe('agent assistant model catalog', () => {
    it('reads a real Codex 0.157.1 app-server model/list response', () => {
        const response = JSON.parse(readFileSync(
            'tests/fixtures/electron/codex-app-server-model-list-0.157.1.json',
            'utf8',
        )) as unknown;
        const models = normalizeCodexModelListResponse(response) ?? [];
        expect(models.map(model => [
            model.id,
            model.label,
            model.defaultReasoningEffort,
        ])).toEqual([
            [
                'gpt-6-astra',
                'GPT-6-Astra',
                'medium',
            ],
            [
                'gpt-6-sol',
                'GPT-6-Sol',
                'medium',
            ],
            [
                'gpt-6-luna',
                'GPT-6-Luna',
                'medium',
            ],
        ]);
        expect(normalizeCodexAssistantModelFromCatalog(models, null)).toBe('gpt-6-astra');
        expect(normalizeCodexAssistantModelFromCatalog(models, 'gpt-5.6-sol')).toBe('gpt-6-astra');
    });

    it('keeps visible entries from the newest GPT generation and uses the backend default', () => {
        const models = normalizeCodexModelListResponse({data: [
            {
                model: 'gpt-5.6-sol',
                displayName: 'GPT-5.6-Sol',
                hidden: false,
            },
            {
                model: 'gpt-6-astra',
                displayName: 'GPT-6-Astra Live',
                hidden: false,
                isDefault: true,
                defaultServiceTier: 'fast',
                serviceTiers: [
                    {
                        id: 'priority',
                        name: 'Fast',
                        description: 'Lower latency',
                    },
                    {
                        id: 'standard',
                        name: 'Standard',
                    },
                ],
                defaultReasoningEffort: 'medium',
                supportedReasoningEfforts: [
                    {
                        reasoningEffort: 'low',
                        description: 'Fast responses',
                    },
                    {
                        reasoningEffort: 'medium',
                        description: 'Balanced responses',
                    },
                    {
                        reasoningEffort: 'xhigh',
                        description: 'Extra high reasoning depth',
                    },
                ],
            },
            {
                id: 'gpt-6-sol',
                displayName: 'GPT-6-Sol',
                hidden: false,
                additionalSpeedTiers: ['fast'],
            },
            {
                id: 'gpt-7-luna',
                hidden: true,
                isDefault: true,
            },
            {
                id: 'custom-runtime-model',
                displayName: 'Custom Runtime Model',
                hidden: false,
            },
        ]});

        expect(models).toEqual([
            {
                id: 'gpt-6-astra',
                label: 'GPT-6-Astra Live',
                reasoningEfforts: [
                    {
                        id: 'low',
                        label: 'Low',
                        description: 'Fast responses',
                    },
                    {
                        id: 'medium',
                        label: 'Medium',
                        description: 'Balanced responses',
                        isDefault: true,
                    },
                    {
                        id: 'xhigh',
                        label: 'Extra High',
                        description: 'Extra high reasoning depth',
                    },
                ],
                defaultReasoningEffort: 'medium',
                serviceTiers: [
                    {
                        id: 'priority',
                        label: 'Fast',
                        description: 'Lower latency',
                    },
                    {
                        id: 'standard',
                        label: 'Standard',
                    },
                ],
                defaultServiceTier: 'fast',
                isDefault: true,
            },
            {
                id: 'gpt-6-sol',
                label: 'GPT-6-Sol',
                serviceTiers: [{
                    id: 'fast',
                    label: 'Fast',
                }],
            },
            {
                id: 'custom-runtime-model',
                label: 'Custom Runtime Model',
            },
        ]);
        expect(resolveCodexModelStatus(models ?? [], 'gpt-5.6-sol')).toMatchObject({
            defaultModel: 'gpt-6-astra',
            activeModel: 'gpt-6-astra',
        });
    });

    it('falls back to the first listed model of the newest generation when no backend default exists', () => {
        const models = normalizeCodexModelListResponse({data: [
            {
                model: 'custom-runtime-model',
                hidden: false,
            },
            {
                model: 'gpt-6-sol',
                hidden: false,
            },
            {
                model: 'gpt-6-astra',
                hidden: false,
            },
            {
                model: 'gpt-5.6-sol',
                hidden: false,
                isDefault: true,
            },
        ]}) ?? [];

        expect(models.map(model => model.id)).toEqual([
            'custom-runtime-model',
            'gpt-6-sol',
            'gpt-6-astra',
        ]);
        expect(resolveCodexModelStatus(models, 'gpt-5.6-sol')).toMatchObject({
            defaultModel: 'gpt-6-sol',
            activeModel: 'gpt-6-sol',
        });
        expect(normalizeCodexAssistantModelFromCatalog([], 'gpt-5.6-sol')).toBe('gpt-6-astra');
    });

    it('deduplicates visible Codex models and ignores hidden and blank records', () => {
        expect(normalizeCodexModelListResponse({data: [
            {
                model: 'gpt-6-astra',
                displayName: 'GPT-6-Astra',
                hidden: false,
            },
            {
                id: 'gpt-6-astra',
                displayName: 'Duplicate',
                hidden: false,
            },
            {
                model: 'gpt-99-hidden',
                hidden: true,
            },
            {model: 'gpt-6-sol'},
            {
                model: '   ',
                hidden: false,
            },
            null,
        ]})).toEqual([
            {
                id: 'gpt-6-astra',
                label: 'GPT-6-Astra',
            },
            {
                id: 'gpt-6-sol',
                label: 'gpt-6-sol',
            },
        ]);
        expect(normalizeCodexModelListResponse({data: 'bad'})).toBeNull();
    });

    it('preserves arbitrary Codex reasoning efforts advertised by model/list', () => {
        const models = normalizeCodexModelListResponse({data: [{
            model: 'custom-runtime-model',
            hidden: false,
            defaultReasoningEffort: 'super-high',
            supportedReasoningEfforts: [
                {
                    reasoningEffort: 'super-high',
                    description: 'Maximum reasoning',
                },
                {reasoningEffort: 'minimal'},
            ],
        }]});

        expect(models?.[0]).toMatchObject({
            id: 'custom-runtime-model',
            reasoningEfforts: [
                {
                    id: 'super-high',
                    label: 'Super High',
                    description: 'Maximum reasoning',
                    isDefault: true,
                },
                {
                    id: 'minimal',
                    label: 'Minimal',
                },
            ],
            defaultReasoningEffort: 'super-high',
        });
    });
});
