import {
    BrowserWindow,
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let createWindowPromise: Promise<void> | null = null;
let isCspConfigured = false;
let isDevCacheCleared = false;

function setupContentSecurityPolicy() {
    if (isCspConfigured) {
        return;
    }
    isCspConfigured = true;

    const csp = [
        'default-src \'self\'',
        'script-src \'self\' \'unsafe-inline\' \'wasm-unsafe-eval\'',
        'style-src \'self\' \'unsafe-inline\'',
        'img-src \'self\' data: blob:',
        'font-src \'self\' data:',
        'connect-src \'self\' blob: data: ws:',
        'worker-src \'self\' blob:',
        'object-src \'none\'',
        'base-uri \'self\'',
        'form-action \'self\'',
    ].join('; ');

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [csp],
        }});
    });
}

export async function createWindow() {
    if (mainWindow) {
        return;
    }
    if (createWindowPromise) {
        return createWindowPromise;
    }

    createWindowPromise = (async () => {
        const preloadPath = join(__dirname, 'preload.js');
        console.log('[Electron] __dirname:', __dirname);
        console.log('[Electron] preload path:', preloadPath);

        setupContentSecurityPolicy();

        if (config.isDev && !isDevCacheCleared) {
            isDevCacheCleared = true;
            try {
                // Prevent stale HTML/asset caching from causing Vite 504 "Outdated Optimize Dep" errors.
                await session.defaultSession.clearCache();
            } catch (err) {
                console.warn('[Electron] Failed to clear HTTP cache:', err);
            }
        }

        await startServer();
        await waitForServer();

        mainWindow = new BrowserWindow({
            width: config.window.width,
            height: config.window.height,
            title: config.window.title,
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
        let devToolsWaitPromise: Promise<void> | null = null;
        let pendingShowTimeout: NodeJS.Timeout | null = null;
        let forceShowTimeout: NodeJS.Timeout | null = null;

        const SHOW_DEBOUNCE_MS = config.isDev ? 750 : 0;
        const FORCE_SHOW_MS = 15_000;

        const openDevToolsOnce = () => {
            if (!config.isDev || hasOpenedDevTools) {
                return;
            }
            hasOpenedDevTools = true;
            mainWindow?.webContents.openDevTools();
        };

        const waitForRendererReadyAndOpenDevTools = () => {
            if (!config.isDev || hasOpenedDevTools || devToolsWaitPromise) {
                return;
            }

            const MAX_WAIT_MS = 20_000;
            devToolsWaitPromise = (async () => {
                const start = Date.now();
                while (!hasOpenedDevTools && Date.now() - start < MAX_WAIT_MS) {
                    if (!mainWindow || mainWindow.isDestroyed()) {
                        return;
                    }
                    try {
                        const isReady = await mainWindow.webContents.executeJavaScript(
                            'Boolean(window.__appReady)',
                            true,
                        );
                        if (isReady) {
                            openDevToolsOnce();
                            return;
                        }
                    } catch {
                        // The page may be navigating/reloading; retry.
                    }
                    await new Promise((resolve) => setTimeout(resolve, 200));
                }

                // Fallback: open DevTools even if the readiness signal never arrives.
                openDevToolsOnce();
            })();
        };

        const cleanupShowHandlers = () => {
            if (!mainWindow || mainWindow.isDestroyed()) {
                return;
            }
            mainWindow.webContents.removeListener('did-start-navigation', onStartNavigation);
            mainWindow.webContents.removeListener('did-finish-load', onFinishLoad);
            mainWindow.webContents.removeListener('did-fail-load', onFailLoad);
        };

        const showWindowNow = () => {
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

            if (!mainWindow.isVisible()) {
                mainWindow.show();
            }
            waitForRendererReadyAndOpenDevTools();
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

        const onStartNavigation = (_event: unknown, _url: string, _isInPlace: boolean, isMainFrame: boolean) => {
            if (hasShownWindow || !isMainFrame) {
                return;
            }
            if (pendingShowTimeout) {
                clearTimeout(pendingShowTimeout);
                pendingShowTimeout = null;
            }
        };

        const onFinishLoad = () => {
            scheduleShow();
        };

        const onFailLoad = (_event: unknown, errorCode: number, errorDescription: string, validatedURL: string) => {
            console.error('[Electron] Failed to load URL:', validatedURL, errorCode, errorDescription);
            showWindowNow();
            openDevToolsOnce();
        };

        mainWindow.webContents.on('did-start-navigation', onStartNavigation);
        mainWindow.webContents.on('did-finish-load', onFinishLoad);
        mainWindow.webContents.on('did-fail-load', onFailLoad);

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
