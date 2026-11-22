import { shallowRef } from 'vue';
import { until } from '@vueuse/core';

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
 * Tells the startup overlay that the shown startup document presented its
 * first view, or that it gave up after the startup budget. An open that ends
 * without its first view leaves the overlay to its error or password exit.
 */
export async function reportStartupFirstView(presented: Promise<boolean>) {
    const shown = shallowRef(false);
    void presented.then((value) => {
        shown.value = value;
    }, () => {});
    await until(shown).toBe(true, {timeout: STARTUP_OPEN_VISUAL_READY_TIMEOUT_MS});
    // An expired wait reports that, never that the document painted.
    dispatchStartupOpenVisualReady(shown.value ? 'first-view-presented' : 'timed-out', !shown.value);
}
