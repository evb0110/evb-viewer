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
import {runtimeConfig} from '@electron/runtimeConfig';
import { te } from '@electron/te';
import { createLogger } from '@electron/utils/createLogger';
import { createWindowSecurity } from '@electron/window/createWindowSecurity';
import { setupContentSecurityPolicy } from '@electron/security/csp';
import { getErrorMessage } from '@electron/utils/error';
import {
    getWindowStartupPhase,
    publishWindowStartupPhase,
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
import { captureMainFailure } from '@electron/features/diagnostics/public';
import { createWindowStartupOptions } from '@electron/window/createWindowStartupOptions';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import type {TRendererStartupFailure} from '@contracts/windowTabsPlatformFeature';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const windowIconPath = !app.isPackaged && !config.isMac
    ? join(__dirname, '..', 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
    : undefined;

const logger = createLogger('window');
const windowStartupStartedAt = Date.now();
const STARTUP_TRACE_ENABLED = runtimeConfig.startupTrace;
const UNRESPONSIVE_RECOVERY_DELAY_MS = 15_000;
const RENDERER_RECOVERY_WINDOW_MS = 5 * 60_000;
const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;

function reportWindowFailure(
    code: string,
    message: string,
    cause?: unknown,
) {
    return logger.error('Window operation failed', captureMainFailure({
        code,
        message,
        cause,
    }), {message});
}

function logWindowStartup(phase: string, details?: Record<string, unknown>) {
    if (!STARTUP_TRACE_ENABLED) {
        return;
    }

    const now = Date.now();
    const elapsedMs = now - windowStartupStartedAt;
    const message = `[startup] ${phase} (+${elapsedMs}ms)`;
    logger.debug('Window startup phase', {
        phase,
        elapsedMs,
        ...details,
    });
    console.info(`[${new Date(now).toISOString()}] [window] ${message}`, {
        elapsedMs,
        ...details,
    });
}

let createMainWindowPromise: Promise<BrowserWindow> | null = null;
let shouldBypassNativeWindowClose = () => false;
let onNativeWindowCloseCancel: () => void = () => undefined;
let rawIpcRegistrationAudit: IRawIpcRegistrationAudit | undefined;

export function setNativeWindowCloseCancelHandler(handler: () => void) {
    onNativeWindowCloseCancel = handler;
}

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
            const receipt = logger.error('Renderer load failed', {
                code: 'MAIN_WINDOW_OPERATION_FAILED',
                cause: error,
            }, {message: error.message});
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
    presentFailure: (failure: TRendererStartupFailure, reload: () => void) => void;
    reportRecoveryLoadFailure: (error: unknown) => FailureReceipt | undefined;
}

const windowSecurity = createWindowSecurity({
    getTrustedRendererUrl: () => config.renderer.trustedUrl,
    logger,
});

function ensureWindowRuntimeReady() {
    const runtimeStart = Date.now();
    try {
        setupContentSecurityPolicy();
        logWindowStartup(`Window runtime ready (step +${Date.now() - runtimeStart}ms)`);
        return Promise.resolve();
    } catch (error) {
        return Promise.reject(error);
    }
}

function showAndFocusMaximizedWindow(window: BrowserWindow) {
    if (window.isDestroyed()) {
        return;
    }

    if (config.automation.hideWindow) {
        // Automation windows stay hidden so local desktop focus is never disrupted.
        return;
    }

    if (config.automation.noFocus) {
        // E2E windows stay out of focus and keep their opening placement: the
        // runner owns their size, and undoing a maximize races the renderer.
        if (!window.isVisible()) {
            window.showInactive();
        }
        return;
    }

    if (!window.isMaximized()) {
        window.maximize();
    }
    if (!window.isVisible()) {
        window.show();
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
        logger.warn('Failed to lock renderer zoom', {error: getErrorMessage(error)});
    }
}

async function promptUnresponsiveRendererRecovery(
    window: BrowserWindow,
    windowId: number,
    recoverRenderer: (reason: string) => void,
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
            logger.info('Renderer recovery prompt failed after window destruction', {
                windowId,
                error: getErrorMessage(error),
            });
        } else {
            reportWindowFailure(
                'MAIN_UNRESPONSIVE_RECOVERY_FAILED',
                message,
                error,
            );
        }
        recoverRenderer('unresponsive-dialog-fallback');
    }
}

