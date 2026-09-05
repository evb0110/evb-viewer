import {
    app,
    BrowserWindow,
    powerMonitor,
} from 'electron';
import type { IAppUpdateStatus } from '@contracts/updatesPlatformFeature';
import { UPDATES_PLATFORM_FEATURE } from '@contracts/updatesPlatformFeature';
import type { TPerformanceMode } from '@contracts/hostResourceProfile';
import { isRecord } from '@contracts/runtimeGuards';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import {
    createExternalOpenManager,
    createMacOpenFileRouter,
} from '@electron/bootstrap/externalOpen';
import { runInitSequence } from '@electron/bootstrap/runInitSequence';
import {
    resolveExternalOpenDispatchWindow,
    shouldResetRendererReadyOnNavigation,
} from '@electron/bootstrap/rendererReady';
import {
    createShutdownCoordinator,
    createShutdownPhaseRunners,
} from '@electron/bootstrap/shutdown';
import {
    requestShutdownSaveFlush,
    shutdownSaveFlushRequiresRecoveryPreservation,
} from '@electron/bootstrap/requestShutdownSaveFlush';
import { createStartupTrace } from '@electron/bootstrap/createStartupTrace';
import { config } from '@electron/config';
import { registerIpcHandlers } from '@electron/platform-ipc/registerIpcHandlers';
import {
    clearAllWorkingCopies,
    cleanupStaleWorkingCopyDirectories,
    settleAllWorkingCopyMaterializations,
} from '@electron/file-access/workingCopyCleanup';
import { allowOpenPaths } from '@electron/file-access/openPathCapabilities';
import {
    attachHostEnvironmentToWindow,
    installHostEnvironmentDisplayWatcher,
} from '@electron/hostEnvironment';
import {
    sendToWindow,
    setupMenu,
    updateRecentFilesMenu,
} from '@electron/menu';
import { initRecentFilesCache } from '@electron/recentFiles';
import {
    performDjvuViewingShutdownCleanup,
    shutdownDjvuConversions,
    pruneStaleDjvuArtifactJobs,
} from '@electron/features/djvu/public';
import { warmNativeToolProtocolHandshakes } from '@electron/native-tools/warmNativeToolProtocolHandshakes';
import { shutdownLocalMcpServer } from '@electron/features/agent/mcpServer';
import { syncAgentMcpServerWithSettings } from '@electron/features/agent/codexMcpIntegration';
import { shutdownAgentAssistantIfLoaded } from '@electron/features/agent/lazyAgentAssistant';
import {
    recoverOcrJobManager,
    shutdownOcrJobManager,
} from '@electron/ocr/jobManager';
import {searchWorkerService} from '@electron/features/search/public';
import {
    captureMainFailure,
    getMainFailureReporter,
    initializeMainFailureReporter,
    setMainDiagnosticsPreference,
} from '@electron/features/diagnostics/public';
import { readDiagnosticsPreferenceSync } from '@electron/features/diagnostics/readDiagnosticsPreferenceSync';
import {
    installStartupCrashMarker,
    notifyStartupCrashMarkerAdapterReady,
    resolveDesktopDiagnosticDist,
    STARTUP_CRASH_MARKER_FILE_NAME,
} from '@electron/features/diagnostics/startupCrashMarker';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {
    createWindow,
    configureNativeWindowCloseHandshake,
    hasWindows,
} from '@electron/window';
import {
    getAllRegisteredAppWindows,
    getRegisteredMainWindow,
} from '@electron/window/registry';
import { markWindowRendererReady } from '@electron/window/rendererReady';
import { focusWindowForUser } from '@electron/window/focusWindowForUser';
import {
    markWindowTabTransferNotReady,
    markWindowTabTransferReady,
    markWindowTabTransferWindowClosed,
} from '@electron/windowTabTransfer';
import { promptSetDefaultViewer } from '@electron/promptSetDefaultViewer';
import {
    createLogger,
    flushPendingLogWrites,
    type ILogger,
} from '@electron/utils/createLogger';
import {
    closeCachedRangeReadHandles,
    sweepStalePdfAnnotationParseArtifacts,
    sweepStalePdfAnnotationIndexArtifacts,
    sweepStalePdfEmbeddedShapeIndexArtifacts,
    sweepStaleDefaultAppTempPdfs,
    sweepStaleOcrTempArtifacts,
    shutdownSerializedPdfPersistence,
} from '@electron/features/documents/public';
import {
    configureUpdateInstallShutdown,
    initializeUpdates,
    shutdownUpdates,
} from '@electron/updates';
import { getErrorMessage } from '@electron/utils/error';
import {
    registerAppProtocolScheme,
    setupAppProtocolHandler,
} from '@electron/protocol';
import {
    loadSettings,
    resetSettingsCacheAfterUserDataPathChange,
} from '@electron/settings';
import { configureMacKeychainAccess } from '@electron/security/macKeychainAccess';
import {
    beginMainOperationShutdown,
    cancelAllMainOperations,
    drainCriticalMainOperations,
} from '@electron/operation-lifecycle/mainOperationLifecycle';
import { sweepStaleManagedScratchTempDirs } from '@electron/utils/managedScratchTemp';
import { initializeAppTempNamespace } from '@electron/utils/appTempDir';
import {
    configureProcessSafeMode,
    createProcessDeathRecovery,
} from '@electron/processDeathRecovery';
import { markPendingUpdateHealthy } from '@electron/updateHealthMarker';
import { runDetached } from '@electron/utils/runDetached';
import { resolveApplicationVersion } from '@electron/appVersion';
import {
    createUnhandledRejectionRecovery,
    decideUnhandledRejection,
} from '@electron/unhandledRejectionRecovery';
import {
    clearWorkspaceCheckpoint,
    flushPendingWorkspaceCheckpointSave,
} from '@electron/workspaceCheckpointStore';
import { initializeHostResourceProfile } from '@electron/resources/hostResourceProfile';
import { configureMainJobBroker } from '@electron/resources/jobBroker';
import { initializeElectronTranslations } from '@electron/te';
import type {
    DiagnosticCode,
    DiagnosticContext,
} from '@contracts/diagnostics/diagnosticCodes';

