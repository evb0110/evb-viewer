// @vitest-environment happy-dom
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { Ref } from 'vue';
import type { ISettingsData } from '@contracts/shared';
import {
    DEFAULT_SETTINGS,
    type TSettingsSavePatch,
} from '@contracts/settings';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import { installNuxtStateTestStubs } from '@tests/unit/app/composables/installNuxtStateTestStubs';

const mockGet = vi.fn<() => Promise<ISettingsData>>();
const mockSave = vi.fn<(settings: TSettingsSavePatch) => Promise<void>>();
const settingsChangeListeners = new Set<(settings: ISettingsData) => void>();
const mockOnChanged = vi.fn((listener: (settings: ISettingsData) => void) => {
    settingsChangeListeners.add(listener);
    return () => settingsChangeListeners.delete(listener);
});
const cookieStore = new Map<string, Ref<unknown>>();
const stateStore = new Map<string, Ref<unknown>>();
const mockPlatformApi = createElectronPlatformApiFixture({settings: {
    get: mockGet,
    onChanged: mockOnChanged,
    save: mockSave,
}});

// The owner sends each committed write to every window, this one included, before the save replies.
function emitSettingsChange(settings: ISettingsData) {
    for (const listener of settingsChangeListeners) {
        listener(settings);
    }
}
const colorMode = {preference: 'light'};

vi.mock('@app/utils/platform', () => ({ getPlatformAPI: () => mockPlatformApi }));

