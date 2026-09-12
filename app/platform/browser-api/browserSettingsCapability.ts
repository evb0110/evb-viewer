import type {
    IDebugLogEntry,
    IRendererLogEntry,
} from '@contracts/electronApiCommon';
import type {
    ISettingsCapability,
    SETTINGS_PLATFORM_FEATURE,
} from '@contracts/settingsPlatformFeature';
import type { TFeatureBrowserBindings } from '@contracts/platformFeature';
import {
    DEFAULT_SETTINGS,
    normalizeLocale,
    normalizeTheme,
    sanitizeSettings,
} from '@contracts/settings';
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
    isValidBrowserSettingsStoragePayload,
    isValidLegacyBrowserSettingsPayload,
    parseBrowserSettingsPayload,
} from '@app/utils/browserSettingsPersistence';
import { safeDecodeURIComponent } from '@app/utils/browserSafe';
import { SETTINGS_STORAGE_KEY } from '@app/platform/browser-api/browserApiStorageKeys';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';
import { DOCUMENTS_STORE } from '@app/platform/browser/browserDocumentConstants';
import { runObjectStoreTransaction } from '@app/platform/browser/browserDocumentIdb';
import { setRendererDiagnosticsPreference } from '@app/utils/failureReporter';

let settingsState: ISettingsData = { ...DEFAULT_SETTINGS };
let browserSettingsLoaded = false;
let diagnosticsPreferenceOverride: TClientDiagnosticsPreference | null = null;
let diagnosticsPreferenceRevision = 0;

interface IBrowserSettingsReadResult {
    settings: ISettingsData;
    persisted: boolean;
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

function readBrowserSettingsFromStorage(options: { allowUnavailable?: boolean } = {}) {
    const result = readLocalStorageItem(SETTINGS_STORAGE_KEY);
    if (result.status === 'unavailable') {
        if (options.allowUnavailable) {
            return null;
        }
        throw result.error;
    }
    if (result.status === 'absent') {
        return null;
    }

    const rawSettings = result.value;
    assertSupportedBrowserSettingsPayload(rawSettings);
    if (!isValidBrowserSettingsStoragePayload(rawSettings)) {
        return null;
    }
    return sanitizeSettings(JSON.parse(rawSettings));
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
                    const nextSettings = sanitizeSettings({
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
    const nextSettings = sanitizeSettings({
        ...currentSettings,
        ...settings,
    });
    writeBrowserSettingsToStorage(nextSettings);
    writeBrowserSettingsBootstrapCookies(nextSettings);
    settingsState = nextSettings;
    browserSettingsLoaded = true;
}

function readAndMigrateBrowserSettings(options: { allowUnavailable?: boolean } = {}): IBrowserSettingsReadResult | null {
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

export const browserSettingsCapability: ISettingsCapability = {
    get() {
        return Promise.resolve().then(() => {
            if (!browserSettingsLoaded) {
                const migration = readAndMigrateBrowserSettings({allowUnavailable: true});
                settingsState = migration?.settings ?? { ...DEFAULT_SETTINGS };
                settingsState = applyDiagnosticsPreferenceOverride(settingsState);
                writeBrowserSettingsBootstrapCookies(settingsState, {expireLegacySettingsCookie: migration?.persisted !== false});
                browserSettingsLoaded = true;
            }
            return sanitizeSettings(settingsState);
        });
    },
    getRecoveryNotice() {
        return Promise.resolve(null);
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
        return Promise.resolve([]);
    },
    onDebugLog: noopUnsubscribe,
    rendererLog(_entry: IRendererLogEntry) {},
};

browserSettingsCapability satisfies TFeatureBrowserBindings<typeof SETTINGS_PLATFORM_FEATURE>;
