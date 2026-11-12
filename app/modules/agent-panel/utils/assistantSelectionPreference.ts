import * as v from 'valibot';
import {
    ASSISTANT_SELECTION_SCHEMA,
    type IAssistantInstanceStatus,
    type IAssistantSelection,
} from '@contracts/assistant';
import { STORAGE_KEYS } from '@app/constants/storageKeys';

export function readAssistantSelectionPreference(storage: Storage | undefined): IAssistantSelection | null {
    if (!storage) return null;
    try {
        const stored = storage.getItem(STORAGE_KEYS.ASSISTANT_SELECTION);
        if (stored) {
            const parsed = v.safeParse(ASSISTANT_SELECTION_SCHEMA, JSON.parse(stored));
            if (parsed.success) return parsed.output;
        }
        const old: unknown = JSON.parse(storage.getItem(STORAGE_KEYS.ASSISTANT_SELECTION_LEGACY) ?? 'null');
        if (typeof old !== 'object' || old === null || !('provider' in old)) return null;
        if (old.provider !== 'codex' && old.provider !== 'claude') return null;
        const model: unknown = 'model' in old && typeof old.model === 'string' ? old.model
            : 'modelsByProvider' in old && typeof old.modelsByProvider === 'object' && old.modelsByProvider !== null
                && old.provider in old.modelsByProvider ? Reflect.get(old.modelsByProvider, old.provider) : '';
        return {
            instanceId: old.provider,
            model: typeof model === 'string' ? model : '',
            effort: 'medium',
            speedMode: 'standard',
        };
    } catch {
        return null;
    }
}

export function persistAssistantSelection(storage: Storage | undefined, selection: IAssistantSelection) {
    try {
        storage?.setItem(STORAGE_KEYS.ASSISTANT_SELECTION, JSON.stringify(selection));
    } catch {
        // Storage can be unavailable; the in-memory selection remains usable.
    }
}

export function resolveAssistantSelection(
    selection: IAssistantSelection | null,
    instances: IAssistantInstanceStatus[],
    fallback: IAssistantSelection | null,
): IAssistantSelection | null {
    const instance = instances.find(item => item.id === selection?.instanceId)
        ?? instances.find(item => item.id === fallback?.instanceId && item.enabled)
        ?? instances.find(item => item.enabled);
    if (!instance) return null;
    const preferred = selection?.instanceId === instance.id ? selection : fallback;
    const model = instance.models.find(item => item.id === preferred?.model)
        ?? instance.models.find(item => item.id === instance.defaultModel);
    const efforts = model?.reasoningEfforts ?? [];
    const effort = efforts.find(item => item.id === preferred?.effort)?.id
        ?? model?.defaultReasoningEffort ?? efforts.find(item => item.isDefault)?.id ?? efforts[0]?.id ?? preferred?.effort ?? 'medium';
    return {
        instanceId: instance.id,
        model: model?.id ?? instance.defaultModel ?? '',
        effort,
        speedMode: preferred?.speedMode === 'fast' && model?.serviceTiers?.some(tier => tier.id === 'fast' || tier.id === 'priority')
            ? 'fast' : 'standard',
    };
}
