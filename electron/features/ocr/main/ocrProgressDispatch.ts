import { BrowserWindow } from 'electron';
import type { IOcrEventMap } from '@contracts/ocrPlatformFeature';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { sendPlatformEvent } from '@electron/utils/sendPlatformEvent';

const log = createLogger('ocr-ipc');

export function safeSendToWindow<TChannel extends Extract<keyof IOcrEventMap, string>>(
    window: BrowserWindow | null | undefined,
    channel: TChannel,
    payload: IOcrEventMap[TChannel],
) {
    sendPlatformEvent<IOcrEventMap, TChannel>(window, channel, payload, (err: unknown) => {
        log.debug(`Failed to send IPC message to channel "${channel}": ${getErrorMessage(err)}`);
    });
}

export function getJobWindow(webContentsId: number) {
    return BrowserWindow.getAllWindows().find(
        window => window.webContents.id === webContentsId,
    );
}
