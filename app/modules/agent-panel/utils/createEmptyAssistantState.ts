import type {
    IAgentAssistantChatScope,
    IAgentAssistantState,
    TAgentAssistantEffort,
    TAgentAssistantProviderId,
    TAgentAssistantSpeedMode,
} from '@contracts/agent';
import {cloneAssistantScope} from '@agent-core/assistantScope';
import {createIsoTimestamp} from '@contracts/timestamps';
import {
    ASSISTANT_DEFAULT_EFFORT,
    ASSISTANT_DEFAULT_SPEED_MODE,
    ASSISTANT_SPEED_MODES,
    CLAUDE_ASSISTANT_DEFAULT_MODEL,
    CLAUDE_ASSISTANT_EFFORTS,
    CLAUDE_ASSISTANT_MODELS,
    CODEX_ASSISTANT_DEFAULT_MODEL,
    CODEX_ASSISTANT_EFFORTS,
    CODEX_ASSISTANT_FALLBACK_MODELS,
} from '@contracts/agentModels';

interface ICreateEmptyAssistantStateOptions {
    chatScope: IAgentAssistantChatScope | null;
    selectedProvider: TAgentAssistantProviderId;
    selectedModel: string;
    selectedEffort: TAgentAssistantEffort;
    selectedSpeedMode: TAgentAssistantSpeedMode;
}

export function createEmptyAssistantState({
    chatScope,
    selectedProvider,
    selectedModel,
    selectedEffort,
    selectedSpeedMode,
}: ICreateEmptyAssistantStateOptions): IAgentAssistantState {
    return {
        scope: chatScope ? cloneAssistantScope(chatScope) : null,
        status: {
            supported: true,
            platform: '',
            provider: selectedProvider,
            providerLabel: selectedProvider === 'claude' ? 'Claude' : 'Codex',
            providers: [
                {
                    id: 'codex',
                    label: 'Codex',
                    installState: 'missing',
                    authState: 'unknown',
                    runtimeState: 'stopped',
                    models: [...CODEX_ASSISTANT_FALLBACK_MODELS],
                    defaultModel: CODEX_ASSISTANT_DEFAULT_MODEL,
                    activeModel: CODEX_ASSISTANT_DEFAULT_MODEL,
                    modelSwitchMode: 'in-session',
                    availableEfforts: [...CODEX_ASSISTANT_EFFORTS],
                    defaultEffort: ASSISTANT_DEFAULT_EFFORT,
                    activeEffort: selectedProvider === 'codex' ? selectedEffort : ASSISTANT_DEFAULT_EFFORT,
                    availableSpeedModes: [...ASSISTANT_SPEED_MODES],
                    defaultSpeedMode: ASSISTANT_DEFAULT_SPEED_MODE,
                    activeSpeedMode: selectedProvider === 'codex' ? selectedSpeedMode : ASSISTANT_DEFAULT_SPEED_MODE,
                    path: null,
                    version: null,
                    minimumVersion: '0.133.0',
                    versionSupported: false,
                    installUrl: '',
                    account: null,
                },
                {
                    id: 'claude',
                    label: 'Claude',
                    installState: 'missing',
                    authState: 'unknown',
                    runtimeState: 'stopped',
                    models: [...CLAUDE_ASSISTANT_MODELS],
                    defaultModel: CLAUDE_ASSISTANT_DEFAULT_MODEL,
                    activeModel: CLAUDE_ASSISTANT_DEFAULT_MODEL,
                    modelSwitchMode: 'in-session',
                    availableEfforts: [...CLAUDE_ASSISTANT_EFFORTS],
                    defaultEffort: ASSISTANT_DEFAULT_EFFORT,
                    activeEffort: selectedProvider === 'claude' ? selectedEffort : ASSISTANT_DEFAULT_EFFORT,
                    availableSpeedModes: [...ASSISTANT_SPEED_MODES],
                    defaultSpeedMode: ASSISTANT_DEFAULT_SPEED_MODE,
                    activeSpeedMode: selectedProvider === 'claude' ? selectedSpeedMode : ASSISTANT_DEFAULT_SPEED_MODE,
                    path: null,
                    version: null,
                    minimumVersion: null,
                    versionSupported: false,
                    installUrl: '',
                    account: null,
                },
            ],
            model: selectedModel,
            modelLabel: selectedModel,
            models: selectedProvider === 'claude'
                ? [...CLAUDE_ASSISTANT_MODELS]
                : [...CODEX_ASSISTANT_FALLBACK_MODELS],
            modelSwitchMode: 'in-session',
            effort: selectedEffort,
            availableEfforts: selectedProvider === 'claude'
                ? [...CLAUDE_ASSISTANT_EFFORTS]
                : [...CODEX_ASSISTANT_EFFORTS],
            speedMode: selectedSpeedMode,
            availableSpeedModes: [...ASSISTANT_SPEED_MODES],
            installState: 'missing',
            codexInstalled: false,
            codexPath: null,
            codexVersion: null,
            minimumCodexVersion: '0.133.0',
            codexVersionSupported: false,
            installUrl: '',
            installScriptUrl: '',
            managedInstallDir: '',
            authState: 'unknown',
            account: null,
            runtimeState: 'stopped',
            mcp: {
                serverName: 'evb_viewer_embedded',
                serverUrl: '',
                serverRunning: false,
                toolCount: 0,
            },
            turn: {
                id: null,
                phase: 'idle',
                reasoning: '',
                toolActivity: [],
                lastEventAtMs: null,
                usage: null,
            },
            lastCheckedAt: createIsoTimestamp(),
        },
        messages: [],
    };
}
