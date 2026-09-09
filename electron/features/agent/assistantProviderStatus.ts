import type {
    IAgentAssistantAccount,
    IAgentAssistantModelOption,
    IAgentAssistantScopedRequest,
    IAgentAssistantSendMessageRequest,
    IAgentAssistantStateRequest,
    IAgentAssistantStatus,
    TAgentAssistantAuthState,
    TAgentAssistantEffort,
    TAgentAssistantProviderId,
    TAgentAssistantRuntimeState,
    TAgentAssistantSpeedMode,
} from '@contracts/agent';
import {
    ASSISTANT_DEFAULT_EFFORT,
    ASSISTANT_DEFAULT_SPEED_MODE,
    ASSISTANT_SPEED_MODES,
    CLAUDE_ASSISTANT_EFFORTS,
    CODEX_ASSISTANT_EFFORTS,
    getAssistantPreferredModelId,
    normalizeAssistantEffortId,
} from '@contracts/agentModels';
import {
    CLAUDE_AGENT_DEFAULT_MODEL,
    CLAUDE_AGENT_INSTALL_URL,
    getClaudeAssistantModelLabel,
    normalizeClaudeAssistantModel,
    shouldUseClaudeAssistantFastMode,
} from '@electron/features/agent/claudeProviderMetadata';
import {
    CODEX_APP_INSTALL_URL,
    type ICodexCliInfo,
} from '@electron/features/agent/codexCli';
import { PINNED_CODEX_CLI_VERSION } from '@electron/features/agent/codexCliReleaseManifest';
import {
    normalizeCodexAssistantModelFromCatalog,
    resolveCodexDefaultModelId,
    type TCodexAssistantModelOption,
} from '@electron/features/agent/assistantModelCatalog';
import { createAssistantErrorEnvelope } from '@electron/features/agent/assistantErrorEnvelope';
import {
    getAssistantProviderLabel,
    normalizeAssistantProviderId,
} from '@electron/features/agent/assistantProviderRegistry';
import type { IClaudeAssistantProviderInfo } from '@electron/features/agent/claudeProviderMetadata';
export type { IClaudeAssistantProviderInfo };

export interface IAssistantSelection {
    provider: TAgentAssistantProviderId;
    model: string;
    effort: TAgentAssistantEffort;
    speedMode: TAgentAssistantSpeedMode;
}

interface IAssistantSelectionRequest {
    provider?: TAgentAssistantProviderId | null;
    model?: string | null;
    effort?: TAgentAssistantEffort | null;
    speedMode?: TAgentAssistantSpeedMode | null;
}

export function codexDefaultModelId(codexModels: readonly TCodexAssistantModelOption[]) {
    return resolveCodexDefaultModelId(codexModels);
}

export function normalizeCodexAssistantModel(
    codexModels: readonly TCodexAssistantModelOption[],
    model: string | null | undefined,
) {
    return normalizeCodexAssistantModelFromCatalog(codexModels, model);
}

export function normalizeAssistantModel(
    codexModels: readonly TCodexAssistantModelOption[],
    provider: TAgentAssistantProviderId,
    model: string | null | undefined,
) {
    return provider === 'claude'
        ? normalizeClaudeAssistantModel(model)
        : normalizeCodexAssistantModel(codexModels, model);
}

function getCodexAssistantModelLabel(
    codexModels: readonly TCodexAssistantModelOption[],
    model: string,
) {
    return codexModels.find(option => option.id === model)?.label ?? model;
}

export function getProviderModelLabel(
    codexModels: readonly TCodexAssistantModelOption[],
    claudeModels: readonly IAgentAssistantModelOption[],
    provider: TAgentAssistantProviderId,
    model: string,
) {
    return provider === 'claude'
        ? claudeModels.find(option => option.id === model)?.label ?? getClaudeAssistantModelLabel(model)
        : getCodexAssistantModelLabel(codexModels, model);
}

function findCodexModelOption(codexModels: readonly TCodexAssistantModelOption[], model: string) {
    const normalized = normalizeCodexAssistantModel(codexModels, model);
    return codexModels.find(option => option.id === normalized) ?? null;
}

export function getProviderEfforts(
    codexModels: readonly TCodexAssistantModelOption[],
    provider: TAgentAssistantProviderId,
    model: string,
): readonly TAgentAssistantEffort[] {
    if (provider === 'claude') {
        return CLAUDE_ASSISTANT_EFFORTS;
    }

    const modelOption = findCodexModelOption(codexModels, model);
    return modelOption?.reasoningEfforts
        ? modelOption.reasoningEfforts.map(effort => effort.id)
        : CODEX_ASSISTANT_EFFORTS;
}

