import type {
    IAgentAssistantProviderStatus,
    IAgentAssistantState,
    IAgentAssistantStatus,
    TAgentAssistantEffort,
    TAgentAssistantProviderId,
    TAgentAssistantSpeedMode,
} from '@contracts/agent';
import { buildAgentAssistantScopeFingerprint } from '@contracts/agent';
import {
    ASSISTANT_DEFAULT_EFFORT,
    ASSISTANT_DEFAULT_SPEED_MODE,
    ASSISTANT_SPEED_MODES,
    normalizeAssistantEffortId,
} from '@contracts/agentModels';

export function modelForSelection(
    providerStatus: IAgentAssistantProviderStatus,
    model: string,
) {
    return providerStatus.models.find(candidate => candidate.id === model)
        ?? providerStatus.models.find(candidate => candidate.id === providerStatus.defaultModel)
        ?? providerStatus.models[0]
        ?? null;
}

export function speedModesForProviderStatus(
    providerStatus: IAgentAssistantProviderStatus,
    model = providerStatus.activeModel,
) {
    if (providerStatus.id === 'codex') {
        return [...ASSISTANT_SPEED_MODES];
    }

    const modelSpeedModes = providerStatus.models
        .find(candidate => candidate.id === model)
        ?.serviceTiers
        ?.map(tier => tier.id)
        .filter((id): id is TAgentAssistantSpeedMode => id === 'fast' || id === 'standard');
    return modelSpeedModes && modelSpeedModes.length > 0
        ? modelSpeedModes
        : providerStatus.availableSpeedModes;
}

function effortsForProviderModel(
    providerStatus: IAgentAssistantProviderStatus,
    modelOption: ReturnType<typeof modelForSelection>,
) {
    return modelOption?.reasoningEfforts
        ? modelOption.reasoningEfforts.map(effort => effort.id)
        : providerStatus.availableEfforts;
}

function defaultEffortForProviderModel(
    providerStatus: IAgentAssistantProviderStatus,
    efforts: readonly TAgentAssistantEffort[],
    modelOption: ReturnType<typeof modelForSelection>,
) {
    if (efforts.includes(providerStatus.defaultEffort)) {
        return providerStatus.defaultEffort;
    }
    const modelDefault = modelOption?.defaultReasoningEffort;
    if (modelDefault && efforts.includes(modelDefault)) {
        return modelDefault;
    }
    const defaultOption = modelOption?.reasoningEfforts?.find(effort => effort.isDefault)?.id;
    if (defaultOption && efforts.includes(defaultOption)) {
        return defaultOption;
    }
    return efforts[0] ?? providerStatus.defaultEffort;
}

