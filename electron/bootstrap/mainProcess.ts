import {
    app,
    BrowserWindow,
    powerMonitor,
} from 'electron';
import { parseDocumentRef } from '@contracts/documentRef';
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
import { createShutdownCoordinator } from '@electron/bootstrap/shutdown';
import { createShutdownPhaseRunners } from '@electron/bootstrap/createShutdownPhaseRunners';
import {
    requestShutdownSaveFlush,
    shutdownSaveFlushRequiresRecoveryPreservation,
    shutdownSaveFlushRequiresRetryableQuit,
} from '@electron/bootstrap/requestShutdownSaveFlush';
import { createStartupTrace } from '@electron/bootstrap/createStartupTrace';
import { config } from '@electron/config';
import {runtimeConfig} from '@electron/runtimeConfig';
import { registerIpcHandlers } from '@electron/platform-ipc/registerIpcHandlers';
import type { TLazyMainSubsystem } from '@electron/platform-ipc/featureRegistrationDescriptors';
import { isTrustedWebContentsSender } from '@electron/platform-ipc/trustedIpcSender';
import { CORE_IPC_SEND_CHANNELS } from '@electron/platform-ipc/coreContract';
import { createRawIpcRegistrationAudit } from '@electron/platform-ipc/rawIpcRegistration';
import {
    clearAllWorkingCopies,
    collectStaleDocuments,
    settleOpenDocuments,
} from '@electron/file-access/documentStore';
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
    captureMainFailure,
    consumeStartupCrashMarker,
    installStartupCrashMarker,
    readDiagnosticsPreferenceSync,
    setMainDiagnosticsPreference,
} from '@electron/features/diagnostics/public';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {
    createAppWindow,
    createWindow,
    configureNativeWindowCloseHandshake,
    hasWindows,
} from '@electron/window';
import {
    getAllRegisteredAppWindows,
    getRegisteredMainWindow,
} from '@electron/window/registry';
import {
    getWindowStartupPhase,
    publishWindowStartupPhase,
    requestInitialReveal,
} from '@electron/window/rendererReady';
import { focusWindowForUser } from '@electron/window/focusWindowForUser';
import {
    markWindowTabTransferNotReady,
    markWindowTabTransferReady,
    markWindowTabTransferWindowClosed,
} from '@electron/windowTabTransfer';
import {
    configureLogDirectory,
    createLogger,
    flushPendingLogWrites,
    type ILogger,
} from '@electron/utils/createLogger';
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
import type { IMainOperationSnapshot } from '@electron/operation-lifecycle/mainOperationLifecycle';
import {
    getAppTempDir,
    initializeAppTempNamespace,
} from '@electron/utils/appTempDir';
import {
    configureProcessSafeMode,
    createProcessDeathRecovery,
} from '@electron/processDeathRecovery';
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

app.setName(app.isPackaged ? 'EVB Viewer' : 'EVB Viewer Dev');
configureProcessSafeMode(app, process.argv);
configureMacKeychainAccess(app);
registerAppProtocolScheme();
if (process.platform === 'win32') {
    app.setAppUserModelId('com.evb.viewer');
}

// Explicitly set userData path to ensure it uses our app name
// This fixes a race condition where imports above may cache the default "Electron" path
const automationUserDataDir = runtimeConfig.automationUserDataDir;
if (automationUserDataDir) {
    app.setPath('userData', automationUserDataDir);
} else {
    app.setPath('userData', join(app.getPath('appData'), app.name));
}
configureLogDirectory(app.getPath('logs'));
initializeAppTempNamespace(app.getPath('userData'));
resetSettingsCacheAfterUserDataPathChange();
setMainDiagnosticsPreference(readDiagnosticsPreferenceSync());
const disarmStartupCrashMarker = installStartupCrashMarker();

