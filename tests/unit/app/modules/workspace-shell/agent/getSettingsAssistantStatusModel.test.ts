import {
    describe, expect, it,
} from 'vitest';
import { getSettingsAssistantStatusModel } from '@app/modules/workspace-shell/agent/getSettingsAssistantStatusModel';
import { createAssistantInstance } from '@tests/helpers/createAgentAssistantStatus';

describe('settings instance status', () => {
    it('preserves the provider message verbatim for display beside its own state', () => {
        const model = getSettingsAssistantStatusModel(createAssistantInstance({
            state: 'error',
            message: 'EXACT initialization\nfailure',
        }));
        expect(model.label.key).toBe('assistant.stateError');
        expect(model.message).toBe('EXACT initialization\nfailure');
    });
    it('shows a checking status before an instance snapshot arrives', () => {
        expect(getSettingsAssistantStatusModel(null).label.key).toBe('assistant.stateChecking');
    });
});