app.setName(app.isPackaged ? 'EVB Viewer' : 'EVB Viewer Dev');
configureProcessSafeMode(app, process.argv);
configureMacKeychainAccess(app);
registerAppProtocolScheme();
if (process.platform === 'win32') {
    app.setAppUserModelId('com.evb.viewer');
}

// Explicitly set userData path to ensure it uses our app name
// This fixes a race condition where imports above may cache the default "Electron" path
const automationUserDataDir = process.env.EVB_AUTOMATION_USER_DATA_DIR?.trim();
if (automationUserDataDir) {
    app.setPath('userData', automationUserDataDir);
} else {
    app.setPath('userData', join(app.getPath('appData'), app.name));
}
initializeAppTempNamespace(app.getPath('userData'));
resetSettingsCacheAfterUserDataPathChange();
const diagnosticsPreference = readDiagnosticsPreferenceSync();
const desktopDiagnosticRelease = `evb-viewer-desktop@${resolveApplicationVersion(app)}`;
const desktopDiagnosticDist = resolveDesktopDiagnosticDist();
const startupCrashMarker = installStartupCrashMarker({
    markerPath: join(app.getPath('userData'), STARTUP_CRASH_MARKER_FILE_NAME),
    preference: () => getMainFailureReporter()?.getPreference() ?? diagnosticsPreference,
    // The bootstrap reporter owns no live transport. The real adapter must
    // call notifyStartupCrashMarkerAdapterReady after it is installed.
    release: desktopDiagnosticRelease,
    dist: desktopDiagnosticDist,
});
let mainDiagnosticsAdapterLoad: Promise<void> | null = null;
const unavailableMainDiagnosticsTransport = Object.freeze({
    isReady: false,
    send: () => false,
});
function ensureMainDiagnosticsAdapter() {
    if (mainDiagnosticsAdapterLoad !== null) {
        return mainDiagnosticsAdapterLoad;
    }
    if (
        process.env.EVB_ENABLE_DIAGNOSTICS_CANARY === '1'
        && process.env.EVB_DIAGNOSTICS_CANARY_DISABLE_ADAPTER === '1'
        && automationUserDataDir
        && process.env.EVB_AUTOMATION_SESSION_NAME?.trim()
    ) {
        mainDiagnosticsAdapterLoad = Promise.resolve();
        return mainDiagnosticsAdapterLoad;
    }
    mainDiagnosticsAdapterLoad = import('@electron/features/diagnostics/sentryNodeAdapter')
        .then(({createSentryNodeDiagnosticsTransportFromEnvironment}) => {
            const transport = createSentryNodeDiagnosticsTransportFromEnvironment({
                appVersion: resolveApplicationVersion(app),
                platform: process.platform,
                architecture: process.arch,
                runtimeVersions: process.versions,
            });
            mainFailureReporterForAdapter.setTransport(transport);
            notifyStartupCrashMarkerAdapterReady({
                preference: () => mainFailureReporterForAdapter.getPreference(),
                send: marker => transport.send?.({
                    schemaVersion: 1,
                    eventId: marker.eventId,
                    code: 'MAIN_STARTUP_CRASH',
                    severity: 'fatal',
                    runtime: 'electron-main',
                    operation: 'startup-crash',
                    occurredAt: marker.timestamp,
                    frames: marker.frames,
                    context: {},
                }),
            });
        })
        .catch(() => {
            mainDiagnosticsAdapterLoad = null;
        });
    return mainDiagnosticsAdapterLoad;
}
const mainFailureReporterForAdapter = initializeMainFailureReporter({
    preference: diagnosticsPreference,
    transport: unavailableMainDiagnosticsTransport,
    onPreferenceGranted: ensureMainDiagnosticsAdapter,
});
if (diagnosticsPreference === 'granted') {
    void ensureMainDiagnosticsAdapter();
}

