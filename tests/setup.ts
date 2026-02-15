import { vi } from 'vitest';
import type { TLocale } from '@app/i18n/locales';

const translate = (key: string) => key;

async function setLocale(_locale: TLocale) {
    return;
}

async function loadLocaleMessages(_locale: TLocale) {
    return;
}

vi.stubGlobal('useI18n', () => ({
    t: translate,
    setLocale,
    loadLocaleMessages,
}));

vi.stubGlobal('useTypedI18n', () => ({
    t: translate,
    setLocale,
    loadLocaleMessages,
}));
