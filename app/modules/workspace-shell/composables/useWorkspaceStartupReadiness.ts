import type { Ref } from 'vue';
import {
    tryOnScopeDispose,
    until,
} from '@vueuse/core';

const STARTUP_OPEN_VISUAL_READY_EVENT_NAME = 'evb:startup-open-visual-ready';
const STARTUP_OPEN_VISUAL_READY_TIMEOUT_MS = 15_000;

export function dispatchStartupOpenVisualReady(reason: string, timedOut = false) {
    if (typeof window === 'undefined') {
        return;
    }

    window.dispatchEvent(new CustomEvent(STARTUP_OPEN_VISUAL_READY_EVENT_NAME, {detail: {
        reason,
        timedOut,
    }}));
}

/**
 * Tells the startup overlay when the first opened document has settled, as
 * its open surface reports it, or that it gave up after the startup budget.
 */
export const useWorkspaceStartupReadiness = (documentOpenSettled: Readonly<Ref<boolean>>) => {
    let latestRequest: symbol | null = null;
    tryOnScopeDispose(() => {
        latestRequest = null;
    });

    function scheduleStartupOpenVisualReady(reason: string) {
        const request = Symbol(reason);
        latestRequest = request;
        // A newer open supersedes the wait at once instead of leaving it to the timeout.
        void until(() => latestRequest !== request || documentOpenSettled.value).toBe(true, {
            timeout: STARTUP_OPEN_VISUAL_READY_TIMEOUT_MS,
        }).then(() => {
            if (latestRequest === request) {
                dispatchStartupOpenVisualReady(reason, !documentOpenSettled.value);
            }
        });
    }

    return {
        scheduleStartupOpenVisualReady,
        dispatchStartupOpenVisualReady,
    };
};
