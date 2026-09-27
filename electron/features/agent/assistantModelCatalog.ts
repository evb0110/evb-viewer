import type {
    IAgentAssistantEffortOption,
    IAgentAssistantModelOption,
    IAgentAssistantServiceTierOption,
} from '@contracts/agent';
import {
    CODEX_ASSISTANT_DEFAULT_MODEL,
    getAssistantEffortFallbackLabel,
    normalizeAssistantEffortId,
} from '@contracts/agentModels';
import { isRecord } from '@contracts/runtimeGuards';

export type TCodexAssistantModelOption = IAgentAssistantModelOption & { isDefault?: boolean };

const CODEX_GPT_MODEL_VERSION_PATTERN = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/iu;

interface ICodexReasoningEffortMetadata {
    reasoningEfforts: IAgentAssistantEffortOption[] | null;
    defaultReasoningEffort: IAgentAssistantModelOption['defaultReasoningEffort'];
}

function normalizeCodexServiceTier(rawTier: unknown): IAgentAssistantServiceTierOption | null {
    if (typeof rawTier === 'string') {
        const id = rawTier.trim();
        return id
            ? {
                id,
                label: id === 'fast' || id === 'priority' ? 'Fast' : id,
            }
            : null;
    }

    if (!isRecord(rawTier)) {
        return null;
    }

    const id = typeof rawTier.id === 'string' && rawTier.id.trim()
        ? rawTier.id.trim()
        : typeof rawTier.value === 'string' && rawTier.value.trim()
            ? rawTier.value.trim()
            : '';
    if (!id) {
        return null;
    }

    const label = typeof rawTier.name === 'string' && rawTier.name.trim()
        ? rawTier.name.trim()
        : typeof rawTier.label === 'string' && rawTier.label.trim()
            ? rawTier.label.trim()
            : id === 'fast' || id === 'priority'
                ? 'Fast'
                : id;
    return {
        id,
        label,
        ...(typeof rawTier.description === 'string' && rawTier.description.trim()
            ? { description: rawTier.description.trim() }
            : {}),
        ...(rawTier.isDefault === true ? { isDefault: true } : {}),
    };
}

function normalizeCodexServiceTiers(rawModel: Record<PropertyKey, unknown>) {
    const rawTiers = Array.isArray(rawModel.serviceTiers)
        ? rawModel.serviceTiers
        : Array.isArray(rawModel.additionalSpeedTiers)
            ? rawModel.additionalSpeedTiers
            : [];
    const seen = new Set<string>();
    return rawTiers
        .map(normalizeCodexServiceTier)
        .filter((tier): tier is IAgentAssistantServiceTierOption => {
            if (!tier || seen.has(tier.id)) {
                return false;
            }
            seen.add(tier.id);
            return true;
        });
}

function normalizeCodexReasoningEffort(
    rawEffort: unknown,
    defaultReasoningEffort: IAgentAssistantModelOption['defaultReasoningEffort'],
): IAgentAssistantEffortOption | null {
    const rawId = isRecord(rawEffort)
        ? rawEffort.reasoningEffort ?? rawEffort.id ?? rawEffort.value
        : rawEffort;
    const id = normalizeAssistantEffortId(rawId);
    if (!id) {
        return null;
    }

    const label = isRecord(rawEffort) && typeof rawEffort.label === 'string' && rawEffort.label.trim()
        ? rawEffort.label.trim()
        : isRecord(rawEffort) && typeof rawEffort.name === 'string' && rawEffort.name.trim()
            ? rawEffort.name.trim()
            : getAssistantEffortFallbackLabel(id);
    return {
        id,
        label,
        ...(isRecord(rawEffort) && typeof rawEffort.description === 'string' && rawEffort.description.trim()
            ? { description: rawEffort.description.trim() }
            : {}),
        ...((isRecord(rawEffort) && rawEffort.isDefault === true) || defaultReasoningEffort === id
            ? { isDefault: true }
            : {}),
    };
}

