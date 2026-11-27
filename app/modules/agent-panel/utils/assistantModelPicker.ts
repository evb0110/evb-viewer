import type {IAgentAssistantModelOption} from '@contracts/agent';
import type {IAssistantInstanceStatus} from '@contracts/assistant';

export type TModelPickerTab = 'favorites' | string;

export interface IModelPickerItem {
    key: string;
    instance: IAssistantInstanceStatus;
    model: IAgentAssistantModelOption;
    isFavorite: boolean;
}

export function modelPickerKey(instanceId: string, modelId: string) {
    return JSON.stringify([instanceId, modelId]);
}

export function isPickableInstance(instance: IAssistantInstanceStatus) {
    return instance.enabled && instance.state !== 'disabled' && instance.models.length > 0;
}

/** Adapted from T3 Code providerInstanceDisplay.ts providerInstanceInitials (0b6f482dc5), MIT. */
export function instanceInitials(label: string) {
    const words = label
        .replace(/[^\P{P}'’]+/gu, ' ')
        .split(/\s+/u)
        .map((word) => word.replace(/^['’]+|['’]+$/gu, ''))
        // A path's "~" names no word.
        .filter((word) => /^[\p{L}\p{N}]/u.test(word));
    if (words.length === 0) {
        return '';
    }
    if (words.length === 1) {
        return Array.from(words[0] ?? '')
            .slice(0, 2)
            .join('')
            .toUpperCase();
    }
    return words
        .slice(0, 2)
        .map((word) => Array.from(word)[0]?.toUpperCase() ?? '')
        .join('');
}

/**
 * Adapted from T3 Code shouldShowInstanceBadge (0b6f482dc5), MIT: a second
 * instance of one provider carries its initials, taken from the words that
 * set it apart ("Codex · codex-proxy" reads CP).
 */
export function instanceBadge(instance: IAssistantInstanceStatus, instances: readonly IAssistantInstanceStatus[]) {
    const shared = instances.filter((candidate) => candidate.driver === instance.driver && (!instance.enabled || candidate.enabled));
    if (shared.length < 2) {
        return '';
    }
    const own = instance.label.split(' · ').slice(1).join(' ') || instance.label;
    return instanceInitials(own);
}

function normalize(value: string) {
    return value.trim().toLowerCase();
}

// Adapted from T3 Code packages/shared/src/searchRanking.ts (0b6f482dc5), MIT, with ignorePosition.
function scoreSubsequence(value: string, query: string) {
    let queryIndex = 0;
    let first = -1;
    let previous = -1;
    let gaps = 0;
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== query[queryIndex]) {
            continue;
        }
        if (first === -1) {
            first = index;
        }
        if (previous !== -1) {
            gaps += index - previous - 1;
        }
        previous = index;
        queryIndex += 1;
        if (queryIndex === query.length) {
            return gaps * 3 + (index - first + 1 - query.length);
        }
    }
    return null;
}

function scoreToken(field: string, token: string, base: number) {
    if (!field || !token) {
        return null;
    }
    if (field === token) {
        return base;
    }
    if (field.startsWith(token)) {
        return base + 2;
    }
    if ([' ', '-', '_', '/'].some((marker) => field.includes(`${marker}${token}`))) {
        return base + 4;
    }
    if (field.includes(token)) {
        return base + 6;
    }
    if (token.length >= 3) {
        const fuzzy = scoreSubsequence(field, token);
        if (fuzzy !== null) {
            return base + 100 + fuzzy;
        }
    }
    return null;
}

/** Adapted from T3 Code packages/client-runtime/src/modelSearch.ts (0b6f482dc5), MIT. */
export function scoreModelSearch(item: IModelPickerItem, query: string) {
    const tokens = normalize(query).split(/\s+/u).filter(Boolean);
    if (tokens.length === 0) {
        return 0;
    }
    const joined = tokens.join(' ');
    const name = normalize(item.model.label).replace(/\s+/gu, ' ');
    const shortName = normalize(item.model.shortLabel ?? '').replace(/\s+/gu, ' ');
    if (joined === name || joined === shortName) {
        return -1000;
    }
    const fields = [
        name,
        ...(shortName ? [shortName] : []),
        normalize(item.instance.driver),
        normalize(item.instance.label),
        normalize([item.model.label, item.model.shortLabel, item.instance.driver, item.instance.label].filter(Boolean).join(' ')),
    ];
    let score = 0;
    for (const token of tokens) {
        const scores = fields.flatMap((field, index) => {
            const value = scoreToken(field, token, index * 10);
            return value === null ? [] : [value];
        });
        if (scores.length === 0) {
            return null;
        }
        score += Math.min(...scores);
    }
    return item.isFavorite ? score - 24 : score;
}

export function rankModelSearch(items: readonly IModelPickerItem[], query: string) {
    return items
        .map((item, order) => ({
            item,
            order,
            score: scoreModelSearch(item, query),
        }))
        .filter((entry): entry is {item: IModelPickerItem; order: number; score: number} => entry.score !== null)
        .sort((a, b) => a.score - b.score || Number(b.item.isFavorite) - Number(a.item.isFavorite) || a.order - b.order)
        .map((entry) => entry.item);
}

export function isApplePlatform() {
    return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.platform);
}

/** ⌘1 through ⌘9 (Ctrl elsewhere) pick the first nine rows while the picker is open. */
export function modelJumpLabel(index: number) {
    if (index > 8) {
        return '';
    }
    return isApplePlatform() ? `⌘${index + 1}` : `Ctrl+${index + 1}`;
}

export function modelJumpIndex(event: KeyboardEvent) {
    const modifier = isApplePlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!modifier || event.altKey || event.shiftKey) {
        return null;
    }
    const digit = /^Digit([1-9])$/u.exec(event.code)?.[1];
    return digit ? Number(digit) - 1 : null;
}
