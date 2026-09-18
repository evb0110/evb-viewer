import { getAutomationEvents } from '@app/modules/workspace-shell/public';
import { readLastViewerInputAt } from '@app/modules/viewer-invariants/viewerActionLog';

/** The quiet window that makes an interaction finished rather than paused. */
const INPUT_QUIET_MS = 500;
const DEFAULT_SETTLE_TIMEOUT_MS = 6_000;
const PAGE_TRACK_SELECTOR = '[data-pdf-page-track]';
const PAGE_SKELETON_SELECTOR = '.document-page-skeleton';
const VIEWPORT_SELECTOR = '[data-document-viewer-chassis-viewport], #pdf-viewer';
const VISIBLE_PAGE_SELECTOR = '.page_container[data-page]:not(.page_container--buffered)';

export interface IViewerSettleOutcome {
    /** Null when settled; otherwise the condition that never became true. */
    reason: string | null;
    settled: boolean;
    waitedMs: number;
}

export interface IViewerSettleOptions {
    /**
     * Requires a `navigation-idle` automation event no older than the last
     * input. Off by default because the event only follows a page report and a
     * plain dev session never publishes it at all. A caller that just drove a
     * navigation turns it on, and then a missing event is a settle failure
     * rather than an unnoticed race.
     */
    requireNavigationIdle?: boolean;
    timeoutMs?: number;
}

function nextAnimationFrame() {
    return new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
}

/**
 * The navigation the last input asked for has reported idle. Anchoring on the
 * input rather than on the start of the wait keeps the condition true for a
 * caller that already waited for its own scroll to come to rest.
 */
function hasNavigationIdleSinceLastInput() {
    const lastInputAt = readLastViewerInputAt();
    return getAutomationEvents().some(event => (
        event.type === 'navigation-idle' && event.timestamp >= lastInputAt
    ));
}

/**
 * Page render completion, kept separate from UI readiness. A skeleton element
 * stays mounted for a page the viewer is not currently showing, so only a
 * painted skeleton inside a page that intersects the viewport means the viewer
 * is still resolving what the reader sees.
 */
function findPageRenderPending() {
    const track = document.querySelector<HTMLElement>(PAGE_TRACK_SELECTOR);
    const viewport = document.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
    if (!track || !viewport) {
        return 'the viewer has no page track';
    }
    if (track.classList.contains('pdfViewer--resize-transition')) {
        return 'the page track was mid-resize';
    }
    const viewportRect = viewport.getBoundingClientRect();
    const pending = [...track.querySelectorAll<HTMLElement>(VISIBLE_PAGE_SELECTOR)]
        .filter((container) => {
            const rect = container.getBoundingClientRect();
            return rect.bottom > viewportRect.top
                && rect.top < viewportRect.bottom
                && rect.right > viewportRect.left
                && rect.left < viewportRect.right;
        })
        .filter((container) => {
            const skeleton = container.querySelector<HTMLElement>(PAGE_SKELETON_SELECTOR);
            if (!skeleton) {
                return false;
            }
            const style = window.getComputedStyle(skeleton);
            const rect = skeleton.getBoundingClientRect();
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') !== 0
                && rect.width > 0
                && rect.height > 0;
        });
    return pending.length > 0
        ? `${String(pending.length)} visible pages were still showing a skeleton`
        : null;
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
    let lastPending = 'the wait never sampled a frame';

    while (Date.now() - startedAt < timeoutMs) {
        await nextAnimationFrame();
        const quietForMs = Date.now() - readLastViewerInputAt();
        if (quietForMs < INPUT_QUIET_MS) {
            lastPending = `input was still arriving ${String(quietForMs)}ms ago`;
            continue;
        }
        const pageRenderPending = findPageRenderPending();
        if (pageRenderPending) {
            lastPending = pageRenderPending;
            continue;
        }
        if (requireNavigationIdle && !hasNavigationIdleSinceLastInput()) {
            lastPending = 'no navigation-idle event followed the last input';
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
