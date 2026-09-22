import { getErrorMessage } from '@electron/utils/error';
import type { ILogger } from '@electron/utils/createLogger';
import type { BrowserWindow } from 'electron';
import {
    deleteWindowRendererReadyCallback,
    deleteWindowRendererReadyState,
    setWindowRendererReadyCallback,
} from '@electron/window/rendererReady';
import { unregisterAppWindow } from '@electron/window/registry';

interface IAttachShowLifecycleOptions {
    blockShowUntilRendererReady?: boolean;
    isDev: boolean;
    logger: ILogger;
    showAndFocusMaximizedWindow: (window: BrowserWindow) => void;
    logWindowStartup: (phase: string, details?: Record<string, unknown>) => void;
}

export function attachShowLifecycle(
    window: BrowserWindow,
    options: IAttachShowLifecycleOptions,
) {
    const windowId = window.id;
    const windowWebContents = window.webContents;
    let hasShownWindow = false;
    let pendingShowTimeout: NodeJS.Timeout | null = null;
    let forceShowTimeout: NodeJS.Timeout | null = null;
    let mainFrameLoadFinished = false;
    const blockShowUntilRendererReady = options.blockShowUntilRendererReady ?? false;
    let rendererReadyForShow = !blockShowUntilRendererReady;

    const SHOW_DEBOUNCE_MS = 0;
    const FORCE_SHOW_MS = options.isDev ? 5_000 : 15_000;
    const STABILITY_WINDOW_MS = options.isDev ? 200 : 500;
    let lastNavigationTime = 0;
    let stabilityCheckTimeout: NodeJS.Timeout | null = null;
    const isStartupPlaceholderUrl = (url: string) => url === 'about:blank';

    const logNavEvent = (event: string, details?: Record<string, unknown>) => {
        if (options.isDev) {
            const info = {
                timestamp: Date.now(),
                windowId: window.id,
                hasShownWindow,
                pendingShowTimeout: !!pendingShowTimeout,
                stabilityCheckTimeout: !!stabilityCheckTimeout,
                ...details,
            };
            options.logger.debug(event, info);
        }
    };

    const cleanupShowHandlers = () => {
        try {
            windowWebContents.removeListener('did-start-navigation', onStartNavigation);
            windowWebContents.removeListener('did-finish-load', onFinishLoad);
        } catch (error) {
            options.logger.warn('Failed to cleanup startup show listeners', {
                windowId,
                error: getErrorMessage(error),
            });
        }
        deleteWindowRendererReadyCallback(windowId);
    };

    const showWindowNow = async () => {
        if (window.isDestroyed() || hasShownWindow) {
            return;
        }
        hasShownWindow = true;

        if (pendingShowTimeout) {
            clearTimeout(pendingShowTimeout);
            pendingShowTimeout = null;
        }
        if (forceShowTimeout) {
            clearTimeout(forceShowTimeout);
            forceShowTimeout = null;
        }
        if (stabilityCheckTimeout) {
            clearTimeout(stabilityCheckTimeout);
            stabilityCheckTimeout = null;
        }

        if (options.isDev) {
            options.showAndFocusMaximizedWindow(window);
            logNavEvent('window-shown-early-for-dev');

            try {
                await window.webContents.executeJavaScript(`
                    window.__navigationTimeline = window.__navigationTimeline || [];
                    window.__navigationTimeline.push({
                        event: 'window-shown',
                        timestamp: ${Date.now()},
                    });
                `);
            } catch {
                // Page might be navigating.
            }
        } else {
            options.showAndFocusMaximizedWindow(window);
        }

        options.logWindowStartup(`Window shown (windowId=${window.id})`, {hasShownWindow});
        cleanupShowHandlers();
    };

    const checkStabilityAndShow = () => {
        if (hasShownWindow || window.isDestroyed()) {
            return;
        }
        if (!rendererReadyForShow) {
            logNavEvent('stability-check-waiting-for-rendererReady');
            return;
        }

        const timeSinceLastNav = Date.now() - lastNavigationTime;
        if (timeSinceLastNav >= STABILITY_WINDOW_MS) {
            logNavEvent('stability-check-passed', { timeSinceLastNav });
            void showWindowNow();
            return;
        }

        const remaining = STABILITY_WINDOW_MS - timeSinceLastNav;
        logNavEvent('stability-check-pending', {
            timeSinceLastNav,
            remaining,
        });
        stabilityCheckTimeout = setTimeout(checkStabilityAndShow, remaining + 50);
    };

    const scheduleDevStabilityCheck = () => {
        if (stabilityCheckTimeout) {
            clearTimeout(stabilityCheckTimeout);
        }
        stabilityCheckTimeout = setTimeout(checkStabilityAndShow, STABILITY_WINDOW_MS);
    };

    const scheduleShow = () => {
        if (hasShownWindow || window.isDestroyed()) {
            return;
        }
        if (!rendererReadyForShow) {
            logNavEvent('show-suppressed-pending-rendererReady');
            return;
        }
        if (pendingShowTimeout) {
            clearTimeout(pendingShowTimeout);
        }
        pendingShowTimeout = setTimeout(() => {
            void showWindowNow();
        }, SHOW_DEBOUNCE_MS);
    };

    const scheduleForceShowTimeout = () => {
        if (forceShowTimeout || hasShownWindow || window.isDestroyed()) {
            return;
        }

        forceShowTimeout = setTimeout(() => {
            void showWindowNow();
        }, FORCE_SHOW_MS);
    };

    const onRendererReadyForShow = () => {
        rendererReadyForShow = true;
        logNavEvent('rendererReady-for-show', { mainFrameLoadFinished });
        scheduleForceShowTimeout();

        if (!mainFrameLoadFinished || hasShownWindow) {
            return;
        }

        if (options.isDev) {
            scheduleDevStabilityCheck();
            return;
        }

        scheduleShow();
    };

    const onStartNavigation = (
        _event: unknown,
        url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (!isMainFrame || isStartupPlaceholderUrl(url)) {
            return;
        }

        if (!isInPlace) {
            mainFrameLoadFinished = false;
        }
        lastNavigationTime = Date.now();
        logNavEvent('navigation-start', {
            url,
            isInPlace,
        });

        if (hasShownWindow) {
            return;
        }
        if (pendingShowTimeout) {
            clearTimeout(pendingShowTimeout);
            pendingShowTimeout = null;
        }
        if (stabilityCheckTimeout) {
            clearTimeout(stabilityCheckTimeout);
            stabilityCheckTimeout = null;
        }
        if (isInPlace && rendererReadyForShow && mainFrameLoadFinished && options.isDev) {
            scheduleDevStabilityCheck();
        }
    };

    const onFinishLoad = () => {
        if (isStartupPlaceholderUrl(window.webContents.getURL())) {
            return;
        }

        mainFrameLoadFinished = true;
        lastNavigationTime = Date.now();
        logNavEvent('navigation-finish-load');

        if (hasShownWindow) {
            return;
        }
        if (!rendererReadyForShow) {
            logNavEvent('finish-load-waiting-for-rendererReady');
            return;
        }

        if (options.isDev) {
            scheduleDevStabilityCheck();
            return;
        }

        scheduleShow();
    };

    const handleMainFrameLoadFailure = (isMainFrame = true) => {
        if (!isMainFrame) {
            return;
        }
        mainFrameLoadFinished = false;

        void showWindowNow();
    };

    setWindowRendererReadyCallback(windowId, onRendererReadyForShow);
    windowWebContents.on('did-start-navigation', onStartNavigation);
    windowWebContents.on('did-finish-load', onFinishLoad);

    scheduleForceShowTimeout();

    window.on('closed', () => {
        cleanupShowHandlers();
        deleteWindowRendererReadyState(windowId);
        if (pendingShowTimeout) {
            clearTimeout(pendingShowTimeout);
            pendingShowTimeout = null;
        }
        if (forceShowTimeout) {
            clearTimeout(forceShowTimeout);
            forceShowTimeout = null;
        }
        if (stabilityCheckTimeout) {
            clearTimeout(stabilityCheckTimeout);
            stabilityCheckTimeout = null;
        }

        unregisterAppWindow(windowId);
    });

    return {handleMainFrameLoadFailure};
}
