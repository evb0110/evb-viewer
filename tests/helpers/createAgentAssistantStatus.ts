import type {
    IAssistantInstanceStatus, IAssistantState,
} from '@contracts/assistant';

export function createAssistantInstance(overrides: Partial<IAssistantInstanceStatus> = {}): IAssistantInstanceStatus {
    return {
        id: 'codex',
        driver: 'codex',
        label: 'Codex A',
        enabled: true,
        state: 'ready',
        auth: 'authenticated',
        binaryPath: '/bin/codex',
        version: '0.133.0',
        homePath: '/home/reader/.codex',
        customEndpoint: false,
        account: null,
        models: [{
            id: 'gpt',
            label: 'GPT',
            reasoningEfforts: [
                {
                    id: 'low',
                    label: 'Low',
                },
                {
                    id: 'high',
                    label: 'High',
                },
            ],
            defaultReasoningEffort: 'high',
            serviceTiers: [{
                id: 'priority',
                label: 'Fast',
            }],
        }],
        defaultModel: 'gpt',
        checkedAt: null,
        canInstall: false,
        canSignIn: false,
        loginPending: false,
        ...overrides,
    };
}

export function createAssistantState(overrides: Partial<IAssistantState> = {}): IAssistantState {
    return {
        supported: true,
        enabled: true,
        instances: [createAssistantInstance()],
        selection: {
            instanceId: 'codex',
            model: 'gpt',
            effort: 'high',
            speedMode: 'standard',
        },
        chat: null,
        installProgress: null,
        ...overrides,
    };
}
