import {
    BrowserWindow,
    app,
    dialog,
    ipcMain,
} from 'electron';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { config } from '@electron/config';
import { te } from '@electron/te';
import { createLogger } from '@electron/utils/createLogger';
import { createWindowRuntime } from '@electron/window/createWindowRuntime';
import { createWindowSecurity } from '@electron/window/createWindowSecurity';
import { getErrorMessage } from '@electron/utils/error';
import {
    notifyWindowRendererLoadFailure,
    waitForInitialRendererReady,
} from '@electron/window/rendererReady';
import { loadStartupPlaceholder } from '@electron/window/loadStartupPlaceholder';
import {
    getAllRegisteredAppWindows,
    getRegisteredMainWindow,
    registerAppWindow,
} from '@electron/window/registry';
import { attachShowLifecycle } from '@electron/window/attachShowLifecycle';
import { attachNativeWindowCloseHandshake } from '@electron/window/windowCloseHandshake';
import type {IRawIpcRegistrationAudit} from '@electron/platform-ipc/rawIpcRegistration';
import {
    encodeHostResourceProfileArgument,
    getHostResourceProfileSnapshot,
} from '@electron/resources/hostResourceProfile';
import {
    captureMainFailure,
    getMainFailureReporter,
} from '@electron/features/diagnostics/public';
import { encodeDiagnosticsPolicyArgument } from '@electron/platform-ipc/coreContract';
import {
    MAX_RENDERER_RECOVERY_ATTEMPTS,
    normalizeProcessGoneExitCode,
    normalizeProcessGoneReason,
} from '@contracts/diagnostics/diagnosticCodes';
import type {
    DiagnosticCode,
    DiagnosticContext,
} from '@contracts/diagnostics/diagnosticCodes';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const windowIconPath = !app.isPackaged && !config.isMac
    ? join(__dirname, '..', 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
    : undefined;

const logger = createLogger('window');
const windowStartupStartedAt = Date.now();
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';
const UNRESPONSIVE_RECOVERY_DELAY_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_WINDOW_UNRESPONSIVE_RECOVERY_MS ?? '15000', 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 15_000;
    }
    return parsed;
})();
const RENDERER_RECOVERY_WINDOW_MS = 5 * 60_000;
const RENDERER_RECOVERY_MAX_ATTEMPTS = MAX_RENDERER_RECOVERY_ATTEMPTS;

function normalizeRendererRecoveryTrigger(reason: string) {
    if (reason.startsWith('render-process-gone:')) {
        return 'renderer-gone' as const;
    }
    switch (reason) {
        case 'unresponsive-automation-reload':
            return 'unresponsive-automation' as const;
        case 'unresponsive-dialog-reload':
            return 'unresponsive-dialog-reload' as const;
        case 'unresponsive-dialog-fallback':
            return 'unresponsive-dialog-fallback' as const;
        default:
            // Unknown recovery reasons stay in the bounded fallback bucket.
            return 'unresponsive-dialog-fallback' as const;
    }
}

function clampRecoveryAttempt(attempt: number) {
    return Math.min(RENDERER_RECOVERY_MAX_ATTEMPTS, Math.max(1, attempt));
}

function reportWindowFailure<C extends DiagnosticCode>(
    code: C,
    context: DiagnosticContext<C>,
    message: string,
    cause?: unknown,
) {
    let receipt: FailureReceipt | undefined;
    try {
        receipt = captureMainFailure({
            code,
            operation: 'main-error',
            context,
            local: {
                source: 'window',
                message,
                cause,
            },
        });
    } catch {
        // Diagnostics must not change renderer recovery or window teardown.
    }
    if (receipt === undefined) {
        logger.error(message, {
            code: 'MAIN_WINDOW_OPERATION_FAILED',
            context: {},
        });
    } else {
        logger.error(message, receipt);
    }
    return receipt;
}

function logWindowStartup(phase: string, details?: Record<string, unknown>) {
    if (!STARTUP_TRACE_ENABLED) {
        return;
    }

    const now = Date.now();
    const elapsedMs = now - windowStartupStartedAt;
    const message = `[startup] ${phase} (+${elapsedMs}ms)`;
    logger.info(message);
    console.info(`[${new Date(now).toISOString()}] [window] ${message}`, {
        elapsedMs,
        ...details,
    });
}

