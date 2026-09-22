import type {
    TForwardPreloadLogToMain,
    TTracePreload,
} from '@electron/preload/preloadLog';

interface IStartupOverlayLifecycleDeps {
    tracePreload: TTracePreload;
    forwardPreloadLogToMain: TForwardPreloadLogToMain;
}

const STARTUP_OVERLAY_ID = 'evb-startup-overlay';
const STARTUP_OVERLAY_STYLE_ID = 'evb-startup-overlay-style';
const APP_READY_EVENT_NAME = 'evb:app-ready';
const STARTUP_OPEN_CLAIMED_EVENT_NAME = 'evb:startup-open-claimed';
const STARTUP_OPEN_VISUAL_READY_EVENT_NAME = 'evb:startup-open-visual-ready';
const DEV_STARTUP_OVERLAY_SHOWN_KEY = 'evb-viewer:dev:startup-overlay-shown';
const STARTUP_OVERLAY_SPINNER_SIZE_PX = 20;
const STARTUP_OVERLAY_GAP_PX = 10;
const STARTUP_OVERLAY_TEXT_FONT_SIZE_PX = 13;
const STARTUP_OVERLAY_TEXT_LINE_HEIGHT_PX = 13;
const STARTUP_OVERLAY_Z_INDEX = 2_147_483_647;
const STARTUP_OVERLAY_INNER_WIDTH_PX = 128;
const DEV_STARTUP_OVERLAY_APP_READY_DELAY_MS = 2200;
const STARTUP_OPEN_CLAIM_GRACE_MS = 300;
const MAX_WAIT_MS = 30_000;

function ensureStartupOverlayStyles(head: HTMLHeadElement) {
    if (document.getElementById(STARTUP_OVERLAY_STYLE_ID)) {
        return;
    }

    const style = document.createElement('style');
    style.id = STARTUP_OVERLAY_STYLE_ID;
    style.textContent = `
#${STARTUP_OVERLAY_ID} {
    position: fixed;
    inset: 0;
    z-index: ${STARTUP_OVERLAY_Z_INDEX};
    display: flex;
    align-items: center;
    justify-content: center;
    background: #ffffff;
    color: #475569;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1;
}
#${STARTUP_OVERLAY_ID} .evb-startup-overlay__inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: ${STARTUP_OVERLAY_GAP_PX}px;
    width: ${STARTUP_OVERLAY_INNER_WIDTH_PX}px;
    height: ${STARTUP_OVERLAY_SPINNER_SIZE_PX + STARTUP_OVERLAY_GAP_PX + STARTUP_OVERLAY_TEXT_LINE_HEIGHT_PX}px;
    min-height: ${STARTUP_OVERLAY_SPINNER_SIZE_PX + STARTUP_OVERLAY_GAP_PX + STARTUP_OVERLAY_TEXT_LINE_HEIGHT_PX}px;
}
#${STARTUP_OVERLAY_ID} .evb-startup-overlay__spinner {
    width: ${STARTUP_OVERLAY_SPINNER_SIZE_PX}px;
    height: ${STARTUP_OVERLAY_SPINNER_SIZE_PX}px;
    flex: 0 0 ${STARTUP_OVERLAY_SPINNER_SIZE_PX}px;
    border-radius: 999px;
    background: conic-gradient(
        from 0deg,
        rgba(0, 0, 0, 0.12) 0deg,
        rgba(0, 0, 0, 0.12) 260deg,
        rgba(0, 0, 0, 0.5) 360deg
    );
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0);
    mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0);
    animation: evb-startup-overlay-spin 1s linear infinite;
    will-change: transform;
    transform: translateZ(0);
}
#${STARTUP_OVERLAY_ID} .evb-startup-overlay__text {
    font-size: ${STARTUP_OVERLAY_TEXT_FONT_SIZE_PX}px;
    line-height: ${STARTUP_OVERLAY_TEXT_LINE_HEIGHT_PX}px;
    letter-spacing: 0.2px;
    margin: 0;
    font-weight: 400;
    height: ${STARTUP_OVERLAY_TEXT_LINE_HEIGHT_PX}px;
}
@keyframes evb-startup-overlay-spin {
    from { transform: translateZ(0) rotate(0deg); }
    to { transform: translateZ(0) rotate(360deg); }
}
`;
    head.appendChild(style);
}

