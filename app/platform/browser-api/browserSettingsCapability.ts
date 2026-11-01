import type {
    IDebugLogEntry,
    IRendererLogEntry,
    TDebugLogLevel,
    TRendererLogLevel,
} from '@contracts/electronApiCommon';
import type {
    ISettingsCapability,
    SETTINGS_PLATFORM_FEATURE,
} from '@contracts/settingsPlatformFeature';
import type { TFeatureBrowserBindings } from '@contracts/platformFeature';
import {
    DEFAULT_SETTINGS,
    migrateSettings,
    normalizeLocale,
    normalizeTheme,
    sanitizeSettings,
    type ISettingsRecoveryNotice,
    type TSettingsRecoveryReason,
} from '@contracts/settings';
import {
    formatLogData,
    toLogData,
} from '@contracts/logRecord';
import { redactLogText } from '@contracts/redactLogText';
import {
    parseClientDiagnosticsPreference,
    type TClientDiagnosticsPreference,
} from '@contracts/diagnostics/diagnosticsPreference';
import type { ISettingsData } from '@contracts/shared';
import {
    readLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/localStorage';
import {
    BROWSER_LOCALE_COOKIE_KEY,
    BROWSER_SETTINGS_COOKIE_KEY,
    BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS,
    BROWSER_THEME_COOKIE_KEY,
    expireLegacyBrowserSettingsCookie,
    assertSupportedBrowserSettingsPayload,
    isValidLegacyBrowserSettingsPayload,
    parseBrowserSettingsPayload,
    parseBrowserSettingsStoragePayload,
} from '@app/utils/browserSettingsPersistence';
import { safeDecodeURIComponent } from '@app/utils/browserSafe';
import { SETTINGS_STORAGE_KEY } from '@app/platform/browser-api/browserApiStorageKeys';
import { DOCUMENTS_STORE } from '@app/platform/browser/browserDocumentConstants';
import { runObjectStoreTransaction } from '@app/platform/browser/browserDocumentIdb';
import { setRendererDiagnosticsPreference } from '@app/utils/failureReporter';
import {
    BrowserLogger,
    setBrowserLogSink,
} from '@app/utils/browserLogger';

let settingsState: ISettingsData = { ...DEFAULT_SETTINGS };
let browserSettingsLoaded = false;
let diagnosticsPreferenceOverride: TClientDiagnosticsPreference | null = null;
let diagnosticsPreferenceRevision = 0;
const settingsListeners = new Set<(settings: ISettingsData) => void>();
let settingsRecoveryNotice: ISettingsRecoveryNotice | null = null;

// The same bound and entry shape as desktop's preload buffer (electron/preload/debugLogBuffer.ts).
const MAX_DEBUG_LOG_ENTRIES = 2000;
const MAX_DEBUG_LOG_DATA_CHARS = 2_000;
const DEBUG_LOG_LEVELS = {
    debug: 'DEBUG',
    info: 'INFO',
    warn: 'WARN',
    error: 'ERROR',
} as const satisfies Record<TRendererLogLevel, TDebugLogLevel>;
const debugLogEntries: IDebugLogEntry[] = [];
const debugLogListeners = new Set<(entry: IDebugLogEntry) => void>();

interface IBrowserSettingsReadResult {
    settings: ISettingsData;
    persisted: boolean;
}

interface IBrowserSettingsReadOptions {
    allowUnavailable?: boolean;
    /** Record a reset for the startup notice, as desktop does when it loads settings. */
    recordRecovery?: boolean;
}

const BROWSER_SETTINGS_STORAGE_LOCK_KEY = '__evb_browser_settings_storage_lock__';

function writeBrowserSettingsToStorage(nextSettings: ISettingsData) {
    if (!safeSetLocalStorageItem(SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings))) {
        throw new Error('Failed to persist browser settings to localStorage');
    }
}

function readBrowserSettingsCookies() {
    if (typeof document === 'undefined') {
        return null;
    }

    const getCookieValue = (key: string) => document.cookie.match(
        new RegExp(`(?:^|; )${key}=([^;]*)`, 'u'),
    )?.[1] ?? null;
    const rawSettingsCookie = getCookieValue(BROWSER_SETTINGS_COOKIE_KEY);
    const localeCookie = getCookieValue(BROWSER_LOCALE_COOKIE_KEY);
    const themeCookie = getCookieValue(BROWSER_THEME_COOKIE_KEY);
    if (rawSettingsCookie === null && localeCookie === null && themeCookie === null) {
        return null;
    }

    const fallbackSettings: Partial<ISettingsData> = {};
    if (localeCookie) {
        fallbackSettings.locale = normalizeLocale(safeDecodeURIComponent(localeCookie));
    }
    if (themeCookie) {
        fallbackSettings.theme = normalizeTheme(safeDecodeURIComponent(themeCookie));
    }

    return {
        fallbackSettings,
        rawSettings: rawSettingsCookie === null
            ? null
            : safeDecodeURIComponent(rawSettingsCookie),
    };
}

