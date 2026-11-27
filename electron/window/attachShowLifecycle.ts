import type {ILogger} from '@electron/utils/createLogger';
import type {BrowserWindow} from 'electron';
import type {TRendererStartupFailure} from '@contracts/windowTabsPlatformFeature';
import {deleteWindowStartup, subscribeWindowStartupPhase} from '@electron/window/rendererReady';
import {unregisterAppWindow} from '@electron/window/registry';

interface IAttachShowLifecycleOptions {
    blockShowUntilRendererReady?: boolean;
    logger: ILogger;
    showAndFocusMaximizedWindow: (window: BrowserWindow) => void;
    presentStartupFailure: (failure: TRendererStartupFailure) => void;
    logWindowStartup: (phase: string, details?: Record<string, unknown>) => void;
}

const SHOW_DEBOUNCE_MS = 0;

/**
 * The one owner of a window's reveal: it shows the window once its main frame
 * has loaded or its shell is interactive (only the latter when asked to wait
 * for it), or at once when its startup fails, which it then presents. A focus
 * request before then takes the same path; the reveal focuses the window.
 */
export function attachShowLifecycle(window: BrowserWindow, options: IAttachShowLifecycleOptions) {
    const windowId = window.id;
    const windowWebContents = window.webContents;
    let hasShownWindow = false;
    let pendingShowTimeout: NodeJS.Timeout | null = null;
    let mainFrameLoadFinished = false;
    let shellInteractive = false;
    const blockShowUntilRendererReady = options.blockShowUntilRendererReady ?? false;
    const isStartupPlaceholderUrl = (url: string) => url === 'about:blank';

    const clearPendingShow = () => {
        if (pendingShowTimeout) {
            clearTimeout(pendingShowTimeout);
            pendingShowTimeout = null;
        }
    };

    const reveal = () => {
        if (window.isDestroyed() || hasShownWindow) {
            return;
        }
        hasShownWindow = true;
        clearPendingShow();
        windowWebContents.removeListener('did-start-navigation', onStartNavigation);
        windowWebContents.removeListener('did-finish-load', onFinishLoad);
        options.showAndFocusMaximizedWindow(window);
        options.logWindowStartup(`Window shown (windowId=${windowId})`);
    };

    const scheduleShow = () => {
        const canReveal = shellInteractive || (mainFrameLoadFinished && !blockShowUntilRendererReady);
        if (!canReveal || hasShownWindow || window.isDestroyed()) {
            return;
        }
        clearPendingShow();
        pendingShowTimeout = setTimeout(reveal, SHOW_DEBOUNCE_MS);
    };

    const onStartNavigation = (_event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => {
        // A same-document navigation keeps the loaded document and its phase.
        if (!isMainFrame || isInPlace || isStartupPlaceholderUrl(url)) {
            return;
        }
        mainFrameLoadFinished = false;
        shellInteractive = false;
        clearPendingShow();
    };

    const onFinishLoad = () => {
        if (isStartupPlaceholderUrl(windowWebContents.getURL())) {
            return;
        }
        mainFrameLoadFinished = true;
        scheduleShow();
    };

    windowWebContents.on('did-start-navigation', onStartNavigation);
    windowWebContents.on('did-finish-load', onFinishLoad);
    subscribeWindowStartupPhase(windowId, {
        onPhase: (phase) => {
            if (phase.phase === 'shell-interactive') {
                shellInteractive = true;
                scheduleShow();
                return;
            }
            options.logger.warn('Window startup failed', {
                windowId,
                reason: phase.reason,
            });
            reveal();
            options.presentStartupFailure(phase);
        },
        requestReveal: () => {
            scheduleShow();
            return !hasShownWindow;
        },
    });

    window.on('closed', () => {
        clearPendingShow();
        deleteWindowStartup(windowId);
        unregisterAppWindow(windowId);
    });

    return {reveal};
}
