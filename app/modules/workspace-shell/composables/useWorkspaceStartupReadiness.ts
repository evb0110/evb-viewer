import type { Ref } from 'vue';
import {
    tryOnScopeDispose,
    until,
} from '@vueuse/core';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';

const STARTUP_OPEN_VISUAL_READY_EVENT_NAME = 'evb:startup-open-visual-ready';
const STARTUP_OPEN_VISUAL_READY_TIMEOUT_MS = 15_000;

function dispatchStartupOpenVisualReady(reason: string, timedOut = false) {
    if (typeof window === 'undefined') {
        return;
    }

    window.dispatchEvent(new CustomEvent(STARTUP_OPEN_VISUAL_READY_EVENT_NAME, {detail: {
        reason,
        timedOut,
    }}));
}

/**
 * Tells the startup overlay when the first opened document has settled in the
 * viewer, or that it gave up after the startup budget.
 */
export const useWorkspaceStartupReadiness = (documentViewerRef: Ref<IDocumentViewerExpose | null>) => {
    const latestRequest = shallowRef<symbol | null>(null);
    tryOnScopeDispose(() => {
        latestRequest.value = null;
    });

    // A newer open supersedes the wait at once instead of leaving it to the timeout.
    async function waitForViewerSettled(request: symbol) {
        await until(() => (
            latestRequest.value !== request
            || typeof documentViewerRef.value?.waitForViewerLoadSettled === 'function'
        )).toBe(true);
        const viewer = documentViewerRef.value;
        if (latestRequest.value !== request || !viewer?.waitForViewerLoadSettled) {
            return false;
        }
        await viewer.waitForViewerLoadSettled();
        return true;
    }

    function scheduleStartupOpenVisualReady(reason: string) {
        const request = Symbol(reason);
        latestRequest.value = request;
        const timeout = AbortSignal.timeout(STARTUP_OPEN_VISUAL_READY_TIMEOUT_MS);
        const timedOut = new Promise<false>((resolve) => {
            timeout.addEventListener('abort', () => resolve(false), {once: true});
        });
        void Promise.race([
            waitForViewerSettled(request),
            timedOut,
        ])
            .catch((error: unknown) => {
                BrowserLogger.diagnostic('loader', 'Startup visual readiness wait failed', error);
                return false;
            })
            .then((settled) => {
                if (latestRequest.value === request) {
                    dispatchStartupOpenVisualReady(reason, !settled);
                }
            });
    }

    return {
        scheduleStartupOpenVisualReady,
        dispatchStartupOpenVisualReady,
    };
};
