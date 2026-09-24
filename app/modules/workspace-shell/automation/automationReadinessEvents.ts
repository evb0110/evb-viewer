import type {
    IEvbAutomationEvent,
    TEvbAutomationEventListener,
    TEvbAutomationEventPredicate,
    TEvbAutomationEventType,
} from '@app/types/evbAutomationEvents';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';
import { isAutomationSession } from '@app/utils/isAutomationSession';

const DEFAULT_AUTOMATION_EVENT_TIMEOUT_MS = 30_000;
const MAX_AUTOMATION_EVENTS = 200;

let nextEventId = 1;
const automationEvents: IEvbAutomationEvent[] = [];
const listeners = new Set<TEvbAutomationEventListener>();

export async function publishStagedPdfNativeMutationForAutomation(
    stagedArtifact: ITypedStagedArtifact,
) {
    if (!isAutomationSession()) {
        return;
    }
    await window.__stagedPdfNativeMutationCommitBarrierForAutomation?.(stagedArtifact);
}

export function emitAutomationEvent<TDetail extends Record<string, unknown> = Record<string, unknown>>(
    type: TEvbAutomationEventType,
    detail = {} as TDetail,
) {
    if (!isAutomationSession()) {
        return null;
    }

    const event: IEvbAutomationEvent<TDetail> = {
        detail,
        id: nextEventId,
        timestamp: Date.now(),
        type,
    };
    nextEventId += 1;
    automationEvents.push(event);
    if (automationEvents.length > MAX_AUTOMATION_EVENTS) {
        automationEvents.splice(0, automationEvents.length - MAX_AUTOMATION_EVENTS);
    }
    for (const listener of listeners) {
        listener(event);
    }
    return event;
}

export function getAutomationEvents() {
    return [...automationEvents];
}

export function onAutomationEvent(listener: TEvbAutomationEventListener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function waitForAutomationEvent(
    type: TEvbAutomationEventType,
    predicate: TEvbAutomationEventPredicate = () => true,
    timeoutMs = DEFAULT_AUTOMATION_EVENT_TIMEOUT_MS,
) {
    const existing = automationEvents.find(event => event.type === type && predicate(event));
    if (existing) {
        return Promise.resolve(existing);
    }

    return new Promise<IEvbAutomationEvent>((resolve, reject) => {
        let unsubscribe: (() => void) | null = null;
        const timeout = setTimeout(() => {
            unsubscribe?.();
            reject(new Error(`Timed out waiting for automation event '${type}' after ${timeoutMs}ms`));
        }, timeoutMs);

        unsubscribe = onAutomationEvent((event) => {
            if (event.type !== type || !predicate(event)) {
                return;
            }

            clearTimeout(timeout);
            unsubscribe?.();
            resolve(event);
        });
    });
}
