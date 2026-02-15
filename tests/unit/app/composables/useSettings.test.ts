import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { ISettingsData } from '@app/types/shared';

const mockGet = vi.fn<() => Promise<ISettingsData>>();
const mockSave = vi.fn<(settings: ISettingsData) => Promise<void>>();

function stubWindow() {
    vi.stubGlobal('window', {
        ...globalThis,
        electronAPI: { settings: {
            get: mockGet,
            save: mockSave,
        } },
    });
}

describe('useSettings', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        stubWindow();
    });

    it('preserves supported locale values on save', async () => {
        const { useSettings } = await import('@app/composables/useSettings');
        const {
            settings,
            save,
        } = useSettings();

        settings.value.locale = 'fr';
        await save();

        expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ locale: 'fr' }));
    });

    it('falls back to default locale when saving invalid locale', async () => {
        const { useSettings } = await import('@app/composables/useSettings');
        const {
            settings,
            save,
        } = useSettings();

        Reflect.set(settings.value, 'locale', 'xx');
        await save();

        expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }));
    });

    it('sanitizes invalid loaded locale to default', async () => {
        mockGet.mockResolvedValue({
            version: 1,
            authorName: 'Tester',
            theme: 'light',
            locale: 'xx' as ISettingsData['locale'],
        });

        const { useSettings } = await import('@app/composables/useSettings');
        const {
            settings,
            load,
        } = useSettings();

        await load();

        expect(settings.value.locale).toBe('en');
    });
});