function mountStartupOverlay(deps: IStartupOverlayLifecycleDeps) {
    if (document.getElementById(STARTUP_OVERLAY_ID)) {
        return;
    }

    const head = document.head;
    const body = document.body;
    if (!head || !body) {
        return;
    }

    ensureStartupOverlayStyles(head);
    const overlay = document.createElement('div');
    overlay.id = STARTUP_OVERLAY_ID;
    overlay.innerHTML = `
<div class="evb-startup-overlay__inner">
  <div class="evb-startup-overlay__spinner"></div>
  <div class="evb-startup-overlay__text">Loading...</div>
</div>
`;
    body.appendChild(overlay);
    deps.tracePreload('startup overlay mounted');
    deps.forwardPreloadLogToMain('debug', 'loader', 'Startup overlay mounted', {
        variant: 'startup-overlay',
        spinnerSizePx: STARTUP_OVERLAY_SPINNER_SIZE_PX,
        hasLabel: true,
    });
}

function unmountStartupOverlay(reason: string, deps: IStartupOverlayLifecycleDeps) {
    const overlay = document.getElementById(STARTUP_OVERLAY_ID);
    if (overlay) {
        overlay.remove();
        deps.tracePreload('startup overlay removed', { reason });
        deps.forwardPreloadLogToMain('debug', 'loader', 'Startup overlay removed', {
            variant: 'startup-overlay',
            reason,
        });
    }
}