// A window whose renderer ran out of recovery attempts, whose page did not load
// or whose startup timed out shows no app. Instead of leaving it blank, the
// user may reload it once more or close it; unsaved work stays in the
// workspace recovery record either way. The answer acts only while that failure
// is still the window's phase: a recovered shell or a newer load supersedes it.
async function promptFailedRendererRecovery(
    window: BrowserWindow,
    windowId: number,
    failure: Exclude<TRendererStartupFailure, {reason: 'renderer-error'}>,
    reloadRenderer: () => void,
) {
    const {reason} = failure;
    if (window.isDestroyed()) {
        return;
    }
    if (config.automation.hideWindow || config.automation.noFocus) {
        logger.warn('The automation window keeps no renderer after its failure', {
            windowId,
            reason,
        });
        return;
    }

    const BUTTON_CLOSE = 0;
    const BUTTON_RELOAD = 1;

    // A dialog that cannot be shown closes the window rather than leave it blank.
    const response = await dialog.showMessageBox(window, {
        type: 'error',
        ...(reason === 'renderer-gone'
            ? {
                title: te('dialogs.rendererCrashed.title'),
                message: te('dialogs.rendererCrashed.message'),
                detail: te('dialogs.rendererCrashed.detail'),
            }
            : {
                title: te('errors.runtime.startupTitle'),
                message: te('errors.runtime.startupTitle'),
                detail: te('errors.runtime.startupDescription'),
            }),
        buttons: [
            te('dialogs.rendererCrashed.close'),
            te('dialogs.rendererCrashed.reload'),
        ],
        defaultId: BUTTON_RELOAD,
        cancelId: BUTTON_CLOSE,
        noLink: true,
    }).then(result => result.response, (error: unknown) => {
        reportWindowFailure(
            'MAIN_RENDERER_RECOVERY_FAILED',
            `Failed to prompt after renderer recovery ran out (windowId=${windowId}): ${getErrorMessage(error)}`,
            error,
        );
        return BUTTON_CLOSE;
    });
    if (window.isDestroyed() || getWindowStartupPhase(windowId) !== failure) {
        return;
    }
    if (response === BUTTON_RELOAD) {
        reloadRenderer();
    } else {
        window.destroy();
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
            logger.info('Renderer recovery load failed after window destruction', {
                windowId,
                reason: failure.reason,
                error: getErrorMessage(error),
            });
        } else {
            receipt = reportWindowFailure(
                failure.reason.startsWith('unresponsive-')
                    ? 'MAIN_UNRESPONSIVE_RECOVERY_FAILED'
                    : 'MAIN_RENDERER_RECOVERY_FAILED',
                message,
                error,
            );
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
        logger.warn('Attempting renderer recovery load', {
            reason,
            windowId,
            attempt: recentRecoveryAttempts.length,
        });
        void (async () => {
            try {
                await ensureWindowRuntimeReady();
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
            logger.info('Renderer process exited after window destruction', {
                windowId,
                reason: details.reason,
                exitCode: details.exitCode,
            });
            return;
        }
        reportWindowFailure(
            'MAIN_RENDERER_PROCESS_GONE',
            message,
        );
        // Development runs no recovery, so its renderer is as gone as one out of attempts.
        if (config.isDev || (!recoveryInFlight && isRecoveryUnavailable())) {
            publishWindowStartupPhase(windowId, {
                phase: 'failed',
                reason: 'renderer-gone',
            });
            return;
        }
        recoverRenderer(`render-process-gone:${details.reason}`);
    });

    webContents.on('preload-error', (_event, preloadPath, error) => {
        const message = `[renderer] preload-error (windowId=${windowId}, preload=${preloadPath}): ${
            error.stack ?? getErrorMessage(error)
        }`;
        if (window.isDestroyed()) {
            logger.info('Renderer preload failed after window destruction', {
                windowId,
                preloadPath,
                error: error.stack ?? getErrorMessage(error),
            });
            return;
        }
        reportWindowFailure(
            'MAIN_PRELOAD_ERROR',
            message,
            error,
        );
    });

    window.on('unresponsive', () => {
        logger.warn('Renderer window unresponsive', {windowId});
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
                message,
            );
            logger.warn('Prompting recovery for unresponsive renderer', {windowId});
            void promptUnresponsiveRendererRecovery(
                window,
                windowId,
                recoverRenderer,
            )
                .finally(() => {
                    unresponsivePromptInFlight = false;
                });
        }, UNRESPONSIVE_RECOVERY_DELAY_MS);
        unresponsiveRecoveryTimer.unref();
    });

    window.on('responsive', () => {
        logger.debug('Renderer window responsive', {windowId});
        clearUnresponsiveRecoveryTimer();
    });

    window.on('closed', () => {
        clearUnresponsiveRecoveryTimer();
    });

    const rendererDiagnostics: IRendererDiagnosticsHandle = {
        isRecoveryLoadInFlight: () => recoveryInFlight,
        // The renderer presents its own failure; development keeps the window as it is.
        // A reload replaces any pending recovery load and gets a fresh recovery budget.
        presentFailure: (failure, reload) => {
            if (config.isDev || failure.reason === 'renderer-error') {
                return;
            }
            void promptFailedRendererRecovery(window, windowId, failure, () => {
                recentRecoveryAttempts = [];
                logger.warn('Reloading the renderer after its failure prompt', {
                    reason: failure.reason,
                    windowId,
                });
                reload();
            });
        },
        reportRecoveryLoadFailure,
    };

    if (!config.isDev) {
        return rendererDiagnostics;
    }

    webContents.on('did-finish-load', () => {
        logger.debug('Renderer finished loading', {
            windowId,
            url: webContents.getURL(),
        });
    });

    return rendererDiagnostics;
}


