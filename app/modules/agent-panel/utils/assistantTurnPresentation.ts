import {formatElapsedClock} from '@app/utils/progressFormatting';
import type { TAgentAssistantTurnPhase } from '@contracts/agent';
import type { TTranslateFn } from '@i18n-app';

export const ASSISTANT_AUTO_REFRESH_MIN_INTERVAL_MS = 2_500;
const ASSISTANT_SCROLL_STICKY_THRESHOLD_PX = 96;
export const ASSISTANT_STATUS_HEARTBEAT_MS = 1_000;
export const ASSISTANT_STATUS_TEXT_LIMIT = 140;

export function isAssistantMessageListNearBottom(element: HTMLElement | null) {
    if (!element) {
        return true;
    }
    return element.scrollHeight - element.scrollTop - element.clientHeight
        <= ASSISTANT_SCROLL_STICKY_THRESHOLD_PX;
}

export function isAssistantBtwCommand(value: string) {
    return value.trim().toLowerCase() === '/btw';
}

const ACTIVE_ASSISTANT_TURN_PHASES = new Set<TAgentAssistantTurnPhase>([
    'queued',
    'thinking',
    'streaming',
    'tool-running',
    'finalizing',
    'interrupting',
    'stalled',
]);

export function isActiveAssistantTurnPhase(phase: TAgentAssistantTurnPhase) {
    return ACTIVE_ASSISTANT_TURN_PHASES.has(phase);
}

export function truncateAssistantStatusText(value: string, limit: number) {
    const normalized = value.replace(/\s+/gu, ' ').trim();
    if (normalized.length <= limit) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

export function formatAssistantTurnStatus(options: {
    phase: TAgentAssistantTurnPhase;
    activity: string;
    ageReferenceMs: number | null;
    startedAtMs: number | null;
    nowMs: number;
    hasQueuedSteer: boolean;
    t: TTranslateFn;
}) {
    const age = options.ageReferenceMs === null
        ? null
        : formatElapsedClock(options.nowMs - options.ageReferenceMs);
    if (options.hasQueuedSteer && options.phase === 'interrupting') {
        return options.t('assistant.steerQueued');
    }
    if (options.phase === 'interrupting') {
        return age === null
            ? options.t('assistant.interrupting')
            : options.t('assistant.workingWithActivity', {
                activity: options.t('assistant.interrupting'),
                age,
            });
    }
    if (options.phase === 'queued') {
        return age === null
            ? options.t('assistant.startingTurn')
            : options.t('assistant.workingWithActivity', {
                activity: options.activity || options.t('assistant.startingTurn'),
                age,
            });
    }
    if (options.activity && age !== null) {
        return options.t('assistant.workingWithActivity', {
            activity: options.activity,
            age,
        });
    }
    if (options.startedAtMs !== null) {
        return options.t('assistant.workingElapsed', {age: formatElapsedClock(options.nowMs - options.startedAtMs)});
    }
    return options.t('assistant.working');
}