const logger = createLogger('main');
let shutdownCoordinator: ReturnType<typeof createShutdownCoordinator> | null = null;
let pendingSafeModeRelaunchArgs: string[] | null = null;
let pendingFatalFailure: {
    reason: string;
    receipt: FailureReceipt
} | null = null;

function logMainFailure<C extends DiagnosticCode>(
    code: C,
    context: DiagnosticContext<C>,
    message: string,
    cause?: unknown,
) {
    try {
        return logger.error(message, {
            code,
            operation: 'main-error',
            context,
            cause,
        });
    } catch {
        // Diagnostics must not change process-death or shutdown behavior.
        return undefined;
    }
}

const shutdownLogger: ILogger = {
    debug: logger.debug,
    info: logger.info,
    warn: logger.warn,
    error: (message, failure) => {
        const pending = pendingFatalFailure;
        if (pending !== null && pending.reason === message) {
            pendingFatalFailure = null;
            return logger.error(message, pending.receipt);
        }
        return logger.error(message, failure);
    },
};

function requestSafeModeRelaunch(args: string[]) {
    if (!shutdownCoordinator) {
        logger.warn('[process-death] Deferring safe-mode relaunch until shutdown coordination is ready');
        pendingSafeModeRelaunchArgs = args;
        return;
    }
    if (
        shutdownCoordinator.isFatalShutdownInProgress()
        || shutdownCoordinator.isGracefulQuitInProgress()
    ) {
        logger.warn('[process-death] Shutdown is already in progress; leaving its exit action unchanged');
        return;
    }
    shutdownCoordinator.requestGracefulQuit({
        afterCleanup: () => {
            app.relaunch({args});
            app.quit();
        },
        preserveRecoveryState: true,
        reason: 'recovery-relaunch',
    });
}

const processDeathRecovery = createProcessDeathRecovery({
    argv: process.argv,
    logger,
    requestSafeModeRelaunch,
    captureFailure: captureMainFailure,
});
app.on('child-process-gone', (_event, details) => {
    processDeathRecovery.handleChildProcessGone(details);
});
const macOpenFileRouter = createMacOpenFileRouter({ logger });
const startupTrace = createStartupTrace(logger);

function requestFatalShutdown(reason: string, receipt?: FailureReceipt) {
    if (!shutdownCoordinator) {
        logger.error(reason, receipt ?? {
            code: 'MAIN_SHUTDOWN_FAILED',
            context: {},
        });
        app.exit(1);
        return;
    }
    if (receipt === undefined) {
        shutdownCoordinator.requestFatalShutdown(reason);
        return;
    }

    const pending = {
        reason,
        receipt,
    };
    pendingFatalFailure = pending;
    try {
        shutdownCoordinator.requestFatalShutdown(reason);
    } finally {
        if (pendingFatalFailure === pending) {
            pendingFatalFailure = null;
        }
    }
}