export function installStartupOverlayLifecycle(deps: IStartupOverlayLifecycleDeps) {
    const overlayLifecycleStartedAt = Date.now();
    let waitingForStartupOpenVisual = false;
    let appReadySeen = false;
    let startupOpenClaimSeen = false;
    let overlayRemoved = false;
    let checkInterval: number | null = null;
    let appReadyRemovalTimer: number | null = null;
    let devRemovalTimer: number | null = null;
    let hardDeadlineTimer: number | null = null;

    function clearAppReadyRemovalTimer() {
        if (appReadyRemovalTimer === null) {
            return;
        }

        window.clearTimeout(appReadyRemovalTimer);
        appReadyRemovalTimer = null;
    }

    function clearDevRemovalTimer() {
        if (devRemovalTimer === null) {
            return;
        }

        window.clearTimeout(devRemovalTimer);
        devRemovalTimer = null;
    }

    function clearHardDeadlineTimer() {
        if (hardDeadlineTimer === null) {
            return;
        }

        window.clearTimeout(hardDeadlineTimer);
        hardDeadlineTimer = null;
    }

    function clearCheckInterval() {
        if (checkInterval === null) {
            return;
        }

        window.clearInterval(checkInterval);
        checkInterval = null;
    }

    function cleanupOverlayLifecycleListeners() {
        clearCheckInterval();
        clearAppReadyRemovalTimer();
        clearDevRemovalTimer();
        clearHardDeadlineTimer();
        window.removeEventListener(APP_READY_EVENT_NAME, handleAppReady);
        window.removeEventListener(STARTUP_OPEN_CLAIMED_EVENT_NAME, handleStartupOpenClaimed);
        window.removeEventListener(STARTUP_OPEN_VISUAL_READY_EVENT_NAME, handleStartupOpenVisualReady);
    }

    function removeOverlay(reason: string) {
        if (overlayRemoved) {
            return;
        }

        overlayRemoved = true;
        cleanupOverlayLifecycleListeners();
        unmountStartupOverlay(reason, deps);
    }

    function mountOverlayIfActive() {
        if (overlayRemoved) {
            return;
        }

        mountStartupOverlay(deps);
    }

    function requestOverlayUnmount(reason: string) {
        if (!process.defaultApp) {
            removeOverlay(reason);
            return;
        }

        const removeWithDelay = () => {
            const elapsedMs = Date.now() - overlayLifecycleStartedAt;
            if (elapsedMs >= DEV_STARTUP_OVERLAY_APP_READY_DELAY_MS) {
                removeOverlay(reason);
                return;
            }

            const delayMs = DEV_STARTUP_OVERLAY_APP_READY_DELAY_MS - elapsedMs;
            deps.forwardPreloadLogToMain('debug', 'loader', 'Startup overlay removal delayed for dev stabilization', {
                variant: 'startup-overlay',
                reason,
                delayMs,
                elapsedMs,
            });
            clearDevRemovalTimer();
            devRemovalTimer = window.setTimeout(() => {
                devRemovalTimer = null;
                removeOverlay(reason);
            }, delayMs);
        };

        removeWithDelay();
    }

    function scheduleAppReadyRemoval(reason: string) {
        appReadySeen = true;
        clearCheckInterval();
        clearHardDeadlineTimer();
        clearAppReadyRemovalTimer();

        appReadyRemovalTimer = window.setTimeout(() => {
            appReadyRemovalTimer = null;
            if (waitingForStartupOpenVisual) {
                deps.forwardPreloadLogToMain('debug', 'loader', 'Startup overlay retained for startup document visual readiness', {
                    variant: 'startup-overlay',
                    reason,
                });
                return;
            }

            if (!startupOpenClaimSeen) {
                deps.forwardPreloadLogToMain('debug', 'loader', 'Startup overlay retained until startup open claim is observed', {
                    variant: 'startup-overlay',
                    reason,
                });
                return;
            }

            requestOverlayUnmount(reason);
        }, STARTUP_OPEN_CLAIM_GRACE_MS);
    }

    function getStartupOpenPathCount(event: Event) {
        if (!(event instanceof CustomEvent)) {
            return 0;
        }

        const detail = event.detail as { pathCount?: unknown } | null;
        const pathCount = typeof detail?.pathCount === 'number' ? detail.pathCount : 0;
        if (!Number.isFinite(pathCount) || pathCount <= 0) {
            return 0;
        }

        return Math.floor(pathCount);
    }

    function handleStartupOpenClaimed(event: Event) {
        startupOpenClaimSeen = true;
        clearHardDeadlineTimer();
        const pathCount = getStartupOpenPathCount(event);
        if (pathCount > 0) {
            waitingForStartupOpenVisual = true;
            clearAppReadyRemovalTimer();
            deps.forwardPreloadLogToMain('debug', 'loader', 'Startup external open claimed; retaining overlay until first document paint', {
                variant: 'startup-overlay',
                pathCount,
            });
            return;
        }

        waitingForStartupOpenVisual = false;
        if (appReadySeen || (window as Window & { __appReady?: boolean }).__appReady) {
            scheduleAppReadyRemoval('startup-open-claimed-empty');
        }
    }

    function handleStartupOpenVisualReady(event: Event) {
        waitingForStartupOpenVisual = false;
        const detail = event instanceof CustomEvent ? event.detail as Record<string, unknown> | null : null;
        deps.forwardPreloadLogToMain('debug', 'loader', 'Startup document visual readiness reached', {
            variant: 'startup-overlay',
            reason: typeof detail?.reason === 'string' ? detail.reason : 'startup-open-visual-ready',
            timedOut: detail?.timedOut === true,
        });
        requestOverlayUnmount('startup-open-visual-ready');
    }

    function handleAppReady() {
        scheduleAppReadyRemoval('app-ready-event');
    }

    if (process.defaultApp) {
        try {
            const overlayAlreadyShown = window.sessionStorage.getItem(DEV_STARTUP_OVERLAY_SHOWN_KEY) === '1';
            if (overlayAlreadyShown) {
                deps.tracePreload('startup overlay continuing across dev reload', {reason: DEV_STARTUP_OVERLAY_SHOWN_KEY});
                deps.forwardPreloadLogToMain('debug', 'loader', 'Startup overlay continuing across dev reload', {variant: 'startup-overlay'});
            }

            window.sessionStorage.setItem(DEV_STARTUP_OVERLAY_SHOWN_KEY, '1');
        } catch {
            // sessionStorage may be unavailable
        }
    }

    mountOverlayIfActive();

    hardDeadlineTimer = window.setTimeout(() => {
        hardDeadlineTimer = null;
        if (appReadySeen || startupOpenClaimSeen || waitingForStartupOpenVisual) {
            return;
        }
        requestOverlayUnmount('timeout');
    }, MAX_WAIT_MS);

    // The app-ready event covers the normal path; this poll only catches a flag that was
    // set outside it, so it checks once immediately and then idles instead of waking the
    // renderer 20 times a second through the whole startup window.
    if ((window as Window & { __appReady?: boolean }).__appReady) {
        scheduleAppReadyRemoval('__appReady-initial');
    } else {
        checkInterval = window.setInterval(() => {
            const windowWithReady = window as Window & { __appReady?: boolean };
            if (windowWithReady.__appReady) {
                scheduleAppReadyRemoval('__appReady-interval');
            }
        }, 250);
    }

    window.addEventListener(APP_READY_EVENT_NAME, handleAppReady, { once: true });
    window.addEventListener(STARTUP_OPEN_CLAIMED_EVENT_NAME, handleStartupOpenClaimed, { once: true });
    window.addEventListener(STARTUP_OPEN_VISUAL_READY_EVENT_NAME, handleStartupOpenVisualReady, { once: true });

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', () => {
            deps.tracePreload('DOMContentLoaded observed');
            mountOverlayIfActive();
        }, { once: true });
    }
}