const logger = createLogger('main');
let shutdownCoordinator: ReturnType<typeof createShutdownCoordinator> | null = null;
let featureRegistrationRuntime: ReturnType<typeof registerIpcHandlers> | null = null;
let pendingSafeModeRelaunchArgs = null as string[] | null;
let pendingFatalFailure: {
    reason: string;
    receipt: FailureReceipt
} | null = null;

function logMainFailure(
    code: string,
    message: string,
    cause?: unknown,
) {
    try {
        return logger.error(message, {
            code,
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
        logger.error(reason, receipt ?? {code: 'MAIN_SHUTDOWN_FAILED'});
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

type TUpdatesModule = typeof import('@electron/updates');
let updatesModulePromise: Promise<TUpdatesModule> | null = null;
let loadedUpdatesModule: TUpdatesModule | null = null;
const loadedSubsystems = new Set<TLazyMainSubsystem>();

function isShutdownActive() {
    return Boolean(
        shutdownCoordinator?.isGracefulQuitInProgress()
        || shutdownCoordinator?.isFatalShutdownInProgress()
        || shutdownCoordinator?.isQuittingAfterCleanup(),
    );
}

function markSubsystemLoaded(subsystem: TLazyMainSubsystem) {
    loadedSubsystems.add(subsystem);
}

function loadAgentModule() {
    markSubsystemLoaded('agent');
    return import('@electron/features/agent/public');
}

function loadUpdatesModule(): Promise<TUpdatesModule> {
    updatesModulePromise ??= import('@electron/updates').then((module) => {
        module.configureUpdateInstallShutdown((install) => {
            shutdownCoordinator?.requestGracefulQuit({ afterCleanup: install });
        });
        loadedUpdatesModule = module;
        return module;
    }).catch((error) => {
        updatesModulePromise = null;
        throw error;
    });
    return updatesModulePromise;
}

const unhandledRecoveryReceipts = new Map<string, FailureReceipt>();
const recoverUnhandledRejectionSubsystem = createUnhandledRejectionRecovery({async recover(subsystem) {
    const message = `Restarting ${subsystem} subsystem after repeated unhandled promise rejections`;
    const receipt = logMainFailure(
        'MAIN_UNHANDLED_REJECTION_RECOVERY',
        message,
    );
    if (receipt) {
        unhandledRecoveryReceipts.set(subsystem, receipt);
    }
    if (subsystem === 'ocr' && loadedSubsystems.has('ocr')) {
        const {recoverOcrJobManager} = await import('@electron/features/ocr/public');
        await recoverOcrJobManager();
    } else if (subsystem === 'search' && loadedSubsystems.has('search')) {
        const {searchService} = await import('@electron/features/search/public');
        searchService.cancelAll('unhandled rejection threshold');
    } else if (subsystem === 'agent' && loadedSubsystems.has('agent')) {
        const {shutdownAgentAssistantIfLoaded} = await loadAgentModule();
        await shutdownAgentAssistantIfLoaded();
    } else if (subsystem === 'djvu' && loadedSubsystems.has('djvu')) {
        const {
            performDjvuViewingShutdownCleanup,
            shutdownDjvuConversions,
        } = await import('@electron/features/djvu/public');
        await shutdownDjvuConversions();
        performDjvuViewingShutdownCleanup();
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

let defaultViewerPromptShown = false;
let defaultViewerPromptTimer: NodeJS.Timeout | null = null;

function isMainWindowRendererReady() {
    const mainWindow = getRegisteredMainWindow();
    return mainWindow !== null && getWindowStartupPhase(mainWindow.id)?.phase === 'shell-interactive';
}

function focusMainWindow() {
    const window = getRegisteredMainWindow();
    if (!window || requestInitialReveal(window.id)) {
        return;
    }

    focusWindowForUser(window, {
        application: app,
        noFocus: config.automation.noFocus,
    });
}
const externalOpenManager = createExternalOpenManager({
    logger,
    logStartupPhase: startupTrace.log,
    isMainWindowRendererReady,
    focusMainWindow,
    hasWindows,
    createWindow: () => createWindow(),
    dispatchOpenPaths: (paths) => {
        const window = resolveExternalOpenDispatchWindow({
            mainWindow: getRegisteredMainWindow(),
            focusedWindow: BrowserWindow.getFocusedWindow(),
        });
        if (!window) {
            return false;
        }

        const validPaths: string[] = [];
        const documentRefs = [];
        for (const path of paths) {
            const documentRef = parseDocumentRef(path);
            if (documentRef === null) {
                logger.warn(`Ignoring unparseable external open path during dispatch: ${path}`);
                continue;
            }
            validPaths.push(path);
            documentRefs.push(documentRef);
        }

        if (documentRefs.length === 0) {
            return true;
        }

        const dispatched = sendToWindow(window, 'menu:openExternalPaths', documentRefs);
        if (dispatched) {
            allowOpenPaths(validPaths, window.webContents);
        }
        return dispatched;
    },
});
macOpenFileRouter.attachExternalOpenManager(externalOpenManager);

const MAIN_OPERATION_CRITICAL_DRAIN_TIMEOUT_MS = 30_000;
const RENDERER_SAVE_FLUSH_TIMEOUT_MS = 2_500;
const rawIpcRegistrationAudit = createRawIpcRegistrationAudit();

function maybePromptForDefaultViewer() {
    if (config.automation.noFocus || isShutdownActive()) {
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
        if (isShutdownActive() || window.isDestroyed()) {
            return;
        }
        // Stale copies first, so "Open With" and the default handler name
        // the installed app only.
        runDetached(
            async () => {
                const {unregisterOtherMacAppCopies} = await import('@electron/unregisterOtherMacAppCopies');
                await unregisterOtherMacAppCopies();
                if (isShutdownActive() || window.isDestroyed()) {
                    return;
                }
                const {promptSetDefaultViewer} = await import('@electron/promptSetDefaultViewer');
                if (isShutdownActive() || window.isDestroyed()) {
                    return;
                }
                await promptSetDefaultViewer(window);
            },
            {
                label: 'default viewer prompt',
                logger,
            },
        );
    }, 1_500);
}

const workingCopyCleanupSkipPaths = new Set<string>();

/**
 * A critical write that did not reach its commit boundary leaves the only copy
 * of the user's edits in its working copy, so the shutdown sweep must not
 * delete it. Both the cancelled writes and the ones the drain gave up on need
 * the same treatment; the caller supplies the wording for the log.
 */
function preserveCriticalWriteWorkingCopies(
    operations: readonly IMainOperationSnapshot[],
    description: string,
) {
    for (const operation of operations) {
        if (operation.workingCopyPath) {
            workingCopyCleanupSkipPaths.add(operation.workingCopyPath);
            logger.error(
                `Skipping working-copy deletion for ${description} critical write path: ${operation.workingCopyPath}`,
                {code: 'MAIN_SHUTDOWN_FAILED'},
            );
        } else {
            logger.error(`A ${description} critical write has no working-copy path; operation=${operation.id}`, {code: 'MAIN_SHUTDOWN_FAILED'});
        }
    }
}
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
                        isTrustedSender: (sender, senderFrame) => isTrustedWebContentsSender(
                            sender,
                            senderFrame,
                            CORE_IPC_SEND_CHANNELS.shutdownSaveFlushResult,
                        ),
                        rawIpcRegistrationAudit,
                    });
                    if (shutdownSaveFlushRequiresRecoveryPreservation(result)) {
                        context.preserveRecoveryState = true;
                        // Unsaved work that the quit keeps for recovery by design is not a
                        // failure. Only a failed or timed-out flush is.
                        if (shutdownSaveFlushRequiresRetryableQuit(result)) {
                            logger.error('Renderer shutdown save flush was incomplete; retaining workspace recovery state', {code: 'MAIN_SHUTDOWN_SAVE_FLUSH_FAILED'});
                        } else {
                            logger.info('Renderer shutdown save flush kept unsaved work for recovery');
                        }
                    }
                    if (shutdownSaveFlushRequiresRetryableQuit(result)) {
                        context.retryablePreservationFailure = true;
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
                label: 'assistant-history-preservation',
                onFailure: () => {
                    context.retryablePreservationFailure = true;
                },
                run: async () => {
                    if (!loadedSubsystems.has('agent')) {
                        return;
                    }
                    const {preserveAssistantStateForShutdownIfLoaded} = await import('@electron/features/agent/public');
                    await preserveAssistantStateForShutdownIfLoaded();
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
                    const canceledCriticalWrites = cancelAllMainOperations('app shutdown');
                    if (canceledCriticalWrites.length > 0) {
                        context.preserveRecoveryState = true;
                        preserveCriticalWriteWorkingCopies(canceledCriticalWrites, 'cancelled pre-commit');
                    }
                },
            },
            {
                label: 'serialized-pdf-persistence',
                timeoutMs: 8_000,
                run: async () => {
                    if (!loadedSubsystems.has('documents')) {
                        return;
                    }
                    const {shutdownSerializedPdfPersistence} = await import('@electron/features/documents/public');
                    await shutdownSerializedPdfPersistence();
                },
            },
            {
                label: 'main-critical-writes',
                // The drain owns a 30s deadline; this guard covers only a bug in
                // the drain itself while leaving time for its pending-path result.
                timeoutMs: MAIN_OPERATION_CRITICAL_DRAIN_TIMEOUT_MS + 500,
                run: async () => {
                    const result = await drainCriticalMainOperations({timeoutMs: MAIN_OPERATION_CRITICAL_DRAIN_TIMEOUT_MS});
                    if (!result.completed) {
                        logger.error(`Timed out waiting for ${result.pending.length} critical main operation(s) during shutdown`, {code: 'MAIN_SHUTDOWN_FAILED'});
                        preserveCriticalWriteWorkingCopies(result.pending, 'pending');
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
            label: 'feature-registration-disposal',
            timeoutMs: 6_000,
            run: () => featureRegistrationRuntime?.disposeAll(),
        },
        {
            label: 'agent-assistant',
            run: async () => {
                if (!loadedSubsystems.has('agent')) {
                    return;
                }
                const {shutdownAgentAssistantIfLoaded} = await import('@electron/features/agent/public');
                await shutdownAgentAssistantIfLoaded();
            },
        },
        {
            label: 'search',
            run: async () => {
                if (!loadedSubsystems.has('search')) {
                    return;
                }
                const {searchService} = await import('@electron/features/search/public');
                await searchService.shutdown();
            },
        },
        {
            label: 'pdf-page-ops-workers',
            run: async () => {
                const [
                    {shutdownPdfPageOpsWorkers},
                    {shutdownQpdfWasmWorkers},
                ] = await Promise.all([
                    import('@electron/native-tools/pdfPageOpsWorkerClient'),
                    import('@electron/native-tools/qpdfWasmWorkerClient'),
                ]);
                shutdownPdfPageOpsWorkers();
                await shutdownQpdfWasmWorkers();
            },
        },
        {
            label: 'mcp-server',
            run: async () => {
                if (!loadedSubsystems.has('agent')) {
                    return;
                }
                const {shutdownLocalMcpServer} = await import('@electron/features/agent/public');
                await shutdownLocalMcpServer();
            },
        },
        {
            label: 'updates',
            run: () => updatesModulePromise ? updatesModulePromise.then(updates => updates.shutdownUpdates()) : undefined,
        },
        {
            label: 'document-store-operations',
            run: () => settleOpenDocuments(),
        },
        {
            label: 'djvu-conversions',
            run: async () => {
                if (!loadedSubsystems.has('djvu')) {
                    return;
                }
                const {shutdownDjvuConversions} = await import('@electron/features/djvu/public');
                await shutdownDjvuConversions();
            },
        },
        {
            label: 'djvu-viewing',
            run: async () => {
                if (!loadedSubsystems.has('djvu')) {
                    return;
                }
                const {performDjvuViewingShutdownCleanup} = await import('@electron/features/djvu/public');
                performDjvuViewingShutdownCleanup();
            },
        },
        {
            label: 'ocr-job-manager',
            run: async () => {
                if (!loadedSubsystems.has('ocr')) {
                    return;
                }
                const {shutdownOcrJobManager} = await import('@electron/features/ocr/public');
                await shutdownOcrJobManager();
            },
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
            runsAfterDeadline: true,
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
const shouldBypassWindowClose = isShutdownActive;
configureNativeWindowCloseHandshake({
    shouldBypass: shouldBypassWindowClose,
    rawIpcRegistrationAudit,
});
// Install fatal process handlers only after the coordinator exists. A synchronous
// startup exception before this point keeps Node's default fail-fast behavior.
process.on('unhandledRejection', (reason) => {
    const decision = decideUnhandledRejection(reason);
    if (decision.action === 'ignore') {
        logger.info(`Ignoring expected unhandled rejection in main process: ${getErrorMessage(reason)}`);
        return;
    }
    const rejectionMessage = `Unhandled promise rejection in main process: ${reason instanceof Error ? reason.stack ?? getErrorMessage(reason) : getErrorMessage(reason)}`;
    logMainFailure(
        'MAIN_UNHANDLED_REJECTION',
        rejectionMessage,
        reason,
    );
    // An unclassified rejection is logged and survived rather than treated as
    // proof of corrupted state; only a subsystem whose recovery fails below is
    // still fatal.
    if (decision.action === 'report') {
        return;
    }
    const recoveryLoggerError = (message: string) => {
        const recoveryReceipt = unhandledRecoveryReceipts.get(decision.subsystem);
        if (!recoveryReceipt) {
            return logger.error(message, {code: 'MAIN_UNHANDLED_REJECTION_RECOVERY'});
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
// Node still prints warnings to stderr; this copy carries the stack that
// locates the source (for example which listener exceeded MaxListeners).
process.on('warning', (warning) => {
    logger.warn(`Node warning: ${warning.message}`, {
        name: warning.name,
        stack: warning.stack,
    });
});
disarmStartupCrashMarker();
process.on('uncaughtException', (error) => {
    const receipt = captureMainFailure({
        code: 'MAIN_UNCAUGHT_EXCEPTION',
        message: 'Uncaught exception in main process',
        cause: error,
        severity: 'fatal',
    });
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
    if (process.platform === 'linux' || process.platform === 'darwin') {
        // Electron installs its signal handlers during startup; register after ready.
        process.on('SIGTERM', () => requestSystemShutdown());
        process.on('SIGHUP', () => requestSystemShutdown());
    }
});
if (pendingSafeModeRelaunchArgs) {
    const args = pendingSafeModeRelaunchArgs;
    pendingSafeModeRelaunchArgs = null;
    requestSafeModeRelaunch(args);
}

const allowMultipleAutomationSessions = runtimeConfig.allowMultipleAutomationSessions;

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
        ? runtimeConfig.test.performanceMode
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
    broadcastUpdateStatus: status => {
        for (const window of getAllRegisteredAppWindows()) {
            const projectedStatus = loadedUpdatesModule
                ? loadedUpdatesModule.projectUpdateStatusForWindow(status, window.webContents.id)
                : status;
            sendToWindow(window, UPDATES_PLATFORM_FEATURE.eventChannels.onStatus, projectedStatus);
        }
    },
    cleanupStaleAppTempNamespaces: async () => {
        const {cleanupStaleAppTempNamespaces} = await import('@electron/utils/cleanupStaleAppTempNamespaces');
        return cleanupStaleAppTempNamespaces();
    },
    cleanupStaleWorkingCopyDirectories: async () => {
        await flushPendingWorkspaceCheckpointSave();
        return {removedDirectories: await collectStaleDocuments()};
    },
    createAdditionalWindow: () => createAppWindow(),
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
    initializeUpdates: async (onStatus) => {
        if (isShutdownActive()) {
            return;
        }
        const updates = await loadUpdatesModule();
        if (isShutdownActive()) {
            await updates.shutdownUpdates();
            return;
        }
        updates.initializeUpdates(onStatus);
    },
    installHostEnvironmentDisplayWatcher,
    logger,
    loadSettings,
    logStartupPhase: startupTrace.log,
    onPrimaryInstanceReady: consumeStartupCrashMarker,
    publishWindowStartupPhase: (windowId, phase) => {
        publishWindowStartupPhase(windowId, phase);
        if (phase.phase !== 'shell-interactive' || windowId !== getRegisteredMainWindow()?.id) {
            return;
        }
        runDetached(
            async () => {
                const {markPendingUpdateHealthy} = await import('@electron/updateHealthMarker');
                await markPendingUpdateHealthy(resolveApplicationVersion(app));
            },
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
    registerIpcHandlers: options => {
        featureRegistrationRuntime = registerIpcHandlers({
            ...options,
            loadUpdatesModule,
            onSubsystemLoaded: markSubsystemLoaded,
            isSubsystemLoaded: subsystem => loadedSubsystems.has(subsystem),
            rawIpcRegistrationAudit,
            requestGracefulQuit: () => shutdownCoordinator.requestGracefulQuit(),
        });
    },
    setupAppProtocolHandler,
    setupMenu,
    updateRecentFilesMenu,
    shouldResetRendererReadyOnNavigation,
    shutdownCoordinator,
    reapOrphanedManagedNativeProcesses: async () => {
        const {reapOrphanedManagedProcesses} = await import('@electron/native-tools/managedProcessRegistry');
        return reapOrphanedManagedProcesses(getAppTempDir(), {log: (level, message) => logger[level](message)});
    },
    sweepStaleDefaultAppTempPdfs: async () => {
        const {sweepStaleDefaultAppTempPdfs} = await import('@electron/features/documents/public');
        return sweepStaleDefaultAppTempPdfs();
    },
    sweepStalePdfAnnotationParseArtifacts: async () => {
        const {sweepStalePdfAnnotationParseArtifacts} = await import('@electron/features/documents/public');
        return sweepStalePdfAnnotationParseArtifacts();
    },
    sweepStaleScanCleanupScratchDirs: async () => {
        const {sweepStaleScanCleanupScratchDirs} = await import('@evb/scan-cleanup/core/scratchCleanup');
        return sweepStaleScanCleanupScratchDirs(getAppTempDir(), {log: (level, message) => logger[level](message)});
    },
    sweepStaleOcrTempArtifacts: async () => {
        const {sweepStaleOcrTempArtifacts} = await import('@electron/features/documents/public');
        return sweepStaleOcrTempArtifacts();
    },
    pruneStaleDjvuArtifactJobs: async () => {
        const {pruneStaleDjvuArtifactJobs} = await import('@electron/features/djvu/public');
        return pruneStaleDjvuArtifactJobs();
    },
})
    .then(() => {
        if (isShutdownActive()) {
            return;
        }
        runDetached(
            async () => {
                try {
                    const settings = await loadSettings();
                    if (!settings.agentMcpEnabled || isShutdownActive()) {
                        return;
                    }
                    const {
                        shutdownLocalMcpServer,
                        syncAgentMcpServerWithSettings,
                    } = await loadAgentModule();
                    if (isShutdownActive()) {
                        return;
                    }
                    await syncAgentMcpServerWithSettings();
                    if (isShutdownActive()) {
                        await shutdownLocalMcpServer();
                    }
                } catch (error: unknown) {
                    logger.warn(`External MCP startup sync unavailable; continuing without it: ${getErrorMessage(error)}`);
                }
            },
            {
                label: 'sync external MCP server with settings',
                logger,
            },
        );
    })
    .catch((error) => {
        requestFatalShutdown(`Application bootstrap failed: ${getErrorMessage(error)}`);
    });
