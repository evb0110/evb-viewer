import type { Ref } from 'vue';
import { getErrorMessage } from '@app/utils/error';

export type TSettingsAssistantAction = 'refresh' | 'install' | 'login' | 'cancel' | 'save' | 'import';

export async function runSettingsAssistantAction(options: {
    action: TSettingsAssistantAction;
    activeAction: Ref<TSettingsAssistantAction | null>;
    error: Ref<string>;
    run: () => Promise<void>;
    isActive?: () => boolean;
}) {
    if (options.activeAction.value || options.isActive?.() === false) return false;
    options.activeAction.value = options.action;
    options.error.value = '';
    try {
        await options.run();
        return true;
    } catch (error) {
        if (options.isActive?.() !== false) options.error.value = getErrorMessage(error);
        return false;
    } finally {
        if (options.isActive?.() !== false) options.activeAction.value = null;
    }
}
