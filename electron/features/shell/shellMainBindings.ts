import {
    shell,
    type IpcMainInvokeEvent,
    type WebContents,
} from 'electron';
import type { SHELL_PLATFORM_FEATURE } from '@contracts/shellPlatformFeature';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import { onSenderLifetimeEnd } from '@electron/utils/onSenderLifetimeEnd';

const SHELL_OPEN_EXTERNAL_MIN_INTERVAL_MS = 1_000;
const shellOpenExternalLastOpenedAtBySender = new Map<number, number>();
const shellOpenExternalCleanupRegisteredBySender = new Set<number>();

function registerSenderCleanup(sender: WebContents) {
    const senderId = sender.id;
    if (shellOpenExternalCleanupRegisteredBySender.has(senderId)) {
        return;
    }

    shellOpenExternalCleanupRegisteredBySender.add(senderId);
    const stop = onSenderLifetimeEnd(sender, () => {
        stop();
        shellOpenExternalLastOpenedAtBySender.delete(senderId);
        shellOpenExternalCleanupRegisteredBySender.delete(senderId);
    });
}

function assertRateLimit(sender: WebContents) {
    registerSenderCleanup(sender);
    const now = Date.now();
    const senderId = sender.id;
    const lastOpenedAt = shellOpenExternalLastOpenedAtBySender.get(senderId) ?? 0;
    if (now - lastOpenedAt < SHELL_OPEN_EXTERNAL_MIN_INTERVAL_MS) {
        throw new Error('External URL opens are being requested too frequently.');
    }
    shellOpenExternalLastOpenedAtBySender.set(senderId, now);
}

export const shellMainBindings = {async openExternal(context, url) {
    assertRateLimit(context.sender);
    await shell.openExternal(url);
    return undefined;
}} satisfies TFeatureMainBindings<typeof SHELL_PLATFORM_FEATURE, IpcMainInvokeEvent>;
