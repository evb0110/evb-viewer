import {
    describe, expect, it,
} from 'vitest';
import { ref } from 'vue';
import {
    runSettingsAssistantAction, type TSettingsAssistantAction,
} from '@app/modules/workspace-shell/agent/runSettingsAssistantAction';

describe('settings assistant operation feedback', () => {
    it('retains the original error as inline feedback and allows the next action', async () => {
        const activeAction = ref<TSettingsAssistantAction | null>(null);
        const error = ref('');
        expect(await runSettingsAssistantAction({
            action: 'save',
            activeAction,
            error,
            run: async () => { throw new Error('Cannot encrypt stored secret'); },
        })).toBe(false);
        expect(error.value).toBe('Cannot encrypt stored secret');
        expect(activeAction.value).toBeNull();
        expect(await runSettingsAssistantAction({
            action: 'save',
            activeAction,
            error,
            run: async () => {},
        })).toBe(true);
        expect(error.value).toBe('');
    });
    it('does not publish a late error after settings is closed', async () => {
        const pending = Promise.withResolvers<undefined>();
        const activeAction = ref<TSettingsAssistantAction | null>(null);
        const error = ref('');
        let active = true;
        const result = runSettingsAssistantAction({
            action: 'refresh',
            activeAction,
            error,
            run: () => pending.promise,
            isActive: () => active,
        });
        active = false;
        pending.reject(new Error('Late error'));
        await result;
        expect(error.value).toBe('');
    });
});