export function createSelectedAssistantStatus(
    baseStatus: IAgentAssistantStatus,
    providerStatus: IAgentAssistantProviderStatus,
    model: string,
    effort: TAgentAssistantEffort,
    speedMode: TAgentAssistantSpeedMode,
) {
    const selectedModelOption = modelForSelection(providerStatus, model);
    const selectedModel = selectedModelOption?.id ?? model;
    const selectedModelLabel = selectedModelOption?.label ?? selectedModel;
    const providerEfforts = effortsForProviderModel(providerStatus, selectedModelOption);
    const providerSpeedModes = speedModesForProviderStatus(providerStatus, selectedModel);
    const defaultSpeedMode = providerSpeedModes.includes(providerStatus.defaultSpeedMode)
        ? providerStatus.defaultSpeedMode
        : providerSpeedModes[0] ?? 'standard';
    const selectedEffortValue = providerEfforts.includes(effort)
        ? effort
        : defaultEffortForProviderModel(providerStatus, providerEfforts, selectedModelOption);
    const selectedSpeedModeValue = providerSpeedModes.includes(speedMode)
        ? speedMode
        : defaultSpeedMode;
    const providers = baseStatus.providers.map(candidate => (candidate.id === providerStatus.id
        ? {
            ...candidate,
            activeModel: selectedModel,
            activeEffort: selectedEffortValue,
            activeSpeedMode: selectedSpeedModeValue,
        }
        : candidate));
    const codexProvider = providerStatus.id === 'codex'
        ? providerStatus
        : providers.find(candidate => candidate.id === 'codex');
    const preserveTurn = baseStatus.provider === providerStatus.id;
    const {
        error: _baseError,
        ...baseStatusWithoutError
    } = baseStatus;

    return {
        ...baseStatusWithoutError,
        provider: providerStatus.id,
        providerLabel: providerStatus.label,
        providers,
        model: selectedModel,
        modelLabel: selectedModelLabel,
        models: providerStatus.models,
        modelSwitchMode: providerStatus.modelSwitchMode,
        effort: selectedEffortValue,
        availableEfforts: providerEfforts,
        speedMode: selectedSpeedModeValue,
        availableSpeedModes: providerSpeedModes,
        installState: providerStatus.installState,
        codexInstalled: codexProvider?.installState === 'installed',
        codexPath: codexProvider?.path ?? null,
        codexVersion: codexProvider?.version ?? null,
        minimumCodexVersion: codexProvider?.minimumVersion ?? baseStatus.minimumCodexVersion,
        codexVersionSupported: codexProvider?.versionSupported ?? baseStatus.codexVersionSupported,
        installUrl: providerStatus.installUrl,
        authState: providerStatus.authState,
        account: providerStatus.account,
        runtimeState: providerStatus.runtimeState,
        turn: preserveTurn
            ? baseStatus.turn
            : {
                id: null,
                phase: 'idle',
                reasoning: '',
                toolActivity: [],
                lastEventAtMs: null,
                usage: null,
            },
        ...(providerStatus.error ? {error: providerStatus.error} : {}),
    } satisfies IAgentAssistantStatus;
}

export function getStateScopeFingerprint(nextState: IAgentAssistantState) {
    return buildAgentAssistantScopeFingerprint(nextState.status.provider, nextState.scope);
}

export function providerDefaultModel(
    providers: readonly IAgentAssistantProviderStatus[],
    provider: TAgentAssistantProviderId,
) {
    const providerStatus = providers.find(candidate => candidate.id === provider);
    return providerStatus?.activeModel
        ?? providerStatus?.defaultModel
        ?? 'default';
}

export function providerDefaultEffort(
    providers: readonly IAgentAssistantProviderStatus[],
    provider: TAgentAssistantProviderId,
): TAgentAssistantEffort {
    const providerStatus = providers.find(candidate => candidate.id === provider);
    return providerStatus?.activeEffort
        ?? providerStatus?.defaultEffort
        ?? ASSISTANT_DEFAULT_EFFORT;
}

export function providerDefaultSpeedMode(
    providers: readonly IAgentAssistantProviderStatus[],
    provider: TAgentAssistantProviderId,
): TAgentAssistantSpeedMode {
    const providerStatus = providers.find(candidate => candidate.id === provider);
    if (providerStatus?.id === 'codex' && !providerStatus.availableSpeedModes.includes('fast')) {
        return ASSISTANT_DEFAULT_SPEED_MODE;
    }
    return providerStatus?.activeSpeedMode
        ?? providerStatus?.defaultSpeedMode
        ?? ASSISTANT_DEFAULT_SPEED_MODE;
}

function unwrapSelectionValue(value: unknown) {
    return typeof value === 'object' && value && 'value' in value
        ? (value as {value?: unknown}).value
        : value;
}

export function normalizeEffortValue(value: unknown): TAgentAssistantEffort | null {
    const id = unwrapSelectionValue(value);
    return normalizeAssistantEffortId(id);
}

export function normalizeSpeedModeValue(value: unknown): TAgentAssistantSpeedMode | null {
    const id = unwrapSelectionValue(value);
    return id === 'fast' || id === 'standard'
        ? id
        : null;
}

export function normalizeProviderValue(value: unknown): TAgentAssistantProviderId {
    const id = unwrapSelectionValue(value);
    return id === 'claude' ? 'claude' : 'codex';
}

export function normalizeModelValue(value: unknown) {
    const id = unwrapSelectionValue(value);
    return typeof id === 'string' ? id : null;
}
