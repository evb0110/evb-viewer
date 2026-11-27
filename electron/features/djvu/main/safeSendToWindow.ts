import type {BrowserWindow} from 'electron';
import type {IDjvuEventMap} from '@contracts/djvuPlatformFeature';
import {createLogger} from '@electron/utils/createLogger';
import {sendPlatformEvent} from '@electron/utils/sendPlatformEvent';

const logger = createLogger('djvu-ipcShared');

export function safeSendToWindow<TChannel extends Extract<keyof IDjvuEventMap, string>>(
    window: BrowserWindow | null | undefined,
    channel: TChannel,
    payload: IDjvuEventMap[TChannel],
) {
    sendPlatformEvent<IDjvuEventMap, TChannel>(window, channel, payload, (error) => {
        logger.debug(`Failed to send IPC message "${channel}": ${String(error)}`);
    });
}