function recordSettingsRecovery(reason: TSettingsRecoveryReason) {
    BrowserLogger.warn('settings', 'Stored settings could not be used; defaults were restored', {reason});
    settingsRecoveryNotice ??= {reason};
}

function readBrowserSettingsFromStorage(options: IBrowserSettingsReadOptions = {}) {
    const result = readLocalStorageItem(SETTINGS_STORAGE_KEY);
    if (result.status === 'unavailable') {
        if (options.allowUnavailable) {
            if (options.recordRecovery) {
                // Storage may come back on the next load, so nothing is overwritten.
                recordSettingsRecovery('unreadable');
            }
            return null;
        }
        throw result.error;
    }
    if (result.status === 'absent') {
        return null;
    }

    const rawSettings = result.value;
    assertSupportedBrowserSettingsPayload(rawSettings);
    const settings = parseBrowserSettingsStoragePayload(rawSettings);
    if (settings === null && options.recordRecovery) {
        // Replace the unusable value so the reset is reported once, as desktop
        // replaces a corrupt settings file with defaults.
        safeSetLocalStorageItem(SETTINGS_STORAGE_KEY, JSON.stringify(DEFAULT_SETTINGS));
        recordSettingsRecovery('corrupt');
    }
    return settings;
}

function readLatestBrowserSettingsForSave() {
    const persistedSettings = readBrowserSettingsFromStorage();
    if (persistedSettings) {
        return applyDiagnosticsPreferenceOverride(persistedSettings);
    }

    if (browserSettingsLoaded) {
        return applyDiagnosticsPreferenceOverride(settingsState);
    }

    return applyDiagnosticsPreferenceOverride(
        readAndMigrateBrowserSettings()?.settings
            ?? { ...DEFAULT_SETTINGS },
    );
}

function applyDiagnosticsPreferenceOverride(settings: ISettingsData) {
    return diagnosticsPreferenceOverride === null
        ? settings
        : {
            ...settings,
            clientDiagnosticsPreference: diagnosticsPreferenceOverride,
        };
}

function writeBrowserSettingsBootstrapCookies(
    nextSettings: ISettingsData,
    options: {expireLegacySettingsCookie?: boolean} = {},
) {
    if (typeof document === 'undefined') {
        return;
    }

    if (options.expireLegacySettingsCookie !== false) {
        expireLegacyBrowserSettingsCookie();
    }
    const secureAttribute = typeof location !== 'undefined' && location.protocol === 'https:'
        ? '; Secure'
        : '';
    document.cookie = `${BROWSER_LOCALE_COOKIE_KEY}=${encodeURIComponent(nextSettings.locale)}; Path=/; Max-Age=${BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secureAttribute}`;
    document.cookie = `${BROWSER_THEME_COOKIE_KEY}=${encodeURIComponent(nextSettings.theme)}; Path=/; Max-Age=${BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secureAttribute}`;
}

async function runSerializedBrowserSettingsSave(settings: Partial<ISettingsData>) {
    const transactionResult = await runObjectStoreTransaction<
        {saved: true} | {error: unknown}
    >(
        DOCUMENTS_STORE,
        'readwrite',
        (store, setResult) => {
            const lockRead = store.get(BROWSER_SETTINGS_STORAGE_LOCK_KEY);
            lockRead.onsuccess = () => {
                try {
                    const currentSettings = readLatestBrowserSettingsForSave();
                    const nextSettings = migrateSettings({
                        ...currentSettings,
                        ...settings,
                    });
                    writeBrowserSettingsToStorage(nextSettings);
                    writeBrowserSettingsBootstrapCookies(nextSettings);
                    settingsState = nextSettings;
                    browserSettingsLoaded = true;
                    setResult({saved: true});
                } catch (error) {
                    setResult({error});
                }
            };
        },
    );
    if (transactionResult) {
        if ('error' in transactionResult) {
            throw transactionResult.error;
        }
        return;
    }

    // IndexedDB is the cross-page serialization boundary. Do not report a
    // successful localStorage mutation when that boundary cannot be acquired.
    if (typeof indexedDB !== 'undefined') {
        throw new Error('Failed to serialize browser settings persistence');
    }

    const currentSettings = readLatestBrowserSettingsForSave();
    const nextSettings = migrateSettings({
        ...currentSettings,
        ...settings,
    });
    writeBrowserSettingsToStorage(nextSettings);
    writeBrowserSettingsBootstrapCookies(nextSettings);
    settingsState = nextSettings;
    browserSettingsLoaded = true;
}

