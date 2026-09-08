import type {
    TLocale,
    TTranslateFn,
} from '~/i18n/locales';
import type { TI18nComposer } from '~/types/i18nComposer';
import { useI18n } from 'vue-i18n';
import {
    DEFAULT_LOCALE,
    createTypedI18nComposer,
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    normalizeTranslationParams,
    resolveLocale,
} from '~/i18n/core';

export function useTypedI18n() {
    const composer = useI18n() as TI18nComposer;
    const typedComposer = createTypedI18nComposer<typeof composer, typeof composer.t, TLocale>(composer);
    const locale = computed<TLocale>(() => resolveLocale(composer.locale.value));
    const baseTranslate = composer.t.bind(composer);
    const t: TTranslateFn = (key, ...args) => {
        const params = normalizeTranslationParams(args[0]);
        const translated = params === undefined
            ? baseTranslate(key)
            : baseTranslate(key, params);

        if (translated !== key || typeof composer.getLocaleMessage !== 'function') {
            return translated;
        }

        const currentLocale = locale.value;
        const primaryMessages = composer.getLocaleMessage(currentLocale);
        const fallbackMessages = composer.getLocaleMessage(DEFAULT_LOCALE);
        const primary = getNestedTranslationLeaf(primaryMessages, key);
        const fallback = getNestedTranslationLeaf(fallbackMessages, key);
        const leaf = primary ?? fallback ?? key;
        return formatTranslationLeaf(leaf, params, currentLocale);
    };

    return {
        ...typedComposer,
        locale,
        t,
    };
}

export type TLandingTypedI18nComposer = ReturnType<typeof useTypedI18n>;
