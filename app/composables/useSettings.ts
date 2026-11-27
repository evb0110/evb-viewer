import {useDebounceFn} from '@vueuse/core';
import {getCurrentInstance, toRaw} from 'vue';
import {normalizeLocale, normalizeTheme, sanitizeSettings} from '@contracts/settings';
import {getFailureReceipt} from '@contracts/diagnostics/failureReceipt';
import type {ISettingsData} from '@contracts/shared';
import type {IPresentedFailureCapture} from '@app/utils/failureReporter';
import {BrowserLogger} from '@app/utils/browserLogger';
import {getErrorMessage} from '@app/utils/error';
import {
    BROWSER_LOCALE_COOKIE_KEY,
    BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS,
    BROWSER_THEME_COOKIE_KEY,
    parseBrowserSettingsPayload,
} from '@app/utils/browserSettingsPersistence';
import {getSettingsCapability} from '@app/utils/getSettingsCapability';
import {getRawElectronPlatformApi} from '@app/utils/electronPlatformBridge';
import {captureFailureForPresentation, setRendererDiagnosticsPreference} from '@app/utils/failureReporter';
import {usePlatformHydratedState} from '@app/composables/usePlatformHydratedState';
import {useTypedI18n} from '@app/composables/useTypedI18n';
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

type TSettingsPersistenceFailureCode = 'SETTINGS_LOAD_FAILED' | 'SETTINGS_SAVE_FAILED';

interface ISettingsSaveError {
    name: string;
    message: string;
}

interface IAppWithUnmountHook {
    onUnmount?: (cleanup: () => void) => void;
    vueApp?: {onUnmount?: (cleanup: () => void) => void};
}

interface ISettingsRuntimeOwner {
    persistenceQueue: ISettingsPersistenceQueue | null;
    pendingIntent: Map<keyof ISettingsData, unknown>;
    flushListener: (() => void) | null;
    unsubscribeSettingsChanges: (() => void) | null;
    readonly debouncedSave: ReturnType<typeof useDebounceFn<(saveNow: () => void) => void>>;
    dispose: () => void;
}

interface ISettingsHmrHandoff {
    pendingIntent: Map<keyof ISettingsData, unknown>;
    persistenceQueue: ISettingsPersistenceQueue | null;
}

interface ISettingsHotRegistration {
    dispose: () => void;
    handoffForHmr: () => ISettingsHmrHandoff;
}

const settingsOwnersByApp = new WeakMap<object, ISettingsRuntimeOwner>();
const hotSettingsCleanups = import.meta.hot ? new Set<() => void>() : null;
const SETTINGS_HOT_DISPOSERS_SYMBOL = Symbol.for('evb:hmr:useSettings:disposers');
const fallbackSettingsAppKey = {};

function getHotSettingsDisposersByApp(): WeakMap<object, ISettingsHotRegistration> | null {
    if (!import.meta.hot) {
        return null;
    }
    const existing = Reflect.get(globalThis, SETTINGS_HOT_DISPOSERS_SYMBOL);
    if (existing instanceof WeakMap) {
        return existing as WeakMap<object, ISettingsHotRegistration>;
    }
    const created = new WeakMap<object, ISettingsHotRegistration>();
    Reflect.set(globalThis, SETTINGS_HOT_DISPOSERS_SYMBOL, created);
    return created;
}

function disposeAllHotSettingsOwners() {
    for (const cleanup of [...(hotSettingsCleanups ?? [])]) {
        cleanup();
    }
}

function resolveSettingsAppKey(): object {
    if (typeof tryUseNuxtApp === 'function') {
        const nuxtApp = tryUseNuxtApp();
        if (nuxtApp) {
            return nuxtApp;
        }
    }
    if (typeof useNuxtApp === 'function') {
        try {
            const nuxtApp = useNuxtApp();
            if (nuxtApp) {
                return nuxtApp;
            }
        } catch {
            // Outside an active Nuxt app context (e.g. standalone unit tests).
        }
    }
    return getCurrentInstance()?.appContext.app ?? fallbackSettingsAppKey;
}

function registerSettingsAppUnmountCleanup(appKey: object, cleanup: () => void) {
    const candidate = appKey as IAppWithUnmountHook;
    const onUnmount =
        typeof candidate.onUnmount === 'function'
            ? candidate.onUnmount.bind(candidate)
            : typeof candidate.vueApp?.onUnmount === 'function'
              ? candidate.vueApp.onUnmount.bind(candidate.vueApp)
              : null;
    onUnmount?.(cleanup);
}

