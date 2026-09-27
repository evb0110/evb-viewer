import type {
    IAgentAssistantProviderStatus,
    TAgentAssistantProviderId,
} from '@contracts/agent';
import {
    CLAUDE_ASSISTANT_DEFAULT_MODEL,
    CODEX_ASSISTANT_DEFAULT_MODEL,
} from '@contracts/agentModels';
import { STORAGE_KEYS } from '@app/constants/storageKeys';
import {
    normalizeModelValue,
    providerDefaultModel,
} from '@app/modules/agent-panel/utils/assistantSelectionState';
import { BrowserLogger } from '@app/utils/browserLogger';

type TAssistantModelPreferenceMap = Partial<Record<TAgentAssistantProviderId, string>>;

export interface IAssistantSelectionPreference {
    provider: TAgentAssistantProviderId;
    modelsByProvider: TAssistantModelPreferenceMap;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function normalizeStoredModelValue(value: unknown) {
    const model = normalizeModelValue(value)?.trim();
    return model && model.length > 0 ? model : null;
}

function normalizeStoredProviderValue(value: unknown): TAgentAssistantProviderId | null {
    return value === 'codex' || value === 'claude' ? value : null;
}

function fallbackAssistantModel(provider: TAgentAssistantProviderId) {
    return provider === 'claude'
        ? CLAUDE_ASSISTANT_DEFAULT_MODEL
        : CODEX_ASSISTANT_DEFAULT_MODEL;
}

function parseAssistantModelPreferences(value: unknown): TAssistantModelPreferenceMap {
    if (!isRecord(value)) {
        return {};
    }

    const modelsByProvider: TAssistantModelPreferenceMap = {};
    for (const provider of [
        'codex',
        'claude',
    ] as const) {
        const model = normalizeStoredModelValue(value[provider]);
        if (model) {
            modelsByProvider[provider] = model;
        }
    }

    return modelsByProvider;
}

function parseAssistantSelectionPreference(value: unknown): IAssistantSelectionPreference | null {
    if (!isRecord(value)) {
        return null;
    }

    const provider = normalizeStoredProviderValue(value.provider);
    if (!provider) {
        return null;
    }

    const modelsByProvider = parseAssistantModelPreferences(value.modelsByProvider);
    const legacyModel = normalizeStoredModelValue(value.model);
    if (legacyModel) {
        modelsByProvider[provider] = legacyModel;
    }

    return {
        provider,
        modelsByProvider,
    };
}

export function readAssistantSelectionPreference(storage: Storage | undefined): IAssistantSelectionPreference | null {
    if (!storage) {
        return null;
    }

    const rawPreference = storage.getItem(STORAGE_KEYS.ASSISTANT_SELECTION);
    if (!rawPreference) {
        return null;
    }

    try {
        return parseAssistantSelectionPreference(JSON.parse(rawPreference));
    } catch (error) {
        BrowserLogger.warn('assistant', 'Failed to read assistant selection preference', { error });
        return null;
    }
}

export function preferredAssistantModel(
    preference: IAssistantSelectionPreference | null,
    provider: TAgentAssistantProviderId,
) {
    return normalizeStoredModelValue(preference?.modelsByProvider[provider])
        ?? fallbackAssistantModel(provider);
}

export function persistAssistantSelection(
    storage: Storage | undefined,
    provider: TAgentAssistantProviderId,
    model: string,
) {
    if (!storage) {
        return;
    }

    const currentPreference = readAssistantSelectionPreference(storage);
    const preference: IAssistantSelectionPreference = {
        provider,
        modelsByProvider: {
            ...currentPreference?.modelsByProvider,
            [provider]: normalizeStoredModelValue(model) ?? fallbackAssistantModel(provider),
        },
    };

    try {
        storage.setItem(STORAGE_KEYS.ASSISTANT_SELECTION, JSON.stringify(preference));
    } catch (error) {
        BrowserLogger.warn('assistant', 'Failed to persist assistant selection preference', { error });
    }
}

function defaultAssistantModel(
    provider: TAgentAssistantProviderId,
    providers: readonly IAgentAssistantProviderStatus[],
) {
    const defaultModel = providerDefaultModel(providers, provider);
    return defaultModel === 'default'
        ? fallbackAssistantModel(provider)
        : defaultModel;
}

export function selectedAssistantModelForProvider(
    storage: Storage | undefined,
    provider: TAgentAssistantProviderId,
    providers: readonly IAgentAssistantProviderStatus[],
    preference = readAssistantSelectionPreference(storage),
) {
    const preferred = normalizeStoredModelValue(preference?.modelsByProvider[provider]);
    const providerStatus = providers.find(candidate => candidate.id === provider);
    if (!providerStatus) {
        return preferred ?? fallbackAssistantModel(provider);
    }
    return providerStatus.models.find(model => model.id === preferred || model.resolvedModel === preferred)?.id
        ?? defaultAssistantModel(provider, providers);
}