export async function createAppWindow(options: ICreateAppWindowOptions = {}) {
    const createStart = Date.now();
    const preloadPath = join(__dirname, 'preload.cjs');
    const keepAutomationRendererActive = config.automation.hideWindow || config.automation.noFocus;

    const startupOptions = createWindowStartupOptions();
    const window = new BrowserWindow({
        ...startupOptions.bounds,
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
            additionalArguments: startupOptions.additionalArguments,
            ...(keepAutomationRendererActive ? {backgroundThrottling: false} : {}),
        },
    });
    const windowWebContents = window.webContents;
    let lastFrameSubscriptionAtMs: number | null = null;
    if (keepAutomationRendererActive) {
        const logPaintState = (renderer: string) => logger.info('Automation first-paint window state', {
            renderer,
            windowId: window.id,
            visible: window.isVisible(),
            minimized: window.isMinimized(),
            nativeFrameVisibility: windowWebContents.mainFrame.visibilityState,
            // Electron exposes no window occlusion query or presentation timestamp.
            occluded: null,
            lastPresentedFrameAtMs: null,
            lastFrameSubscriptionAtMs,
        });
        windowWebContents.on('console-message', event => {
            if (event.message.startsWith('[automation-first-paint] ')) {
                logPaintState(event.message);
            }
        });
        window.on('show', () => logPaintState('window:show'));
        window.on('hide', () => logPaintState('window:hide'));
        window.on('minimize', () => logPaintState('window:minimize'));
        window.on('restore', () => logPaintState('window:restore'));
        window.on('close', () => logPaintState('window:close'));
    }

    registerAppWindow(window, {...(options.setAsMain === undefined ? {} : { setAsMain: options.setAsMain })});
    attachNativeWindowCloseHandshake(window, {
        ipcMain,
        logger,
        onCancel: () => onNativeWindowCloseCancel(),
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
    // The initial load and a reload after a failure prompt share one startup
    // deadline; its timeout belongs to the current load.
    const loadRenderer = (beforeLoad: Promise<unknown>) => ({
        readyPromise: waitForInitialRendererReady(window, {
            onInitialLoadFailure: error => {
                windowLoadFailureOwner.report(windowLoadFailureOwner.getCurrentAttempt(), error);
            },
        }),
        loadPromise: (async () => {
            await beforeLoad;
            if (window.isDestroyed()) {
                return;
            }
            await window.loadURL(config.renderer.url);
        })(),
    });
    // A failure the reload meets is published as a startup phase and presented again.
    const reloadAfterFailure = () => {
        const {readyPromise, loadPromise} = loadRenderer(ensureWindowRuntimeReady());
        void readyPromise.catch(() => {});
        void loadPromise.catch(() => {});
    };
    const showLifecycle = attachShowLifecycle(window, {
        blockShowUntilRendererReady: shouldWaitForInitialRendererReady,
        logger,
        showAndFocusMaximizedWindow,
        presentStartupFailure: failure => rendererDiagnostics.presentFailure(failure, reloadAfterFailure),
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
            showLifecycle.reveal();
            return;
        }
        if (rendererDiagnostics.isRecoveryLoadInFlight()) {
            rendererDiagnostics.reportRecoveryLoadFailure(error);
        } else {
            windowLoadFailureOwner.report(attempt, error);
        }
        // An aborted load (-3) was replaced by another navigation, which reports its own outcome.
        if (errorCode !== -3) {
            publishWindowStartupPhase(window.id, {
                phase: 'failed',
                reason: 'load-failed',
            }, error);
        }
    };
    windowWebContents.on('did-start-navigation', handleTopLevelNavigationStart);
    windowWebContents.on('did-fail-load', handleMainFrameLoadFailure);
    window.on('closed', () => {
        // BrowserWindow.webContents throws after the window's WebContents has
        // been destroyed. Keep the captured EventEmitter for teardown so a
        // close during renderer restart cannot crash the main process.
        windowWebContents.removeListener('did-start-navigation', handleTopLevelNavigationStart);
        windowWebContents.removeListener('did-fail-load', handleMainFrameLoadFailure);
    });

    const startupPlaceholderPromise = shouldShowStartupPlaceholder
        ? loadStartupPlaceholder(window, {
            title: config.window.title,
            logger,
        })
        : Promise.resolve();
    const runtimeReadyPromise = ensureWindowRuntimeReady();
    // A navigation's failure arrives as did-fail-load; without a runtime none starts.
    void runtimeReadyPromise.catch((error) => {
        publishWindowStartupPhase(window.id, {
            phase: 'failed',
            reason: 'load-failed',
        }, new Error(`Initial loadURL failed: ${getErrorMessage(error)}`));
    });

    const {
        readyPromise: initialRendererReadyPromise,
        loadPromise: initialLoadPromise,
    } = loadRenderer(runtimeReadyPromise.then(() => startupPlaceholderPromise.catch(() => {})));
    void initialLoadPromise.catch((error) => {
        if (!initialRendererGone) {
            windowLoadFailureOwner.report(
                initialLoadAttempt,
                new Error(`Initial loadURL failed: ${getErrorMessage(error)}`),
            );
        }
    });
    if (!shouldWaitForInitialRendererReady) {
        // Its failure is presented in the window, which stays open.
        void initialRendererReadyPromise.catch(() => {});
    }
    windowWebContents.on('did-finish-load', () => {
        void lockRendererZoom(window);
        if (keepAutomationRendererActive && process.platform !== 'darwin') {
            // Keep pending copies for automation windows, including Linux startup.
            windowWebContents.beginFrameSubscription(() => {
                lastFrameSubscriptionAtMs = Date.now();
            });
        }
    });
    await startupPlaceholderPromise.catch(() => {});
    if (shouldShowStartupPlaceholder) {
        showLifecycle.reveal();
    }
    logWindowStartup(`BrowserWindow created and loadURL dispatched (step +${Date.now() - createStart}ms)`, {
        windowId: window.id,
        url: config.renderer.url,
    });

    if (shouldWaitForInitialRendererReady) {
        try {
            await initialRendererReadyPromise;
        } catch (error) {
            if (!window.isDestroyed()) {
                window.destroy();
            }
            throw error;
        }
    } else {
        await initialLoadPromise.catch(() => {});
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
