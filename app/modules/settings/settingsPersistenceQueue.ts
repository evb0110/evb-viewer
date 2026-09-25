import {
    SETTINGS_SAVE_KEYS,
    sanitizeSettings,
    type TSettingsSavePatch,
} from '@contracts/settings';
import type { ISettingsData } from '@contracts/shared';

export type TSettingsPersistenceStatus = 'idle' | 'saving' | 'failed';

export interface ISettingsPersistenceQueueOptions {
    getSettingsSnapshot: () => unknown;
    getLastSavedSettings: () => ISettingsData | null;
    savePatch: (patch: TSettingsSavePatch) => Promise<void>;
    onSaved: (settings: ISettingsData) => void;
    onSaveError: (error: unknown) => void;
    onStatusChanged?: (status: TSettingsPersistenceStatus, error?: unknown) => void;
}

export interface ISettingsPersistenceQueue {save: () => Promise<boolean>;}

export function buildSettingsPatch(
    previousSettings: ISettingsData | null,
    nextSettings: ISettingsData,
) {
    const patch: TSettingsSavePatch = {};
    for (const key of SETTINGS_SAVE_KEYS) {
        if (
            Object.hasOwn(nextSettings, key)
            && (!previousSettings || nextSettings[key] !== previousSettings[key])
        ) {
            Object.assign(patch, {[key]: nextSettings[key]});
        }
    }
    return patch;
}

/**
 * Coalesces saves: a save requested while one is in flight runs once more
 * with the latest snapshot. A failed save reports its error and waits for the
 * user's next change or an explicit retry; a local file write gains nothing
 * from timed retries.
 */
export function createSettingsPersistenceQueue(
    options: ISettingsPersistenceQueueOptions,
): ISettingsPersistenceQueue {
    let saveInFlight: Promise<boolean> | null = null;
    let dirtyRevision = 0;

    async function runSaveQueue() {
        for (;;) {
            const revision = dirtyRevision;
            const payload = sanitizeSettings(options.getSettingsSnapshot());
            const patch = buildSettingsPatch(options.getLastSavedSettings(), payload);
            try {
                if (Object.keys(patch).length > 0) {
                    await options.savePatch(patch);
                }
                options.onSaved(payload);
            } catch (error) {
                options.onSaveError(error);
                options.onStatusChanged?.('failed', error);
                return false;
            }
            if (dirtyRevision === revision) {
                options.onStatusChanged?.('idle');
                return true;
            }
        }
    }

    function save() {
        if (saveInFlight) {
            dirtyRevision += 1;
            return saveInFlight;
        }
        options.onStatusChanged?.('saving');
        saveInFlight = runSaveQueue().finally(() => {
            saveInFlight = null;
        });
        return saveInFlight;
    }

    return {save};
}
