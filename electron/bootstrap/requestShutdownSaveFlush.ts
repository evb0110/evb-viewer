import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import {
    CORE_IPC_EVENT_CHANNELS,
    CORE_IPC_SEND_CHANNELS,
    decodeShutdownSaveFlushResult,
} from '@electron/platform-ipc/coreContract';
import type { ILogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { workingCopyMap } from '@electron/file-access/workingCopyStore';
import type {IRawIpcRegistrationAudit} from '@electron/platform-ipc/rawIpcRegistration';

export interface IShutdownSaveFlushSummary {
    dirtyWorkingCopyPaths: string[];
    failedWindowIds: number[];
    flushedWorkingCopyPaths: string[];
    timedOutWindowIds: number[];
}

export function shutdownSaveFlushRequiresRecoveryPreservation(
    summary: IShutdownSaveFlushSummary,
) {
    return summary.dirtyWorkingCopyPaths.length > 0
        || summary.failedWindowIds.length > 0
        || summary.timedOutWindowIds.length > 0;
}

function normalizePathList(value: unknown): string[] {
    return Array.isArray(value)
        ? (value as unknown[]).filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
        : [];
}

interface IShutdownSaveWindow {
    id: number;
    isDestroyed: () => boolean;
    webContents: {
        id: number;
        isDestroyed: () => boolean;
        send: (channel: string, payload: {requestId: string}) => void;
    };
}

type TIsTrustedShutdownSaveSender = (
    sender: Electron.WebContents,
    senderFrame: Electron.WebFrameMain | null | undefined,
) => boolean;

export async function requestShutdownSaveFlush(options: {
    getWindows: () => IShutdownSaveWindow[];
    logger: ILogger;
    timeoutMs: number;
    isTrustedSender: TIsTrustedShutdownSaveSender;
    rawIpcRegistrationAudit?: IRawIpcRegistrationAudit;
}): Promise<IShutdownSaveFlushSummary> {
    const windows = options.getWindows()
        .filter(window => !window.isDestroyed() && !window.webContents.isDestroyed());
    if (windows.length === 0) {
        return {
            dirtyWorkingCopyPaths: [],
            failedWindowIds: [],
            flushedWorkingCopyPaths: [],
            timedOutWindowIds: [],
        };
    }

    const requestId = `shutdown-save-flush-${randomUUID()}`;
    const pendingBySenderId = new Map(windows.map(window => [
        window.webContents.id,
        window.id,
    ]));
    const dirtyWorkingCopyPaths = new Set<string>();
    const failedWindowIds = new Set<number>();
    const flushedWorkingCopyPaths = new Set<string>();

    return new Promise(resolve => {
        const preserveOwnedWorkingCopies = (senderId: number) => {
            for (const [
                workingCopyPath,
                entry,
            ] of workingCopyMap) {
                if (entry.ownerWebContentsId === senderId) {
                    dirtyWorkingCopyPaths.add(workingCopyPath);
                    flushedWorkingCopyPaths.delete(workingCopyPath);
                }
            }
        };

        const timeout = setTimeout(() => {
            cleanup();
            for (const senderId of pendingBySenderId.keys()) {
                preserveOwnedWorkingCopies(senderId);
            }
            const timedOutWindowIds = Array.from(pendingBySenderId.values());
            if (timedOutWindowIds.length > 0) {
                options.logger.error(
                    `Timed out waiting for shutdown save flush from ${timedOutWindowIds.length} renderer(s): ${timedOutWindowIds.join(', ')}`,
                    {
                        code: 'MAIN_SHUTDOWN_SAVE_FLUSH_FAILED',
                        context: {},
                    },
                );
            }
            resolve({
                dirtyWorkingCopyPaths: Array.from(dirtyWorkingCopyPaths),
                failedWindowIds: Array.from(failedWindowIds),
                flushedWorkingCopyPaths: Array.from(flushedWorkingCopyPaths),
                timedOutWindowIds,
            });
        }, options.timeoutMs);
        timeout.unref();

        const cleanup = () => {
            clearTimeout(timeout);
            ipcMain.removeListener(CORE_IPC_SEND_CHANNELS.shutdownSaveFlushResult, handleResponse);
            options.rawIpcRegistrationAudit?.release('shutdown-save-flush-result');
        };

        const finishIfDone = () => {
            if (pendingBySenderId.size > 0) {
                return;
            }
            cleanup();
            resolve({
                dirtyWorkingCopyPaths: Array.from(dirtyWorkingCopyPaths),
                failedWindowIds: Array.from(failedWindowIds),
                flushedWorkingCopyPaths: Array.from(flushedWorkingCopyPaths),
                timedOutWindowIds: [],
            });
        };

        const handleResponse = (
            event: Electron.IpcMainEvent,
            rawPayload: unknown,
        ) => {
            if (!options.isTrustedSender(event.sender, event.senderFrame)) {
                return;
            }
            if (!pendingBySenderId.has(event.sender.id)) {
                return;
            }
            const windowId = pendingBySenderId.get(event.sender.id)!;
            const payload = decodeShutdownSaveFlushResult(rawPayload);
            if (!payload || payload.requestId !== requestId) {
                preserveOwnedWorkingCopies(event.sender.id);
                failedWindowIds.add(windowId);
                pendingBySenderId.delete(event.sender.id);
                options.logger.error(`Renderer shutdown save flush returned an invalid response for sender ${event.sender.id}`, {
                    code: 'MAIN_SHUTDOWN_SAVE_FLUSH_FAILED',
                    context: {},
                });
                finishIfDone();
                return;
            }
            pendingBySenderId.delete(event.sender.id);
            for (const path of normalizePathList(payload.dirtyWorkingCopyPaths)) {
                dirtyWorkingCopyPaths.add(path);
                flushedWorkingCopyPaths.delete(path);
            }
            for (const path of normalizePathList(payload.flushedWorkingCopyPaths)) {
                if (dirtyWorkingCopyPaths.has(path)) {
                    options.logger.error(
                        `Renderer shutdown save flush reported the same working copy as both dirty and flushed; preserving it: ${path}`,
                        {
                            code: 'MAIN_SHUTDOWN_SAVE_FLUSH_FAILED',
                            context: {},
                        },
                    );
                    continue;
                }
                const entry = workingCopyMap.get(path);
                if (
                    entry
                    && (
                        entry.ownerWebContentsId === undefined
                        || entry.ownerWebContentsId === event.sender.id
                    )
                    && (
                        entry.backingState === 'lazy-original'
                        || entry.backingState === 'materializing'
                    )
                ) {
                    dirtyWorkingCopyPaths.add(path);
                    flushedWorkingCopyPaths.delete(path);
                    options.logger.error(
                        `WORKING_COPY_SHUTDOWN_FLUSH_UNMATERIALIZED: renderer reported an unmaterialized working copy as flushed: ${path}`,
                        {
                            code: 'MAIN_SHUTDOWN_SAVE_FLUSH_FAILED',
                            context: {},
                        },
                    );
                } else {
                    flushedWorkingCopyPaths.add(path);
                    dirtyWorkingCopyPaths.delete(path);
                }
            }
            if (payload.callbackCount === 0 || payload.error) {
                preserveOwnedWorkingCopies(event.sender.id);
                failedWindowIds.add(windowId);
                options.logger.error(payload.callbackCount === 0
                    ? 'Renderer shutdown save flush had no registered handlers'
                    : `Renderer shutdown save flush failed: ${payload.error ?? 'unknown error'}`, {
                    code: 'MAIN_SHUTDOWN_SAVE_FLUSH_FAILED',
                    context: {},
                });
            }
            finishIfDone();
        };

        const register = () => ipcMain.on(CORE_IPC_SEND_CHANNELS.shutdownSaveFlushResult, handleResponse);
        if (options.rawIpcRegistrationAudit) {
            options.rawIpcRegistrationAudit.register('shutdown-save-flush-result', register);
        } else {
            register();
        }
        for (const window of windows) {
            try {
                window.webContents.send(CORE_IPC_EVENT_CHANNELS.shutdownSaveFlushRequest, {requestId});
            } catch (error) {
                pendingBySenderId.delete(window.webContents.id);
                preserveOwnedWorkingCopies(window.webContents.id);
                failedWindowIds.add(window.id);
                options.logger.error(`Failed to request renderer save flush for window ${window.id}: ${getErrorMessage(error)}`, {
                    code: 'MAIN_SHUTDOWN_SAVE_FLUSH_FAILED',
                    context: {},
                    cause: error,
                });
            }
        }
        finishIfDone();
    });
}
