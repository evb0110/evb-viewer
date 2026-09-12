import { BrowserWindow } from 'electron';
import {
    countBy,
    sortBy,
} from 'es-toolkit/array';
import type { IWindowTabTargetWindow } from '@contracts/windowTabs';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    WINDOW_TABS_PLATFORM_FEATURE,
    type IWindowTabsInvokeMap,
} from '@contracts/windowTabsPlatformFeature';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import { te } from '@electron/te';
import {
    acknowledgeWindowTabTransfer,
    requestWindowTabTransfer,
} from '@electron/windowTabTransfer';
import { getAllRegisteredAppWindows } from '@electron/window/registry';
import { registerRendererLogBridge } from '@electron/platform-ipc/rendererLogBridge';
import { registerRendererDiagnosticBridge } from '@electron/platform-ipc/registerRendererDiagnosticBridge';
import { getMainFailureReporter } from '@electron/features/diagnostics/public';
import { isTrustedWebContentsSender } from '@electron/platform-ipc/trustedIpcSender';
import {
    createValidatedIpcMainEventRegistrar,
    createValidatedIpcMainRegistrar,
    registerPlatformFeatureHandlers,
} from '@electron/platform-ipc/validatedIpcRegistrar';
import {
    CORE_IPC_CHANNELS,
    CORE_IPC_SEND_CHANNELS,
    decodeDiagnosticsCanaryAction,
    decodeIpcInvokeRequestId,
} from '@electron/platform-ipc/coreContract';
import {cancelIpcInvoke} from '@electron/platform-ipc/ipcInvokeCancellation';
import type {IRawIpcRegistrationAudit} from '@electron/platform-ipc/rawIpcRegistration';
import {
    acknowledgeWorkspaceCheckpoint,
    claimWorkspaceCheckpoint,
    discardWorkspaceCheckpoint,
    resumeWorkspaceCheckpoint,
    saveWorkspaceCheckpoint,
} from '@electron/workspaceCheckpointStore';
import { allowOpenPaths } from '@electron/file-access/openPathCapabilities';

export interface ICoreIpcHandlerOptions {
    onRendererReady?: (event: Electron.IpcMainEvent) => void;
    claimPendingExternalOpenPaths?: (sender: Electron.WebContents) => Promise<TDocumentRef[]>;
    acknowledgePendingExternalOpenPaths?: (sender: Electron.WebContents, failedPaths: TDocumentRef[]) => void;
    rawIpcRegistrationAudit?: IRawIpcRegistrationAudit;
}

const CORE_RAW_EVENT_CHANNEL_SET = new Set<string>([
    CORE_IPC_CHANNELS.rendererReady,
    CORE_IPC_SEND_CHANNELS.ipcInvokeCanceled,
    CORE_IPC_SEND_CHANNELS.rendererLog,
    CORE_IPC_SEND_CHANNELS.windowCloseResponse,
]);

function isDiagnosticsCanaryEnabled() {
    return process.env.EVB_ENABLE_DIAGNOSTICS_CANARY === '1'
        && Boolean(process.env.EVB_AUTOMATION_USER_DATA_DIR?.trim())
        && Boolean(process.env.EVB_AUTOMATION_SESSION_NAME?.trim());
}

function buildTabTransferTargetLabels(sourceWindowId: number): IWindowTabTargetWindow[] {
    const otherWindows = sortBy(
        getAllRegisteredAppWindows().filter(window => window.id !== sourceWindowId),
        [window => window.id],
    );
    const titleCountByLabel = countBy(otherWindows, window => (window.getTitle() || te('app.title')).trim() || te('app.title'));

    return otherWindows.map((window) => {
        const title = (window.getTitle() || te('app.title')).trim() || te('app.title');
        const duplicateCount = titleCountByLabel[title] ?? 0;
        return {
            windowId: window.id,
            label: duplicateCount > 1 ? `${title} (${window.id})` : title,
        };
    });
}

function assertAutomationCheckpointReset() {
    if (
        !process.env.EVB_AUTOMATION_USER_DATA_DIR?.trim()
        || !process.env.EVB_AUTOMATION_SESSION_NAME?.trim()
    ) {
        throw new Error('Workspace checkpoint reset is available only to isolated automation sessions');
    }
}

