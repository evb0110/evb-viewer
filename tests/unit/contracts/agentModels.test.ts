import {describe, expect, it} from 'vitest';
import {ASSISTANT_DEFAULT_EFFORT, ASSISTANT_DEFAULT_SPEED_MODE, getAssistantPreferredModelId} from '@contracts/agentModels';

describe('assistant model defaults', () => {
    it('starts assistant sessions in medium-reasoning fast mode', () => {
        expect(ASSISTANT_DEFAULT_EFFORT).toBe('medium');
        expect(ASSISTANT_DEFAULT_SPEED_MODE).toBe('fast');
    });

    it('resolves preferred families from model metadata before using the first model', () => {
        expect(
            getAssistantPreferredModelId(
                [
                    {
                        id: 'first-runtime-model',
                        label: 'First runtime model',
                    },
                    {
                        id: 'runtime-opus',
                        label: 'Runtime Opus 4.9',
                    },
                ],
                'opus',
            ),
        ).toBe('runtime-opus');
    });
});