// macOS can deliver open-file during very early cold-start launch, before the
// rest of the external-open pipeline is initialized.
app.on('open-file', (event, filePath) => {
    event.preventDefault();
    macOpenFileRouter.handleOpenFile(filePath);
});

const unhandledRecoveryReceipts = new Map<string, FailureReceipt>();
const recoverUnhandledRejectionSubsystem = createUnhandledRejectionRecovery({async recover(subsystem) {
    const message = `Restarting ${subsystem} subsystem after repeated unhandled promise rejections`;
    const receipt = logMainFailure(
        'MAIN_UNHANDLED_REJECTION_RECOVERY',
        {subsystem},
        message,
    );
    if (receipt) {
        unhandledRecoveryReceipts.set(subsystem, receipt);
    }
    if (subsystem === 'ocr') {
        await recoverOcrJobManager();
    } else if (subsystem === 'search') {
        await searchWorkerService.cleanupAll('unhandled rejection threshold');
    } else if (subsystem === 'agent') {
        await shutdownAgentAssistantIfLoaded();
    } else if (subsystem === 'djvu') {
        await shutdownDjvuConversions();
        performDjvuViewingShutdownCleanup();
    } else if (subsystem === 'documents') {
        await closeCachedRangeReadHandles();
    }
}});

// Expected third-party cancellations already settle at their owning boundary.
// Electron dialogs return canceled results, updater requests catch typed aborts,
// and PDF.js or worker cancellations are translated from their local signals.
// No untyped message adapter belongs at this process-wide boundary.

