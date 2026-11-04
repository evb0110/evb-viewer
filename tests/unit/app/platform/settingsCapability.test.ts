import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { MemoryStorage } from '@tests/unit/app/platform/browserPlatformTestDoubles';
import { SETTINGS_STORAGE_KEY } from '@app/platform/browser-api/browserApiStorageKeys';
import {
    requireEpochMs,
    requireIsoTimestamp,
} from '@contracts/timestamps';

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

    it('runs on defaults beside a future storage schema, preserves it and refuses to save over it', async () => {
        const localStorage = new MemoryStorage();
        const futureSettings = JSON.stringify({
            version: 99,
            authorName: 'Future user',
            futureSetting: 'keep me',
        });
        localStorage.setItem(SETTINGS_STORAGE_KEY, futureSettings);
        vi.stubGlobal('window', {localStorage});

        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');

        const { DEFAULT_SETTINGS } = await import('@contracts/settings');
        await expect(browserSettingsCapability.get()).resolves.toMatchObject({authorName: DEFAULT_SETTINGS.authorName});
        expect(await browserSettingsCapability.getRecoveryNotice()).toEqual({reason: 'unsupported'});
        expect(await browserSettingsCapability.getRecoveryNotice()).toBeNull();
        await expect(browserSettingsCapability.save({authorName: 'Older tab'})).rejects.toMatchObject({
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

    it('grants no consent and saves nothing while a newer version owns either settings source', async () => {
        const localStorage = new MemoryStorage();
        const browserWindow = Object.assign(new EventTarget(), {localStorage});
        vi.stubGlobal('window', browserWindow);
        const {DEFAULT_SETTINGS} = await import('@contracts/settings');
        const {BROWSER_SETTINGS_COOKIE_KEY} = await import('@app/utils/browserSettingsPersistence');
        const supported = JSON.stringify({
            ...DEFAULT_SETTINGS,
            clientDiagnosticsPreference: 'granted',
        });
        localStorage.setItem(SETTINGS_STORAGE_KEY, supported);
        const futureCookie = encodeURIComponent(JSON.stringify({
            version: 99,
            clientDiagnosticsPreference: 'granted',
        }));
        const cookieWrites: string[] = [];
        vi.stubGlobal('document', {
            get cookie() {
                return `${BROWSER_SETTINGS_COOKIE_KEY}=${futureCookie}`;
            },
            set cookie(value: string) {
                cookieWrites.push(value);
            },
        });

        // The reporter reads consent before settings load.
        const reporter = await import('@app/utils/failureReporter');
        expect(reporter.getRendererDiagnosticsPreference()).toBe('unknown');
        const {browserSettingsCapability} = await import('@app/platform/browser-api/browserSettingsCapability');
        expect(await browserSettingsCapability.get()).toMatchObject({clientDiagnosticsPreference: 'unknown'});
        expect(await browserSettingsCapability.getRecoveryNotice()).toEqual({reason: 'unsupported'});
        browserWindow.dispatchEvent(new Event('pageshow'));
        expect(await browserSettingsCapability.get()).toMatchObject({clientDiagnosticsPreference: 'unknown'});
        expect(reporter.getRendererDiagnosticsPreference()).toBe('unknown');
        await expect(browserSettingsCapability.save({authorName: 'Older tab'})).rejects.toMatchObject({code: 'unsupported-settings-schema'});
        expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(supported);
        expect(cookieWrites).toEqual([]);
    });

    it('delivers current shared settings and fails closed when storage is cleared or unsupported', async () => {
        const localStorage = new MemoryStorage();
        const browserWindow = Object.assign(new EventTarget(), {localStorage});
        vi.stubGlobal('window', browserWindow);
        const {DEFAULT_SETTINGS} = await import('@contracts/settings');
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
            ...DEFAULT_SETTINGS,
            clientDiagnosticsPreference: 'granted',
        }));
        const {browserSettingsCapability} = await import('@app/platform/browser-api/browserSettingsCapability');
        const reporter = await import('@app/utils/failureReporter');
        await browserSettingsCapability.get();
        const changes: unknown[] = [];
        const unsubscribe = browserSettingsCapability.onChanged(settings => changes.push(settings));
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
            ...DEFAULT_SETTINGS,
            clientDiagnosticsPreference: 'denied',
        }));
        browserWindow.dispatchEvent(Object.assign(new Event('storage'), {
            storageArea: localStorage,
            key: SETTINGS_STORAGE_KEY,
            // A queued notification must not replay its old granted snapshot.
            newValue: JSON.stringify({
                ...DEFAULT_SETTINGS,
                clientDiagnosticsPreference: 'granted',
            }),
        }));
        expect(await browserSettingsCapability.get()).toMatchObject({clientDiagnosticsPreference: 'denied'});
        expect(reporter.getRendererDiagnosticsPreference()).toBe('denied');
        expect(changes).toEqual([expect.objectContaining({clientDiagnosticsPreference: 'denied'})]);
        localStorage.clear();
        browserWindow.dispatchEvent(Object.assign(new Event('storage'), {
            storageArea: localStorage,
            key: null,
        }));
        expect(await browserSettingsCapability.get()).toMatchObject({clientDiagnosticsPreference: 'unknown'});
        expect(reporter.getRendererDiagnosticsPreference()).toBe('unknown');
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
            version: 99,
            clientDiagnosticsPreference: 'granted',
        }));
        browserWindow.dispatchEvent(new Event('pageshow'));
        expect(await browserSettingsCapability.get()).toMatchObject({clientDiagnosticsPreference: 'unknown'});
        expect(reporter.getRendererDiagnosticsPreference()).toBe('unknown');
        expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toContain('99');
        unsubscribe();
    });

    it('drops delayed consent replay and queued hosted envelopes after shared withdrawal', async () => {
        const localStorage = new MemoryStorage();
        const browserWindow = Object.assign(new EventTarget(), {localStorage});
        vi.stubGlobal('window', browserWindow);
        const {DEFAULT_SETTINGS} = await import('@contracts/settings');
        const envelopes: unknown[] = [];
        const queued: Array<() => void> = [];
        let releaseSdk!: () => void;
        const sdkReady = new Promise<void>((resolve) => { releaseSdk = resolve; });
        let sendEnvelope: (envelope: unknown) => Promise<unknown> = () => Promise.resolve({});
        const options = {enabled: false};
        vi.doMock('@sentry/browser', async () => {
            await sdkReady;
            return {
                init(config: {
                    enabled: boolean;
                    transport: (options: object) => {send: typeof sendEnvelope}
                }) {
                    options.enabled = config.enabled;
                    sendEnvelope = config.transport({}).send;
                },
                getClient: () => ({getOptions: () => options}),
                captureException: (_error: unknown, capture: {event_id: string}) => {
                    queued.push(() => { void sendEnvelope({event_id: capture.event_id}); });
                },
                makeFetchTransport: () => ({
                    send(envelope: unknown) {
                        envelopes.push(envelope);
                        return Promise.resolve({});
                    },
                    flush: () => Promise.resolve(true),
                }),
            };
        });
        try {
            const reporter = await import('@app/utils/failureReporter');
            const {browserSettingsCapability} = await import('@app/platform/browser-api/browserSettingsCapability');
            reporter.initializeRendererDiagnostics({
                dsn: 'https://public@example.invalid/1',
                release: 'test',
                environment: 'test',
            });
            const input = {
                code: 'TEST_FAILURE',
                local: {
                    source: 'test',
                    message: 'Failure',
                    cause: new Error('Failure'),
                },
            };
            const held = reporter.captureFailureForPresentation(input);
            await browserSettingsCapability.save({clientDiagnosticsPreference: 'granted'});
            expect(held.pendingDiagnostic?.resendOnceAfterGrant()).toBe(true);
            reporter.captureRendererFailure(input);
            localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
                ...DEFAULT_SETTINGS,
                clientDiagnosticsPreference: 'denied',
            }));
            browserWindow.dispatchEvent(Object.assign(new Event('storage'), {
                storageArea: localStorage,
                key: SETTINGS_STORAGE_KEY,
            }));
            releaseSdk();
            await vi.waitFor(() => expect(options.enabled).toBe(false));
            // Wait for the actual async import to initialize, without a timer.
            await import('@sentry/browser');
            await Promise.resolve();
            queued.splice(0).forEach(deliver => deliver());
            expect(envelopes).toEqual([]);

            await browserSettingsCapability.save({clientDiagnosticsPreference: 'granted'});
            const granted = reporter.captureRendererFailure(input);
            queued.splice(0).forEach(deliver => deliver());
            expect(envelopes).toEqual([{event_id: granted.eventId}]);
            reporter.captureRendererFailure(input);
            localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
                ...DEFAULT_SETTINGS,
                clientDiagnosticsPreference: 'denied',
            }));
            // A resumed context refreshes even before a queued storage event.
            browserWindow.dispatchEvent(new Event('visibilitychange'));
            queued.splice(0).forEach(deliver => deliver());
            expect(envelopes).toEqual([{event_id: granted.eventId}]);
            expect(await browserSettingsCapability.get()).toMatchObject({clientDiagnosticsPreference: 'denied'});
        } finally {
            releaseSdk();
            vi.doUnmock('@sentry/browser');
        }
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
        await expect(savePromise).rejects.toThrow('quota exceeded');
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

        await expect(grantPromise).rejects.toThrow('quota exceeded');
        await denialPromise;
        expect(failureReporter.getRendererDiagnosticsPreference()).toBe('denied');
    });

    it('keeps a failed browser revoke closed', async () => {
        const durableStorage = new MemoryStorage();
        const {DEFAULT_SETTINGS} = await import('@contracts/settings');
        durableStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
            ...DEFAULT_SETTINGS,
            clientDiagnosticsPreference: 'granted',
        }));
        const localStorage = {
            getItem: durableStorage.getItem.bind(durableStorage),
            setItem: () => {
                throw new Error('quota exceeded');
            },
        };
        const browserWindow = Object.assign(new EventTarget(), {localStorage});
        vi.stubGlobal('window', browserWindow);
        const failureReporter = await import('@app/utils/failureReporter');
        failureReporter.setRendererDiagnosticsPreference('granted');
        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');

        const savePromise = browserSettingsCapability.save({clientDiagnosticsPreference: 'denied'});
        expect(failureReporter.getRendererDiagnosticsPreference()).toBe('denied');
        await expect(savePromise).rejects.toThrow('quota exceeded');
        browserWindow.dispatchEvent(Object.assign(new Event('storage'), {
            storageArea: localStorage,
            key: SETTINGS_STORAGE_KEY,
        }));
        expect(failureReporter.getRendererDiagnosticsPreference()).toBe('denied');
        expect(await browserSettingsCapability.get()).toMatchObject({clientDiagnosticsPreference: 'denied'});
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

    it.each([
        'QuotaExceededError',
        'SecurityError',
        'NotAllowedError',
    ])('preserves %s and leaves stored settings, cookies and consent unchanged after a failed write', async (name) => {
        const storage = new MemoryStorage();
        let failure: DOMException | null = null;
        vi.stubGlobal('window', {localStorage: {
            getItem: storage.getItem.bind(storage),
            setItem: (key: string, value: string) => {
                if (failure) throw failure;
                storage.setItem(key, value);
            },
        }});
        let cookie = '';
        vi.stubGlobal('document', {
            get cookie() { return cookie; },
            set cookie(value: string) { cookie = value; },
        });
        const {browserSettingsCapability} = await import('@app/platform/browser-api/browserSettingsCapability');
        const reporter = await import('@app/utils/failureReporter');
        await browserSettingsCapability.save({
            authorName: 'Saved',
            locale: 'ru',
            clientDiagnosticsPreference: 'denied',
        });
        await expect(browserSettingsCapability.get()).resolves.toMatchObject({authorName: 'Saved'});
        const stored = storage.getItem(SETTINGS_STORAGE_KEY);
        const savedCookie = cookie;
        failure = new DOMException('RAW storage detail', name);
        await expect(browserSettingsCapability.save({
            authorName: 'Unsaved',
            locale: 'fr',
            clientDiagnosticsPreference: 'granted',
        })).rejects.toBe(failure);
        expect(storage.getItem(SETTINGS_STORAGE_KEY)).toBe(stored);
        expect(cookie).toBe(savedCookie);
        expect(reporter.getRendererDiagnosticsPreference()).toBe('denied');
    });

    it('rejects a browser settings write when localStorage refuses it', async () => {
        vi.stubGlobal('window', {localStorage: {
            getItem: () => null,
            setItem: () => {
                throw new Error('quota exceeded');
            },
        }});
        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');

        await expect(browserSettingsCapability.save({authorName: 'Unsaved'})).rejects.toThrow('quota exceeded');
    });

    it('delivers a save to this page\'s own listeners before the save resolves', async () => {
        const localStorage = new MemoryStorage();
        vi.stubGlobal('window', {localStorage});
        const {browserSettingsCapability} = await import('@app/platform/browser-api/browserSettingsCapability');
        const changes: unknown[] = [];
        const unsubscribe = browserSettingsCapability.onChanged(settings => changes.push(settings));

        await browserSettingsCapability.save({locale: 'ru'});

        expect(changes.at(-1)).toMatchObject({locale: 'ru'});
        unsubscribe();
    });

    it('does not let a grant that committed before a withdrawal reopen reporting', async () => {
        const localStorage = new MemoryStorage();
        vi.stubGlobal('window', {localStorage});
        const {browserSettingsCapability} = await import('@app/platform/browser-api/browserSettingsCapability');
        const changes: Array<{clientDiagnosticsPreference: string}> = [];
        const unsubscribe = browserSettingsCapability.onChanged(settings => changes.push(settings));

        const grant = browserSettingsCapability.save({clientDiagnosticsPreference: 'granted'});
        const withdrawal = browserSettingsCapability.save({clientDiagnosticsPreference: 'denied'});
        await Promise.all([
            grant,
            withdrawal,
        ]);

        expect(changes.some(settings => settings.clientDiagnosticsPreference === 'granted')).toBe(false);
        expect(changes.at(-1)).toMatchObject({clientDiagnosticsPreference: 'denied'});
        unsubscribe();
    });

    it('reports a malformed stored settings reset once and stores defaults', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const localStorage = new MemoryStorage();
        localStorage.setItem(SETTINGS_STORAGE_KEY, '{"version": 2, "authorName": ');
        vi.stubGlobal('window', {localStorage});
        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');

        await expect(browserSettingsCapability.get()).resolves.toMatchObject({authorName: ''});
        expect(await browserSettingsCapability.getRecoveryNotice()).toEqual({reason: 'corrupt'});
        expect(await browserSettingsCapability.getRecoveryNotice()).toBeNull();
        expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null')).toMatchObject({version: 2});

        vi.resetModules();
        const reloaded = await import('@app/platform/browser-api/browserSettingsCapability');
        await reloaded.browserSettingsCapability.get();
        expect(await reloaded.browserSettingsCapability.getRecoveryNotice()).toBeNull();
    });

    it('reports unavailable storage as unreadable without a write, even with bootstrap cookies', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const {
            BROWSER_LOCALE_COOKIE_KEY,
            BROWSER_THEME_COOKIE_KEY,
        } = await import('@app/utils/browserSettingsPersistence');
        vi.stubGlobal('document', {cookie: `${BROWSER_LOCALE_COOKIE_KEY}=ru; ${BROWSER_THEME_COOKIE_KEY}=dark`});
        const setItem = vi.fn();
        vi.stubGlobal('window', {localStorage: {
            getItem: () => {
                throw new DOMException('Access is denied', 'SecurityError');
            },
            setItem,
        }});
        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');

        await expect(browserSettingsCapability.get()).resolves.toMatchObject({locale: 'ru'});
        expect(await browserSettingsCapability.getRecoveryNotice()).toEqual({reason: 'unreadable'});
        expect(setItem).not.toHaveBeenCalled();
    });

    it('reports no recovery for a clean profile or valid stored settings', async () => {
        const localStorage = new MemoryStorage();
        vi.stubGlobal('window', {localStorage});
        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');

        await browserSettingsCapability.get();
        expect(await browserSettingsCapability.getRecoveryNotice()).toBeNull();
        await browserSettingsCapability.save({authorName: 'Stored user'});

        vi.resetModules();
        const reloaded = await import('@app/platform/browser-api/browserSettingsCapability');
        await expect(reloaded.browserSettingsCapability.get()).resolves.toMatchObject({authorName: 'Stored user'});
        expect(await reloaded.browserSettingsCapability.getRecoveryNotice()).toBeNull();
    });

    it('buffers renderer logs in desktop debug-log entries, redacted and bounded', async () => {
        vi.stubGlobal('window', {localStorage: new MemoryStorage()});
        const { browserSettingsCapability } = await import('@app/platform/browser-api/browserSettingsCapability');
        const { decodeDebugLogEntry } = await import('@contracts/electronApiCommon');
        const streamed: unknown[] = [];
        const unsubscribe = browserSettingsCapability.onDebugLog(entry => streamed.push(entry));

        browserSettingsCapability.rendererLog({
            level: 'error',
            section: 'ocr',
            message: 'OCR backend reported page failures',
            timestamp: requireIsoTimestamp('2026-11-01T10:00:00.000Z'),
            data: {
                errors: ['Model download failed: https://models.test/eng.traineddata?token=s3cr3t'],
                errorCode: 'OCR_MODEL_DOWNLOAD_FAILED',
            },
            failureRef: {
                eventId: '0123456789abcdef0123456789abcdef',
                code: 'RENDERER_OCR_BACKEND_FAILED',
                occurredAt: requireEpochMs(1),
                severity: 'error',
            },
        });
        browserSettingsCapability.rendererLog({
            level: 'warn',
            section: 'ocr',
            message: 'OCR run was not started',
            timestamp: requireIsoTimestamp('2026-11-01T10:00:01.000Z'),
        });

        const logs = await browserSettingsCapability.getDebugLogs();
        expect(logs).toEqual([
            {
                source: 'ocr',
                message: expect.stringContaining('[ERROR] OCR backend reported page failures errors=') as unknown,
                timestamp: '2026-11-01T10:00:00.000Z',
                level: 'ERROR',
                failureRef: {
                    eventId: '0123456789abcdef0123456789abcdef',
                    code: 'RENDERER_OCR_BACKEND_FAILED',
                    severity: 'error',
                },
            },
            {
                source: 'ocr',
                message: '[WARN] OCR run was not started',
                timestamp: '2026-11-01T10:00:01.000Z',
                level: 'WARN',
            },
        ]);
        expect(logs[0]!.message).toContain('token=[redacted]');
        expect(logs[0]!.message).not.toContain('s3cr3t');
        expect(logs.map(entry => decodeDebugLogEntry(entry))).toEqual(logs);
        expect(streamed).toEqual(logs);
        unsubscribe();

        for (let index = 0; index < 2_005; index += 1) {
            browserSettingsCapability.rendererLog({
                level: 'warn',
                section: 'bulk',
                message: `entry ${index}`,
                timestamp: requireIsoTimestamp('2026-11-01T10:00:02.000Z'),
            });
        }
        const bounded = await browserSettingsCapability.getDebugLogs();
        expect(bounded).toHaveLength(2_000);
        expect(bounded[0]!.message).toBe('[WARN] entry 5');
        expect(bounded.at(-1)!.message).toBe('[WARN] entry 2004');
        expect(streamed).toHaveLength(2);
    });
});
