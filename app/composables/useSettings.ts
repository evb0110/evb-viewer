import {
    normalizeLocale,
    normalizeTheme,
    sanitizeSettings,
} from '@contracts/settings';
import { getFailureReceipt } from '@contracts/diagnostics/failureReceipt';
import type { ISettingsData } from '@contracts/shared';
import type { IPresentedFailureCapture } from '@app/utils/failureReporter';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import {
    BROWSER_LOCALE_COOKIE_KEY,
    BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS,
    BROWSER_THEME_COOKIE_KEY,
    parseBrowserSettingsPayload,
} from '@app/utils/browserSettingsPersistence';
import { getSettingsCapability } from '@app/utils/getSettingsCapability';
import { getRawElectronPlatformApi } from '@app/utils/electronPlatformBridge';
import {
    captureFailureForPresentation,
    setRendererDiagnosticsPreference,
} from '@app/utils/failureReporter';
import { usePlatformHydratedState } from '@app/composables/usePlatformHydratedState';
import { useTypedI18n } from '@app/composables/useTypedI18n';
import {
    createSettingsPersistenceQueue,
    type ISettingsPersistenceQueue,
    type TSettingsPersistenceStatus,
} from '@app/modules/settings/public';

const PERSISTENT_SETTINGS_COOKIE_OPTIONS = {
    watch: false,
    maxAge: BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS,
    sameSite: 'lax' as const,
    path: '/',
    secure: import.meta.client && window.location.protocol === 'https:',
};
const SETTINGS_SAVE_DEBOUNCE_MS = 400;
let settingsPersistenceQueue: ISettingsPersistenceQueue | null = null;
let settingsSaveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let flushDebouncedSettingsSave: (() => void) | null = null;
let settingsSaveFlushListener: (() => void) | null = null;
let unsubscribeSettingsChanges: (() => void) | null = null;
const pendingSettingsIntent = new Map<keyof ISettingsData, unknown>();

type TSettingsPersistenceFailureCode = 'SETTINGS_LOAD_FAILED' | 'SETTINGS_SAVE_FAILED';

function captureSettingsPersistenceFailure(
    code: TSettingsPersistenceFailureCode,
    error: unknown,
    message: string,
): IPresentedFailureCapture {
    const existingFailure = getFailureReceipt(error);
    const presentation = existingFailure
        ? {failure: existingFailure}
        : captureFailureForPresentation({
            code,
            local: {
                source: 'settings',
                message,
                cause: error,
            },
        });
    BrowserLogger.error('settings', message, error, presentation.failure);
    return presentation;
}

function cancelDebouncedSettingsSave() {
    if (settingsSaveDebounceTimer !== null) {
        clearTimeout(settingsSaveDebounceTimer);
        settingsSaveDebounceTimer = null;
    }
    flushDebouncedSettingsSave = null;
}

/**
 * What a window adopts from a committed write it did not make: each key it has
 * no unsaved edit in, and a diagnostics withdrawal even over a local grant. A
 * grant saved elsewhere therefore cannot reopen reporting in a window whose own
 * withdrawal is not yet saved.
 */
export function selectAdoptedSettings(
    current: ISettingsData,
    lastSaved: ISettingsData | null,
    committed: ISettingsData,
    pendingIntent?: ReadonlyMap<keyof ISettingsData, unknown>,
): Partial<ISettingsData> {
    const adopted: Partial<ISettingsData> = {};
    for (const key of Object.keys(committed) as Array<keyof ISettingsData>) {
        const withdrawal = key === 'clientDiagnosticsPreference' && committed[key] === 'denied';
        if (withdrawal || (pendingIntent?.has(key)
            ? pendingIntent.get(key) === committed[key]
            : current[key] === lastSaved?.[key])) {
            Object.assign(adopted, {[key]: committed[key]});
        }
    }
    return adopted;
}