let createMainWindowPromise: Promise<BrowserWindow> | null = null;
let shouldBypassNativeWindowClose = () => false;
let rawIpcRegistrationAudit: IRawIpcRegistrationAudit | undefined;

export function configureNativeWindowCloseHandshake(options: {
    shouldBypass: () => boolean;
    rawIpcRegistrationAudit?: IRawIpcRegistrationAudit;
}) {
    shouldBypassNativeWindowClose = options.shouldBypass;
    rawIpcRegistrationAudit = options.rawIpcRegistrationAudit;
}

interface ICreateAppWindowOptions {
    setAsMain?: boolean;
    showStartupPlaceholder?: boolean;
    waitForInitialRendererReady?: boolean;
}

interface IWindowLoadAttempt {
    reported: boolean;
    receipt?: FailureReceipt;
}

interface IWindowLoadFailureOwner {
    initialAttempt: IWindowLoadAttempt;
    getCurrentAttempt: () => IWindowLoadAttempt;
    observeTopLevelNavigation: (url: string, isInPlace: boolean, isMainFrame: boolean) => void;
    adopt: (attempt: IWindowLoadAttempt, receipt: FailureReceipt | undefined) => void;
    report: (attempt: IWindowLoadAttempt, error: Error) => FailureReceipt | undefined;
}

function createWindowLoadFailureOwner(): IWindowLoadFailureOwner {
    const initialAttempt: IWindowLoadAttempt = {reported: false};
    let currentAttempt = initialAttempt;
    let observedInitialNavigation = false;

    return {
        initialAttempt,
        getCurrentAttempt: () => currentAttempt,
        observeTopLevelNavigation: (url, isInPlace, isMainFrame) => {
            if (!isMainFrame || isInPlace || url === 'about:blank') {
                return;
            }
            if (!observedInitialNavigation) {
                observedInitialNavigation = true;
                return;
            }
            currentAttempt = {reported: false};
        },
        adopt: (attempt, receipt) => {
            if (attempt.reported) {
                return;
            }

            attempt.reported = true;
            // Keep the attempt closed even when teardown prevented a receipt.
            if (receipt) {
                attempt.receipt = receipt;
            }
        },
        report: (attempt, error) => {
            if (attempt.reported) {
                return attempt.receipt;
            }

            attempt.reported = true;
            const receipt = logger.error(error.message, {
                code: 'MAIN_WINDOW_OPERATION_FAILED',
                context: {},
                cause: error,
            });
            if (receipt) {
                attempt.receipt = receipt;
            }
            return receipt;
        },
    };
}

interface IRendererDiagnosticsOptions {
    onRendererGone?: () => void;
    onRecoveryFailure?: (receipt: FailureReceipt | undefined) => void;
}

interface IRendererDiagnosticsHandle {
    isRecoveryLoadInFlight: () => boolean;
    reportRecoveryLoadFailure: (error: unknown) => FailureReceipt | undefined;
}

const windowSecurity = createWindowSecurity({
    getTrustedRendererUrl: () => config.renderer.trustedUrl,
    logger,
});
const windowRuntime = createWindowRuntime({
    isDev: config.isDev,
    logger,
    logWindowStartup,
});

function showAndFocusMaximizedWindow(window: BrowserWindow) {
    if (window.isDestroyed()) {
        return;
    }

    if (config.automation.hideWindow) {
        // Automation windows stay hidden so local desktop focus is never disrupted.
        return;
    }

    if (!window.isMaximized()) {
        window.maximize();
    }
    if (!window.isVisible()) {
        if (config.automation.noFocus) {
            // Keep E2E windows out of focus so local work is not interrupted.
            const showInactive = (window as BrowserWindow & { showInactive?: () => void; }).showInactive;
            if (typeof showInactive === 'function') {
                showInactive.call(window);
            } else {
                window.show();
            }
        } else {
            window.show();
        }
    }

    if (config.automation.noFocus) {
        return;
    }

    if (process.platform === 'darwin') {
        app.focus({ steal: true });
    }
    window.focus();
    window.webContents.focus();
}