function createSettingsRuntimeOwner(handoff?: ISettingsHmrHandoff): ISettingsRuntimeOwner {
    const debouncedSave = useDebounceFn((saveNow: () => void) => {
        saveNow();
    }, SETTINGS_SAVE_DEBOUNCE_MS);

    function detachListenersAndTimers(owner: ISettingsRuntimeOwner) {
        owner.debouncedSave.cancel();
        if (owner.flushListener !== null && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('pagehide', owner.flushListener);
        }
        owner.flushListener = null;
        owner.unsubscribeSettingsChanges?.();
        owner.unsubscribeSettingsChanges = null;
    }

    const owner: ISettingsRuntimeOwner = {
        persistenceQueue: handoff?.persistenceQueue ?? null,
        pendingIntent: handoff ? new Map(handoff.pendingIntent) : new Map<keyof ISettingsData, unknown>(),
        flushListener: null,
        unsubscribeSettingsChanges: null,
        debouncedSave,
        dispose() {
            detachListenersAndTimers(owner);
            owner.persistenceQueue = null;
            owner.pendingIntent.clear();
        },
    };
    return owner;
}

function getSettingsRuntimeOwner(): ISettingsRuntimeOwner {
    const appKey = resolveSettingsAppKey();
    let owner = settingsOwnersByApp.get(appKey);
    if (!owner) {
        const hotDisposers = getHotSettingsDisposersByApp();
        const handoff = hotDisposers && appKey !== fallbackSettingsAppKey ? hotDisposers.get(appKey)?.handoffForHmr() : undefined;
        const created = createSettingsRuntimeOwner(handoff);
        const baseDispose = created.dispose;
        const detachRegistration = () => {
            hotSettingsCleanups?.delete(cleanup);
            if (hotDisposers?.get(appKey) === hotRegistration) {
                hotDisposers.delete(appKey);
            }
            if (settingsOwnersByApp.get(appKey) === created) {
                settingsOwnersByApp.delete(appKey);
            }
        };
        const cleanup = () => {
            detachRegistration();
            baseDispose();
        };
        const hotRegistration: ISettingsHotRegistration = {
            dispose: cleanup,
            handoffForHmr() {
                // Preserve in-flight queue ordering and pending intent across same-app HMR
                // while releasing the retiring module's debounce timer and event listeners.
                const preserved: ISettingsHmrHandoff = {
                    pendingIntent: new Map(created.pendingIntent),
                    persistenceQueue: created.persistenceQueue,
                };
                detachRegistration();
                created.debouncedSave.cancel();
                if (created.flushListener !== null && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
                    window.removeEventListener('pagehide', created.flushListener);
                }
                created.flushListener = null;
                created.unsubscribeSettingsChanges?.();
                created.unsubscribeSettingsChanges = null;
                return preserved;
            },
        };
        created.dispose = cleanup;
        settingsOwnersByApp.set(appKey, created);
        hotSettingsCleanups?.add(cleanup);
        if (hotDisposers && appKey !== fallbackSettingsAppKey) {
            hotDisposers.set(appKey, hotRegistration);
        }
        registerSettingsAppUnmountCleanup(appKey, cleanup);
        owner = created;
    }
    return owner;
}

/** Disposes the active app-level settings owner, cancelling pending saves and detaching listeners. */
export function disposeSettingsOwner() {
    const appKey = resolveSettingsAppKey();
    settingsOwnersByApp.get(appKey)?.dispose();
}

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
        if (withdrawal || (pendingIntent?.has(key) ? pendingIntent.get(key) === committed[key] : current[key] === lastSaved?.[key])) {
            Object.assign(adopted, {[key]: committed[key]});
        }
    }
    return adopted;
}

