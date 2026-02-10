import type { Composer } from 'vue-i18n';

export type TI18nComposer = Composer & {
    setLocale: (locale: string) => Promise<void>;
    loadLocaleMessages: (locale: string) => Promise<void>;
};