async function lockRendererZoom(window: BrowserWindow) {
    try {
        await window.webContents.setVisualZoomLevelLimits(1, 1);
        window.webContents.setZoomFactor(1);
        window.webContents.setZoomLevel(0);
    } catch (error) {
        logger.warn(
            `Failed to lock renderer zoom: ${getErrorMessage(error)}`,
        );
    }
}

async function promptUnresponsiveRendererRecovery(
    window: BrowserWindow,
    windowId: number,
    recoverRenderer: (reason: string) => void,
    recoveryAttempt: number,
) {
    if (window.isDestroyed()) {
        return;
    }

    if (config.automation.hideWindow || config.automation.noFocus) {
        recoverRenderer('unresponsive-automation-reload');
        return;
    }

    const BUTTON_WAIT = 0;
    const BUTTON_RELOAD = 1;

    try {
        const { response } = await dialog.showMessageBox(window, {
            type: 'warning',
            title: te('dialogs.unresponsiveRenderer.title'),
            message: te('dialogs.unresponsiveRenderer.message'),
            detail: te('dialogs.unresponsiveRenderer.detail'),
            buttons: [
                te('dialogs.unresponsiveRenderer.wait'),
                te('dialogs.unresponsiveRenderer.reload'),
            ],
            defaultId: BUTTON_WAIT,
            cancelId: BUTTON_WAIT,
            noLink: true,
        });

        if (response === BUTTON_RELOAD && !window.isDestroyed()) {
            recoverRenderer('unresponsive-dialog-reload');
        }
    } catch (error) {
        const message = `Failed to prompt for unresponsive renderer recovery (windowId=${windowId}): ${getErrorMessage(error)}`;
        if (window.isDestroyed()) {
            logger.info(message);
        } else {
            reportWindowFailure(
                'MAIN_UNRESPONSIVE_RECOVERY_FAILED',
                {
                    trigger: 'unresponsive-dialog-prompt',
                    recoveryAttempt: clampRecoveryAttempt(recoveryAttempt),
                },
                message,
                error,
            );
        }
        recoverRenderer('unresponsive-dialog-fallback');
    }
}

