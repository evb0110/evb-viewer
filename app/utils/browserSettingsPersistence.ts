import { omit } from 'es-toolkit/object';
import {
    assertSupportedSettingsSchema,
    DEFAULT_SETTINGS,
    sanitizeSettings,
    UnsupportedSettingsSchemaError,
} from '@contracts/settings';
import { isRecord } from '@contracts/runtimeGuards';
import type {
    ISettingsData,
    TAppLocale,
    TAppTheme,
} from '@contracts/shared';
import type { TPerformanceMode } from '@contracts/hostResourceProfile';
import { LOCALE_CODES } from '@i18n-core';
import { safeDecodeURIComponent } from '@app/utils/browserSafe';
import {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/localStorage';
import { BROWSER_SETTINGS_STORAGE_KEY } from '@app/utils/browserRuntimePersistence';

export const BROWSER_SETTINGS_COOKIE_KEY = 'evb_viewer_settings';
export const BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;
export const BROWSER_THEME_COOKIE_KEY = 'nuxt-color-mode';
export const BROWSER_LOCALE_COOKIE_KEY = 'i18n_redirected';

type TBrowserSettingsCookiePayload = Omit<ISettingsData, 'agentMcpEnabled' | 'clientDiagnosticsPreference' | 'theme' | 'locale'>;
const SUPPORTED_LOCALES: ReadonlySet<string> = new Set<TAppLocale>(LOCALE_CODES);

function parseRawBrowserSettingsPayload(raw: unknown): Record<PropertyKey, unknown> | null {
    if (!raw) {
        return null;
    }

    if (isRecord(raw)) {
        return raw;
    }

    if (typeof raw !== 'string') {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(raw);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function hasExpectedSettingsShape(
    value: Record<PropertyKey, unknown> | null,
    requireBrowserOnlyFields: boolean,
) {
    if (!value
        || typeof value.version !== 'number'
        || !Number.isInteger(value.version)
        || value.version < 1
        || value.version > DEFAULT_SETTINGS.version
        || typeof value.authorName !== 'string'
        || typeof value.defaultZoomPreset !== 'string'
        || typeof value.defaultViewMode !== 'string'
        || typeof value.defaultContinuousScroll !== 'boolean'
        || typeof value.defaultAnnotationColor !== 'string') {
        return false;
    }

    const optionalBooleanFields = [
        'optimizePdfOnSaveAs',
        'assistantPanelEnabled',
        'agentMcpEnabled',
        'suppressDefaultViewerPrompt',
    ];
    if (optionalBooleanFields.some(key => Object.hasOwn(value, key) && typeof value[key] !== 'boolean')) {
        return false;
    }
    const optionalStringFields = [
        'uiScale',
        'tabMemoryPolicy',
        'performanceMode',
        'skippedUpdateVersion',
    ];
    if (optionalStringFields.some(key => Object.hasOwn(value, key) && typeof value[key] !== 'string')) {
        return false;
    }

    return !requireBrowserOnlyFields || (
        isAppLocale(value.locale)
        && isAppTheme(value.theme)
        && (!Object.hasOwn(value, 'agentMcpEnabled') || typeof value.agentMcpEnabled === 'boolean')
    );
}

export function isValidLegacyBrowserSettingsPayload(raw: unknown) {
    return hasExpectedSettingsShape(parseRawBrowserSettingsPayload(raw), false);
}

export function isValidBrowserSettingsStoragePayload(raw: unknown) {
    return hasExpectedSettingsShape(parseRawBrowserSettingsPayload(raw), true);
}

export function assertSupportedBrowserSettingsPayload(raw: unknown) {
    assertSupportedSettingsSchema(parseRawBrowserSettingsPayload(raw));
}

export function isFutureBrowserSettingsPayload(raw: unknown) {
    try {
        assertSupportedBrowserSettingsPayload(raw);
        return false;
    } catch (error) {
        if (error instanceof UnsupportedSettingsSchemaError) {
            return true;
        }
        return false;
    }
}

function isAppLocale(value: unknown): value is TAppLocale {
    return typeof value === 'string' && SUPPORTED_LOCALES.has(value);
}

function isAppTheme(value: unknown): value is TAppTheme {
    return value === 'light' || value === 'dark';
}

function omitCookieBackedSettingsFields<T extends Record<PropertyKey, unknown> | null>(
    settings: T,
) : Omit<NonNullable<T>, 'clientDiagnosticsPreference' | 'theme' | 'locale'> | null {
    if (!settings) {
        return null;
    }

    return omit(settings, [
        'theme',
        'locale',
        'clientDiagnosticsPreference',
    ]);
}

function parseStoredBrowserSettingsSnapshot(raw: string | null) {
    if (raw === null || !isValidBrowserSettingsStoragePayload(raw)) {
        return null;
    }

    const parsed = parseRawBrowserSettingsPayload(raw);
    return parsed ? sanitizeSettings(parsed) : null;
}

export function parseBrowserSettingsPayload(
    raw: unknown,
    fallback: Partial<ISettingsData> | null = null,
) {
    const rawSettings = parseRawBrowserSettingsPayload(raw);
    assertSupportedSettingsSchema(rawSettings);
    const parsed = omitCookieBackedSettingsFields(rawSettings);
    const normalizedFallback = fallback ? { ...fallback } : null;
    if (normalizedFallback && !isAppLocale(normalizedFallback.locale)) {
        delete normalizedFallback.locale;
    }
    if (normalizedFallback && !isAppTheme(normalizedFallback.theme)) {
        delete normalizedFallback.theme;
    }
    return sanitizeSettings({
        ...parsed,
        ...normalizedFallback,
    });
}

export function serializeBrowserSettingsPayload(settings: ISettingsData) {
    const sanitized = sanitizeSettings(settings);
    const payload: TBrowserSettingsCookiePayload = {
        version: sanitized.version,
        authorName: sanitized.authorName,
        defaultZoomPreset: sanitized.defaultZoomPreset,
        defaultViewMode: sanitized.defaultViewMode,
        defaultContinuousScroll: sanitized.defaultContinuousScroll,
        defaultAnnotationColor: sanitized.defaultAnnotationColor,
        uiScale: sanitized.uiScale,
        tabMemoryPolicy: sanitized.tabMemoryPolicy,
        performanceMode: sanitized.performanceMode,
        optimizePdfOnSaveAs: sanitized.optimizePdfOnSaveAs,
        assistantPanelEnabled: sanitized.assistantPanelEnabled,
    };
    if (sanitized.suppressDefaultViewerPrompt !== undefined) {
        payload.suppressDefaultViewerPrompt = sanitized.suppressDefaultViewerPrompt;
    }
    if (sanitized.suppressUnencryptedSaveNotice !== undefined) {
        payload.suppressUnencryptedSaveNotice = sanitized.suppressUnencryptedSaveNotice;
    }
    if (sanitized.skippedUpdateVersion !== undefined) {
        payload.skippedUpdateVersion = sanitized.skippedUpdateVersion;
    }
    return JSON.stringify(payload);
}

export function expireLegacyBrowserSettingsCookie() {
    if (typeof document === 'undefined') {
        return;
    }
    const secureAttribute = typeof location !== 'undefined' && location.protocol === 'https:'
        ? '; Secure'
        : '';
    document.cookie = `${BROWSER_SETTINGS_COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax${secureAttribute}`;
}

function readBrowserSettingsCookies() {
    if (typeof document === 'undefined') {
        return null;
    }

    let rawSettings: string | null = null;
    let locale: TAppLocale | undefined;
    let theme: TAppTheme | undefined;
    for (const cookie of document.cookie.split(';')) {
        const separatorIndex = cookie.indexOf('=');
        if (separatorIndex === -1) {
            continue;
        }

        const name = cookie.slice(0, separatorIndex).trim();
        const value = safeDecodeURIComponent(cookie.slice(separatorIndex + 1).trim());
        if (name === BROWSER_SETTINGS_COOKIE_KEY) {
            rawSettings = value;
        } else if (name === BROWSER_LOCALE_COOKIE_KEY && isAppLocale(value)) {
            locale = value;
        } else if (name === BROWSER_THEME_COOKIE_KEY && isAppTheme(value)) {
            theme = value;
        }
    }

    if (rawSettings === null && locale === undefined && theme === undefined) {
        return null;
    }

    return {
        rawSettings,
        fallbackSettings: {
            ...(locale === undefined ? {} : {locale}),
            ...(theme === undefined ? {} : {theme}),
        } satisfies Partial<ISettingsData>,
    };
}

export function readBrowserPerformanceModeSnapshot(): TPerformanceMode {
    const storageSnapshot = safeGetLocalStorageItem(BROWSER_SETTINGS_STORAGE_KEY);
    if (storageSnapshot !== null && isFutureBrowserSettingsPayload(storageSnapshot)) {
        assertSupportedBrowserSettingsPayload(storageSnapshot);
    }
    const existingStorageSettings = parseStoredBrowserSettingsSnapshot(storageSnapshot);
    const cookieSnapshot = readBrowserSettingsCookies();
    const legacyCookie = cookieSnapshot?.rawSettings ?? null;
    if (legacyCookie !== null) {
        const isValidLegacyCookie = isValidLegacyBrowserSettingsPayload(legacyCookie);
        if (isValidLegacyCookie) {
            const cookieSettings = parseBrowserSettingsPayload(
                legacyCookie,
                cookieSnapshot?.fallbackSettings,
            );
            const migratedSettings = existingStorageSettings
                ? sanitizeSettings({
                    ...cookieSettings,
                    ...existingStorageSettings,
                    ...cookieSnapshot?.fallbackSettings,
                })
                : cookieSettings;
            const committed = safeSetLocalStorageItem(
                BROWSER_SETTINGS_STORAGE_KEY,
                JSON.stringify(migratedSettings),
            );
            if (committed) {
                expireLegacyBrowserSettingsCookie();
            }
            return migratedSettings.performanceMode;
        }
        if (!isFutureBrowserSettingsPayload(legacyCookie)) {
            expireLegacyBrowserSettingsCookie();
        }
    } else if (cookieSnapshot) {
        // Locale and theme cookies are only a partial migration. Start with
        // the committed settings snapshot so an early performance-mode read
        // cannot erase settings saved by the main settings capability.
        const migratedSettings = sanitizeSettings({
            ...existingStorageSettings,
            ...cookieSnapshot.fallbackSettings,
        });
        const committed = safeSetLocalStorageItem(
            BROWSER_SETTINGS_STORAGE_KEY,
            JSON.stringify(migratedSettings),
        );
        if (committed) {
            expireLegacyBrowserSettingsCookie();
        }
        return migratedSettings.performanceMode;
    }

    assertSupportedBrowserSettingsPayload(storageSnapshot);
    if (isValidBrowserSettingsStoragePayload(storageSnapshot)) {
        return parseBrowserSettingsPayload(storageSnapshot).performanceMode;
    }
    return 'auto';
}