function installNuxtStateStubs() {
    installNuxtStateTestStubs(cookieStore, stateStore);
    vi.stubGlobal('toRaw', <T>(value: T) => value);
    vi.stubGlobal('useColorMode', () => colorMode);
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

describe('useSettings', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mockGet.mockReset();
        mockSave.mockReset();
        settingsChangeListeners.clear();
        vi.useRealTimers();
        cookieStore.clear();
        stateStore.clear();
        installNuxtStateStubs();
    });

    it('preserves supported locale values on save', async () => {
        const { useSettings } = await import('@app/composables/useSettings');
        const {
            settings,
            load,
            save,
        } = useSettings();

        await load();
        settings.value.locale = 'fr';
        await expect(save()).resolves.toBe(true);

        expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ locale: 'fr' }));
    });

    it('falls back to default locale when saving invalid locale', async () => {
        mockGet.mockResolvedValue({locale: 'fr'} as ISettingsData);
        const { useSettings } = await import('@app/composables/useSettings');
        const {
            settings,
            load,
            save,
        } = useSettings();

        await load();
        Reflect.set(settings.value, 'locale', 'xx');
        await expect(save()).resolves.toBe(true);

        expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }));
    });

    it('sanitizes invalid loaded locale to default', async () => {
        mockGet.mockResolvedValue({
            version: 1,
            performanceMode: 'auto',
            authorName: 'Tester',
            theme: 'light',
            locale: 'xx' as ISettingsData['locale'],
            defaultZoomPreset: 'fit-width',
            defaultViewMode: 'single',
            defaultContinuousScroll: true,
            defaultAnnotationColor: '#ffd400',
            uiScale: 'auto',
            tabMemoryPolicy: 'conservative',
            optimizePdfOnSaveAs: false,
            agentMcpEnabled: false,
            assistantPanelEnabled: false,
            clientDiagnosticsPreference: 'unknown',
        });

        const { useSettings } = await import('@app/composables/useSettings');
        const {
            settings,
            load,
        } = useSettings();

        await load();

        expect(settings.value.locale).toBe('en');
    });

    it('starts unresolved without a snapshot and resolves after the authoritative load', async () => {
        mockGet.mockResolvedValue({
            version: 1,
            performanceMode: 'auto',
            authorName: 'Browser Tester',
            theme: 'dark',
            locale: 'fr',
            defaultZoomPreset: 'fit-width',
            defaultViewMode: 'single',
            defaultContinuousScroll: true,
            defaultAnnotationColor: '#ffd400',
            uiScale: 'auto',
            tabMemoryPolicy: 'conservative',
            optimizePdfOnSaveAs: false,
            agentMcpEnabled: false,
            assistantPanelEnabled: false,
            clientDiagnosticsPreference: 'unknown',
            suppressDefaultViewerPrompt: false,
        });

        const { useSettings } = await import('@app/composables/useSettings');
        const {
            hasCookieSnapshot,
            settings,
            isLoaded,
            load,
        } = useSettings();

        expect(isLoaded.value).toBe(false);

        await load();

        expect(isLoaded.value).toBe(true);
        expect(hasCookieSnapshot.value).toBe(false);
        expect(settings.value.theme).toBe('dark');
        expect(settings.value.locale).toBe('fr');
    });

    it('starts from the UI scale main passed to the window before settings load', async () => {
        vi.stubGlobal('window', {electronAPI: createElectronPlatformApiFixture({
            settings: {
                get: mockGet,
                save: mockSave,
            },
            startupUiScalePreference: 'large',
        })});
        try {
            const { useSettings } = await import('@app/composables/useSettings');
            const {
                isLoaded,
                settings,
            } = useSettings();

            expect(isLoaded.value).toBe(false);
            expect(settings.value.uiScale).toBe('large');
            expect(mockGet).not.toHaveBeenCalled();
        } finally {
            Reflect.deleteProperty(globalThis, 'window');
        }
    });

    it('holds pre-hydration intent until recovery and persists only that field', async () => {
        const authoritativeSettings: ISettingsData = {
            version: 2,
            performanceMode: 'high',
            authorName: 'Stored user',
            theme: 'dark',
            locale: 'fr',
            defaultZoomPreset: '150',
            defaultViewMode: 'facing',
            defaultContinuousScroll: false,
            defaultAnnotationColor: '#00ff00',
            uiScale: 'comfortable',
            tabMemoryPolicy: 'aggressive',
            optimizePdfOnSaveAs: true,
            agentMcpEnabled: false,
            assistantPanelEnabled: true,
            clientDiagnosticsPreference: 'granted',
            suppressUnencryptedSaveNotice: false,
        };
        mockGet.mockRejectedValueOnce(new Error('temporary read failure'));
        mockSave.mockResolvedValue(undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const { useSettings } = await import('@app/composables/useSettings');
        const {
            isLoaded,
            load,
            settings,
            save,
            updateSetting,
        } = useSettings();

        await load();
        expect(isLoaded.value).toBe(false);

        updateSetting('suppressUnencryptedSaveNotice', true);
        await expect(save()).resolves.toBe(true);
        expect(mockSave).not.toHaveBeenCalled();

        mockGet.mockResolvedValueOnce(authoritativeSettings);
        await load();
        expect(isLoaded.value).toBe(true);
        expect(settings.value.suppressUnencryptedSaveNotice).toBe(true);
        await vi.waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));

        expect(mockSave).toHaveBeenCalledWith({ suppressUnencryptedSaveNotice: true });
        expect(settings.value.locale).toBe('fr');
        expect(settings.value.theme).toBe('dark');
        expect(settings.value.defaultZoomPreset).toBe('150');
    });

    it('adopts a later commit after a pre-hydration edit was saved during load', async () => {
        vi.stubGlobal('window', {addEventListener: vi.fn()});
        mockGet.mockResolvedValue({
            ...DEFAULT_SETTINGS,
            authorName: 'Stored author',
        });
        mockSave.mockImplementation(async patch => {
            emitSettingsChange({
                ...DEFAULT_SETTINGS,
                ...patch,
            });
        });
        const {useSettings} = await import('@app/composables/useSettings');
        const instance = useSettings();
        instance.updateSetting('authorName', 'Before hydration');
        await instance.load();
        await vi.waitFor(() => expect(mockSave).toHaveBeenCalledOnce());
        emitSettingsChange({
            ...DEFAULT_SETTINGS,
            authorName: 'Saved in another window',
        });
        expect(instance.settings.value.authorName).toBe('Saved in another window');
    });

    it('reports a failed settings save and saves the latest payload on the next change', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mockSave
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValue(undefined);

        const { useSettings } = await import('@app/composables/useSettings');
        const {
            load,
            settings,
            save,
            settingsSaveError,
            settingsSaveFailure,
            settingsSaveStatus,
        } = useSettings();

        await load();
        settings.value.locale = 'fr';
        await expect(save()).resolves.toBe(false);
        expect(settingsSaveStatus.value).toBe('failed');
        expect(settingsSaveError.value).toBe('temporary failure');
        expect(settingsSaveFailure.value?.failure.code).toBe('SETTINGS_SAVE_FAILED');

        settings.value.locale = 'de';
        await expect(save()).resolves.toBe(true);
        expect(mockSave).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'de' }));
        expect(settingsSaveStatus.value).toBe('idle');
        expect(settingsSaveError.value).toBeNull();
        expect(settingsSaveFailure.value).toBeNull();
    });

    it('debounces updateSetting saves and flushes a pending save on pagehide', async () => {
        vi.useFakeTimers();
        mockSave.mockResolvedValue(undefined);
        const addEventListener = vi.fn<(type: string, listener: () => void) => void>();
        vi.stubGlobal('window', { addEventListener });

        try {
            const { useSettings } = await import('@app/composables/useSettings');
            const {
                load,
                updateSetting,
            } = useSettings();

            await load();

            updateSetting('authorName', 'First');
            updateSetting('authorName', 'Latest');
            expect(mockSave).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(400);
            expect(mockSave).toHaveBeenCalledTimes(1);
            expect(mockSave).toHaveBeenLastCalledWith(expect.objectContaining({ authorName: 'Latest' }));

            updateSetting('authorName', 'Unflushed');
            const pagehideListener = addEventListener.mock.calls
                .find(([type]) => type === 'pagehide')?.[1];
            expect(pagehideListener).toBeDefined();
            pagehideListener?.();
            await vi.advanceTimersByTimeAsync(0);

            expect(mockSave).toHaveBeenCalledTimes(2);
            expect(mockSave).toHaveBeenLastCalledWith(expect.objectContaining({ authorName: 'Unflushed' }));

            await vi.advanceTimersByTimeAsync(400);
            expect(mockSave).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });

    it('changes the live diagnostics gate before the debounced settings save', async () => {
        vi.useFakeTimers();
        const failureReporter = await import('@app/utils/failureReporter');
        failureReporter.setRendererDiagnosticsPreference('granted');
        const { useSettings } = await import('@app/composables/useSettings');
        const { updateSetting } = useSettings();

        updateSetting('clientDiagnosticsPreference', 'denied');

        expect(failureReporter.getRendererDiagnosticsPreference()).toBe('denied');
        expect(mockSave).not.toHaveBeenCalled();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('shares one in-flight save queue across settings composable callers', async () => {
        const firstSave = createDeferred();
        mockSave
            .mockImplementationOnce(async (patch) => {
                await firstSave.promise;
                emitSettingsChange({
                    ...DEFAULT_SETTINGS,
                    ...patch,
                });
            })
            .mockResolvedValue(undefined);

        const { useSettings } = await import('@app/composables/useSettings');
        const firstSettings = useSettings();
        const secondSettings = useSettings();

        await firstSettings.load();
        firstSettings.settings.value.locale = 'fr';
        const firstSavePromise = firstSettings.save();
        await vi.waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));

        secondSettings.settings.value.theme = 'dark';
        const secondSavePromise = secondSettings.save();

        expect(mockSave).toHaveBeenCalledTimes(1);

        firstSave.resolve();
        await Promise.all([
            firstSavePromise,
            secondSavePromise,
        ]);

        expect(mockSave).toHaveBeenCalledTimes(2);
        expect(mockSave).toHaveBeenNthCalledWith(2, { theme: 'dark' });
    });

    it('drains a setting edit admitted while the close flush is in flight', async () => {
        const firstSave = createDeferred();
        mockSave
            .mockImplementationOnce(async (patch) => {
                await firstSave.promise;
                emitSettingsChange({
                    ...DEFAULT_SETTINGS,
                    ...patch,
                });
            })
            .mockResolvedValue(undefined);

        const { useSettings } = await import('@app/composables/useSettings');
        const settings = useSettings();
        await settings.load();

        settings.updateSetting('locale', 'fr');
        const flush = settings.save();
        await vi.waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));

        settings.updateSetting('theme', 'dark');
        firstSave.resolve();

        await flush;

        expect(mockSave).toHaveBeenCalledTimes(2);
        expect(mockSave).toHaveBeenLastCalledWith({theme: 'dark'});
    });

    it('preserves an edit-back when the invoke reply is delivered before its own committed event', async () => {
        const baseline = {
            ...DEFAULT_SETTINGS,
            authorName: 'Saved author',
            clientDiagnosticsPreference: 'denied' as const,
        };
        mockGet.mockResolvedValue(baseline);
        const {useSettings} = await import('@app/composables/useSettings');
        const instance = useSettings();
        await instance.load();
        const pending = createDeferred();
        mockSave.mockReturnValueOnce(pending.promise);
        instance.updateSetting('authorName', 'First edit');
        const saving = instance.save();
        instance.updateSetting('authorName', 'Saved author');
        pending.resolve();
        await saving;
        mockSave.mockImplementationOnce(async patch => { emitSettingsChange({
            ...baseline,
            ...patch,
        }); });
        emitSettingsChange({
            ...baseline,
            authorName: 'First edit',
        });
        expect(instance.settings.value.authorName).toBe('Saved author');
        await vi.waitFor(() => expect(instance.settingsSaveStatus.value).toBe('idle'));
        expect(mockSave).toHaveBeenLastCalledWith({authorName: 'Saved author'});
        emitSettingsChange({
            ...baseline,
            authorName: 'Other window',
        });
        expect(instance.settings.value.authorName).toBe('Other window');
    });

    it('settles an undo to the saved value after a failed write and adopts another window', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const baseline = {
            ...DEFAULT_SETTINGS,
            authorName: 'Saved author',
            clientDiagnosticsPreference: 'denied' as const,
        };
        mockGet.mockResolvedValue(baseline);
        const {useSettings} = await import('@app/composables/useSettings');
        const instance = useSettings();
        await instance.load();
        mockSave.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
        instance.updateSetting('authorName', 'Failed edit');
        await expect(instance.save()).resolves.toBe(false);
        expect(instance.settingsSaveStatus.value).toBe('failed');
        instance.updateSetting('authorName', 'Saved author');
        await expect(instance.save()).resolves.toBe(true);
        emitSettingsChange({
            ...baseline,
            authorName: 'Other window',
        });
        expect(instance.settings.value.authorName).toBe('Other window');
        expect(instance.settingsSaveStatus.value).toBe('idle');
    });

    it('releases an edit that returned to the committed value before any save started', async () => {
        mockGet.mockResolvedValue({
            ...DEFAULT_SETTINGS,
            theme: 'light',
        });
        const {useSettings} = await import('@app/composables/useSettings');
        const instance = useSettings();
        await instance.load();
        instance.updateSetting('theme', 'dark');
        instance.updateSetting('theme', 'light');
        await instance.save();
        emitSettingsChange({
            ...DEFAULT_SETTINGS,
            theme: 'dark',
        });
        expect(instance.settings.value.theme).toBe('dark');
    });

    it.each([
        [
            'authorName',
            'Saved author',
            'First edit',
        ],
        [
            'theme',
            'light',
            'dark',
        ],
        [
            'clientDiagnosticsPreference',
            'denied',
            'granted',
        ],
    ] as const)('preserves a later %s edit returning to its saved value', async (key, savedValue, firstValue) => {
        const baseline = {
            ...DEFAULT_SETTINGS,
            [key]: savedValue,
        };
        mockGet.mockResolvedValue(baseline);
        const pending = createDeferred();
        mockSave.mockReturnValueOnce(pending.promise).mockImplementationOnce(async (patch) => {
            emitSettingsChange({
                ...baseline,
                ...patch,
            });
        });
        const {useSettings} = await import('@app/composables/useSettings');
        const instance = useSettings();
        await instance.load();

        instance.updateSetting(key, firstValue);
        const saving = instance.save();
        instance.updateSetting(key, savedValue);
        emitSettingsChange({
            ...baseline,
            [key]: firstValue,
        });
        pending.resolve();
        await saving;

        expect(instance.settings.value[key]).toBe(savedValue);
        expect(mockSave).toHaveBeenLastCalledWith({[key]: savedValue});
        if (key === 'clientDiagnosticsPreference') {
            const {getRendererDiagnosticsPreference} = await import('@app/utils/failureReporter');
            expect(getRendererDiagnosticsPreference()).toBe('denied');
        }
        emitSettingsChange({
            ...baseline,
            [key]: firstValue,
        });
        expect(instance.settings.value[key]).toBe(firstValue);
    });

    it('keeps the committed value of a key another window saved while this save was in flight', async () => {
        const firstSave = createDeferred();
        mockGet.mockResolvedValue({
            ...DEFAULT_SETTINGS,
            locale: 'en',
            theme: 'light',
        });
        mockSave.mockImplementationOnce(() => firstSave.promise);

        const { useSettings } = await import('@app/composables/useSettings');
        const {
            load,
            save,
            settings,
        } = useSettings();
        await load();

        settings.value.theme = 'dark';
        const savePromise = save();
        await vi.waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
        // Another window changes the locale while this save is in flight, then the owner commits this save.
        emitSettingsChange({
            ...DEFAULT_SETTINGS,
            locale: 'ru',
            theme: 'light',
        });
        emitSettingsChange({
            ...DEFAULT_SETTINGS,
            locale: 'ru',
            theme: 'dark',
        });
        firstSave.resolve();
        await savePromise;

        expect(settings.value.locale).toBe('ru');
        // Nothing is pending in this window for the locale, so another window's next change is adopted.
        emitSettingsChange({
            ...DEFAULT_SETTINGS,
            locale: 'en',
            theme: 'dark',
        });
        expect(settings.value.locale).toBe('en');
    });
});