function attachRendererDiagnostics(
    window: BrowserWindow,
    options: IRendererDiagnosticsOptions = {},
): IRendererDiagnosticsHandle {
    const webContents = window.webContents;
    const windowId = window.id;
    let recoveryInFlight = false;
    let recentRecoveryAttempts: number[] = [];
    let unresponsiveRecoveryTimer: NodeJS.Timeout | null = null;
    let unresponsivePromptInFlight = false;
    let activeRecoveryFailure: {
        reason: string;
        reported: boolean;
        receipt?: FailureReceipt;
    } | null = null;

    const isRecoveryUnavailable = (includePrompt = false) => {
        const now = Date.now();
        recentRecoveryAttempts = recentRecoveryAttempts.filter(
            attemptedAt => now - attemptedAt < RENDERER_RECOVERY_WINDOW_MS,
        );
        return recoveryInFlight
            || window.isDestroyed()
            || recentRecoveryAttempts.length >= RENDERER_RECOVERY_MAX_ATTEMPTS
            || (includePrompt && unresponsivePromptInFlight);
    };

    const clearUnresponsiveRecoveryTimer = () => {
        if (!unresponsiveRecoveryTimer) {
            return;
        }
        clearTimeout(unresponsiveRecoveryTimer);
        unresponsiveRecoveryTimer = null;
    };

    const reportRecoveryLoadFailure = (error: unknown) => {
        const failure = activeRecoveryFailure;
        if (!failure || failure.reported) {
            return failure?.receipt;
        }

        failure.reported = true;
        const message = `Renderer recovery load failed (${failure.reason}, windowId=${windowId}): ${
            getErrorMessage(error)
        }`;
        let receipt: FailureReceipt | undefined;
        if (window.isDestroyed()) {
            logger.info(message);
        } else {
            const trigger = normalizeRendererRecoveryTrigger(failure.reason);
            if (trigger === 'renderer-gone') {
                receipt = reportWindowFailure(
                    'MAIN_RENDERER_RECOVERY_FAILED',
                    {
                        trigger,
                        recoveryAttempt: clampRecoveryAttempt(recentRecoveryAttempts.length),
                    },
                    message,
                    error,
                );
            } else {
                receipt = reportWindowFailure(
                    'MAIN_UNRESPONSIVE_RECOVERY_FAILED',
                    {
                        trigger,
                        recoveryAttempt: clampRecoveryAttempt(recentRecoveryAttempts.length),
                    },
                    message,
                    error,
                );
            }
        }
        if (receipt) {
            failure.receipt = receipt;
        }
        try {
            options.onRecoveryFailure?.(receipt);
        } catch {
            // Recovery reporting must not change renderer recovery behavior.
        }
        return receipt;
    };

    const recoverRenderer = (reason: string) => {
        if (config.isDev || isRecoveryUnavailable()) {
            return;
        }

        recoveryInFlight = true;
        recentRecoveryAttempts.push(Date.now());
        activeRecoveryFailure = {
            reason,
            reported: false,
        };
        clearUnresponsiveRecoveryTimer();
        logger.warn(`[renderer] attempting recovery load (${reason}, windowId=${windowId}, attempt=${recentRecoveryAttempts.length})`);
        void (async () => {
            try {
                await windowRuntime.ensureReady();
                if (window.isDestroyed()) {
                    return;
                }
                await window.loadURL(config.renderer.url);
            } catch (error) {
                reportRecoveryLoadFailure(error);
            } finally {
                activeRecoveryFailure = null;
                recoveryInFlight = false;
            }
        })();
    };

    webContents.on('render-process-gone', (_event, details) => {
        try {
            options.onRendererGone?.();
        } catch {
            // Recovery diagnostics must not change renderer death handling.
        }
        const message = `[renderer] render-process-gone (windowId=${windowId}, reason=${details.reason}, exitCode=${details.exitCode})`;
        if (window.isDestroyed()) {
            logger.info(message);
            return;
        }
        const exitCode = normalizeProcessGoneExitCode(details.exitCode);
        reportWindowFailure(
            'MAIN_RENDERER_PROCESS_GONE',
            {
                reason: normalizeProcessGoneReason(details.reason),
                ...(exitCode === undefined ? {} : {exitCode}),
            },
            message,
        );
        recoverRenderer(`render-process-gone:${details.reason}`);
    });

    webContents.on('preload-error', (_event, preloadPath, error) => {
        const message = `[renderer] preload-error (windowId=${windowId}, preload=${preloadPath}): ${
            error.stack ?? getErrorMessage(error)
        }`;
        if (window.isDestroyed()) {
            logger.info(message);
            return;
        }
        reportWindowFailure(
            'MAIN_PRELOAD_ERROR',
            {hasStack: typeof error.stack === 'string' && error.stack.length > 0},
            message,
            error,
        );
    });

    window.on('unresponsive', () => {
        logger.warn(`[renderer] window unresponsive (windowId=${windowId})`);
        if (config.isDev || isRecoveryUnavailable(true) || UNRESPONSIVE_RECOVERY_DELAY_MS <= 0) {
            return;
        }
        clearUnresponsiveRecoveryTimer();
        unresponsiveRecoveryTimer = setTimeout(() => {
            unresponsiveRecoveryTimer = null;
            if (isRecoveryUnavailable(true)) {
                return;
            }

            unresponsivePromptInFlight = true;
            const message = `[renderer] window remained unresponsive after ${UNRESPONSIVE_RECOVERY_DELAY_MS}ms `
                + `(windowId=${windowId})`;
            reportWindowFailure(
                'MAIN_UNRESPONSIVE_RENDERER',
                {
                    automated: config.automation.hideWindow || config.automation.noFocus,
                    recoveryAttempt: Math.min(RENDERER_RECOVERY_MAX_ATTEMPTS, recentRecoveryAttempts.length),
                },
                message,
            );
            logger.warn(`[renderer] prompting recovery for unresponsive renderer (windowId=${windowId})`);
            void promptUnresponsiveRendererRecovery(
                window,
                windowId,
                recoverRenderer,
                Math.min(RENDERER_RECOVERY_MAX_ATTEMPTS, recentRecoveryAttempts.length + 1),
            )
                .finally(() => {
                    unresponsivePromptInFlight = false;
                });
        }, UNRESPONSIVE_RECOVERY_DELAY_MS);
        unresponsiveRecoveryTimer.unref();
    });

    window.on('responsive', () => {
        logger.info(`[renderer] window responsive (windowId=${windowId})`);
        clearUnresponsiveRecoveryTimer();
    });

    window.on('closed', () => {
        clearUnresponsiveRecoveryTimer();
    });

    const rendererDiagnostics: IRendererDiagnosticsHandle = {
        isRecoveryLoadInFlight: () => recoveryInFlight,
        reportRecoveryLoadFailure,
    };

    if (!config.isDev) {
        return rendererDiagnostics;
    }

    webContents.on('did-start-loading', () => {
        logger.debug(`[renderer] did-start-loading (windowId=${windowId})`);
    });

    webContents.on('did-stop-loading', () => {
        logger.debug(`[renderer] did-stop-loading (windowId=${windowId})`);
    });

    webContents.on('did-start-navigation', (
        _event,
        url,
        isInPlace,
        isMainFrame,
    ) => {
        if (!isMainFrame) {
            return;
        }

        logger.debug(`[renderer] did-start-navigation (windowId=${windowId}, inPlace=${String(isInPlace)}, url=${url})`);
    });

    webContents.on('did-navigate', (_event, url) => {
        logger.info(`[renderer] did-navigate (windowId=${windowId}, url=${url})`);
    });

    webContents.on('did-finish-load', () => {
        logger.info(`[renderer] did-finish-load (windowId=${windowId}, url=${webContents.getURL()})`);
    });

    return rendererDiagnostics;
}