function getProviderDefaultEffort(
    codexModels: readonly TCodexAssistantModelOption[],
    provider: TAgentAssistantProviderId,
    model: string,
) {
    const efforts = getProviderEfforts(codexModels, provider, model);
    if (efforts.includes(ASSISTANT_DEFAULT_EFFORT)) {
        return ASSISTANT_DEFAULT_EFFORT;
    }
    if (provider === 'codex') {
        const modelOption = findCodexModelOption(codexModels, model);
        const modelDefault = modelOption?.defaultReasoningEffort;
        if (modelDefault && efforts.includes(modelDefault)) {
            return modelDefault;
        }
        const defaultOption = modelOption?.reasoningEfforts?.find(effort => effort.isDefault)?.id;
        if (defaultOption && efforts.includes(defaultOption)) {
            return defaultOption;
        }
    }
    return efforts[0] ?? ASSISTANT_DEFAULT_EFFORT;
}

function isCodexFastServiceTierId(id: string) {
    return id === 'fast' || id === 'priority';
}

function findCodexFastServiceTier(codexModels: readonly TCodexAssistantModelOption[], model: string) {
    const option = findCodexModelOption(codexModels, model);
    return option?.serviceTiers?.find(tier => isCodexFastServiceTierId(tier.id)) ?? null;
}

export function resolveCodexServiceTier(
    codexModels: readonly TCodexAssistantModelOption[],
    model: string,
    speedMode: TAgentAssistantSpeedMode,
) {
    if (speedMode !== 'fast') {
        return undefined;
    }
    return findCodexFastServiceTier(codexModels, model)?.id ?? 'priority';
}

export function getProviderSpeedModes(
    codexModels: readonly TCodexAssistantModelOption[],
    provider: TAgentAssistantProviderId,
    model: string,
): readonly TAgentAssistantSpeedMode[] {
    if (provider === 'claude') {
        return shouldUseClaudeAssistantFastMode(model, ASSISTANT_DEFAULT_SPEED_MODE)
            ? ASSISTANT_SPEED_MODES
            : ['standard'];
    }

    return ASSISTANT_SPEED_MODES;
}

function getClaudeSpeedTierOptions(model: string) {
    return getProviderSpeedModes([], 'claude', model).map(mode => ({
        id: mode,
        label: mode === 'fast' ? 'Fast' : 'Standard',
        ...(mode === 'fast' ? {isDefault: true} : {}),
    }));
}

function getProviderDefaultSpeedMode(
    codexModels: readonly TCodexAssistantModelOption[],
    provider: TAgentAssistantProviderId,
    model: string,
) {
    const speedModes = getProviderSpeedModes(codexModels, provider, model);
    return speedModes.includes(ASSISTANT_DEFAULT_SPEED_MODE)
        ? ASSISTANT_DEFAULT_SPEED_MODE
        : 'standard';
}

export function normalizeAssistantEffort(
    codexModels: readonly TCodexAssistantModelOption[],
    provider: TAgentAssistantProviderId,
    model: string,
    effort: TAgentAssistantEffort | null | undefined,
): TAgentAssistantEffort {
    const normalizedEffort = normalizeAssistantEffortId(effort);
    const efforts = getProviderEfforts(codexModels, provider, model);
    return normalizedEffort && efforts.includes(normalizedEffort)
        ? normalizedEffort
        : getProviderDefaultEffort(codexModels, provider, model);
}

export function normalizeAssistantSpeedMode(
    codexModels: readonly TCodexAssistantModelOption[],
    provider: TAgentAssistantProviderId,
    model: string,
    speedMode: TAgentAssistantSpeedMode | null | undefined,
): TAgentAssistantSpeedMode {
    const speedModes = getProviderSpeedModes(codexModels, provider, model);
    return speedMode && speedModes.includes(speedMode)
        ? speedMode
        : getProviderDefaultSpeedMode(codexModels, provider, model);
}

export function resolveAssistantSelection(
    codexModels: readonly TCodexAssistantModelOption[],
    request?:
        | IAgentAssistantStateRequest
        | IAgentAssistantScopedRequest
        | IAgentAssistantSendMessageRequest
        | IAssistantSelectionRequest
        | null,
): IAssistantSelection {
    const provider = normalizeAssistantProviderId(request?.provider);
    const model = normalizeAssistantModel(codexModels, provider, request?.model);
    return {
        provider,
        model,
        effort: normalizeAssistantEffort(codexModels, provider, model, request?.effort),
        speedMode: normalizeAssistantSpeedMode(codexModels, provider, model, request?.speedMode),
    };
}

