import type {
    IAgentAssistantEffortOption,
    IAgentAssistantModelOption,
    TAgentAssistantEffort,
    TAgentAssistantSpeedMode,
} from '@contracts/agent';
export { ASSISTANT_KNOWN_EFFORTS } from '@contracts/agent';

// Start with balanced reasoning; users can choose more depth or a slower tier.
export const ASSISTANT_DEFAULT_EFFORT = 'medium' satisfies TAgentAssistantEffort;
export const ASSISTANT_DEFAULT_SPEED_MODE = 'fast' satisfies TAgentAssistantSpeedMode;
export const ASSISTANT_SPEED_MODES = [
    'fast',
    'standard',
] as const satisfies readonly TAgentAssistantSpeedMode[];
export const CLAUDE_ASSISTANT_EFFORTS = [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
] as const satisfies readonly TAgentAssistantEffort[];
export const CODEX_ASSISTANT_EFFORTS = [
    'low',
    'medium',
    'high',
    'xhigh',
] as const satisfies readonly TAgentAssistantEffort[];

const ASSISTANT_EFFORT_LABELS: Readonly<Record<string, string>> = {
    none: 'None',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra High',
    max: 'Max',
};

export function normalizeAssistantEffortId(value: unknown): TAgentAssistantEffort | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : null;
}

function titleCaseEffortSegment(segment: string) {
    return `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`;
}

export function getAssistantEffortFallbackLabel(effort: TAgentAssistantEffort) {
    const normalized = effort.trim();
    const knownLabel = ASSISTANT_EFFORT_LABELS[normalized];
    if (knownLabel) {
        return knownLabel;
    }

    const label = normalized
        .split(/[-_\s]+/u)
        .filter(Boolean)
        .map(titleCaseEffortSegment)
        .join(' ');
    return label || normalized;
}

export function createAssistantEffortOptions(
    efforts: readonly TAgentAssistantEffort[],
    defaultEffort: TAgentAssistantEffort | null = null,
) {
    const seen = new Set<string>();
    return efforts.flatMap((effort): IAgentAssistantEffortOption[] => {
        const id = normalizeAssistantEffortId(effort);
        if (!id || seen.has(id)) {
            return [];
        }
        seen.add(id);
        return [{
            id,
            label: getAssistantEffortFallbackLabel(id),
            ...(defaultEffort === id ? { isDefault: true } : {}),
        }];
    });
}

export function getAssistantDefaultModelId(
    models: readonly IAgentAssistantModelOption[],
    fallback = 'default',
) {
    return models[0]?.id ?? fallback;
}

export function getAssistantPreferredModelId(
    models: readonly IAgentAssistantModelOption[],
    preferredFamily: string,
    fallback = 'default',
) {
    const normalizedFamily = preferredFamily.toLowerCase();
    return models.find(model => (
        model.id.toLowerCase().includes(normalizedFamily)
        || model.label.toLowerCase().includes(normalizedFamily)
    ))?.id
        ?? getAssistantDefaultModelId(models, fallback);
}

// These rows are only used before the provider supplies its current model list.
export const CLAUDE_ASSISTANT_MODELS = [
    {
        id: 'opus',
        label: 'Opus',
    },
    {
        id: 'fable',
        label: 'Fable',
    },
] as const satisfies readonly IAgentAssistantModelOption[];

export const CLAUDE_ASSISTANT_DEFAULT_MODEL = getAssistantPreferredModelId(
    CLAUDE_ASSISTANT_MODELS,
    'opus',
);

const CODEX_ASSISTANT_FALLBACK_MODEL_ID = 'gpt-6-astra';

export const CODEX_ASSISTANT_FALLBACK_MODELS = [{
    id: CODEX_ASSISTANT_FALLBACK_MODEL_ID,
    label: `GPT-${CODEX_ASSISTANT_FALLBACK_MODEL_ID.slice(4).split('-').map(titleCaseEffortSegment).join('-')}`,
    reasoningEfforts: createAssistantEffortOptions(CODEX_ASSISTANT_EFFORTS, 'medium'),
    defaultReasoningEffort: 'medium',
    serviceTiers: [
        {
            id: 'fast',
            label: 'Fast',
            isDefault: true,
        },
        {
            id: 'standard',
            label: 'Standard',
        },
    ],
    defaultServiceTier: 'fast',
}] as const satisfies readonly IAgentAssistantModelOption[];

export const CODEX_ASSISTANT_DEFAULT_MODEL = getAssistantDefaultModelId(CODEX_ASSISTANT_FALLBACK_MODELS);
