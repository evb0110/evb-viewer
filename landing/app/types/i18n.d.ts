import type { Composer } from 'vue-i18n';
import type {
    TLocale,
    TLocaleSchema,
} from '~/i18n/locales';

declare module 'vue-i18n' {
    export interface DefineLocaleMessage extends TLocaleSchema {}
}

export type TI18nComposer = Composer & {
    setLocale: (locale: TLocale) => Promise<void>;
    loadLocaleMessages: (locale: TLocale) => Promise<void>;
};
