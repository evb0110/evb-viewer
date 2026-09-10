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
    events: [] as string[],
    loadSettings: vi.fn(),
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

vi.mock('@electron/menu', () => ({updateRecentFilesMenu: mocks.updateRecentFilesMenu}));
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

describe('Electron settings diagnostics scheduling', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.events.length = 0;
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
