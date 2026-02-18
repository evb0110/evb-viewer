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
import { delay } from 'es-toolkit/promise';
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

const appWindows = new Map<number, BrowserWindow>();
let mainWindowId: number | null = null;
let createMainWindowPromise: Promise<BrowserWindow> | null = null;
let serverReadyPromise: Promise<void> | null = null;
let isDevCacheCleared = false;
let isCspConfigured = false;

interface ICreateAppWindowOptions {setAsMain?: boolean;}

function syncWindowRegistry() {
    const allWindows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
    const activeIds = new Set(allWindows.map(window => window.id));

    for (const window of allWindows) {
        appWindows.set(window.id, window);
    }

    for (const windowId of appWindows.keys()) {
        if (!activeIds.has(windowId)) {
            appWindows.delete(windowId);
        }
    }

    if (mainWindowId !== null && !activeIds.has(mainWindowId)) {
        mainWindowId = allWindows[0]?.id ?? null;
    }
}

async function ensureWindowRuntimeReady() {
    const runtimeStart = Date.now();
    if (!isCspConfigured) {
        isCspConfigured = true;
        setupContentSecurityPolicy();
    }

    if (config.isDev && !isDevCacheCleared) {
        isDevCacheCleared = true;
        try {
            // Prevent stale HTML/asset caching from causing Vite 504 "Outdated Optimize Dep" errors.
            await session.defaultSession.clearCache();
        } catch (err) {
            logger.warn(`Failed to clear HTTP cache: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    if (!serverReadyPromise) {
        serverReadyPromise = (async () => {
            const serverBootStart = Date.now();
            logger.info('[startup] Ensuring Nuxt runtime server is ready');
            await startServer();
            logger.info(`[startup] Nuxt runtime process ensured (+${Date.now() - serverBootStart}ms)`);
            await waitForServer();
            logger.info(`[startup] Nuxt runtime server is healthy (+${Date.now() - serverBootStart}ms)`);
        })();
    }

    await serverReadyPromise;
    logger.info(`[startup] Window runtime ready (+${Date.now() - runtimeStart}ms)`);
}

function attachShowLifecycle(window: BrowserWindow) {
    // In development, Vite/Nuxt may trigger an immediate full reload (e.g. "Outdated Optimize Dep"),
    // which can cause a white flash and DevTools console to appear to "load twice".
    // Debounce showing the window until navigation settles.
    let hasShownWindow = false;
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
                windowId: window.id,
                hasShownWindow,
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
                const isReady = await window.webContents.executeJavaScript(
                    'Boolean(window.__appReady)',
                    true,
                );
                if (isReady) {
                    return true;
                }
            } catch {
                // Page navigating
            }
            await delay(100);
        }
        return false;
    }

    const cleanupShowHandlers = () => {
        if (window.isDestroyed()) {
            return;
        }
        window.webContents.removeListener('did-start-navigation', onStartNavigation);
        window.webContents.removeListener('did-finish-load', onFinishLoad);
        window.webContents.removeListener('did-fail-load', onFailLoad);
    };

    function showAndFocusMaximizedWindow() {
        if (window.isDestroyed()) {
            return;
        }

        if (!window.isMaximized()) {
            window.maximize();
        }
        if (!window.isVisible()) {
            window.show();
        }
        window.focus();

        if (process.platform === 'darwin') {
            app.focus({ steal: true });
        }
    }

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

        if (config.isDev) {
            logNavEvent('waiting-for-app-ready');
            const isReady = await waitForAppReady(3000);
            logNavEvent('app-ready-result', { isReady });

            if (window.isDestroyed()) {
                return;
            }

            showAndFocusMaximizedWindow();

            try {
                await window.webContents.executeJavaScript(`
                    window.__navigationTimeline = window.__navigationTimeline || [];
                    window.__navigationTimeline.push({
                        event: 'window-shown',
                        timestamp: ${Date.now()},
                    });
                `);
            } catch {
                // Page might be navigating
            }
        } else {
            showAndFocusMaximizedWindow();
            logger.info(`[startup] Window shown (windowId=${window.id})`);
        }

        cleanupShowHandlers();
    };

    const checkStabilityAndShow = () => {
        if (hasShownWindow || window.isDestroyed()) {
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

    const scheduleShow = () => {
        if (hasShownWindow || window.isDestroyed()) {
            return;
        }
        if (pendingShowTimeout) {
            clearTimeout(pendingShowTimeout);
        }
        pendingShowTimeout = setTimeout(() => {
            void showWindowNow();
        }, SHOW_DEBOUNCE_MS);
    };

    const onStartNavigation = (
        _event: unknown,
        url: string,
        _isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (!isMainFrame) {
            return;
        }

        lastNavigationTime = Date.now();
        logNavEvent('navigation-start', { url });

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
    };

    const onFinishLoad = () => {
        lastNavigationTime = Date.now();
        logNavEvent('navigation-finish-load');

        if (hasShownWindow) {
            return;
        }

        if (config.isDev) {
            if (stabilityCheckTimeout) {
                clearTimeout(stabilityCheckTimeout);
            }
            stabilityCheckTimeout = setTimeout(checkStabilityAndShow, STABILITY_WINDOW_MS);
            return;
        }

        scheduleShow();
    };

    const onFailLoad = (_event: unknown, errorCode: number, errorDescription: string, validatedURL: string) => {
        logger.error(`Failed to load URL: ${validatedURL} (code=${errorCode}, desc=${errorDescription})`);
        void showWindowNow();
    };

    window.webContents.on('did-start-navigation', onStartNavigation);
    window.webContents.on('did-finish-load', onFinishLoad);
    window.webContents.on('did-fail-load', onFailLoad);

    forceShowTimeout = setTimeout(() => {
        void showWindowNow();
    }, FORCE_SHOW_MS);

    window.on('closed', () => {
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

        appWindows.delete(window.id);
        if (mainWindowId === window.id) {
            mainWindowId = null;
            syncWindowRegistry();
        }
    });
}

export async function createAppWindow(options: ICreateAppWindowOptions = {}) {
    const createStart = Date.now();
    await ensureWindowRuntimeReady();

    const preloadPath = join(__dirname, 'preload.js');
    logger.debug(`__dirname: ${__dirname}`);
    logger.debug(`preload path: ${preloadPath}`);

    const window = new BrowserWindow({
        width: config.window.width,
        height: config.window.height,
        title: config.window.title,
        ...(windowIconPath ? { icon: windowIconPath } : {}),
        show: false,
        backgroundColor: config.window.backgroundColor,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: preloadPath,
        },
    });

    appWindows.set(window.id, window);

    const shouldSetMain = options.setAsMain ?? mainWindowId === null;
    if (shouldSetMain) {
        mainWindowId = window.id;
    }

    if (!window.isMaximized()) {
        window.maximize();
    }

    attachShowLifecycle(window);
    void window.loadURL(config.server.url);
    logger.info(`[startup] BrowserWindow created and loadURL dispatched (+${Date.now() - createStart}ms)`);

    return window;
}

export async function createWindow() {
    const existingMainWindow = getMainWindow();
    if (existingMainWindow) {
        return existingMainWindow;
    }

    if (createMainWindowPromise) {
        return createMainWindowPromise;
    }

    createMainWindowPromise = createAppWindow({setAsMain: true});
    try {
        return await createMainWindowPromise;
    } finally {
        createMainWindowPromise = null;
    }
}

export function getWindowById(windowId: number) {
    const fromRegistry = appWindows.get(windowId);
    if (fromRegistry && !fromRegistry.isDestroyed()) {
        return fromRegistry;
    }

    const fromElectron = BrowserWindow.fromId(windowId);
    if (!fromElectron || fromElectron.isDestroyed()) {
        appWindows.delete(windowId);
        return null;
    }

    appWindows.set(windowId, fromElectron);
    return fromElectron;
}

export function getAllAppWindows() {
    syncWindowRegistry();
    return Array.from(appWindows.values()).filter(window => !window.isDestroyed());
}

export function hasWindows() {
    return getAllAppWindows().length > 0;
}

export function getMainWindow() {
    if (mainWindowId !== null) {
        const mainWindow = getWindowById(mainWindowId);
        if (mainWindow) {
            return mainWindow;
        }
    }

    const fallback = getAllAppWindows()[0] ?? null;
    if (fallback) {
        mainWindowId = fallback.id;
    }

    return fallback;
}
