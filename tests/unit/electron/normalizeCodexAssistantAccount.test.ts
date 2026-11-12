import {
    describe, expect, it,
} from 'vitest';
import {normalizeCodexAssistantAccount} from '@electron/features/agent/normalizeCodexAssistantAccount';

describe('assistant provider accounts', () => {
    it('normalizes Codex account payloads', () => {
        expect(normalizeCodexAssistantAccount({
            type: 'chatgpt',
            email: 'reader@example.com',
            planType: 'plus',
        })).toEqual({
            type: 'chatgpt',
            email: 'reader@example.com',
            planType: 'plus',
        });
        expect(normalizeCodexAssistantAccount({
            type: 'apiKey',
            email: 'ignored@example.com',
        })).toEqual({ type: 'apiKey' });
        expect(normalizeCodexAssistantAccount({ type: 'other-provider' })).toEqual({ type: 'other' });
        expect(normalizeCodexAssistantAccount(null)).toBeNull();
    });

});
