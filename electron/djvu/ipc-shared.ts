import type { BrowserWindow } from 'electron';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('djvu-ipc-shared');

export function safeSendToWindow(
    window: BrowserWindow | null | undefined,
    channel: string,
    ...args: unknown[]
) {
    if (!window) {
        return;
    }
    if (window.isDestroyed()) {
        return;
    }
    if (window.webContents.isDestroyed()) {
        return;
    }

    try {
        window.webContents.send(channel, ...args);
    } catch (error) {
        logger.debug(`Failed to send IPC message "${channel}": ${String(error)}`);
    }
}
