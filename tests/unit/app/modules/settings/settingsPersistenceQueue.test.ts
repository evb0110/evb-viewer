import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { DEFAULT_SETTINGS } from '@contracts/settings';
import type { ISettingsData } from '@contracts/shared';
import {
    buildSettingsPatch,
    createSettingsPersistenceQueue,
} from '@app/modules/settings/settingsPersistenceQueue';

function createSettings(overrides: Partial<ISettingsData> = {}) {
    return {
        ...DEFAULT_SETTINGS,
        ...overrides,
    };
}

function createDeferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return {
        promise,
        resolve,
        reject,
    };
}

describe('settingsPersistenceQueue', () => {
    it('builds a minimal patch against the last saved settings', () => {
        const previousSettings = createSettings({
            locale: 'en',
            theme: 'light',
        });
        const nextSettings = createSettings({
            locale: 'fr',
            theme: 'light',
        });

        expect(buildSettingsPatch(previousSettings, nextSettings)).toEqual({ locale: 'fr' });
    });

    it('never includes settings owned by updater and MCP flows', () => {
        const previousSettings = createSettings({
            agentMcpEnabled: false,
            skippedUpdateVersion: '1.0.0',
        });
        const nextSettings = createSettings({
            agentMcpEnabled: true,
            skippedUpdateVersion: '2.0.0',
        });

        expect(buildSettingsPatch(previousSettings, nextSettings)).toEqual({});
        expect(buildSettingsPatch(null, nextSettings)).not.toHaveProperty('agentMcpEnabled');
        expect(buildSettingsPatch(null, nextSettings)).not.toHaveProperty('skippedUpdateVersion');
    });

    it('skips platform writes when the sanitized payload has not changed', async () => {
        const snapshot = createSettings({ locale: 'fr' });
        let lastSavedSettings: ISettingsData | null = snapshot;
        const savePatch = vi.fn<() => Promise<void>>();
        const onSaved = vi.fn((settings: ISettingsData) => {
            lastSavedSettings = settings;
        });

        const queue = createSettingsPersistenceQueue({
            getSettingsSnapshot: () => snapshot,
            getLastSavedSettings: () => lastSavedSettings,
            savePatch,
            onSaved,
            onSaveError: vi.fn(),
        });

        await expect(queue.save()).resolves.toBe(true);

        expect(savePatch).not.toHaveBeenCalled();
        expect(onSaved).toHaveBeenCalledWith(snapshot);
    });

    it('drains the latest dirty snapshot after an in-flight save finishes', async () => {
        let snapshot = createSettings({
            locale: 'fr',
            theme: 'light',
        });
        let lastSavedSettings: ISettingsData | null = null;
        const firstSave = createDeferred();
        const savePatch = vi.fn(async () => {
            if (savePatch.mock.calls.length === 1) {
                await firstSave.promise;
            }
        });

        const queue = createSettingsPersistenceQueue({
            getSettingsSnapshot: () => snapshot,
            getLastSavedSettings: () => lastSavedSettings,
            savePatch,
            onSaved(settings) {
                lastSavedSettings = settings;
            },
            onSaveError: vi.fn(),
        });

        const firstSavePromise = queue.save();
        await vi.waitFor(() => expect(savePatch).toHaveBeenCalledTimes(1));

        snapshot = createSettings({
            locale: 'fr',
            theme: 'dark',
        });
        const secondSavePromise = queue.save();
        firstSave.resolve();
        await Promise.all([
            firstSavePromise,
            secondSavePromise,
        ]);

        expect(savePatch).toHaveBeenCalledTimes(2);
        expect(savePatch).toHaveBeenNthCalledWith(1, expect.objectContaining({
            locale: 'fr',
            theme: 'light',
        }));
        expect(savePatch).toHaveBeenNthCalledWith(2, { theme: 'dark' });
    });

    it('reports a failed save without scheduling a retry', async () => {
        const snapshot = createSettings({ locale: 'fr' });
        const saveError = new Error('temporary failure');
        const statusChanges: Array<{
            status: string;
            error?: unknown;
        }> = [];
        const queue = createSettingsPersistenceQueue({
            getSettingsSnapshot: () => snapshot,
            getLastSavedSettings: () => null,
            savePatch: vi.fn(async () => {
                throw saveError;
            }),
            onSaved: vi.fn(),
            onSaveError: vi.fn(),
            onStatusChanged(status, error) {
                statusChanges.push({
                    status,
                    ...(error ? { error } : {}),
                });
            },
        });

        await expect(queue.save()).resolves.toBe(false);

        expect(statusChanges).toEqual([
            { status: 'saving' },
            {
                status: 'failed',
                error: saveError,
            },
        ]);
    });
});