function normalizeCodexReasoningEfforts(
    rawModel: Record<PropertyKey, unknown>,
): ICodexReasoningEffortMetadata {
    const defaultReasoningEffort = normalizeAssistantEffortId(rawModel.defaultReasoningEffort);
    const rawEfforts = Array.isArray(rawModel.supportedReasoningEfforts)
        ? rawModel.supportedReasoningEfforts
        : Array.isArray(rawModel.reasoningEfforts)
            ? rawModel.reasoningEfforts
            : null;
    if (!rawEfforts) {
        return {
            reasoningEfforts: null,
            defaultReasoningEffort,
        };
    }

    const seen = new Set<string>();
    return {
        reasoningEfforts: rawEfforts
            .map(rawEffort => normalizeCodexReasoningEffort(rawEffort, defaultReasoningEffort))
            .filter((effort): effort is IAgentAssistantEffortOption => {
                if (!effort || seen.has(effort.id)) {
                    return false;
                }
                seen.add(effort.id);
                return true;
            }),
        defaultReasoningEffort,
    };
}

function normalizeCodexModelOption(rawModel: unknown): TCodexAssistantModelOption | null {
    if (!isRecord(rawModel) || rawModel.hidden === true) {
        return null;
    }

    const id = typeof rawModel.model === 'string' && rawModel.model.trim()
        ? rawModel.model.trim()
        : typeof rawModel.id === 'string' && rawModel.id.trim()
            ? rawModel.id.trim()
            : '';
    if (!id) {
        return null;
    }

    const label = typeof rawModel.displayName === 'string' && rawModel.displayName.trim()
        ? rawModel.displayName.trim()
        : id;
    const {
        reasoningEfforts,
        defaultReasoningEffort,
    } = normalizeCodexReasoningEfforts(rawModel);
    const serviceTiers = normalizeCodexServiceTiers(rawModel);
    const defaultServiceTier = typeof rawModel.defaultServiceTier === 'string' && rawModel.defaultServiceTier.trim()
        ? rawModel.defaultServiceTier.trim()
        : serviceTiers.find(tier => tier.isDefault)?.id ?? null;
    return {
        id,
        label,
        ...(reasoningEfforts ? { reasoningEfforts } : {}),
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
        ...(serviceTiers.length > 0 ? { serviceTiers } : {}),
        ...(defaultServiceTier ? { defaultServiceTier } : {}),
        ...(rawModel.isDefault === true ? {isDefault: true} : {}),
    };
}

export function normalizeCodexModelListResponse(value: unknown) {
    if (!isRecord(value) || !Array.isArray(value.data)) {
        return null;
    }

    const seen = new Set<string>();
    const listedModels = value.data
        .map(normalizeCodexModelOption)
        .filter((model): model is TCodexAssistantModelOption => {
            if (!model || seen.has(model.id)) {
                return false;
            }
            seen.add(model.id);
            return true;
        });
    const versions = listedModels.flatMap(model => {
        const match = CODEX_GPT_MODEL_VERSION_PATTERN.exec(model.id);
        return match
            ? [{
                model,
                major: Number(match[1]),
                minor: Number(match[2] ?? 0),
            }]
            : [];
    });
    if (versions.length === 0) {
        return listedModels;
    }

    const newest = versions.reduce((current, candidate) => (
        candidate.major > current.major
        || (candidate.major === current.major && candidate.minor > current.minor)
            ? candidate
            : current
    ));
    return listedModels.filter(model => {
        const version = versions.find(candidate => candidate.model.id === model.id);
        return !version || (version.major === newest.major && version.minor === newest.minor);
    });
}

export function resolveCodexDefaultModelId(models: readonly TCodexAssistantModelOption[]) {
    return models.find(option => option.isDefault)?.id
        ?? models.find(option => CODEX_GPT_MODEL_VERSION_PATTERN.test(option.id))?.id
        ?? models[0]?.id
        ?? CODEX_ASSISTANT_DEFAULT_MODEL;
}

export function normalizeCodexAssistantModelFromCatalog(
    models: readonly TCodexAssistantModelOption[],
    model: string | null | undefined,
) {
    const fallback = resolveCodexDefaultModelId(models);
    const trimmed = model?.trim();
    if (!trimmed) {
        return fallback;
    }

    return models.some(option => option.id === trimmed)
        ? trimmed
        : fallback;
}

export function resolveCodexModelStatus(
    models: readonly TCodexAssistantModelOption[],
    requestedModel: string | null | undefined,
) {
    return {
        models,
        defaultModel: resolveCodexDefaultModelId(models),
        activeModel: normalizeCodexAssistantModelFromCatalog(models, requestedModel),
    };
}
