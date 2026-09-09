import type {
    TLocale,
    TTranslateFn,
} from '@i18n-app';
import EN_MESSAGE_SCHEMA from '@i18n-app/messages/en';
import {flattenObject} from 'es-toolkit/object';
import {ref} from 'vue';
import {vi} from 'vitest';

const EN_TRANSLATION_KEYS = new Set(
    Object.entries(flattenObject(EN_MESSAGE_SCHEMA))
        .filter(entry => typeof entry[1] === 'string')
        .map(entry => entry[0]),
);

const translate: TTranslateFn = (key, ...args) => {
    if (!EN_TRANSLATION_KEYS.has(key)) {
        throw new Error(`Unknown i18n key in test: "${key}"`);
    }
    const rawParams = args[0];
    if (typeof rawParams === 'number') {
        return `${key}:${rawParams}`;
    }
    if (rawParams && typeof rawParams === 'object') {
        return `${key}:${JSON.stringify(rawParams)}`;
    }
    return key;
};

const i18nComposer = {
    locale: ref<TLocale>('en'),
    t: translate,
    setLocale: async (_locale: TLocale) => {},
    loadLocaleMessages: async (_locale: TLocale) => {},
};

vi.mock('vue-i18n', () => ({useI18n: () => i18nComposer}));

vi.stubGlobal('useRuntimeConfig', () => ({public: {
    analyticsEnabled: false,
    landingUrl: '',
    siteUrl: '',
}}));

vi.stubGlobal('useRoute', () => ({path: '/'}));
