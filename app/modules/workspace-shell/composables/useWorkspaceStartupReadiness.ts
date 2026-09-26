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
    let latestRequest: symbol | null = null;
    tryOnScopeDispose(() => {
        latestRequest = null;
    });

    async function waitForViewerSettled(signal: AbortSignal) {
        const viewer = await until(documentViewerRef).toMatch(
            candidate => typeof candidate?.waitForViewerLoadSettled === 'function',
            {timeout: STARTUP_OPEN_VISUAL_READY_TIMEOUT_MS},
        );
        if (!viewer?.waitForViewerLoadSettled || signal.aborted) {
            return false;
        }
        await viewer.waitForViewerLoadSettled();
        return true;
    }

    function scheduleStartupOpenVisualReady(reason: string) {
        const request = Symbol(reason);
        latestRequest = request;
        const timeout = AbortSignal.timeout(STARTUP_OPEN_VISUAL_READY_TIMEOUT_MS);
        const timedOut = new Promise<false>((resolve) => {
            timeout.addEventListener('abort', () => resolve(false), {once: true});
        });
        void Promise.race([
            waitForViewerSettled(timeout),
            timedOut,
        ])
            .catch((error: unknown) => {
                BrowserLogger.diagnostic('loader', 'Startup visual readiness wait failed', error);
                return false;
            })
            .then((settled) => {
                if (latestRequest === request) {
                    dispatchStartupOpenVisualReady(reason, !settled);
                }
            });
    }

    return {
        scheduleStartupOpenVisualReady,
        dispatchStartupOpenVisualReady,
    };
};