if (process.platform === 'darwin' && config.automation.noFocus) {
    try {
        // Keep automation sessions from becoming the active foreground app on macOS.
        app.setActivationPolicy('accessory');
    } catch (error) {
        logger.warn(
            `Failed to switch activation policy for automation mode: ${
                getErrorMessage(error)
            }`,
        );
    }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const devDockIconPath = join(__dirname, '..', 'resources', 'icon.png');
const aboutIconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : devDockIconPath;
const DEV_DOCK_BADGE_TEXT = 'DEV';

const readyWindowIds = new Set<number>();
let defaultViewerPromptShown = false;
let defaultViewerPromptTimer: NodeJS.Timeout | null = null;

function isMainWindowRendererReady() {
    const mainWindow = getRegisteredMainWindow();
    if (!mainWindow) {
        return false;
    }

    return readyWindowIds.has(mainWindow.id);
}

function focusMainWindow() {
    const window = getRegisteredMainWindow();
    if (!window) {
        return;
    }

    focusWindowForUser(window, {
        application: app,
        noFocus: config.automation.noFocus,
    });
}
const externalOpenManager = createExternalOpenManager({
    application: app,
    logger,
    noFocus: config.automation.noFocus,
    logStartupPhase: startupTrace.log,
    isMainWindowRendererReady,
    getMainWindow: getRegisteredMainWindow,
    hasWindows,
    createWindow: async () => {
        readyWindowIds.clear();
        await createWindow();
    },
    dispatchOpenPaths: (paths) => {
        const window = resolveExternalOpenDispatchWindow({
            mainWindow: getRegisteredMainWindow(),
            focusedWindow: BrowserWindow.getFocusedWindow(),
        });
        if (!window) {
            return false;
        }

        allowOpenPaths(paths, window.webContents);
        return sendToWindow(window, 'menu:openExternalPaths', paths);
    },
});
macOpenFileRouter.attachExternalOpenManager(externalOpenManager);

const MAIN_OPERATION_CRITICAL_DRAIN_TIMEOUT_MS = 30_000;
const RENDERER_SAVE_FLUSH_TIMEOUT_MS = 2_500;

function maybePromptForDefaultViewer() {
    if (config.automation.noFocus) {
        return;
    }

    if (defaultViewerPromptShown) {
        return;
    }
    const window = getRegisteredMainWindow();
    if (!window) {
        return;
    }
    defaultViewerPromptShown = true;
    defaultViewerPromptTimer = setTimeout(() => {
        defaultViewerPromptTimer = null;
        if (window.isDestroyed()) {
            return;
        }
        void promptSetDefaultViewer(window);
    }, 1_500);
}

const workingCopyCleanupSkipPaths = new Set<string>();
const shutdownPhaseRunners = createShutdownPhaseRunners(logger, {
    createPreservationSteps: context => {
        workingCopyCleanupSkipPaths.clear();
        return [
            {
                label: 'renderer-save-flush',
                timeoutMs: RENDERER_SAVE_FLUSH_TIMEOUT_MS + 500,
                run: async () => {
                    const result = await requestShutdownSaveFlush({
                        getWindows: getAllRegisteredAppWindows,
                        logger,
                        timeoutMs: RENDERER_SAVE_FLUSH_TIMEOUT_MS,
                    });
                    if (shutdownSaveFlushRequiresRecoveryPreservation(result)) {
                        context.preserveRecoveryState = true;
                        logger.error('Renderer shutdown save flush was incomplete; retaining workspace recovery state', {
                            code: 'MAIN_SHUTDOWN_SAVE_FLUSH_FAILED',
                            context: {},
                        });
                    }
                    for (const workingCopyPath of result.dirtyWorkingCopyPaths) {
                        workingCopyCleanupSkipPaths.add(workingCopyPath);
                        logger.warn(`Renderer reported dirty working copy during shutdown; skipping deletion: ${workingCopyPath}`);
                    }
                    if (result.flushedWorkingCopyPaths.length > 0) {
                        logger.info(`Renderer flushed ${result.flushedWorkingCopyPaths.length} working copy path(s) before shutdown`);
                    }
                },
            },
            {
                label: 'main-operation-shutdown',
                run: () => {
                    beginMainOperationShutdown('Main process is shutting down');
                },
            },
            {
                label: 'main-operations-cancel',
                run: () => {
                    cancelAllMainOperations('app shutdown');
                },
            },
            {
                label: 'serialized-pdf-persistence',
                timeoutMs: 8_000,
                run: () => shutdownSerializedPdfPersistence(),
            },
            {
                label: 'main-critical-writes',
                // The drain owns a 30s deadline; this guard covers only a bug in
                // the drain itself while leaving time for its pending-path result.
                timeoutMs: MAIN_OPERATION_CRITICAL_DRAIN_TIMEOUT_MS + 500,
                run: async () => {
                    const result = await drainCriticalMainOperations({timeoutMs: MAIN_OPERATION_CRITICAL_DRAIN_TIMEOUT_MS});
                    if (!result.completed) {
                        logger.error(`Timed out waiting for ${result.pending.length} critical main operation(s) during shutdown`, {
                            code: 'MAIN_SHUTDOWN_FAILED',
                            context: {},
                        });
                        for (const operation of result.pending) {
                            if (operation.workingCopyPath) {
                                workingCopyCleanupSkipPaths.add(operation.workingCopyPath);
                                logger.error(
                                    `Skipping working-copy deletion for pending critical write path: ${operation.workingCopyPath}`,
                                    {
                                        code: 'MAIN_SHUTDOWN_FAILED',
                                        context: {},
                                    },
                                );
                            } else {
                                logger.error(`Pending critical write has no working-copy path; operation=${operation.id}`, {
                                    code: 'MAIN_SHUTDOWN_FAILED',
                                    context: {},
                                });
                            }
                        }
                    }
                },
            },
            {
                // Last, so a checkpoint written by any earlier preservation step still
                // survives the debounce window instead of dying with the process.
                label: 'workspace-checkpoint-flush',
                run: () => flushPendingWorkspaceCheckpointSave(),
            },
        ];
    },
    createBestEffortCleanupSteps: context => [
        {
            label: 'agent-assistant',
            run: () => shutdownAgentAssistantIfLoaded(),
        },
        {
            label: 'search-workers',
            timeoutMs: 12_000,
            run: () => searchWorkerService.shutdown('App shutting down'),
        },
        {
            label: 'mcp-server',
            run: () => shutdownLocalMcpServer(),
        },
        {
            label: 'updates',
            run: () => shutdownUpdates(),
        },
        {
            label: 'working-copy-materializations',
            run: () => settleAllWorkingCopyMaterializations(),
        },
        {
            label: 'djvu-conversions',
            run: () => shutdownDjvuConversions(),
        },
        {
            label: 'djvu-viewing',
            run: () => performDjvuViewingShutdownCleanup(),
        },
        {
            label: 'ocr-job-manager',
            run: () => shutdownOcrJobManager(),
        },
        {
            label: 'range-read-handles',
            run: () => closeCachedRangeReadHandles(),
        },
        {
            label: 'workspace-checkpoint',
            run: () => context.preserveRecoveryState
                ? undefined
                : clearWorkspaceCheckpoint(),
        },
        {
            label: 'working-copies',
            run: () => context.preserveRecoveryState
                ? undefined
                : clearAllWorkingCopies({skipPaths: workingCopyCleanupSkipPaths}),
        },
        // Last, so lines emitted by every earlier shutdown step reach disk.
        {
            label: 'log-flush',
            timeoutMs: 2_000,
            run: () => flushPendingLogWrites(),
        },
    ],
});

function prepareShutdown() {
    if (defaultViewerPromptTimer) {
        clearTimeout(defaultViewerPromptTimer);
        defaultViewerPromptTimer = null;
    }
    externalOpenManager.clearTimers();
}

shutdownCoordinator = createShutdownCoordinator({
    app,
    logger: shutdownLogger,
    runPreservationSteps: async (context) => {
        prepareShutdown();
        await shutdownPhaseRunners.runPreservationSteps(context);
    },
    runBestEffortCleanupSteps: shutdownPhaseRunners.runBestEffortCleanupSteps,
});
const shouldBypassWindowClose = () => Boolean(
    shutdownCoordinator?.isGracefulQuitInProgress()
    || shutdownCoordinator?.isFatalShutdownInProgress()
    || shutdownCoordinator?.isQuittingAfterCleanup(),
);
configureNativeWindowCloseHandshake({shouldBypass: shouldBypassWindowClose});
// Install fatal process handlers only after the coordinator exists. A synchronous
// startup exception before this point keeps Node's default fail-fast behavior.
process.on('unhandledRejection', (reason) => {
    const decision = decideUnhandledRejection(reason);
    if (decision.action === 'ignore') {
        logger.info(`Ignoring expected unhandled rejection in main process: ${getErrorMessage(reason)}`);
        return;
    }
    const rejectionMessage = `Unhandled promise rejection in main process: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`;
    const receipt = logMainFailure(
        'MAIN_UNHANDLED_REJECTION',
        {subsystem: decision.action === 'fatal' ? 'unknown' : decision.subsystem},
        rejectionMessage,
        reason,
    );
    if (decision.action === 'fatal') {
        requestFatalShutdown('Unhandled promise rejection requires fatal shutdown', receipt);
        return;
    }
    const recoveryLoggerError = (message: string) => {
        const recoveryReceipt = unhandledRecoveryReceipts.get(decision.subsystem);
        if (!recoveryReceipt) {
            return logger.error(message, {
                code: 'MAIN_UNHANDLED_REJECTION_RECOVERY',
                context: {subsystem: decision.subsystem},
            });
        }
        const projectedReceipt = logger.error(message, recoveryReceipt);
        unhandledRecoveryReceipts.delete(decision.subsystem);
        return projectedReceipt;
    };
    runDetached(
        () => recoverUnhandledRejectionSubsystem(decision.subsystem, reason).then(result => {
            if (result.recovered) {
                unhandledRecoveryReceipts.delete(decision.subsystem);
            }
            return result;
        }),
        {
            label: 'recover subsystem after unhandled rejection threshold',
            logger: {error: recoveryLoggerError},
            onError: error => {
                const recoveryReceipt = unhandledRecoveryReceipts.get(decision.subsystem);
                requestFatalShutdown(
                    `Unhandled rejection subsystem recovery failed (${decision.subsystem}): ${getErrorMessage(error)}`,
                    recoveryReceipt,
                );
            },
        },
    );
});
process.on('uncaughtException', (error) => {
    const receipt = startupCrashMarker.captureLiveException(error);
    requestFatalShutdown(
        `Uncaught exception in main process: ${error.stack ?? error.message}`,
        receipt,
    );
});
function requestSystemShutdown(event?: {preventDefault(): void}) {
    if (shutdownCoordinator?.isQuittingAfterCleanup()) {
        return;
    }
    event?.preventDefault();
    shutdownCoordinator?.requestSystemShutdown();
}
app.on('browser-window-created', (_event, window) => {
    window.on('query-session-end', requestSystemShutdown);
});
void app.whenReady().then(() => {
    powerMonitor.on('shutdown', requestSystemShutdown);
});
if (pendingSafeModeRelaunchArgs) {
    const args = pendingSafeModeRelaunchArgs;
    pendingSafeModeRelaunchArgs = null;
    requestSafeModeRelaunch(args);
}
configureUpdateInstallShutdown((install) => {
    shutdownCoordinator?.requestGracefulQuit({ afterCleanup: install });
});

function broadcastUpdateStatus(status: IAppUpdateStatus) {
    for (const window of getAllRegisteredAppWindows()) {
        sendToWindow(window, UPDATES_PLATFORM_FEATURE.eventChannels.onStatus, status);
    }
}

const allowMultipleAutomationSessions = process.env.EVB_ALLOW_MULTI_AUTOMATION_SESSIONS === '1';

function isPerformanceMode(value: unknown): value is TPerformanceMode {
    return value === 'auto'
        || value === 'low'
        || value === 'medium'
        || value === 'high';
}

function readLaunchPerformanceMode(value: unknown) {
    // Automation-only override; remove if the E2E harness gains a settings
    // handoff that survives session relaunches.
    const automationMode = automationUserDataDir
        ? process.env.EVB_TEST_PERFORMANCE_MODE
        : undefined;
    if (isPerformanceMode(automationMode)) {
        return automationMode;
    }
    return isRecord(value) && isPerformanceMode(value.performanceMode)
        ? value.performanceMode
        : 'auto';
}

void runInitSequence({
    app,
    aboutIconPath,
    allowMultipleAutomationSessions,
    allowOpenPaths,
    attachHostEnvironmentToWindow,
    broadcastUpdateStatus,
    cleanupStaleWorkingCopyDirectories,
    createWindow,
    devDockBadgeText: DEV_DOCK_BADGE_TEXT,
    devDockIconPath,
    externalOpenManager,
    focusMainWindow,
    getMainWindow: getRegisteredMainWindow,
    getWindowFromWebContents: BrowserWindow.fromWebContents,
    hasWindows,
    initRecentFilesCache,
    initializeElectronTranslations,
    initializeResourceRuntime: async () => {
        const settings = await loadSettings();
        setMainDiagnosticsPreference(settings.clientDiagnosticsPreference);
        const resourceProfile = initializeHostResourceProfile({
            app,
            performanceMode: readLaunchPerformanceMode(settings),
        });
        configureMainJobBroker(resourceProfile);
        startupTrace.log(
            `Host resource profile initialized: tier=${resourceProfile.tier}, `
            + `mode=${resourceProfile.performanceMode}, logicalCpus=${resourceProfile.logicalCpus}, `
            + `totalRamBytes=${resourceProfile.totalRamBytes}, safeMode=${String(resourceProfile.safeMode)}`,
        );
    },
    initializeUpdates,
    installHostEnvironmentDisplayWatcher,
    logger,
    loadSettings,
    logStartupPhase: startupTrace.log,
    markWindowRendererReady: (windowId) => {
        markWindowRendererReady(windowId);
        if (windowId !== getRegisteredMainWindow()?.id) {
            return;
        }
        runDetached(
            () => markPendingUpdateHealthy(resolveApplicationVersion(app)),
            {
                label: 'mark current update healthy',
                logger,
            },
        );
    },
    markWindowTabTransferNotReady,
    markWindowTabTransferReady,
    markWindowTabTransferWindowClosed,
    maybePromptForDefaultViewer,
    readyWindowIds,
    registerIpcHandlers,
    setupAppProtocolHandler,
    setupMenu,
    updateRecentFilesMenu,
    shouldResetRendererReadyOnNavigation,
    shutdownCoordinator,
    sweepStaleDefaultAppTempPdfs,
    sweepStalePdfAnnotationParseArtifacts,
    sweepStalePdfAnnotationIndexArtifacts,
    sweepStalePdfEmbeddedShapeIndexArtifacts,
    sweepStaleManagedScratchTempDirs,
    sweepStaleOcrTempArtifacts,
    pruneStaleDjvuArtifactJobs,
    warmNativeToolProtocolHandshakes,
})
    .then(() => syncAgentMcpServerWithSettings())
    .catch((error) => {
        requestFatalShutdown(`Application bootstrap failed: ${getErrorMessage(error)}`);
    });
