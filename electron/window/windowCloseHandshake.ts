import { randomUUID } from 'node:crypto';
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
import type { ILogger } from '@electron/utils/createLogger';
import type {IRawIpcRegistrationAudit} from '@electron/platform-ipc/rawIpcRegistration';

export const NATIVE_WINDOW_CLOSE_HANDSHAKE_TIMEOUT_MS = 10_000;

interface IWindowCloseHandshakeOptions {
    createRequestId?: () => string;
    ipcMain: Pick<IpcMain, 'on' | 'removeListener'>;
    logger: Pick<ILogger, 'warn'>;
    shouldBypass?: () => boolean;
    timeoutMs?: number;
    rawIpcRegistrationAudit?: IRawIpcRegistrationAudit;
}

interface IWindowCloseEvent {preventDefault(): void;}

export function attachNativeWindowCloseHandshake(
    window: BrowserWindow,
    options: IWindowCloseHandshakeOptions,
) {
    const timeoutMs = options.timeoutMs ?? NATIVE_WINDOW_CLOSE_HANDSHAKE_TIMEOUT_MS;
    const createRequestId = options.createRequestId ?? randomUUID;
    const registrationScope = `window:${window.id}`;
    let disposed = false;
    let approvedClose = false;
    let pendingRequestId: string | null = null;
    let pendingTimeout: NodeJS.Timeout | null = null;

    function clearPendingRequest() {
        pendingRequestId = null;
        if (!pendingTimeout) {
            return;
        }
        clearTimeout(pendingTimeout);
        pendingTimeout = null;
    }

    function handleResponse(event: IpcMainEvent, payload: unknown) {
        if (disposed || event.sender !== window.webContents || pendingRequestId === null) {
            return;
        }

        const response = decodeWindowCloseResponse(payload);
        if (!response || response.requestId !== pendingRequestId) {
            return;
        }

        clearPendingRequest();
        if ('decision' in response) {
            if (response.decision !== 'save' && response.decision !== 'discard') {
                return;
            }
        } else {
            options.logger.warn(
                `[window-close] Renderer could not provide a close decision (${response.reason}); keeping the window open (windowId=${window.id})`,
            );
            return;
        }

        if (window.isDestroyed() || window.webContents.isDestroyed()) {
            options.logger.warn(
                `[window-close] Renderer approved close after the window was destroyed (windowId=${window.id})`,
            );
            return;
        }

        approvedClose = true;
        try {
            window.close();
        } catch (error) {
            approvedClose = false;
            options.logger.warn(
                `[window-close] Approved close failed (windowId=${window.id}): ${String(error)}`,
            );
        }
    }

    function handleClose(event: IWindowCloseEvent) {
        if (disposed) {
            return;
        }
        if (approvedClose) {
            approvedClose = false;
            return;
        }

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
        if (window.isDestroyed() || window.webContents.isDestroyed()) {
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
            window.webContents.send(CORE_IPC_EVENT_CHANNELS.windowCloseRequest, {requestId});
        } catch (error) {
            clearPendingRequest();
            options.logger.warn(
                `[window-close] Failed to send close request; keeping the window open (windowId=${window.id}): ${String(error)}`,
            );
        }
    }

    function cleanup() {
        disposed = true;
        clearPendingRequest();
        options.ipcMain.removeListener(CORE_IPC_SEND_CHANNELS.windowCloseResponse, handleResponse);
        options.rawIpcRegistrationAudit?.release('window-close-response', registrationScope);
    }

    const register = () => options.ipcMain.on(CORE_IPC_SEND_CHANNELS.windowCloseResponse, handleResponse);
    if (options.rawIpcRegistrationAudit) {
        options.rawIpcRegistrationAudit.register('window-close-response', register, registrationScope);
    } else {
        register();
    }
    window.on('close', handleClose);
    window.once('closed', cleanup);

    return cleanup;
}