export const useSettings = () => {
    const {
        locale,
        setLocale,
    } = useTypedI18n();
    const colorMode = useColorMode();
    const localeCookie = useCookie(
        BROWSER_LOCALE_COOKIE_KEY,
        PERSISTENT_SETTINGS_COOKIE_OPTIONS,
    );
    const themeCookie = useCookie(
        BROWSER_THEME_COOKIE_KEY,
        PERSISTENT_SETTINGS_COOKIE_OPTIONS,
    );
    const hasSettingsCookieSnapshot = useState(
        'settings:has-cookie-snapshot',
        () => localeCookie.value != null
            || themeCookie.value != null,
    );
    const fallbackSettings: Partial<ISettingsData> = {};
    if (localeCookie.value != null) {
        fallbackSettings.locale = normalizeLocale(localeCookie.value);
    }
    if (themeCookie.value != null) {
        fallbackSettings.theme = normalizeTheme(themeCookie.value);
    }
    // Main passes the stored UI scale to the window, so the first layout uses it.
    const startupUiScalePreference = getRawElectronPlatformApi()?.startupUiScalePreference;
    if (startupUiScalePreference) {
        fallbackSettings.uiScale = startupUiScalePreference;
    }
    const initialSettings = parseBrowserSettingsPayload(null, fallbackSettings);
    const lastSavedSettings = useState<ISettingsData | null>(
        'settings:last-saved',
        () => null,
    );
    const settingsSaveStatus = useState<TSettingsPersistenceStatus>('settings:save-status', () => 'idle');
    const settingsSaveError = useState<string | null>('settings:save-error', () => null);
    const settingsLoadFailure = useState<IPresentedFailureCapture | null>('settings:load-failure', () => null);
    const settingsSaveFailure = useState<IPresentedFailureCapture | null>('settings:save-failure', () => null);

    function rememberSavedSettings(nextSettings: ISettingsData) {
        lastSavedSettings.value = sanitizeSettings(nextSettings);
    }

    function refreshSettingsBootstrapCookieSnapshot() {
        hasSettingsCookieSnapshot.value = localeCookie.value != null
            || themeCookie.value != null;
    }

    const {
        state: settings,
        isResolved: isLoaded,
        error: settingsLoadError,
        load: loadSettingsState,
    } = usePlatformHydratedState<ISettingsData>({
        key: 'settings',
        initialValue: () => initialSettings,
        initialResolved: false,
        async loadValue() {
            const loadedSettings = await getSettingsCapability().get();
            return sanitizeSettings(loadedSettings);
        },
        onLoaded(nextSettings) {
            refreshSettingsBootstrapCookieSnapshot();
            rememberSavedSettings(nextSettings);
            if (pendingSettingsIntent.size > 0) {
                settings.value = sanitizeSettings({
                    ...nextSettings,
                    ...Object.fromEntries(pendingSettingsIntent),
                });
                setRendererDiagnosticsPreference(settings.value.clientDiagnosticsPreference);
                settingsLoadFailure.value = null;
                cancelDebouncedSettingsSave();
                void getSettingsPersistenceQueue().save();
                return;
            }
            setRendererDiagnosticsPreference(nextSettings.clientDiagnosticsPreference);
            settingsLoadFailure.value = null;
        },
        onError(loadError) {
            settingsLoadFailure.value ??= captureSettingsPersistenceFailure(
                'SETTINGS_LOAD_FAILED',
                loadError,
                'Failed to load settings',
            );
        },
    });

    if (typeof window !== 'undefined' && unsubscribeSettingsChanges === null) {
        unsubscribeSettingsChanges = getSettingsCapability().onChanged((committed) => {
            const adopted = selectAdoptedSettings(settings.value, lastSavedSettings.value, committed, pendingSettingsIntent);
            for (const key of Object.keys(adopted) as Array<keyof ISettingsData>) pendingSettingsIntent.delete(key);
            if (Object.hasOwn(adopted, 'clientDiagnosticsPreference')) {
                setRendererDiagnosticsPreference(adopted.clientDiagnosticsPreference);
            }
            Object.assign(settings.value, adopted);
            if (adopted.theme !== undefined) {
                colorMode.preference = adopted.theme;
            }
            if (adopted.locale !== undefined && adopted.locale !== locale.value) {
                void setLocale(adopted.locale).catch((error: unknown) => {
                    BrowserLogger.warn('settings', 'Failed to apply the language saved in another window', error);
                });
            }
            rememberSavedSettings(committed);
            if (isLoaded.value && pendingSettingsIntent.size > 0) void getSettingsPersistenceQueue().save();
            else if (settingsSaveStatus.value === 'saving') settingsSaveStatus.value = 'idle';
        });
    }

    function load() {
        return loadSettingsState();
    }

    async function loadOrThrow() {
        const loadedSettings = await load();
        if (loadedSettings === null) {
            throw new Error(settingsLoadError.value ?? 'Settings could not be loaded.');
        }
        return loadedSettings;
    }

    function getSettingsPersistenceQueue() {
        if (settingsPersistenceQueue) {
            return settingsPersistenceQueue;
        }

        settingsPersistenceQueue = createSettingsPersistenceQueue({
            getSettingsSnapshot: () => toRaw(settings.value),
            getLastSavedSettings: () => lastSavedSettings.value,
            savePatch: patch => getSettingsCapability().save(patch),
            onSaved() {
                refreshSettingsBootstrapCookieSnapshot();
                settingsSaveFailure.value = null;
            },
            onSaveError(error) {
                settingsSaveFailure.value ??= captureSettingsPersistenceFailure(
                    'SETTINGS_SAVE_FAILED',
                    error,
                    'Failed to save settings',
                );
            },
            onStatusChanged(status, error) {
                settingsSaveStatus.value = status === 'idle' && pendingSettingsIntent.size > 0 ? 'saving' : status;
                settingsSaveError.value = error ? getErrorMessage(error) : null;
            },
        });
        return settingsPersistenceQueue;
    }

    async function save() {
        cancelDebouncedSettingsSave();
        if (!isLoaded.value) {
            return true;
        }
        return getSettingsPersistenceQueue().save();
    }

    // Trailing debounce: per-keystroke updates otherwise write storage plus
    // two cookies (browser) or an IPC round-trip (desktop) on every change.
    // The queue reads the live snapshot at save time, so the flushed save
    // always persists the latest state.
    function scheduleDebouncedSave() {
        if (settingsSaveFlushListener === null && typeof window !== 'undefined') {
            settingsSaveFlushListener = () => flushDebouncedSettingsSave?.();
            window.addEventListener('pagehide', settingsSaveFlushListener);
        }
        if (settingsSaveDebounceTimer !== null) {
            clearTimeout(settingsSaveDebounceTimer);
        }
        flushDebouncedSettingsSave = () => {
            void save();
        };
        settingsSaveDebounceTimer = setTimeout(() => {
            settingsSaveDebounceTimer = null;
            const flush = flushDebouncedSettingsSave;
            flushDebouncedSettingsSave = null;
            flush?.();
        }, SETTINGS_SAVE_DEBOUNCE_MS);
    }

    function updateSetting<K extends keyof ISettingsData>(key: K, value: ISettingsData[K]) {
        if (settingsSaveStatus.value === 'idle' && value === lastSavedSettings.value?.[key]) pendingSettingsIntent.delete(key);
        else pendingSettingsIntent.set(key, value);
        Object.assign(settings.value, {[key]: value});
        if (key === 'clientDiagnosticsPreference') {
            setRendererDiagnosticsPreference(value);
        }
        if (settingsSaveStatus.value === 'saving') void getSettingsPersistenceQueue().save();
        else scheduleDebouncedSave();
    }

    return {
        settings,
        isLoaded,
        hasCookieSnapshot: hasSettingsCookieSnapshot,
        load,
        loadOrThrow,
        settingsLoadError,
        settingsLoadFailure,
        save,
        settingsSaveError,
        settingsSaveFailure,
        settingsSaveStatus,
        updateSetting,
    };
};

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        cancelDebouncedSettingsSave();
        if (settingsSaveFlushListener !== null && typeof window !== 'undefined') {
            window.removeEventListener('pagehide', settingsSaveFlushListener);
            settingsSaveFlushListener = null;
        }
        settingsPersistenceQueue = null;
        unsubscribeSettingsChanges?.();
        unsubscribeSettingsChanges = null;
    });
}