export function registerCoreIpcHandlers(
    ipcMain: Electron.IpcMain,
    options: ICoreIpcHandlerOptions,
) {
    if (isDiagnosticsCanaryEnabled()) {
        const register = () => ipcMain.handle(CORE_IPC_CHANNELS.diagnosticsCanary, (event, value: unknown) => {
            if (!isTrustedWebContentsSender(
                event.sender,
                event.senderFrame,
                CORE_IPC_CHANNELS.diagnosticsCanary,
            )) {
                return null;
            }
            const action = decodeDiagnosticsCanaryAction(value);
            if (action === 'main-health') {
                const reporter = getMainFailureReporter();
                return reporter === null
                    ? null
                    : {
                        preference: reporter.getPreference(),
                        transportReady: reporter.isTransportReady(),
                    };
            }
            if (action === 'main-error') {
                return getMainFailureReporter()?.capture({
                    code: 'MAIN_RENDERER_LOG_BRIDGE_FAILED',
                    context: {},
                    local: {
                        source: 'diagnostics-canary',
                        message: 'Packaged main diagnostics canary',
                    },
                }) ?? null;
            }
            if (action === 'crash-main') {
                setImmediate(() => {
                    throw new Error('Packaged startup crash-marker canary');
                });
                return true;
            }
            return null;
        });
        if (options.rawIpcRegistrationAudit) {
            options.rawIpcRegistrationAudit.register('diagnostics-canary', register);
        } else {
            register();
        }
    }
    const windowTabsRegistrar = createValidatedIpcMainRegistrar<IWindowTabsInvokeMap>(ipcMain, {
        allowedChannels: WINDOW_TABS_PLATFORM_FEATURE.invokeChannelSet,
        codecs: WINDOW_TABS_PLATFORM_FEATURE.ipcCodecs,
    });
    const eventRegistrar = createValidatedIpcMainEventRegistrar(ipcMain, {allowedChannels: CORE_RAW_EVENT_CHANNEL_SET});
    registerRendererLogBridge({
        isTrustedSender: isTrustedWebContentsSender,
        registerListener: (channel, handler) => {
            const register = () => eventRegistrar.on(channel, (event, payload) => {
                handler(event, payload as Parameters<typeof handler>[1]);
            });
            if (options.rawIpcRegistrationAudit) {
                options.rawIpcRegistrationAudit.register('renderer-log', register);
            } else {
                register();
            }
        },
    });
    registerRendererDiagnosticBridge({
        captureRecord: (record, suppressedCount) => {
            const reporter = getMainFailureReporter();
            if (!reporter) {
                return false;
            }
            reporter.captureRecord(record, suppressedCount);
            return true;
        },
        isTrustedSender: isTrustedWebContentsSender,
        registerListener: (channel, handler) => {
            const register = () => ipcMain.on(channel, (event, payload, suppressedCount) => {
                handler(event, payload, suppressedCount);
            });
            if (options.rawIpcRegistrationAudit) {
                options.rawIpcRegistrationAudit.register('renderer-diagnostic', register);
            } else {
                register();
            }
        },
    });
    eventRegistrar.on(CORE_IPC_CHANNELS.rendererReady, (event) => {
        options.onRendererReady?.(event);
    });
    eventRegistrar.on(CORE_IPC_SEND_CHANNELS.ipcInvokeCanceled, (event, payload) => {
        const requestId = decodeIpcInvokeRequestId(payload);
        if (requestId !== null) {
            cancelIpcInvoke(event.sender, requestId);
        }
    });

    const bindings: TFeatureMainBindings<
        typeof WINDOW_TABS_PLATFORM_FEATURE,
        Electron.IpcMainInvokeEvent
    > = {
        claimPendingExternalOpenPaths: ({sender}) =>
            options.claimPendingExternalOpenPaths?.(sender) ?? [],
        acknowledgePendingExternalOpenPaths: ({sender}, failedPaths) => {
            options.acknowledgePendingExternalOpenPaths?.(sender, failedPaths);
        },
        saveWorkspaceCheckpoint: async ({
            sender,
            senderId,
        }, checkpoint) => {
            await saveWorkspaceCheckpoint(checkpoint, senderId, sender);
        },
        discardWorkspaceCheckpoint: async ({senderId}) => {
            assertAutomationCheckpointReset();
            return discardWorkspaceCheckpoint(senderId);
        },
        resumeWorkspaceCheckpoint: ({senderId}, discardToken) => {
            assertAutomationCheckpointReset();
            resumeWorkspaceCheckpoint(senderId, discardToken);
        },
        claimWorkspaceCheckpoint: async ({
            sender,
            senderId,
        }) => {
            const checkpoint = await claimWorkspaceCheckpoint(senderId);
            if (checkpoint) {
                allowOpenPaths(checkpoint.tabs.flatMap(tab => [
                    tab.sourceRef,
                    tab.workingCopyRef,
                ].filter((path): path is TDocumentRef => path !== null)), sender);
            }
            return checkpoint;
        },
        acknowledgeWorkspaceCheckpoint: async ({senderId}) => {
            await acknowledgeWorkspaceCheckpoint(senderId);
        },
        requestWindowTabTransfer: async ({sender}, request) => {
            const sourceWindow = BrowserWindow.fromWebContents(sender);
            if (!sourceWindow) {
                return {
                    transferId: '',
                    success: false,
                    targetWindowId: request.target.kind === 'window' ? request.target.windowId : -1,
                    error: 'Source window is not available.',
                };
            }
            return requestWindowTabTransfer(sourceWindow.id, request, sender.id);
        },
        acknowledgeWindowTabTransfer: ({sender}, ack) => {
            const window = BrowserWindow.fromWebContents(sender);
            return window ? acknowledgeWindowTabTransfer(window.id, ack) : false;
        },
        listWindowTabTargets: ({sender}): IWindowTabTargetWindow[] => {
            const sourceWindow = BrowserWindow.fromWebContents(sender);
            return sourceWindow ? buildTabTransferTargetLabels(sourceWindow.id) : [];
        },
        closeCurrentWindow: ({sender}) => {
            const window = BrowserWindow.fromWebContents(sender);
            if (!window || window.isDestroyed()) {
                return false;
            }
            window.close();
            return true;
        },
    };
    registerPlatformFeatureHandlers(
        windowTabsRegistrar as never,
        WINDOW_TABS_PLATFORM_FEATURE,
        bindings,
    );
}
