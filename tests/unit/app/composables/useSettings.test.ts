import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { Ref } from 'vue';
import type { ISettingsData } from '@contracts/shared';
import type { TSettingsSavePatch } from '@contracts/settings';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import { installNuxtStateTestStubs } from '@tests/unit/app/composables/installNuxtStateTestStubs';

const mockGet = vi.fn<() => Promise<ISettingsData>>();
const mockSave = vi.fn<(settings: TSettingsSavePatch) => Promise<void>>();
const cookieStore = new Map<string, Ref<unknown>>();
const stateStore = new Map<string, Ref<unknown>>();
const mockPlatformApi = createElectronPlatformApiFixture({settings: {
    get: mockGet,
    save: mockSave,
}});

vi.mock('@app/utils/platform', () => ({ getPlatformAPI: () => mockPlatformApi }));

function installNuxtStateStubs() {
    installNuxtStateTestStubs(cookieStore, stateStore);
    vi.stubGlobal('toRaw', <T>(value: T) => value);
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

    it('retries a failed settings save with the latest dirty payload', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.useFakeTimers();
        mockSave
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValue(undefined);

        const failureReporter = await import('@app/utils/failureReporter');
        const reporter = failureReporter.initializeRendererFailureReporter({
            host: 'hosted-browser',
            preference: 'denied',
        });
        const { useSettings } = await import('@app/composables/useSettings');
        const {
            isSettingsSavePendingRetry,
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
        expect(mockSave).toHaveBeenCalledTimes(1);
        expect(settingsSaveStatus.value).toBe('retry-pending');
        expect(settingsSaveError.value).toBe('temporary failure');
        const firstFailure = settingsSaveFailure.value;
        expect(firstFailure?.failure.code).toBe('SETTINGS_SAVE_FAILED');
        expect(reporter.getHealthSnapshot().attempted).toBe(1);
        expect(isSettingsSavePendingRetry.value).toBe(true);

        settings.value.locale = 'de';
        await vi.advanceTimersByTimeAsync(1_000);

        expect(mockSave).toHaveBeenCalledTimes(2);
        expect(mockSave).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'de' }));
        expect(settingsSaveStatus.value).toBe('idle');
        expect(settingsSaveError.value).toBeNull();
        expect(settingsSaveFailure.value).toBeNull();
        expect(reporter.getHealthSnapshot().attempted).toBe(1);
        expect(firstFailure?.failure.eventId).toBeDefined();
        expect(isSettingsSavePendingRetry.value).toBe(false);
        vi.useRealTimers();
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
        const reporter = failureReporter.initializeRendererFailureReporter({
            host: 'hosted-browser',
            preference: 'granted',
        });
        const { useSettings } = await import('@app/composables/useSettings');
        const { updateSetting } = useSettings();

        updateSetting('clientDiagnosticsPreference', 'denied');

        expect(reporter.getPreference()).toBe('denied');
        expect(mockSave).not.toHaveBeenCalled();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('shares one in-flight save queue across settings composable callers', async () => {
        const firstSave = createDeferred();
        mockSave
            .mockImplementationOnce(() => firstSave.promise)
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
});
