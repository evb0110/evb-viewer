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
    CLAUDE_ASSISTANT_DEFAULT_MODEL,
    CLAUDE_ASSISTANT_MODELS,
    CODEX_ASSISTANT_EFFORTS,
    normalizeAssistantEffortId,
} from '@contracts/agentModels';
import {
    CLAUDE_AGENT_INSTALL_URL,
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

function isClaudeModelFamily(option: IAgentAssistantModelOption, family: string) {
    return [
        option.id,
        option.resolvedModel,
        option.label,
    ]
        .some(value => value?.toLowerCase().includes(family));
}

export function normalizeClaudeAssistantModel(
    models: readonly IAgentAssistantModelOption[],
    model: string | null | undefined,
) {
    const trimmed = model?.trim();
    const matched = trimmed
        ? models.find(option => option.id === trimmed || option.resolvedModel === trimmed)
        : undefined;
    if (matched) {
        return matched.id;
    }
    return models.find(option => isClaudeModelFamily(option, 'opus'))?.id
        ?? models[0]?.id
        ?? CLAUDE_ASSISTANT_DEFAULT_MODEL;
}

export function normalizeAssistantModel(
    codexModels: readonly TCodexAssistantModelOption[],
    provider: TAgentAssistantProviderId,
    model: string | null | undefined,
    claudeModels: readonly IAgentAssistantModelOption[] = CLAUDE_ASSISTANT_MODELS,
) {
    return provider === 'claude'
        ? normalizeClaudeAssistantModel(claudeModels, model)
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
        ? claudeModels.find(option => option.id === model || option.resolvedModel === model)?.label ?? model
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
    claudeModels: readonly IAgentAssistantModelOption[] = CLAUDE_ASSISTANT_MODELS,
): readonly TAgentAssistantEffort[] {
    if (provider === 'claude') {
        const modelOption = claudeModels.find(option => option.id === model);
        return modelOption?.reasoningEfforts?.length
            ? modelOption.reasoningEfforts.map(effort => effort.id)
            : CLAUDE_ASSISTANT_EFFORTS;
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
    claudeModels: readonly IAgentAssistantModelOption[] = CLAUDE_ASSISTANT_MODELS,
) {
    const efforts = getProviderEfforts(codexModels, provider, model, claudeModels);
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
    if (efforts.includes(ASSISTANT_DEFAULT_EFFORT)) {
        return ASSISTANT_DEFAULT_EFFORT;
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
    claudeModels: readonly IAgentAssistantModelOption[] = CLAUDE_ASSISTANT_MODELS,
): readonly TAgentAssistantSpeedMode[] {
    if (provider === 'claude') {
        const option = claudeModels.find(candidate => candidate.id === model);
        return shouldUseClaudeAssistantFastMode(
            option ? `${option.id} ${option.resolvedModel ?? ''} ${option.label}` : model,
            ASSISTANT_DEFAULT_SPEED_MODE,
        )
            ? ASSISTANT_SPEED_MODES
            : ['standard'];
    }

    return ASSISTANT_SPEED_MODES;
}

function getClaudeSpeedTierOptions(model: IAgentAssistantModelOption) {
    return getProviderSpeedModes([], 'claude', model.id, [model]).map(mode => ({
        id: mode,
        label: mode === 'fast' ? 'Fast' : 'Standard',
        ...(mode === 'fast' ? {isDefault: true} : {}),
    }));
}

function getProviderDefaultSpeedMode(
    codexModels: readonly TCodexAssistantModelOption[],
    provider: TAgentAssistantProviderId,
    model: string,
    claudeModels: readonly IAgentAssistantModelOption[] = CLAUDE_ASSISTANT_MODELS,
) {
    const speedModes = getProviderSpeedModes(codexModels, provider, model, claudeModels);
    return speedModes.includes(ASSISTANT_DEFAULT_SPEED_MODE)
        ? ASSISTANT_DEFAULT_SPEED_MODE
        : 'standard';
}

export function normalizeAssistantEffort(
    codexModels: readonly TCodexAssistantModelOption[],
    provider: TAgentAssistantProviderId,
    model: string,
    effort: TAgentAssistantEffort | null | undefined,
    claudeModels: readonly IAgentAssistantModelOption[] = CLAUDE_ASSISTANT_MODELS,
): TAgentAssistantEffort {
    const normalizedEffort = normalizeAssistantEffortId(effort);
    const efforts = getProviderEfforts(codexModels, provider, model, claudeModels);
    return normalizedEffort && efforts.includes(normalizedEffort)
        ? normalizedEffort
        : getProviderDefaultEffort(codexModels, provider, model, claudeModels);
}

export function normalizeAssistantSpeedMode(
    codexModels: readonly TCodexAssistantModelOption[],
    provider: TAgentAssistantProviderId,
    model: string,
    speedMode: TAgentAssistantSpeedMode | null | undefined,
    claudeModels: readonly IAgentAssistantModelOption[] = CLAUDE_ASSISTANT_MODELS,
): TAgentAssistantSpeedMode {
    const speedModes = getProviderSpeedModes(codexModels, provider, model, claudeModels);
    return speedMode && speedModes.includes(speedMode)
        ? speedMode
        : getProviderDefaultSpeedMode(codexModels, provider, model, claudeModels);
}

export function resolveAssistantSelection(
    codexModels: readonly TCodexAssistantModelOption[],
    request?:
        | IAgentAssistantStateRequest
        | IAgentAssistantScopedRequest
        | IAgentAssistantSendMessageRequest
        | IAssistantSelectionRequest
        | null,
    claudeModels: readonly IAgentAssistantModelOption[] = CLAUDE_ASSISTANT_MODELS,
): IAssistantSelection {
    const provider = normalizeAssistantProviderId(request?.provider);
    const model = normalizeAssistantModel(codexModels, provider, request?.model, claudeModels);
    return {
        provider,
        model,
        effort: normalizeAssistantEffort(codexModels, provider, model, request?.effort, claudeModels),
        speedMode: normalizeAssistantSpeedMode(codexModels, provider, model, request?.speedMode, claudeModels),
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
    const activeModel = normalizeClaudeAssistantModel(options.models, options.model);
    const models = options.models;
    const modelsWithSpeedTiers = models.map(model => {
        const speedTiers = model.serviceTiers ?? getClaudeSpeedTierOptions(model);
        return {
            ...model,
            serviceTiers: speedTiers,
            ...(model.defaultServiceTier === undefined
                ? {defaultServiceTier: speedTiers[0]?.id ?? null}
                : {}),
        };
    });
    const error = options.lastError ?? options.claudeInfo?.error;
    const availableSpeedModes = getProviderSpeedModes([], 'claude', activeModel, models);
    const availableEfforts = getProviderEfforts([], 'claude', activeModel, models);
    const defaultEffort = getProviderDefaultEffort([], 'claude', activeModel, models);
    return {
        id: 'claude',
        label: getAssistantProviderLabel('claude'),
        installState: supported ? (installed ? 'installed' : 'missing') : 'unsupported',
        authState: installed && options.authState === 'unknown' ? 'signed-in' : options.authState,
        runtimeState: installed && options.runtimeState === 'stopped' ? 'ready' : options.runtimeState,
        models: modelsWithSpeedTiers,
        defaultModel: normalizeClaudeAssistantModel(modelsWithSpeedTiers, null),
        activeModel,
        modelSwitchMode: 'in-session',
        availableEfforts,
        defaultEffort,
        activeEffort: normalizeAssistantEffort([], 'claude', activeModel, options.effort, modelsWithSpeedTiers),
        availableSpeedModes,
        defaultSpeedMode: getProviderDefaultSpeedMode([], 'claude', activeModel, modelsWithSpeedTiers),
        activeSpeedMode: normalizeAssistantSpeedMode([], 'claude', activeModel, options.speedMode, modelsWithSpeedTiers),
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