export const useSettings = () => {
    const owner = getSettingsRuntimeOwner();
    const {locale, setLocale} = useTypedI18n();
    const colorMode = useColorMode();
    const localeCookie = useCookie(BROWSER_LOCALE_COOKIE_KEY, PERSISTENT_SETTINGS_COOKIE_OPTIONS);
    const themeCookie = useCookie(BROWSER_THEME_COOKIE_KEY, PERSISTENT_SETTINGS_COOKIE_OPTIONS);
    const hasSettingsCookieSnapshot = useState(
        'settings:has-cookie-snapshot',
        () => localeCookie.value != null || themeCookie.value != null,
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
    const lastSavedSettings = useState<ISettingsData | null>('settings:last-saved', () => null);
    const settingsSaveStatus = useState<TSettingsPersistenceStatus>('settings:save-status', () => 'idle');
    const settingsSaveError = useState<ISettingsSaveError | null>('settings:save-error', () => null);
    const settingsLoadFailure = useState<IPresentedFailureCapture | null>('settings:load-failure', () => null);
    const settingsSaveFailure = useState<IPresentedFailureCapture | null>('settings:save-failure', () => null);

    function refreshSettingsBootstrapCookieSnapshot() {
        hasSettingsCookieSnapshot.value = localeCookie.value != null || themeCookie.value != null;
    }

    const {
        state: settings,
        isResolved: isLoaded,
        error: settingsLoadError,
        load,
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
            lastSavedSettings.value = sanitizeSettings(nextSettings);
            if (owner.pendingIntent.size > 0) {
                settings.value = sanitizeSettings({
                    ...nextSettings,
                    ...Object.fromEntries(owner.pendingIntent),
                });
                setRendererDiagnosticsPreference(settings.value.clientDiagnosticsPreference);
                settingsLoadFailure.value = null;
                owner.debouncedSave.cancel();
                void getSettingsPersistenceQueue().save();
                return;
            }
            setRendererDiagnosticsPreference(nextSettings.clientDiagnosticsPreference);
            settingsLoadFailure.value = null;
        },
        onError(loadError) {
            settingsLoadFailure.value ??= captureSettingsPersistenceFailure('SETTINGS_LOAD_FAILED', loadError, 'Failed to load settings');
        },
    });

    if (typeof window !== 'undefined' && owner.unsubscribeSettingsChanges === null) {
        owner.unsubscribeSettingsChanges = getSettingsCapability().onChanged((committed) => {
            const adopted = selectAdoptedSettings(settings.value, lastSavedSettings.value, committed, owner.pendingIntent);
            for (const key of Object.keys(adopted) as Array<keyof ISettingsData>) {
                owner.pendingIntent.delete(key);
            }
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
            lastSavedSettings.value = sanitizeSettings(committed);
            if (isLoaded.value && owner.pendingIntent.size > 0 && settingsSaveStatus.value !== 'failed') {
                void getSettingsPersistenceQueue().save();
            } else if (settingsSaveStatus.value === 'saving') {
                settingsSaveStatus.value = 'idle';
            }
        });
    }

    async function loadOrThrow() {
        const loadedSettings = await load();
        if (loadedSettings === null) {
            throw new Error(settingsLoadError.value ?? 'Settings could not be loaded.');
        }
        return loadedSettings;
    }

    function getSettingsPersistenceQueue() {
        if (owner.persistenceQueue) {
            return owner.persistenceQueue;
        }

        owner.persistenceQueue = createSettingsPersistenceQueue({
            getSettingsSnapshot: () => toRaw(settings.value),
            getLastSavedSettings: () => lastSavedSettings.value,
            savePatch: (patch) => getSettingsCapability().save(patch),
            onSaved() {
                refreshSettingsBootstrapCookieSnapshot();
                settingsSaveFailure.value = null;
            },
            onSaveError(error) {
                settingsSaveFailure.value ??= captureSettingsPersistenceFailure('SETTINGS_SAVE_FAILED', error, 'Failed to save settings');
            },
            onStatusChanged(status, error) {
                settingsSaveStatus.value = status === 'idle' && owner.pendingIntent.size > 0 ? 'saving' : status;
                settingsSaveError.value = error
                    ? {
                          name: typeof error === 'object' && 'name' in error && typeof error.name === 'string' ? error.name : 'Error',
                          message: getErrorMessage(error),
                      }
                    : null;
            },
        });
        return owner.persistenceQueue;
    }

    async function save() {
        owner.debouncedSave.cancel();
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
        if (owner.flushListener === null && typeof window !== 'undefined') {
            owner.flushListener = () => {
                owner.debouncedSave.flush();
            };
            window.addEventListener('pagehide', owner.flushListener);
        }
        void owner.debouncedSave(() => {
            void save();
        });
    }

    function updateSetting<K extends keyof ISettingsData>(key: K, value: ISettingsData[K]) {
        if (settingsSaveStatus.value !== 'saving' && value === lastSavedSettings.value?.[key]) {
            owner.pendingIntent.delete(key);
        } else {
            owner.pendingIntent.set(key, value);
        }
        Object.assign(settings.value, {[key]: value});
        if (key === 'clientDiagnosticsPreference') {
            setRendererDiagnosticsPreference(value);
        }
        if (settingsSaveStatus.value === 'saving') {
            void getSettingsPersistenceQueue().save();
        } else {
            scheduleDebouncedSave();
        }
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
    import.meta.hot.dispose(disposeAllHotSettingsOwners);
}
