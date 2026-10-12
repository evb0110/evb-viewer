import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { DEFAULT_SETTINGS } from '@contracts/settings';
import {
    BROWSER_SETTINGS_COOKIE_KEY,
    isValidLegacyBrowserSettingsPayload,
    parseBrowserSettingsPayload,
    readBrowserPerformanceModeSnapshot,
    serializeBrowserSettingsPayload,
} from '@app/utils/browserSettingsPersistence';
import { BROWSER_SETTINGS_STORAGE_KEY } from '@app/utils/browserRuntimePersistence';

function expectedLegacySettingsCookieExpiry(secure = false) {
    return `${BROWSER_SETTINGS_COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function stubBrowserPersistence(options: {
    cookieValue?: string;
    protocol?: 'http:' | 'https:';
    storageValue?: string;
    throwOnSet?: boolean;
    localeValue?: string;
    themeValue?: string;
} = {}) {
    const storage = new Map<string, string>();
    if (options.storageValue !== undefined) {
        storage.set(BROWSER_SETTINGS_STORAGE_KEY, options.storageValue);
    }
    const cookieWrites: string[] = [];
    vi.stubGlobal('window', {localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
            if (options.throwOnSet) {
                throw new Error('storage unavailable');
            }
            storage.set(key, value);
        },
    }});
    vi.stubGlobal('location', {protocol: options.protocol ?? 'http:'});
    vi.stubGlobal('document', {
        get cookie() {
            return [
                options.cookieValue === undefined
                    ? null
                    : `${BROWSER_SETTINGS_COOKIE_KEY}=${encodeURIComponent(options.cookieValue)}`,
                options.localeValue === undefined ? null : `i18n_redirected=${options.localeValue}`,
                options.themeValue === undefined ? null : `nuxt-color-mode=${options.themeValue}`,
            ].filter((value): value is string => value !== null).join('; ');
        },
        set cookie(value: string) { cookieWrites.push(value); },
    });
    return {
        cookieWrites,
        storage,
    };
}

describe('browserSettingsPersistence performanceMode', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('round-trips performanceMode through the legacy payload parser', () => {
        const serialized = serializeBrowserSettingsPayload({
            ...DEFAULT_SETTINGS,
            performanceMode: 'high',
        });
        expect(parseBrowserSettingsPayload(serialized).performanceMode).toBe('high');
    });

    it('round-trips the reopen preference through existing settings persistence', () => {
        const serialized = serializeBrowserSettingsPayload({
            ...DEFAULT_SETTINGS,
            rememberDocumentView: true,
        });
        expect(parseBrowserSettingsPayload(serialized).rememberDocumentView).toBe(true);
        expect(parseBrowserSettingsPayload({version: 2}).rememberDocumentView).toBe(false);
    });

    it('keeps client diagnostics out of the legacy settings cookie', () => {
        const serialized = serializeBrowserSettingsPayload({
            ...DEFAULT_SETTINGS,
            clientDiagnosticsPreference: 'granted',
        });

        expect(serialized).not.toContain('clientDiagnosticsPreference');
        expect(parseBrowserSettingsPayload(serialized).clientDiagnosticsPreference).toBe('unknown');
    });

    it('sanitizes an invalid persisted performanceMode back to auto', () => {
        expect(parseBrowserSettingsPayload(JSON.stringify({ performanceMode: 'turbo' })).performanceMode)
            .toBe('auto');
    });

    it('migrates an older payload with fields added after its schema version', () => {
        const olderPayload = JSON.stringify({
            version: 2,
            authorName: 'Older user',
            defaultZoomPreset: '150',
            defaultViewMode: 'facing',
            defaultContinuousScroll: false,
            defaultAnnotationColor: '#123456',
            optimizePdfOnSaveAs: true,
        });

        expect(isValidLegacyBrowserSettingsPayload(olderPayload)).toBe(true);
        expect(parseBrowserSettingsPayload(olderPayload)).toMatchObject({
            authorName: 'Older user',
            defaultZoomPreset: '150',
            defaultViewMode: 'facing',
            defaultContinuousScroll: false,
            defaultAnnotationColor: '#123456',
            optimizePdfOnSaveAs: true,
            performanceMode: 'auto',
            uiScale: 'auto',
            tabMemoryPolicy: 'conservative',
        });
    });

    it('preserves committed storage over a stale legacy cookie', () => {
        const browser = stubBrowserPersistence({
            cookieValue: serializeBrowserSettingsPayload({
                ...DEFAULT_SETTINGS,
                performanceMode: 'low',
            }),
            storageValue: JSON.stringify({
                ...DEFAULT_SETTINGS,
                performanceMode: 'medium',
            }),
        });

        expect(readBrowserPerformanceModeSnapshot()).toBe('medium');
        expect(JSON.parse(browser.storage.get(BROWSER_SETTINGS_STORAGE_KEY) ?? 'null'))
            .toMatchObject({performanceMode: 'medium'});
        expect(browser.cookieWrites).toEqual([expectedLegacySettingsCookieExpiry()]);
    });

    it('does not replace a future storage schema with a legacy cookie', () => {
        const futureSettings = JSON.stringify({
            version: DEFAULT_SETTINGS.version + 1,
            futureSetting: true,
        });
        const browser = stubBrowserPersistence({
            cookieValue: serializeBrowserSettingsPayload(DEFAULT_SETTINGS),
            storageValue: futureSettings,
        });

        expect(() => readBrowserPerformanceModeSnapshot()).toThrow('newer than the supported version');
        expect(browser.storage.get(BROWSER_SETTINGS_STORAGE_KEY)).toBe(futureSettings);
        expect(browser.cookieWrites).toEqual([]);
    });

    it('does not treat valid JSON with the wrong storage shape as canonical', () => {
        stubBrowserPersistence({storageValue: JSON.stringify({})});

        expect(readBrowserPerformanceModeSnapshot()).toBe('auto');
    });

    it('falls back from wrong-shaped storage to a valid legacy cookie', () => {
        const browser = stubBrowserPersistence({
            cookieValue: serializeBrowserSettingsPayload({
                ...DEFAULT_SETTINGS,
                performanceMode: 'high',
            }),
            storageValue: JSON.stringify({}),
        });

        expect(readBrowserPerformanceModeSnapshot()).toBe('high');
        expect(JSON.parse(browser.storage.get(BROWSER_SETTINGS_STORAGE_KEY) ?? 'null'))
            .toMatchObject({performanceMode: 'high'});
        expect(browser.cookieWrites).toEqual([expectedLegacySettingsCookieExpiry()]);
    });

    it('migrates a legacy full-settings cookie to local storage and expires it', () => {
        const browser = stubBrowserPersistence({cookieValue: serializeBrowserSettingsPayload({
            ...DEFAULT_SETTINGS,
            performanceMode: 'medium',
        })});

        expect(readBrowserPerformanceModeSnapshot()).toBe('medium');
        expect(JSON.parse(browser.storage.get(BROWSER_SETTINGS_STORAGE_KEY) ?? 'null'))
            .toMatchObject({performanceMode: 'medium'});
        expect(browser.cookieWrites).toEqual([expectedLegacySettingsCookieExpiry()]);
    });

    it('merges locale and theme cookies before the early performance migration commits', () => {
        const browser = stubBrowserPersistence({
            cookieValue: serializeBrowserSettingsPayload(DEFAULT_SETTINGS),
            localeValue: 'ru',
            themeValue: 'dark',
        });

        expect(readBrowserPerformanceModeSnapshot()).toBe('auto');
        expect(JSON.parse(browser.storage.get(BROWSER_SETTINGS_STORAGE_KEY) ?? 'null'))
            .toMatchObject({
                locale: 'ru',
                theme: 'dark',
            });
        expect(browser.cookieWrites).toEqual([expectedLegacySettingsCookieExpiry()]);
    });

    it('adds Secure to legacy cookie expiry only over HTTPS', () => {
        const browser = stubBrowserPersistence({
            cookieValue: serializeBrowserSettingsPayload(DEFAULT_SETTINGS),
            protocol: 'https:',
        });

        expect(readBrowserPerformanceModeSnapshot()).toBe('auto');
        expect(browser.cookieWrites).toEqual([expectedLegacySettingsCookieExpiry(true)]);
    });

    it('retains the request cookie when local storage migration fails', () => {
        const browser = stubBrowserPersistence({
            cookieValue: serializeBrowserSettingsPayload({
                ...DEFAULT_SETTINGS,
                performanceMode: 'low',
            }),
            throwOnSet: true,
        });

        expect(readBrowserPerformanceModeSnapshot()).toBe('low');
        expect(browser.cookieWrites).toEqual([]);
    });

    it('returns auto when no local or legacy snapshot exists', () => {
        stubBrowserPersistence();
        expect(readBrowserPerformanceModeSnapshot()).toBe('auto');
    });

    it('returns auto when browser globals are unavailable', () => {
        vi.stubGlobal('window', undefined);
        vi.stubGlobal('document', undefined);
        expect(readBrowserPerformanceModeSnapshot()).toBe('auto');
    });
});