function readAndMigrateBrowserSettings(options: IBrowserSettingsReadOptions = {}): IBrowserSettingsReadResult | null {
    const persistedSettings = readBrowserSettingsFromStorage(options);
    const cookieSnapshot = readBrowserSettingsCookies();
    if (cookieSnapshot && cookieSnapshot.rawSettings !== null) {
        assertSupportedBrowserSettingsPayload(cookieSnapshot.rawSettings);
        const isValidLegacyCookie = isValidLegacyBrowserSettingsPayload(cookieSnapshot.rawSettings);
        if (isValidLegacyCookie) {
            if (persistedSettings) {
                expireLegacyBrowserSettingsCookie();
                return {
                    persisted: true,
                    settings: persistedSettings,
                };
            }
            const legacySettings = parseBrowserSettingsPayload(
                cookieSnapshot.rawSettings,
                cookieSnapshot.fallbackSettings,
            );
            let persisted = false;
            try {
                writeBrowserSettingsToStorage(legacySettings);
                expireLegacyBrowserSettingsCookie();
                persisted = true;
            } catch (error) {
                if (!options.allowUnavailable) {
                    throw error;
                }
            }
            return {
                persisted,
                settings: legacySettings,
            };
        }
        expireLegacyBrowserSettingsCookie();
    }

    if (persistedSettings) {
        return {
            persisted: true,
            settings: persistedSettings,
        };
    }

    if (cookieSnapshot) {
        const bootstrapSettings = parseBrowserSettingsPayload(
            null,
            cookieSnapshot.fallbackSettings,
        );
        let persisted = false;
        try {
            writeBrowserSettingsToStorage(bootstrapSettings);
            persisted = true;
        } catch (error) {
            if (!options.allowUnavailable) {
                throw error;
            }
        }
        return {
            persisted,
            settings: bootstrapSettings,
        };
    }
    return null;
}

function refreshSharedSettings() {
    const previousPreference = settingsState.clientDiagnosticsPreference;
    try {
        settingsState = applyDiagnosticsPreferenceOverride(
            readBrowserSettingsFromStorage({allowUnavailable: true}) ?? { ...DEFAULT_SETTINGS },
        );
    } catch {
        // A cleared, unreadable or unsupported shared preference grants nothing.
        settingsState = applyDiagnosticsPreferenceOverride({ ...DEFAULT_SETTINGS });
    }
    browserSettingsLoaded = true;
    if (settingsState.clientDiagnosticsPreference !== previousPreference) {
        diagnosticsPreferenceRevision += 1;
    }
    setRendererDiagnosticsPreference(settingsState.clientDiagnosticsPreference);
    notifySettingsListeners();
}

// Listeners see every commit: one from another page through a storage event, and this
// page's own through save, before save resolves. A withdrawal still in flight stays applied.
function notifySettingsListeners() {
    for (const listener of settingsListeners) {
        listener(sanitizeSettings(applyDiagnosticsPreferenceOverride(settingsState)));
    }
}

function onSharedStorageChange(event: StorageEvent) {
    if (event.storageArea === window.localStorage && (event.key === SETTINGS_STORAGE_KEY || event.key === null)) {
        // Read the current value, since an older notification may already be queued.
        refreshSharedSettings();
    }
}

function onSharedSettingsResume() {
    if (browserSettingsLoaded && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
        refreshSharedSettings();
    }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', onSharedStorageChange);
    window.addEventListener('pageshow', onSharedSettingsResume);
    window.addEventListener('visibilitychange', onSharedSettingsResume);
    import.meta.hot?.dispose(() => {
        window.removeEventListener('storage', onSharedStorageChange);
        window.removeEventListener('pageshow', onSharedSettingsResume);
        window.removeEventListener('visibilitychange', onSharedSettingsResume);
        settingsListeners.clear();
    });
}

