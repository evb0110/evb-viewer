import type {Composer} from 'vue-i18n';
import type {TLocale, TLocaleSchema, TTranslateFn} from '@i18n-app';

declare module 'vue-i18n' {
    export interface DefineLocaleMessage extends TLocaleSchema {}
}

export type TI18nComposer = Composer & {
    t: TTranslateFn;
    setLocale: (locale: TLocale) => Promise<void>;
    loadLocaleMessages: (locale: TLocale) => Promise<void>;
};
