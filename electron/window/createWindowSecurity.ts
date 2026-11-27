import type {ILogger} from '@electron/utils/createLogger';
import type {BrowserWindow} from 'electron';
import {shell} from 'electron';
import {inspectAllowedExternalUrl} from '@contracts/externalUrl';
import {getErrorMessage} from '@electron/utils/error';
import {isTrustedRendererUrl as matchesTrustedRendererUrl} from '@electron/security/isTrustedRendererUrl';

interface ICreateWindowSecurityOptions {
    getTrustedRendererUrl: () => string;
    logger: ILogger;
}

const EXTERNAL_OPEN_MIN_INTERVAL_MS = 1_000;
type TExternalOpenSource = 'window-open' | 'navigation';
type TExternalOpenThrottleState = Partial<Record<TExternalOpenSource, number>>;

export function createWindowSecurity(options: ICreateWindowSecurityOptions) {
    const lastExternalOpenByWindow = new WeakMap<BrowserWindow, TExternalOpenThrottleState>();

    function isTrustedRendererUrl(value: string) {
        return matchesTrustedRendererUrl(value, options.getTrustedRendererUrl());
    }

    function shouldThrottleExternalOpen(window: BrowserWindow, source: TExternalOpenSource) {
        let throttleState = lastExternalOpenByWindow.get(window);
        if (!throttleState) {
            throttleState = {};
            lastExternalOpenByWindow.set(window, throttleState);
        }

        const now = Date.now();
        const lastOpenedAt = throttleState[source];
        if (lastOpenedAt !== undefined && now - lastOpenedAt < EXTERNAL_OPEN_MIN_INTERVAL_MS) {
            return true;
        }

        throttleState[source] = now;
        return false;
    }

    function openExternalSafely(window: BrowserWindow, url: string, source: TExternalOpenSource) {
        const decision = inspectAllowedExternalUrl(url);
        if (!decision.ok) {
            if (decision.reason === 'unsupported-protocol') {
                options.logger.warn(`Blocked ${source} URL with unsupported protocol: ${url}`);
                return;
            }

            options.logger.warn(`Blocked ${source} URL with invalid value: ${url}`);
            return;
        }
        if (shouldThrottleExternalOpen(window, source)) {
            options.logger.warn(`Blocked repeated ${source} URL open: ${decision.normalizedUrl}`);
            return;
        }
        void shell.openExternal(decision.normalizedUrl).catch((error) => {
            options.logger.warn(`Failed to open external URL (${source}): ${getErrorMessage(error)}`);
        });
    }

    function hardenWindowWebContents(window: BrowserWindow) {
        window.webContents.setWindowOpenHandler(({url}) => {
            openExternalSafely(window, url, 'window-open');
            return {action: 'deny'};
        });

        window.webContents.on('will-navigate', (event, url) => {
            if (isTrustedRendererUrl(url) || url === 'about:blank') {
                return;
            }

            event.preventDefault();
            openExternalSafely(window, url, 'navigation');
        });
        window.once('closed', () => {
            lastExternalOpenByWindow.delete(window);
        });
    }

    return {
        hardenWindowWebContents,
        isTrustedRendererUrl,
    };
}
