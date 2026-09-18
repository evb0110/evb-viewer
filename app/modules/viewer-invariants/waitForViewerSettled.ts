import { getAutomationEvents } from '@app/modules/workspace-shell/public';
import { readLastViewerInputAt } from '@app/modules/viewer-invariants/viewerActionLog';

/** The quiet window that makes an interaction finished rather than paused. */
const INPUT_QUIET_MS = 500;
const DEFAULT_SETTLE_TIMEOUT_MS = 6_000;
const PAGE_TRACK_SELECTOR = '[data-pdf-page-track]';
const PAGE_SKELETON_SELECTOR = '.document-page-skeleton';

export interface IViewerSettleOutcome {
    /** Null when settled; otherwise the condition that never became true. */
    reason: string | null;
    settled: boolean;
    waitedMs: number;
}

export interface IViewerSettleOptions {
    /**
     * Requires a `navigation-idle` automation event after the wait started.
     * Off by default because the event only follows a page report and a plain
     * dev session never publishes it at all. A caller that just drove a
     * navigation turns it on, and then a missing event is a settle failure
     * rather than an unnoticed race.
     */
    requireNavigationIdle?: boolean;
    timeoutMs?: number;
}

function nextAnimationFrame() {
    return new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
}

function latestAutomationEventId() {
    return getAutomationEvents().at(-1)?.id ?? 0;
}

function hasNavigationIdleAfter(eventId: number) {
    return getAutomationEvents().some(event => event.type === 'navigation-idle' && event.id > eventId);
}

function isPageRenderQuiet() {
    const track = document.querySelector<HTMLElement>(PAGE_TRACK_SELECTOR);
    if (!track) {
        return false;
    }
    if (track.classList.contains('pdfViewer--resize-transition')) {
        return false;
    }
    return track.querySelector(PAGE_SKELETON_SELECTOR) === null;
}

/**
 * Waits until the viewer is settled: no input for the quiet window, no page
 * still laying out, and, when the automation event stream is publishing, a
 * `navigation-idle` observed since the wait began.
 *
 * The timeout is independent of the caller. Failing to settle is reported as
 * an outcome so it can be raised as a violation, never as a reason to skip a
 * check.
 */
export async function waitForViewerSettled(
    options: IViewerSettleOptions = {},
): Promise<IViewerSettleOutcome> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    const requireNavigationIdle = options.requireNavigationIdle ?? false;
    const startedAt = Date.now();
    const baselineEventId = latestAutomationEventId();
    let lastPending = 'the wait never sampled a frame';

    while (Date.now() - startedAt < timeoutMs) {
        await nextAnimationFrame();
        const quietForMs = Date.now() - readLastViewerInputAt();
        if (quietForMs < INPUT_QUIET_MS) {
            lastPending = `input was still arriving ${String(quietForMs)}ms ago`;
            continue;
        }
        if (!isPageRenderQuiet()) {
            lastPending = 'pages were still laying out';
            continue;
        }
        if (requireNavigationIdle && !hasNavigationIdleAfter(baselineEventId)) {
            lastPending = 'no navigation-idle event arrived after the wait began';
            continue;
        }
        return {
            reason: null,
            settled: true,
            waitedMs: Date.now() - startedAt,
        };
    }

    return {
        reason: `${lastPending} within ${String(timeoutMs)}ms`,
        settled: false,
        waitedMs: Date.now() - startedAt,
    };
}
