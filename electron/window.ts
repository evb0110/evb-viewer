import {
    BrowserWindow,
    app,
    session,
} from 'electron';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { config } from '@electron/config';
import {
    startServer,
    waitForServer,
} from '@electron/server';
import { setupContentSecurityPolicy } from '@electron/security/csp';
import { createLogger } from '@electron/utils/logger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const windowIconPath = !app.isPackaged && !config.isMac
    ? join(__dirname, '..', 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
    : undefined;

const logger = createLogger('window');

let mainWindow: BrowserWindow | null = null;
let createWindowPromise: Promise<void> | null = null;
let isDevCacheCleared = false;

export async function createWindow() {
    if (mainWindow) {
        return;
    }
    if (createWindowPromise) {
        return createWindowPromise;
    }

    createWindowPromise = (async () => {
        const preloadPath = join(__dirname, 'preload.js');
        logger.debug(`__dirname: ${__dirname}`);
        logger.debug(`preload path: ${preloadPath}`);

        setupContentSecurityPolicy();

        if (config.isDev && !isDevCacheCleared) {
            isDevCacheCleared = true;
            try {
                // Prevent stale HTML/asset caching from causing Vite 504 "Outdated Optimize Dep" errors.
                await session.defaultSession.clearCache();
            } catch (err) {
                logger.warn(`Failed to clear HTTP cache: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        await startServer();
        await waitForServer();

        mainWindow = new BrowserWindow({
            width: config.window.width,
            height: config.window.height,
            title: config.window.title,
            ...(windowIconPath ? { icon: windowIconPath } : {}),
            show: false,
            backgroundColor: '#f5f5f5',
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: preloadPath,
            },
        });

        // In development, Vite/Nuxt may trigger an immediate full reload (e.g. "Outdated Optimize Dep"),
        // which can cause a white flash and DevTools console to appear to "load twice".
        // Debounce showing the window until navigation settles.
        let hasShownWindow = false;
        let hasOpenedDevTools = false;
        let pendingShowTimeout: NodeJS.Timeout | null = null;
        let forceShowTimeout: NodeJS.Timeout | null = null;

        const SHOW_DEBOUNCE_MS = config.isDev ? 750 : 0;
        const FORCE_SHOW_MS = config.isDev ? 5_000 : 15_000;
        const STABILITY_WINDOW_MS = 500;
        let lastNavigationTime = 0;
        let stabilityCheckTimeout: NodeJS.Timeout | null = null;

        const logNavEvent = (event: string, details?: Record<string, unknown>) => {
            if (config.isDev) {
                const info = {
                    timestamp: Date.now(),
                    hasShownWindow,
                    hasOpenedDevTools,
                    pendingShowTimeout: !!pendingShowTimeout,
                    stabilityCheckTimeout: !!stabilityCheckTimeout,
                    ...details,
                };
                logger.debug(`${event} ${JSON.stringify(info)}`);
            }
        };

        async function waitForAppReady(timeoutMs: number): Promise<boolean> {
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
                try {
                    const isReady = await mainWindow?.webContents.executeJavaScript(
                        'Boolean(window.__appReady)',
                        true,
                    );
                    if (isReady) {
                        return true;
                    }
                } catch {
                    // Page navigating
                }
                await new Promise(r => setTimeout(r, 100));
            }
            return false;
        }

        const checkStabilityAndShow = () => {
            if (hasShownWindow) {
                return;
            }

            const timeSinceLastNav = Date.now() - lastNavigationTime;

            if (timeSinceLastNav >= STABILITY_WINDOW_MS) {
                logNavEvent('stability-check-passed', { timeSinceLastNav });
                showWindowNow();
            } else {
                const remaining = STABILITY_WINDOW_MS - timeSinceLastNav;
                logNavEvent('stability-check-pending', {
                    timeSinceLastNav,
                    remaining, 
                });
                stabilityCheckTimeout = setTimeout(checkStabilityAndShow, remaining + 50);
            }
        };

        const openDevToolsOnce = () => {
            if (!config.isDev || hasOpenedDevTools) {
                return;
            }
            hasOpenedDevTools = true;
            mainWindow?.webContents.openDevTools();
        };

        const cleanupShowHandlers = () => {
            if (!mainWindow || mainWindow.isDestroyed()) {
                return;
            }
            mainWindow.webContents.removeListener('did-start-navigation', onStartNavigation);
            mainWindow.webContents.removeListener('did-finish-load', onFinishLoad);
            mainWindow.webContents.removeListener('did-fail-load', onFailLoad);
        };

        const showWindowNow = async () => {
            if (!mainWindow || mainWindow.isDestroyed() || hasShownWindow) {
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

            // M3.1: In dev mode, wait for app ready and open window + DevTools together
            if (config.isDev) {
                logNavEvent('waiting-for-app-ready');
                const isReady = await waitForAppReady(3000);
                logNavEvent('app-ready-result', { isReady });

                if (!mainWindow || mainWindow.isDestroyed()) {
                    return;
                }

                if (!mainWindow.isVisible()) {
                    mainWindow.show();
                }
                // Ensure window comes to front on macOS (needed when spawned from background)
                mainWindow.focus();
                if (process.platform === 'darwin') {
                    app.focus({ steal: true });
                }
                openDevToolsOnce();

                // M6.2: Add navigation timeline to window for debugging
                try {
                    await mainWindow.webContents.executeJavaScript(`
                        window.__navigationTimeline = window.__navigationTimeline || [];
                        window.__navigationTimeline.push({
                            event: 'window-shown',
                            timestamp: ${Date.now()},
                            hasDevTools: ${hasOpenedDevTools},
                        });
                    `);
                } catch {
                    // Page might be navigating
                }
            } else {
                if (!mainWindow.isVisible()) {
                    mainWindow.show();
                }
                // Ensure window comes to front on macOS (needed when spawned from background)
                mainWindow.focus();
                if (process.platform === 'darwin') {
                    app.focus({ steal: true });
                }
            }

            cleanupShowHandlers();
        };

        const scheduleShow = () => {
            if (hasShownWindow) {
                return;
            }
            if (pendingShowTimeout) {
                clearTimeout(pendingShowTimeout);
            }
            pendingShowTimeout = setTimeout(showWindowNow, SHOW_DEBOUNCE_MS);
        };

        const onStartNavigation = (_event: unknown, url: string, _isInPlace: boolean, isMainFrame: boolean) => {
            if (!isMainFrame) {
                return;
            }

            lastNavigationTime = Date.now();
            logNavEvent('navigation-start', { url });

            if (hasShownWindow) {
                return;
            }

            // Cancel any pending show or stability check
            if (pendingShowTimeout) {
                clearTimeout(pendingShowTimeout);
                pendingShowTimeout = null;
            }
            if (stabilityCheckTimeout) {
                clearTimeout(stabilityCheckTimeout);
                stabilityCheckTimeout = null;
            }
        };

        const onFinishLoad = () => {
            lastNavigationTime = Date.now();
            logNavEvent('navigation-finish-load');

            if (hasShownWindow) {
                return;
            }

            // In dev mode, use stability window; in prod, show immediately
            if (config.isDev) {
                // Clear any existing stability check and schedule a new one
                if (stabilityCheckTimeout) {
                    clearTimeout(stabilityCheckTimeout);
                }
                stabilityCheckTimeout = setTimeout(checkStabilityAndShow, STABILITY_WINDOW_MS);
            } else {
                scheduleShow();
            }
        };

        const onFailLoad = (_event: unknown, errorCode: number, errorDescription: string, validatedURL: string) => {
            logger.error(`Failed to load URL: ${validatedURL} (code=${errorCode}, desc=${errorDescription})`);
            showWindowNow();
            openDevToolsOnce();
        };

        mainWindow.webContents.on('did-start-navigation', onStartNavigation);
        mainWindow.webContents.on('did-finish-load', onFinishLoad);
        mainWindow.webContents.on('did-fail-load', onFailLoad);

        // M3.2: Handle DevTools reopening after navigation (e.g., hot reload)
        mainWindow.webContents.on('did-navigate', () => {
            if (config.isDev) {
                logNavEvent('navigation-complete-checking-devtools');
                setTimeout(() => {
                    if (!mainWindow?.webContents.isDevToolsOpened()) {
                        logNavEvent('reopening-devtools-after-navigation');
                        mainWindow?.webContents.openDevTools();
                    }
                }, 500);
            }
        });

        forceShowTimeout = setTimeout(showWindowNow, FORCE_SHOW_MS);

        void mainWindow.loadURL(config.server.url);

        mainWindow.on('closed', () => {
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
            mainWindow = null;
        });
    })();

    try {
        await createWindowPromise;
    } finally {
        createWindowPromise = null;
    }
}

export function hasWindows() {
    return BrowserWindow.getAllWindows().length > 0;
}
