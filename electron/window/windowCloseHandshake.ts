import { randomUUID } from 'node:crypto';
import { discardWorkspaceCheckpoint } from '@electron/workspaceCheckpointStore';
import {
    cleanupWorkingCopy,
    openDocuments,
} from '@electron/file-access/documentStore';
import type {
    BrowserWindow,
    IpcMain,
    IpcMainEvent,
} from 'electron';
import {
    CORE_IPC_EVENT_CHANNELS,
    CORE_IPC_SEND_CHANNELS,
    decodeWindowCloseResponse,
} from '@electron/platform-ipc/coreContract';
import { shouldResetRendererReadyOnNavigation } from '@electron/bootstrap/rendererReady';
import type { ILogger } from '@electron/utils/createLogger';
import type {IRawIpcRegistrationAudit} from '@electron/platform-ipc/rawIpcRegistration';

// Bounds only how long the renderer may take to acknowledge a request. Once
// acknowledged, the person's choice and its save take as long as they take;
// renderer death or replacement settles the request instead.
export const NATIVE_WINDOW_CLOSE_HANDSHAKE_TIMEOUT_MS = 10_000;

interface IWindowCloseHandshakeOptions {
    createRequestId?: () => string;
    ipcMain: Pick<IpcMain, 'on' | 'removeListener'>;
    logger: Pick<ILogger, 'warn'>;
    onCancel?: () => void;
    shouldBypass?: () => boolean;
    timeoutMs?: number;
    rawIpcRegistrationAudit?: IRawIpcRegistrationAudit;
}

interface IWindowCloseEvent {
    preventDefault(): void;
    readonly defaultPrevented?: boolean;
}

