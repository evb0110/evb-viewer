import type * as TViMockOriginalModule from '@electron/features/diagnostics/public';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {DEFAULT_SETTINGS} from '@contracts/settings';

const mocks = vi.hoisted(() => ({
    appWindows: [] as unknown[],
    events: [] as string[],
    loadSettings: vi.fn(),
    trustedRendererUrl: 'evb-viewer://app/electron',
    diagnosticsConsentRevision: 0,
    recordMainDiagnosticsConsentIntent: vi.fn((preference: unknown) => {
        mocks.events.push(`consent-intent:${String(preference)}`);
        mocks.diagnosticsConsentRevision += 1;
        return mocks.diagnosticsConsentRevision;
    }),
    setMainDiagnosticsPreference: vi.fn((preference: unknown) => {
        mocks.events.push(`preference:${String(preference)}`);
    }),
    setElectronLocale: vi.fn(async () => undefined),
    updateRecentFilesMenu: vi.fn(),
    updateSettings: vi.fn(),
}));

vi.mock('@electron/config', () => ({config: {renderer: {trustedUrl: mocks.trustedRendererUrl}}}));
vi.mock('@electron/menu', () => ({updateRecentFilesMenu: mocks.updateRecentFilesMenu}));
vi.mock('@electron/window/registry', () => ({getAllRegisteredAppWindows: () => mocks.appWindows}));
vi.mock('@electron/features/diagnostics/public', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    setMainDiagnosticsPreference: mocks.setMainDiagnosticsPreference,
}));
vi.mock('@electron/settings', () => ({
    loadSettings: mocks.loadSettings,
    recordMainDiagnosticsConsentIntent: mocks.recordMainDiagnosticsConsentIntent,
    updateSettings: mocks.updateSettings,
}));
vi.mock('@electron/te', () => ({setElectronLocale: mocks.setElectronLocale}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
})}));

function createAppWindow(url: string) {
    const send = vi.fn();
    return {
        send,
        window: {
            isDestroyed: () => false,
            webContents: {
                getURL: () => url,
                isDestroyed: () => false,
                send,
            },
        },
    };
}

describe('Electron settings diagnostics scheduling', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.events.length = 0;
        mocks.appWindows.length = 0;
        mocks.diagnosticsConsentRevision = 0;
        vi.useFakeTimers();
        mocks.updateSettings.mockImplementation(async (mutate: (settings: typeof DEFAULT_SETTINGS) => unknown) => {
            mocks.events.push('persist');
            const mutation = await mutate({...DEFAULT_SETTINGS});
            return {
                ...DEFAULT_SETTINGS,
                ...(mutation && typeof mutation === 'object' ? mutation : {}),
            };
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('flushes a diagnostics preference before the 25 ms coalescing window', async () => {
        const {createSettingsMainBindings} = await import('@electron/features/settings/createSettingsMainBindings');
        const bindings = createSettingsMainBindings(async () => undefined);

        const savePromise = bindings.save({senderId: 7} as never, {clientDiagnosticsPreference: 'denied'});

        expect(mocks.updateSettings).toHaveBeenCalledOnce();
        expect(mocks.events).toEqual([
            'consent-intent:denied',
            'persist',
        ]);
        await savePromise;
        await vi.advanceTimersByTimeAsync(25);
        expect(mocks.updateSettings).toHaveBeenCalledOnce();
    });

    it('keeps ordinary settings coalesced', async () => {
        const {createSettingsMainBindings} = await import('@electron/features/settings/createSettingsMainBindings');
        const bindings = createSettingsMainBindings(async () => undefined);

        const savePromise = bindings.save({senderId: 8} as never, {authorName: 'Later'});

        expect(mocks.updateSettings).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(25);
        await savePromise;
        expect(mocks.updateSettings).toHaveBeenCalledOnce();
    });
});

describe('Electron settings change broadcast', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.appWindows.length = 0;
        mocks.events.length = 0;
        vi.useFakeTimers();
        mocks.updateSettings.mockImplementation(async (mutate: (settings: typeof DEFAULT_SETTINGS) => unknown) => {
            const mutation = await mutate({...DEFAULT_SETTINGS});
            return {
                ...DEFAULT_SETTINGS,
                ...(mutation && typeof mutation === 'object' ? mutation : {}),
            };
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('sends each committed write to every window that shows the app', async () => {
        const first = createAppWindow(mocks.trustedRendererUrl);
        const second = createAppWindow(mocks.trustedRendererUrl);
        mocks.appWindows.push(first.window, second.window);
        const {createSettingsMainBindings} = await import('@electron/features/settings/createSettingsMainBindings');
        const bindings = createSettingsMainBindings(async () => undefined);

        const savePromise = bindings.save({senderId: 7} as never, {authorName: 'Shared'});
        await vi.advanceTimersByTimeAsync(25);
        await savePromise;

        const expected = expect.objectContaining({authorName: 'Shared'});
        expect(first.send).toHaveBeenCalledOnce();
        expect(first.send).toHaveBeenCalledWith('settings:changed', expected);
        expect(second.send).toHaveBeenCalledOnce();
        expect(second.send).toHaveBeenCalledWith('settings:changed', expected);
    });

    it('leaves out a window that no longer shows the app', async () => {
        const foreign = createAppWindow('https://example.com/elsewhere');
        mocks.appWindows.push(foreign.window);
        const {createSettingsMainBindings} = await import('@electron/features/settings/createSettingsMainBindings');
        const bindings = createSettingsMainBindings(async () => undefined);

        const savePromise = bindings.save({senderId: 7} as never, {authorName: 'Hidden'});
        await vi.advanceTimersByTimeAsync(25);
        await savePromise;

        expect(foreign.send).not.toHaveBeenCalled();
    });

    it('sends one broadcast for a coalesced batch of saves', async () => {
        const window = createAppWindow(mocks.trustedRendererUrl);
        mocks.appWindows.push(window.window);
        const {createSettingsMainBindings} = await import('@electron/features/settings/createSettingsMainBindings');
        const bindings = createSettingsMainBindings(async () => undefined);

        const first = bindings.save({senderId: 9} as never, {authorName: 'First'});
        const second = bindings.save({senderId: 9} as never, {locale: 'ru'});
        await vi.advanceTimersByTimeAsync(25);
        await Promise.all([
            first,
            second,
        ]);

        expect(mocks.updateSettings).toHaveBeenCalledOnce();
        expect(window.send).toHaveBeenCalledOnce();
        expect(window.send).toHaveBeenCalledWith('settings:changed', expect.objectContaining({
            authorName: 'First',
            locale: 'ru',
        }));
    });

    it('broadcasts a diagnostics withdrawal before the coalescing window', async () => {
        const window = createAppWindow(mocks.trustedRendererUrl);
        mocks.appWindows.push(window.window);
        const {createSettingsMainBindings} = await import('@electron/features/settings/createSettingsMainBindings');
        const bindings = createSettingsMainBindings(async () => undefined);

        await bindings.save({senderId: 10} as never, {clientDiagnosticsPreference: 'denied'});

        expect(window.send).toHaveBeenCalledWith('settings:changed', expect.objectContaining({clientDiagnosticsPreference: 'denied'}));
    });
});