export function buildCodexProviderStatus(options: {
    platform: string;
    codexInfo: ICodexCliInfo | null;
    models: readonly TCodexAssistantModelOption[];
    model: string;
    effort: TAgentAssistantEffort;
    speedMode: TAgentAssistantSpeedMode;
    authState: TAgentAssistantAuthState;
    runtimeState: TAgentAssistantRuntimeState;
    account: IAgentAssistantAccount | null;
    lastError?: string;
}): IAgentAssistantStatus['providers'][number] {
    const installed = options.codexInfo?.installed === true;
    const supported = options.platform === 'darwin' || options.platform === 'win32' || options.platform === 'linux';
    const activeModel = normalizeCodexAssistantModel(options.models, options.model);
    const availableSpeedModes = getProviderSpeedModes(options.models, 'codex', activeModel);
    const availableEfforts = getProviderEfforts(options.models, 'codex', activeModel);
    const defaultEffort = getProviderDefaultEffort(options.models, 'codex', activeModel);
    return {
        id: 'codex',
        label: getAssistantProviderLabel('codex'),
        installState: supported ? (installed ? 'installed' : 'missing') : 'unsupported',
        authState: options.authState,
        runtimeState: options.runtimeState,
        models: options.models,
        defaultModel: codexDefaultModelId(options.models),
        activeModel,
        modelSwitchMode: 'in-session',
        availableEfforts,
        defaultEffort,
        activeEffort: normalizeAssistantEffort(options.models, 'codex', activeModel, options.effort),
        availableSpeedModes,
        defaultSpeedMode: getProviderDefaultSpeedMode(options.models, 'codex', activeModel),
        activeSpeedMode: normalizeAssistantSpeedMode(options.models, 'codex', activeModel, options.speedMode),
        path: options.codexInfo?.path ?? null,
        version: options.codexInfo?.version ?? null,
        minimumVersion: options.codexInfo?.minimumVersion ?? PINNED_CODEX_CLI_VERSION,
        versionSupported: options.codexInfo?.isVersionSupported === true,
        installUrl: CODEX_APP_INSTALL_URL,
        account: options.account,
        ...(options.lastError
            ? {
                error: options.lastError,
                errorEnvelope: createAssistantErrorEnvelope(options.lastError),
            }
            : {}),
    };
}

export function buildClaudeProviderStatus(options: {
    platform: string;
    claudeInfo: IClaudeAssistantProviderInfo | null;
    models: readonly IAgentAssistantModelOption[];
    model: string;
    effort: TAgentAssistantEffort;
    speedMode: TAgentAssistantSpeedMode;
    authState: TAgentAssistantAuthState;
    runtimeState: TAgentAssistantRuntimeState;
    account: IAgentAssistantAccount | null;
    lastError?: string;
}): IAgentAssistantStatus['providers'][number] {
    const supported = options.platform === 'darwin' || options.platform === 'win32' || options.platform === 'linux';
    const installed = options.claudeInfo?.installed === true;
    const activeModel = normalizeClaudeAssistantModel(options.model);
    const models = options.models.some(option => option.id === activeModel)
        ? options.models
        : [
            {
                id: activeModel,
                label: getClaudeAssistantModelLabel(activeModel),
            },
            ...options.models,
        ];
    const modelsWithSpeedTiers = models.map(model => {
        const speedTiers = model.serviceTiers ?? getClaudeSpeedTierOptions(model.id);
        return {
            ...model,
            serviceTiers: speedTiers,
            ...(model.defaultServiceTier === undefined
                ? {defaultServiceTier: speedTiers[0]?.id ?? null}
                : {}),
        };
    });
    const error = options.lastError ?? options.claudeInfo?.error;
    const availableSpeedModes = getProviderSpeedModes([], 'claude', activeModel);
    const availableEfforts = getProviderEfforts([], 'claude', activeModel);
    const defaultEffort = getProviderDefaultEffort([], 'claude', activeModel);
    return {
        id: 'claude',
        label: getAssistantProviderLabel('claude'),
        installState: supported ? (installed ? 'installed' : 'missing') : 'unsupported',
        authState: installed && options.authState === 'unknown' ? 'signed-in' : options.authState,
        runtimeState: installed && options.runtimeState === 'stopped' ? 'ready' : options.runtimeState,
        models: modelsWithSpeedTiers,
        defaultModel: getAssistantPreferredModelId(modelsWithSpeedTiers, 'opus', CLAUDE_AGENT_DEFAULT_MODEL),
        activeModel,
        modelSwitchMode: 'in-session',
        availableEfforts,
        defaultEffort,
        activeEffort: normalizeAssistantEffort([], 'claude', activeModel, options.effort),
        availableSpeedModes,
        defaultSpeedMode: getProviderDefaultSpeedMode([], 'claude', activeModel),
        activeSpeedMode: normalizeAssistantSpeedMode([], 'claude', activeModel, options.speedMode),
        path: options.claudeInfo?.executablePath ?? null,
        version: options.claudeInfo?.version ?? null,
        minimumVersion: null,
        versionSupported: installed,
        installUrl: CLAUDE_AGENT_INSTALL_URL,
        account: options.account,
        ...(error
            ? {
                error,
                errorEnvelope: createAssistantErrorEnvelope(error),
            }
            : {}),
    };
}
