import {resolveLocale, type TLocale} from '@i18n-core';

const LOCALE_MESSAGE_LOADERS = {
    en: () => import('@i18n-app/messages/en'),
    ru: () => import('@i18n-app/messages/ru'),
    fr: () => import('@i18n-app/messages/fr'),
    de: () => import('@i18n-app/messages/de'),
    es: () => import('@i18n-app/messages/es'),
    it: () => import('@i18n-app/messages/it'),
    pt: () => import('@i18n-app/messages/pt'),
    'pt-BR': () => import('@i18n-app/messages/ptBr'),
    nl: () => import('@i18n-app/messages/nl'),
} satisfies Record<TLocale, () => Promise<{default: Record<string, unknown>}>>;

export default defineI18nLocale(async (locale) => {
    const {default: messages} = await LOCALE_MESSAGE_LOADERS[resolveLocale(locale)]();
    return messages;
});
