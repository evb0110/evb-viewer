import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    loadSettings: vi.fn(),
    logger: {
        error: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('@electron/settings', () => ({loadSettings: mocks.loadSettings}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

describe('Electron translations', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.loadSettings.mockResolvedValue({locale: 'en'});
    });

    it('keeps te synchronous while switching the active locale', async () => {
        const {setElectronLocale, te} = await import('@electron/te');

        expect(te('assistant.open')).toBe('Open EVB Assistant');
        await setElectronLocale('ru');
        expect(te('assistant.open')).toBe('Открыть EVB Assistant');
        await setElectronLocale('en');
        expect(te('assistant.open')).toBe('Open EVB Assistant');
    });

    it('ignores a stale locale load that finishes after a newer request', async () => {
        const {setElectronLocale, te} = await import('@electron/te');

        const slowSwitch = setElectronLocale('ru');
        await setElectronLocale('en');
        await slowSwitch;
        expect(te('assistant.open')).toBe('Open EVB Assistant');
    });

    it('loads the saved locale before startup and falls back to English on failure', async () => {
        mocks.loadSettings.mockResolvedValueOnce({locale: 'ru'});
        const {initializeElectronTranslations, te} = await import('@electron/te');

        await initializeElectronTranslations();
        expect(te('assistant.open')).toBe('Открыть EVB Assistant');

        mocks.loadSettings.mockRejectedValueOnce(new Error('settings unavailable'));
        await initializeElectronTranslations();
        expect(te('assistant.open')).toBe('Open EVB Assistant');
        expect(mocks.logger.warn).toHaveBeenCalledWith('Failed to initialize Electron translations: settings unavailable');
    });
});
