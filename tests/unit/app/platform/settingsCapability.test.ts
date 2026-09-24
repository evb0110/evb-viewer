import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { MemoryStorage } from '@tests/unit/app/platform/browserPlatformTestDoubles';
import { SETTINGS_STORAGE_KEY } from '@app/platform/browser-api/browserApiStorageKeys';

describe('browserSettingsCapability', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    it('preserves cookie-backed locale and theme when saving before get', async () => {
        const cookies = new Map<string, string>();
        const cookieWrites: string[] = [];
        const localStorage = new MemoryStorage();
        vi.stubGlobal('window', { localStorage });
        vi.stubGlobal('location', {protocol: 'https:'});
        vi.stubGlobal('document', {
            get cookie() {
                return Array.from(cookies.entries())
                    .map(([
                        key,
                        value,
                    ]) => `${key}=${value}`)
                    .join('; ');
            },
            set cookie(value: string) {
                cookieWrites.push(value);
                const [pair] = value.split(';');
                const separatorIndex = pair?.indexOf('=') ?? -1;
                if (!pair || separatorIndex < 0) {
                    return;
                }
                const key = pair.slice(0, separatorIndex);
                if (value.includes('Max-Age=0')) {
                    cookies.delete(key);
                } else {
                    cookies.set(key, pair.slice(separatorIndex + 1));
                }
            },
        });

        const {
            BROWSER_LOCALE_COOKIE_KEY,
            BROWSER_SETTINGS_COOKIE_KEY,
            BROWSER_THEME_COOKIE_KEY,
        } = await import('@app/utils/browserSettingsPersistence');
        cookies.set(BROWSER_LOCALE_COOKIE_KEY, encodeURIComponent('ru'));
        cookies.set(BROWSER_THEME_COOKIE_KEY, encodeURIComponent('dark'));

        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');
        await browserSettingsCapability.save({
            authorName: 'Browser User',
            assistantPanelEnabled: false,
        });
        const settings = await browserSettingsCapability.get();

        expect(settings.authorName).toBe('Browser User');
        expect(settings.assistantPanelEnabled).toBe(false);
        expect(settings.locale).toBe('ru');
        expect(settings.theme).toBe('dark');
        expect(cookies.has(BROWSER_SETTINGS_COOKIE_KEY)).toBe(false);
        expect(Array.from(cookies.keys()).sort()).toEqual([
            BROWSER_LOCALE_COOKIE_KEY,
            BROWSER_THEME_COOKIE_KEY,
        ].sort());
        expect(localStorage.getItem('evb-viewer:browser:settings')).not.toBeNull();
        expect(cookieWrites.filter(value => !value.includes('Max-Age=0'))).toEqual([
            expect.stringContaining('; SameSite=Lax; Secure'),
            expect.stringContaining('; SameSite=Lax; Secure'),
        ]);
    });

    it('migrates and removes the legacy full-settings request cookie', async () => {
        const cookies = new Map<string, string>();
        const localStorage = new MemoryStorage();
        vi.stubGlobal('window', { localStorage });
        vi.stubGlobal('document', {
            get cookie() {
                return Array.from(cookies.entries()).map(([
                    key,
                    value,
                ]) => `${key}=${value}`).join('; ');
            },
            set cookie(value: string) {
                const [pair] = value.split(';');
                const separatorIndex = pair?.indexOf('=') ?? -1;
                if (!pair || separatorIndex < 0) {
                    return;
                }
                const key = pair.slice(0, separatorIndex);
                if (value.includes('Max-Age=0')) {
                    cookies.delete(key);
                } else {
                    cookies.set(key, pair.slice(separatorIndex + 1));
                }
            },
        });
        const {
            BROWSER_SETTINGS_COOKIE_KEY,
            serializeBrowserSettingsPayload,
        } = await import('@app/utils/browserSettingsPersistence');
        const { DEFAULT_SETTINGS } = await import('@contracts/settings');
        localStorage.setItem('evb-viewer:browser:settings', JSON.stringify({
            ...DEFAULT_SETTINGS,
            authorName: 'Divergent Storage User',
            performanceMode: 'high',
        }));
        cookies.set(BROWSER_SETTINGS_COOKIE_KEY, encodeURIComponent(serializeBrowserSettingsPayload({
            ...DEFAULT_SETTINGS,
            authorName: 'Migrated User',
            performanceMode: 'low',
        })));

        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');
        const settings = await browserSettingsCapability.get();

        expect(settings).toMatchObject({
            authorName: 'Divergent Storage User',
            performanceMode: 'high',
        });
        expect(cookies.has(BROWSER_SETTINGS_COOKIE_KEY)).toBe(false);
        expect(JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? 'null'))
            .toMatchObject({
                authorName: 'Divergent Storage User',
                performanceMode: 'high',
            });
    });

    it('ignores malformed browser settings cookies', async () => {
        const localStorage = new MemoryStorage();
        vi.stubGlobal('window', { localStorage });
        vi.stubGlobal('document', {
            get cookie() {
                return 'evb_viewer_settings=%E0%A4%A; i18n_redirected=%E0%A4%A; evb_viewer_theme=%E0%A4%A';
            },
            set cookie(value: string) {
                void value;
            },
        });

        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');
        const settings = await browserSettingsCapability.get();

        expect(settings.locale).toBe('en');
        expect(settings.theme).toBe('light');
    });

    it('preserves a future storage schema and fails closed', async () => {
        const localStorage = new MemoryStorage();
        const futureSettings = JSON.stringify({
            version: 99,
            authorName: 'Future user',
            futureSetting: 'keep me',
        });
        localStorage.setItem(SETTINGS_STORAGE_KEY, futureSettings);
        vi.stubGlobal('window', {localStorage});

        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');

        await expect(browserSettingsCapability.get()).rejects.toMatchObject({
            code: 'unsupported-settings-schema',
            version: 99,
        });
        expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(futureSettings);
    });

    it('keeps a valid settings cookie when storage migration cannot commit', async () => {
        const cookies = new Map<string, string>();
        vi.stubGlobal('window', {localStorage: {
            getItem: () => {
                throw new Error('storage unavailable');
            },
            setItem: () => {
                throw new Error('storage unavailable');
            },
        }});
        vi.stubGlobal('document', {
            get cookie() {
                return Array.from(cookies.entries())
                    .map(([
                        key,
                        value,
                    ]) => `${key}=${value}`)
                    .join('; ');
            },
            set cookie(value: string) {
                const [pair] = value.split(';');
                const separatorIndex = pair?.indexOf('=') ?? -1;
                if (!pair || separatorIndex < 0) {
                    return;
                }
                const key = pair.slice(0, separatorIndex);
                if (value.includes('Max-Age=0')) {
                    cookies.delete(key);
                } else {
                    cookies.set(key, pair.slice(separatorIndex + 1));
                }
            },
        });
        const {
            BROWSER_SETTINGS_COOKIE_KEY,
            serializeBrowserSettingsPayload,
        } = await import('@app/utils/browserSettingsPersistence');
        const { DEFAULT_SETTINGS } = await import('@contracts/settings');
        const serialized = serializeBrowserSettingsPayload({
            ...DEFAULT_SETTINGS,
            authorName: 'Cookie user',
        });
        cookies.set(BROWSER_SETTINGS_COOKIE_KEY, encodeURIComponent(serialized));

        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');
        await expect(browserSettingsCapability.get()).resolves.toMatchObject({authorName: 'Cookie user'});

        expect(cookies.get(BROWSER_SETTINGS_COOKIE_KEY)).toBe(encodeURIComponent(serialized));
    });

    it('merges a durable update made by another settings writer', async () => {
        const localStorage = new MemoryStorage();
        vi.stubGlobal('window', {localStorage});
        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');

        await browserSettingsCapability.save({authorName: 'First writer'});
        const externalSettings = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null') as Record<string, unknown>;
        externalSettings.theme = 'dark';
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(externalSettings));

        await browserSettingsCapability.save({assistantPanelEnabled: true});

        expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null')).toMatchObject({
            authorName: 'First writer',
            assistantPanelEnabled: true,
            theme: 'dark',
        });
    });

    it('round-trips a granted diagnostics preference through browser local storage only', async () => {
        const localStorage = new MemoryStorage();
        vi.stubGlobal('window', {localStorage});
        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');

        await browserSettingsCapability.save({clientDiagnosticsPreference: 'granted'});

        expect(await browserSettingsCapability.get()).toMatchObject({clientDiagnosticsPreference: 'granted'});
        expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toContain('clientDiagnosticsPreference');
    });

    it('changes the live diagnostics gate before browser persistence resolves', async () => {
        const localStorage = new MemoryStorage();
        vi.stubGlobal('window', {localStorage});
        const failureReporter = await import('@app/utils/failureReporter');
        failureReporter.setRendererDiagnosticsPreference('granted');
        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');

        const savePromise = browserSettingsCapability.save({clientDiagnosticsPreference: 'denied'});

        expect(failureReporter.getRendererDiagnosticsPreference()).toBe('denied');
        await savePromise;
        expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null'))
            .toMatchObject({clientDiagnosticsPreference: 'denied'});
    });

    it('closes a failed browser grant without resending', async () => {
        const localStorage = new MemoryStorage();
        vi.stubGlobal('window', {localStorage: {
            getItem: localStorage.getItem.bind(localStorage),
            setItem: () => {
                throw new Error('quota exceeded');
            },
        }});
        const failureReporter = await import('@app/utils/failureReporter');
        failureReporter.setRendererDiagnosticsPreference('unknown');
        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');

        const savePromise = browserSettingsCapability.save({clientDiagnosticsPreference: 'granted'});
        expect(failureReporter.getRendererDiagnosticsPreference()).toBe('granted');
        await expect(savePromise).rejects.toThrow('localStorage');
        expect(failureReporter.getRendererDiagnosticsPreference()).toBe('unknown');
    });

    it('does not let an older failed grant reopen after a newer denial', async () => {
        const durableStorage = new MemoryStorage();
        let failNextWrite = true;
        vi.stubGlobal('window', {localStorage: {
            getItem: durableStorage.getItem.bind(durableStorage),
            setItem: (key: string, value: string) => {
                if (failNextWrite) {
                    failNextWrite = false;
                    throw new Error('quota exceeded');
                }
                durableStorage.setItem(key, value);
            },
        }});
        const failureReporter = await import('@app/utils/failureReporter');
        failureReporter.setRendererDiagnosticsPreference('unknown');
        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');

        const grantPromise = browserSettingsCapability.save({clientDiagnosticsPreference: 'granted'});
        const denialPromise = browserSettingsCapability.save({clientDiagnosticsPreference: 'denied'});

        await expect(grantPromise).rejects.toThrow('localStorage');
        await denialPromise;
        expect(failureReporter.getRendererDiagnosticsPreference()).toBe('denied');
    });

    it('keeps a failed browser revoke closed', async () => {
        vi.stubGlobal('window', {localStorage: {
            getItem: () => null,
            setItem: () => {
                throw new Error('quota exceeded');
            },
        }});
        const failureReporter = await import('@app/utils/failureReporter');
        failureReporter.setRendererDiagnosticsPreference('granted');
        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');

        const savePromise = browserSettingsCapability.save({clientDiagnosticsPreference: 'denied'});
        expect(failureReporter.getRendererDiagnosticsPreference()).toBe('denied');
        await expect(savePromise).rejects.toThrow('localStorage');
        expect(failureReporter.getRendererDiagnosticsPreference()).toBe('denied');
    });

    it('keeps an otherwise valid browser settings snapshot when diagnostics preference is invalid', async () => {
        const localStorage = new MemoryStorage();
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
            version: 2,
            authorName: 'Stored user',
            theme: 'dark',
            locale: 'en',
            defaultZoomPreset: 'fit-width',
            defaultViewMode: 'single',
            defaultContinuousScroll: true,
            defaultAnnotationColor: '#ffd400',
            clientDiagnosticsPreference: false,
        }));
        vi.stubGlobal('window', {localStorage});
        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');

        await expect(browserSettingsCapability.get()).resolves.toMatchObject({
            authorName: 'Stored user',
            theme: 'dark',
            clientDiagnosticsPreference: 'unknown',
        });
    });

    it('rejects a browser settings write when localStorage refuses it', async () => {
        vi.stubGlobal('window', {localStorage: {
            getItem: () => null,
            setItem: () => {
                throw new Error('quota exceeded');
            },
        }});
        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');

        await expect(browserSettingsCapability.save({authorName: 'Unsaved'})).rejects.toThrow('localStorage');
    });
});
