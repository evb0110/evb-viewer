import type {TLocale, TTranslateFn} from '@i18n-app';
import {DEFAULT_LOCALE, formatTranslationLeaf, getNestedTranslationLeaf, normalizeTranslationParams} from '@i18n-core';

export function createPluginTranslate(
    getLocaleMessages: (locale: TLocale) => Record<string, unknown>,
    getLocale: () => TLocale | null | undefined,
): TTranslateFn {
    const t: TTranslateFn = (key, ...args) => {
        const params = normalizeTranslationParams(args[0]);
        const locale = getLocale() ?? DEFAULT_LOCALE;
        const leaf =
            getNestedTranslationLeaf(getLocaleMessages(locale), key) ??
            getNestedTranslationLeaf(getLocaleMessages(DEFAULT_LOCALE), key) ??
            key;

        return formatTranslationLeaf(leaf, params, locale);
    };

    return t;
}