// The browser has no main process, so its renderer records are the log. They get
// desktop's broadcast text and redaction; they stay in this page until the user copies them.
function toDebugLogEntry(entry: IRendererLogEntry): IDebugLogEntry {
    const level = DEBUG_LOG_LEVELS[entry.level];
    const dataText = formatLogData(toLogData(entry.data), MAX_DEBUG_LOG_DATA_CHARS);
    const base = {
        source: entry.section,
        message: redactLogText(`[${level}] ${entry.message}${dataText ? ` ${dataText}` : ''}`),
        timestamp: entry.timestamp,
    };
    if (level !== 'ERROR') {
        return {
            ...base,
            level,
        };
    }
    // BrowserLogger.error always carries a receipt; an error without one cannot be an ERROR entry.
    return entry.failureRef
        ? {
            ...base,
            level,
            failureRef: {
                eventId: entry.failureRef.eventId,
                code: entry.failureRef.code,
                severity: entry.failureRef.severity,
            },
        }
        : {
            ...base,
            level: 'WARN',
        };
}

export const browserSettingsCapability: ISettingsCapability = {
    onChanged(callback) {
        settingsListeners.add(callback);
        return () => settingsListeners.delete(callback);
    },
    get() {
        return Promise.resolve().then(() => {
            if (!browserSettingsLoaded) {
                const migration = readAndMigrateBrowserSettings({
                    allowUnavailable: true,
                    recordRecovery: true,
                });
                settingsState = migration?.settings ?? { ...DEFAULT_SETTINGS };
                settingsState = applyDiagnosticsPreferenceOverride(settingsState);
                writeBrowserSettingsBootstrapCookies(settingsState, {expireLegacySettingsCookie: migration?.persisted !== false});
                browserSettingsLoaded = true;
            }
            return sanitizeSettings(settingsState);
        });
    },
    getRecoveryNotice() {
        const notice = settingsRecoveryNotice;
        settingsRecoveryNotice = null;
        return Promise.resolve(notice);
    },
    save(settings) {
        const hasDiagnosticsPreference = Object.hasOwn(settings, 'clientDiagnosticsPreference');
        const previousDiagnosticsPreference = diagnosticsPreferenceOverride
            ?? settingsState.clientDiagnosticsPreference;
        const nextDiagnosticsPreference = hasDiagnosticsPreference
            ? parseClientDiagnosticsPreference(settings.clientDiagnosticsPreference)
            : null;
        const diagnosticsSaveRevision = nextDiagnosticsPreference === null
            ? null
            : diagnosticsPreferenceRevision + 1;
        if (diagnosticsSaveRevision !== null) {
            diagnosticsPreferenceRevision = diagnosticsSaveRevision;
        }
        if (nextDiagnosticsPreference !== null) {
            // Browser persistence is promise-based. Change the live gate before
            // that promise can resolve so revocation cannot wait on storage.
            setRendererDiagnosticsPreference(nextDiagnosticsPreference);
            if (nextDiagnosticsPreference !== 'granted') {
                diagnosticsPreferenceOverride = nextDiagnosticsPreference;
            }
        }

        return Promise.resolve().then(() => {
            return runSerializedBrowserSettingsSave(settings);
        }).then(() => {
            if (
                diagnosticsSaveRevision === null
                || diagnosticsSaveRevision === diagnosticsPreferenceRevision
            ) {
                diagnosticsPreferenceOverride = null;
            }
            if (
                diagnosticsSaveRevision === diagnosticsPreferenceRevision
                && nextDiagnosticsPreference === 'granted'
            ) {
                setRendererDiagnosticsPreference(nextDiagnosticsPreference);
            }
            notifySettingsListeners();
        }).catch((error: unknown) => {
            if (
                nextDiagnosticsPreference === 'granted'
                && diagnosticsSaveRevision === diagnosticsPreferenceRevision
            ) {
                // A failed grant must not leave the in-memory reporter open.
                setRendererDiagnosticsPreference(previousDiagnosticsPreference);
            }
            throw error;
        });
    },
    getDebugLogs(): Promise<IDebugLogEntry[]> {
        return Promise.resolve([...debugLogEntries]);
    },
    onDebugLog(callback) {
        debugLogListeners.add(callback);
        return () => debugLogListeners.delete(callback);
    },
    rendererLog(entry: IRendererLogEntry) {
        const debugLogEntry = toDebugLogEntry(entry);
        if (debugLogEntries.push(debugLogEntry) > MAX_DEBUG_LOG_ENTRIES) {
            debugLogEntries.shift();
        }
        for (const listener of debugLogListeners) {
            listener(debugLogEntry);
        }
    },
};

browserSettingsCapability satisfies TFeatureBrowserBindings<typeof SETTINGS_PLATFORM_FEATURE>;

setBrowserLogSink(entry => browserSettingsCapability.rendererLog(entry));
