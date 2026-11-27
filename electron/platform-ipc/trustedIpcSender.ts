import {BrowserWindow, type IpcMainInvokeEvent, type WebContents, type WebFrameMain} from 'electron';
import {config} from '@electron/config';
import {isTrustedRendererUrl} from '@electron/security/isTrustedRendererUrl';
import {createLogger} from '@electron/utils/createLogger';
import {getWindowByIdFromRegistry} from '@electron/window/registry';

const logger = createLogger('ipc');

function getTrustedRendererUrl() {
    return config.renderer.trustedUrl;
}

export function isTrustedWebContentsSender(sender: WebContents, senderFrame: WebFrameMain | null | undefined, channel: string) {
    const sourceWindow = BrowserWindow.fromWebContents(sender);
    if (!sourceWindow || sourceWindow.isDestroyed() || sender.isDestroyed()) {
        logger.warn(`[ipc] rejected ${channel}: missing or destroyed sender window`);
        return false;
    }
    const registeredWindow = getWindowByIdFromRegistry(sourceWindow.id);
    if (registeredWindow !== sourceWindow || registeredWindow.webContents !== sender) {
        logger.warn(`[ipc] rejected ${channel}: sender window is not registered`);
        return false;
    }

    const senderMainFrame = sender.mainFrame;
    if (senderFrame && senderFrame !== senderMainFrame) {
        logger.warn(`[ipc] rejected ${channel}: non-main frame sender`);
        return false;
    }

    const senderFrameUrl = senderFrame?.url;
    const rawSenderUrl = senderFrameUrl && senderFrameUrl.length > 0 ? senderFrameUrl : sender.getURL();
    const trustedUrl = getTrustedRendererUrl();
    if (!trustedUrl || !rawSenderUrl) {
        logger.warn(`[ipc] rejected ${channel}: missing trusted URL or sender URL`);
        return false;
    }

    if (!isTrustedRendererUrl(rawSenderUrl, trustedUrl)) {
        let senderDescription = rawSenderUrl;
        try {
            const parsedSenderUrl = new URL(rawSenderUrl);
            senderDescription = `${parsedSenderUrl.origin}${parsedSenderUrl.pathname}`;
        } catch {
            logger.warn(`[ipc] rejected ${channel}: invalid sender URL ${rawSenderUrl}`);
            return false;
        }

        logger.warn(`[ipc] rejected ${channel}: untrusted sender URL ${senderDescription} (expected ${trustedUrl})`);
        return false;
    }

    return true;
}

export function isTrustedIpcInvokeSender(event: IpcMainInvokeEvent, channel: string) {
    return isTrustedWebContentsSender(event.sender, event.senderFrame, channel);
}
