import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    ASSISTANT_DEFAULT_EFFORT,
    ASSISTANT_DEFAULT_SPEED_MODE,
    CLAUDE_ASSISTANT_DEFAULT_MODEL,
    CLAUDE_ASSISTANT_MODELS,
    CODEX_ASSISTANT_DEFAULT_MODEL,
    CODEX_ASSISTANT_FALLBACK_MODELS,
    getAssistantPreferredModelId,
} from '@contracts/agentModels';

describe('assistant model defaults', () => {
    it('starts assistant sessions in medium-reasoning fast mode', () => {
        expect(ASSISTANT_DEFAULT_EFFORT).toBe('medium');
        expect(ASSISTANT_DEFAULT_SPEED_MODE).toBe('fast');
    });

    it('keeps one current Codex fallback before model discovery', () => {
        expect(CODEX_ASSISTANT_DEFAULT_MODEL).toBe('gpt-6-astra');
        expect(CODEX_ASSISTANT_FALLBACK_MODELS).toMatchObject([{
            id: 'gpt-6-astra',
            label: 'GPT-6-Astra',
            defaultReasoningEffort: 'medium',
            defaultServiceTier: 'fast',
        }]);
    });

    it('keeps unversioned Claude fallback labels and defaults to Opus', () => {
        expect(CLAUDE_ASSISTANT_DEFAULT_MODEL).toBe('opus');
        expect(CLAUDE_ASSISTANT_MODELS.map(model => model.label)).toEqual([
            'Opus',
            'Fable',
        ]);
    });

    it('resolves preferred families from model metadata before using the first model', () => {
        expect(getAssistantPreferredModelId([
            {
                id: 'first-runtime-model',
                label: 'First runtime model',
            },
            {
                id: 'runtime-opus',
                label: 'Runtime Opus 4.9',
            },
        ], 'opus')).toBe('runtime-opus');
    });
});
