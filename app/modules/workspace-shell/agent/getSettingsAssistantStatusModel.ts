import type { IAssistantInstanceStatus } from '@contracts/assistant';

export function getSettingsAssistantStatusModel(status: IAssistantInstanceStatus | null) {
    const keys = {
        checking: 'assistant.stateChecking',
        ready: 'assistant.stateReady',
        warning: 'assistant.stateWarning',
        error: 'assistant.stateError',
        disabled: 'assistant.stateDisabled',
        missing: 'assistant.stateMissing',
    } as const;
    return {
        label: { key: keys[status?.state ?? 'checking'] },
        message: status?.message ?? '',
        icon: status?.state === 'ready' ? 'i-ph-check-circle' : status?.state === 'checking' ? 'i-ph-circle-notch' : 'i-ph-warning-circle',
    };
}

export type TSettingsAssistantCopy = ReturnType<typeof getSettingsAssistantStatusModel>['label'];
