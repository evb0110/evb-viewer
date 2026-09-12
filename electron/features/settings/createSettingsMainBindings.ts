import type { IpcMainInvokeEvent } from 'electron';
import {
    sanitizeSettings,
    type TSettingsSavePatch,
} from '@contracts/settings';
import type { SETTINGS_PLATFORM_FEATURE } from '@contracts/settingsPlatformFeature';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import type { ISettingsData } from '@contracts/shared';
import { updateRecentFilesMenu } from '@electron/menu';
import {
    consumeSettingsRecoveryNotice,
    loadSettings,
    recordMainDiagnosticsConsentIntent,
    updateSettings,
} from '@electron/settings';
import { setElectronLocale } from '@electron/te';
import { createLogger } from '@electron/utils/createLogger';

const logger = createLogger('ipc');
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';
const SETTINGS_SAVE_COALESCE_MS = 25;

interface IQueuedSettingsSave {
    pendingPatch: TSettingsSavePatch;
    diagnosticsConsentRevision: number | undefined;
    shutdownAssistant: () => Promise<void>;
    waiters: Array<{
        resolve: () => void;
        reject: (error: unknown) => void;
    }>;
    timer: ReturnType<typeof setTimeout> | null;
    flushing: boolean;
}

const settingsSaveQueuesBySender = new Map<number, IQueuedSettingsSave>();

async function applySettingsSavePatch(
    settingsPayload: TSettingsSavePatch,
    shutdownAssistant: () => Promise<void>,
    diagnosticsConsentRevision: number | undefined,
) {
    let shouldShutdownAssistant = false as boolean;
    const savedSettings = await updateSettings((currentSettings: ISettingsData) => {
        const incoming = sanitizeSettings({
            ...currentSettings,
            ...settingsPayload,
        });
        shouldShutdownAssistant = currentSettings.assistantPanelEnabled && !incoming.assistantPanelEnabled;
        return settingsPayload;
    }, diagnosticsConsentRevision === undefined
        ? {}
        : {diagnosticsConsentRevision});
    if (shouldShutdownAssistant) {
        await shutdownAssistant();
    }
    await setElectronLocale(savedSettings.locale);
    updateRecentFilesMenu();
}

function scheduleSettingsSaveFlush(senderId: number, queue: IQueuedSettingsSave) {
    if (queue.flushing) {
        return;
    }

    if (Object.hasOwn(queue.pendingPatch, 'clientDiagnosticsPreference')) {
        if (queue.timer !== null) {
            clearTimeout(queue.timer);
            queue.timer = null;
        }
        void flushSettingsSaveQueue(senderId, queue);
        return;
    }

    if (queue.timer !== null) {
        return;
    }

    queue.timer = setTimeout(() => {
        queue.timer = null;
        void flushSettingsSaveQueue(senderId, queue);
    }, SETTINGS_SAVE_COALESCE_MS);
}

async function flushSettingsSaveQueue(senderId: number, queue: IQueuedSettingsSave) {
    if (queue.flushing) {
        return;
    }

    queue.flushing = true;
    const settingsPayload = queue.pendingPatch;
    const diagnosticsConsentRevision = queue.diagnosticsConsentRevision;
    const waiters = queue.waiters;
    queue.pendingPatch = {};
    queue.diagnosticsConsentRevision = undefined;
    queue.waiters = [];

    try {
        await applySettingsSavePatch(
            settingsPayload,
            queue.shutdownAssistant,
            diagnosticsConsentRevision,
        );
        for (const waiter of waiters) {
            waiter.resolve();
        }
    } catch (error) {
        for (const waiter of waiters) {
            waiter.reject(error);
        }
    } finally {
        queue.flushing = false;
        if (queue.waiters.length > 0) {
            scheduleSettingsSaveFlush(senderId, queue);
        } else if (settingsSaveQueuesBySender.get(senderId) === queue) {
            settingsSaveQueuesBySender.delete(senderId);
        }
    }
}

function queueSettingsSave(
    senderId: number,
    settingsPayload: TSettingsSavePatch,
    shutdownAssistant: () => Promise<void>,
) {
    let queue = settingsSaveQueuesBySender.get(senderId);
    if (!queue) {
        queue = {
            pendingPatch: {},
            diagnosticsConsentRevision: undefined,
            shutdownAssistant,
            waiters: [],
            timer: null,
            flushing: false,
        };
        settingsSaveQueuesBySender.set(senderId, queue);
    }

    queue.pendingPatch = {
        ...queue.pendingPatch,
        ...settingsPayload,
    };
    if (Object.hasOwn(settingsPayload, 'clientDiagnosticsPreference')) {
        queue.diagnosticsConsentRevision = recordMainDiagnosticsConsentIntent(
            settingsPayload.clientDiagnosticsPreference,
        );
    }

    const savePromise = new Promise<void>((resolve, reject) => {
        queue.waiters.push({
            resolve,
            reject,
        });
    });
    scheduleSettingsSaveFlush(senderId, queue);
    return savePromise;
}

export function createSettingsMainBindings(shutdownAssistant: () => Promise<void>) {
    return {
        async get() {
            const startedAt = Date.now();
            const settings = await loadSettings();
            if (STARTUP_TRACE_ENABLED) {
                logger.info(`[startup] IPC settings:get resolved (+${Date.now() - startedAt}ms)`);
            }
            return settings;
        },
        getRecoveryNotice: () => Promise.resolve(consumeSettingsRecoveryNotice()),
        save: (context, settings) => queueSettingsSave(context.senderId, settings, shutdownAssistant),
    } satisfies TFeatureMainBindings<typeof SETTINGS_PLATFORM_FEATURE, IpcMainInvokeEvent>;
}