export function attachNativeWindowCloseHandshake(
    window: BrowserWindow,
    options: IWindowCloseHandshakeOptions,
) {
    const timeoutMs = options.timeoutMs ?? NATIVE_WINDOW_CLOSE_HANDSHAKE_TIMEOUT_MS;
    const createRequestId = options.createRequestId ?? randomUUID;
    const registrationScope = `window:${window.id}`;
    // Captured once: by 'closed' the BrowserWindow is destroyed and its
    // webContents getter is no longer safe to read.
    const webContents = window.webContents;
    const ownerWebContentsId = webContents.id;
    let disposed = false;
    let approvedClose: {
        event: IWindowCloseEvent | null;
        retirement?: Promise<string>
    } | null = null;
    let pendingRequestId: string | null = null;
    let pendingTimeout: NodeJS.Timeout | null = null;

    function clearPendingTimeout() {
        if (!pendingTimeout) {
            return;
        }
        clearTimeout(pendingTimeout);
        pendingTimeout = null;
    }

    function clearPendingRequest() {
        pendingRequestId = null;
        clearPendingTimeout();
    }

    function settleForRendererLoss(reason: string) {
        approvedClose = null;
        if (pendingRequestId === null) {
            return;
        }
        clearPendingRequest();
        options.logger.warn(
            `[window-close] Renderer ${reason} before deciding; keeping the window open (windowId=${window.id})`,
        );
    }

    function handleRenderProcessGone() {
        settleForRendererLoss('went away');
    }

    function handleNavigationStart(_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) {
        if (shouldResetRendererReadyOnNavigation({
            isInPlace,
            isMainFrame,
        })) {
            settleForRendererLoss('was replaced');
        }
    }

    function handleResponse(event: IpcMainEvent, payload: unknown) {
        if (disposed || event.sender !== webContents || pendingRequestId === null) {
            return;
        }

        const response = decodeWindowCloseResponse(payload);
        if (!response || response.requestId !== pendingRequestId) {
            return;
        }

        if ('status' in response && response.status === 'acknowledged') {
            clearPendingTimeout();
            return;
        }

        clearPendingRequest();
        if ('decision' in response) {
            if (response.decision === 'cancel') {
                options.onCancel?.();
                return;
            }
            if (response.decision !== 'save' && response.decision !== 'discard') {
                return;
            }
        } else {
            options.logger.warn(
                `[window-close] Renderer could not provide a close decision (${response.reason}); keeping the window open (windowId=${window.id})`,
            );
            return;
        }

        if (window.isDestroyed() || webContents.isDestroyed()) {
            options.logger.warn(
                `[window-close] Renderer approved close after the window was destroyed (windowId=${window.id})`,
            );
            return;
        }

        approvedClose = {event: null};
        try {
            window.close();
        } catch (error) {
            approvedClose = null;
            options.logger.warn(
                `[window-close] Approved close failed (windowId=${window.id}): ${String(error)}`,
            );
        }
    }

    function handleClose(event: IWindowCloseEvent) {
        if (disposed) {
            return;
        }
        if (approvedClose && approvedClose.event === null) {
            approvedClose.event = event;
            return;
        }
        // A vetoed attempt never authorizes a later close.
        approvedClose = null;

        let shouldBypass = false;
        try {
            shouldBypass = options.shouldBypass?.() === true;
        } catch (error) {
            options.logger.warn(
                `[window-close] Shutdown bypass check failed; keeping the close handshake active (windowId=${window.id}): ${String(error)}`,
            );
        }
        if (shouldBypass) {
            return;
        }

        event.preventDefault();
        if (pendingRequestId !== null) {
            return;
        }
        if (window.isDestroyed() || webContents.isDestroyed()) {
            options.logger.warn(
                `[window-close] Renderer cannot answer a close request; keeping the window open (windowId=${window.id})`,
            );
            return;
        }

        const requestId = createRequestId();
        pendingRequestId = requestId;
        pendingTimeout = setTimeout(() => {
            if (pendingRequestId !== requestId) {
                return;
            }
            clearPendingRequest();
            options.logger.warn(
                `[window-close] Renderer close handshake timed out after ${timeoutMs}ms; keeping the window open (windowId=${window.id})`,
            );
        }, timeoutMs);
        pendingTimeout.unref();

        try {
            webContents.send(CORE_IPC_EVENT_CHANNELS.windowCloseRequest, {requestId});
        } catch (error) {
            clearPendingRequest();
            options.logger.warn(
                `[window-close] Failed to send close request; keeping the window open (windowId=${window.id}): ${String(error)}`,
            );
        }
    }

    function handleWebContentsDestroyed() {
        const event = approvedClose?.event;
        if (disposed || !event || event.defaultPrevented === true || !approvedClose) return;
        // Registered before renderer startup can create a recovery owner:
        // fence claims before that owner's destroyed listener makes it orphaned.
        approvedClose.retirement = discardWorkspaceCheckpoint(ownerWebContentsId, webContents);
        void approvedClose.retirement.catch(() => undefined);
    }

    function handleClosed() {
        const approvedEvent = approvedClose?.event;
        const retireOwner = !disposed && approvedEvent !== null
            && approvedEvent !== undefined && approvedEvent.defaultPrevented !== true;
        const retirement = approvedClose?.retirement;
        cleanup();
        if (!retireOwner) return;

        // The fallback covers a window adapter without a destroyed event.
        void (retirement ?? discardWorkspaceCheckpoint(ownerWebContentsId, webContents)).then(async () => {
            // All synchronous 'closed' listeners have run, including transfer
            // rollback. Work only on registrations this window still owns.
            for (const [
                path,
                entry,
            ] of [...openDocuments]) {
                if (entry.ownerWebContentsId === ownerWebContentsId) {
                    await cleanupWorkingCopy(path, ownerWebContentsId);
                }
            }
        }).catch((error: unknown) => {
            // Failed discard keeps its recovery evidence and forbids byte cleanup.
            options.logger.warn(`[window-close] Could not retire window resources (windowId=${window.id}): ${String(error)}`);
        });
    }

    function cleanup() {
        disposed = true;
        approvedClose = null;
        clearPendingRequest();
        options.ipcMain.removeListener(CORE_IPC_SEND_CHANNELS.windowCloseResponse, handleResponse);
        webContents.removeListener('render-process-gone', handleRenderProcessGone);
        webContents.removeListener('destroyed', handleWebContentsDestroyed);
        webContents.removeListener('did-start-navigation', handleNavigationStart);
        options.rawIpcRegistrationAudit?.release('window-close-response', registrationScope);
    }

    const register = () => options.ipcMain.on(CORE_IPC_SEND_CHANNELS.windowCloseResponse, handleResponse);
    if (options.rawIpcRegistrationAudit) {
        options.rawIpcRegistrationAudit.register('window-close-response', register, registrationScope);
    } else {
        register();
    }
    webContents.on('destroyed', handleWebContentsDestroyed);
    webContents.on('render-process-gone', handleRenderProcessGone);
    webContents.on('did-start-navigation', handleNavigationStart);
    window.on('close', handleClose);
    window.once('closed', handleClosed);

    return cleanup;
}
