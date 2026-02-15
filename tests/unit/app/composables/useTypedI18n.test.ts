import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

describe('useTypedI18n', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('exposes safe locale methods when i18n composer does not provide them', async () => {
        vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));

        const { useTypedI18n } = await import('@app/composables/useTypedI18n');
        const i18n = useTypedI18n();

        await expect(i18n.setLocale('en')).resolves.toBeUndefined();
        await expect(i18n.loadLocaleMessages('en')).resolves.toBeUndefined();
    });

    it('calls composer locale methods when they are available', async () => {
        const setLocale = vi.fn(async (_locale: string) => {});
        const loadLocaleMessages = vi.fn(async (_locale: string) => {});

        vi.stubGlobal('useI18n', () => ({
            t: (key: string) => key,
            setLocale,
            loadLocaleMessages,
        }));

        const { useTypedI18n } = await import('@app/composables/useTypedI18n');
        const i18n = useTypedI18n();

        await i18n.setLocale('fr');
        await i18n.loadLocaleMessages('fr');

        expect(setLocale).toHaveBeenCalledWith('fr');
        expect(loadLocaleMessages).toHaveBeenCalledWith('fr');
    });
});