export async function createAppWindow(options: ICreateAppWindowOptions = {}) {
    const createStart = Date.now();
    const preloadPath = join(__dirname, 'preload.cjs');
    const keepAutomationRendererActive = config.automation.hideWindow || config.automation.noFocus;
    logger.debug(`__dirname: ${__dirname}`);
    logger.debug(`preload path: ${preloadPath}`);

    const window = new BrowserWindow({
        width: config.window.width,
        height: config.window.height,
        title: config.window.title,
        ...(windowIconPath ? { icon: windowIconPath } : {}),
        autoHideMenuBar: false,
        show: false,
        ...(keepAutomationRendererActive ? {paintWhenInitiallyHidden: true} : {}),
        backgroundColor: config.window.backgroundColor,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: preloadPath,
            additionalArguments: [
                encodeHostResourceProfileArgument(getHostResourceProfileSnapshot()),
                encodeDiagnosticsPolicyArgument(getMainFailureReporter()?.getPreference()),
            ],
            ...(keepAutomationRendererActive ? {backgroundThrottling: false} : {}),
        },
    });

    registerAppWindow(window, {...(options.setAsMain === undefined ? {} : { setAsMain: options.setAsMain })});
    attachNativeWindowCloseHandshake(window, {
        ipcMain,
        logger,
        shouldBypass: () => shouldBypassNativeWindowClose(),
        ...(rawIpcRegistrationAudit ? {rawIpcRegistrationAudit} : {}),
    });

    const shouldWaitForInitialRendererReady = options.waitForInitialRendererReady ?? false;
    const shouldShowStartupPlaceholder = options.showStartupPlaceholder ?? !shouldWaitForInitialRendererReady;
    const windowLoadFailureOwner = createWindowLoadFailureOwner();
    const initialLoadAttempt = windowLoadFailureOwner.initialAttempt;
    let initialRendererGone = false;
    const markInitialRendererGone = () => {
        initialRendererGone = true;
    };
    windowSecurity.hardenWindowWebContents(window);
    const rendererDiagnostics = attachRendererDiagnostics(window, {
        onRendererGone: markInitialRendererGone,
        onRecoveryFailure: receipt => {
            windowLoadFailureOwner.adopt(windowLoadFailureOwner.getCurrentAttempt(), receipt);
        },
    });
    const showLifecycle = attachShowLifecycle(window, {
        blockShowUntilRendererReady: shouldWaitForInitialRendererReady,
        isDev: config.isDev,
        logger,
        showAndFocusMaximizedWindow,
        logWindowStartup,
    });

    const handleTopLevelNavigationStart = (
        _event: unknown,
        url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        windowLoadFailureOwner.observeTopLevelNavigation(url, isInPlace, isMainFrame);
    };
    const handleMainFrameLoadFailure = (
        _event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame?: boolean,
    ) => {
        if (isMainFrame === false) {
            return;
        }

        const attempt = windowLoadFailureOwner.getCurrentAttempt();
        const error = new Error(
            attempt === initialLoadAttempt
                ? `Initial renderer load failed (${errorCode}: ${errorDescription}) for ${validatedURL}`
                : `Renderer navigation failed (${errorCode}: ${errorDescription}) for ${validatedURL}`,
        );
        if (attempt === initialLoadAttempt && initialRendererGone) {
            // The renderer-gone listener already owns this startup failure.
        } else if (rendererDiagnostics.isRecoveryLoadInFlight()) {
            rendererDiagnostics.reportRecoveryLoadFailure(error);
        } else {
            windowLoadFailureOwner.report(attempt, error);
        }
        if (attempt === initialLoadAttempt) {
            notifyWindowRendererLoadFailure(window.id, error);
        }
        showLifecycle.handleMainFrameLoadFailure();
    };
    window.webContents.on('did-start-navigation', handleTopLevelNavigationStart);
    window.webContents.on('did-fail-load', handleMainFrameLoadFailure);
    window.on('closed', () => {
        window.webContents.removeListener('did-start-navigation', handleTopLevelNavigationStart);
        window.webContents.removeListener('did-fail-load', handleMainFrameLoadFailure);
    });

    const startupPlaceholderPromise = shouldShowStartupPlaceholder
        ? loadStartupPlaceholder(window, {
            title: config.window.title,
            logger,
        })
        : Promise.resolve();
    const runtimeReadyPromise = windowRuntime.ensureReady();
    void runtimeReadyPromise.catch(() => {});

    const initialLoadPromise = (async () => {
        await runtimeReadyPromise;
        await startupPlaceholderPromise.catch(() => {});
        if (window.isDestroyed()) {
            return;
        }
        await window.loadURL(config.renderer.url);
    })();
    void initialLoadPromise.catch((error) => {
        if (!initialRendererGone) {
            windowLoadFailureOwner.report(
                initialLoadAttempt,
                new Error(`Initial loadURL failed: ${getErrorMessage(error)}`),
            );
        }
    });
    const initialRendererReadyPromise = shouldWaitForInitialRendererReady
        ? waitForInitialRendererReady(window, initialLoadPromise, {
            onInitialLoadFailure: error => {
                if (!initialRendererGone) {
                    windowLoadFailureOwner.report(initialLoadAttempt, error);
                }
            },
            onRendererGone: markInitialRendererGone,
        })
        : null;
    window.webContents.on('did-finish-load', () => {
        void lockRendererZoom(window);
    });
    await startupPlaceholderPromise.catch(() => {});
    if (shouldShowStartupPlaceholder) {
        showAndFocusMaximizedWindow(window);
    }
    logWindowStartup(`BrowserWindow created and loadURL dispatched (step +${Date.now() - createStart}ms)`, {
        windowId: window.id,
        url: config.renderer.url,
    });

    if (initialRendererReadyPromise) {
        try {
            await initialRendererReadyPromise;
        } catch (error) {
            if (!window.isDestroyed()) {
                window.destroy();
            }
            throw error;
        }
    } else {
        await initialLoadPromise;
    }

    return window;
}

export async function createWindow(options: {
    showStartupPlaceholder?: boolean;
    waitForInitialRendererReady?: boolean;
} = {}) {
    const existingMainWindow = getRegisteredMainWindow();
    if (existingMainWindow) {
        return existingMainWindow;
    }

    if (createMainWindowPromise) {
        return createMainWindowPromise;
    }

    createMainWindowPromise = createAppWindow({
        setAsMain: true,
        ...(options.waitForInitialRendererReady === undefined
            ? {}
            : { waitForInitialRendererReady: options.waitForInitialRendererReady }),
        ...(options.showStartupPlaceholder === undefined
            ? {}
            : { showStartupPlaceholder: options.showStartupPlaceholder }),
    });
    try {
        return await createMainWindowPromise;
    } finally {
        createMainWindowPromise = null;
    }
}

export function hasWindows() {
    return getAllRegisteredAppWindows().length > 0;
}