describe('selectAdoptedSettings', () => {
    it('adopts the committed values of keys the window has no unsaved edit in', async () => {
        const { selectAdoptedSettings } = await import('@app/composables/useSettings');
        const saved: ISettingsData = {
            ...DEFAULT_SETTINGS,
            locale: 'en',
            theme: 'light',
        };
        const current: ISettingsData = {
            ...saved,
            authorName: 'Unsaved here',
        };
        const committed: ISettingsData = {
            ...DEFAULT_SETTINGS,
            authorName: 'Saved elsewhere',
            locale: 'ru',
            theme: 'dark',
        };

        const adopted = selectAdoptedSettings(current, saved, committed);

        expect(adopted).toMatchObject({
            locale: 'ru',
            theme: 'dark',
        });
        expect(adopted).not.toHaveProperty('authorName');
    });

    it('lets a withdrawal saved elsewhere replace a local unsaved grant', async () => {
        const { selectAdoptedSettings } = await import('@app/composables/useSettings');
        const saved: ISettingsData = {
            ...DEFAULT_SETTINGS,
            clientDiagnosticsPreference: 'denied',
        };
        const current: ISettingsData = {
            ...saved,
            clientDiagnosticsPreference: 'granted',
        };

        const adopted = selectAdoptedSettings(current, saved, saved);

        expect(adopted).toMatchObject({clientDiagnosticsPreference: 'denied'});
    });

    it('does not let a grant saved elsewhere reopen reporting over a local unsaved withdrawal', async () => {
        const { selectAdoptedSettings } = await import('@app/composables/useSettings');
        const saved: ISettingsData = {
            ...DEFAULT_SETTINGS,
            clientDiagnosticsPreference: 'granted',
        };
        const current: ISettingsData = {
            ...saved,
            clientDiagnosticsPreference: 'denied',
        };
        const committed: ISettingsData = {
            ...saved,
            clientDiagnosticsPreference: 'granted',
        };

        const adopted = selectAdoptedSettings(current, saved, committed);

        expect(adopted).not.toHaveProperty('clientDiagnosticsPreference');
    });

    it('adopts only a withdrawal before the window has a saved value to compare with', async () => {
        const { selectAdoptedSettings } = await import('@app/composables/useSettings');
        const current: ISettingsData = {...DEFAULT_SETTINGS};

        expect(selectAdoptedSettings(current, null, {
            ...DEFAULT_SETTINGS,
            locale: 'ru',
            clientDiagnosticsPreference: 'granted',
        })).toEqual({});
        expect(selectAdoptedSettings(current, null, {
            ...DEFAULT_SETTINGS,
            clientDiagnosticsPreference: 'denied',
        })).toEqual({clientDiagnosticsPreference: 'denied'});
    });
});
