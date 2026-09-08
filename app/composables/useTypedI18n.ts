import type {
    TLocale,
    TTranslateFn,
} from '@i18n-app';
import {
    DEFAULT_LOCALE,
    createTypedI18nComposer,
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    normalizeTranslationParams,
    resolveLocale,
} from '@i18n-core';

type TResolvedTranslationLeaf = NonNullable<ReturnType<typeof getNestedTranslationLeaf>> | string;

interface ITranslationLeafCache {
    primaryMessages: Record<string, unknown>;
    fallbackMessages: Record<string, unknown>;
    leaves: Map<string, TResolvedTranslationLeaf>;
}

// Resolving a dotted key walks two message trees; the result only changes when the
// locale's message objects are replaced (locale switch, lazy load, HMR), so cache per
// locale and drop the entry as soon as either tree identity changes.
const translationLeafCacheByLocale = new Map<string, ITranslationLeafCache>();

function resolveTranslationLeaf(
    locale: string,
    primaryMessages: Record<string, unknown>,
    fallbackMessages: Record<string, unknown>,
    key: string,
) {
    const cached = translationLeafCacheByLocale.get(locale);
    const cache = cached
        && cached.primaryMessages === primaryMessages
        && cached.fallbackMessages === fallbackMessages
        ? cached
        : {
            primaryMessages,
            fallbackMessages,
            leaves: new Map<string, TResolvedTranslationLeaf>(),
        };
    if (cache !== cached) {
        translationLeafCacheByLocale.set(locale, cache);
    }

    const cachedLeaf = cache.leaves.get(key);
    if (cachedLeaf !== undefined) {
        return cachedLeaf;
    }

    const leaf = getNestedTranslationLeaf(primaryMessages, key)
        ?? getNestedTranslationLeaf(fallbackMessages, key)
        ?? key;
    cache.leaves.set(key, leaf);
    return leaf;
}

export const useTypedI18n = () => {
    const composer = useI18n();
    const typedComposer = createTypedI18nComposer<typeof composer, typeof composer.t, TLocale>(composer);
    const locale = computed<TLocale>(() => resolveLocale(composer.locale.value));
    const t: TTranslateFn = (key, ...args) => {
        const params = normalizeTranslationParams(args[0]);
        const currentLocale = locale.value;
        if (typeof composer.getLocaleMessage !== 'function') {
            return params === undefined
                ? composer.t(key)
                : composer.t(key, params);
        }
        const primaryMessages = composer.getLocaleMessage(currentLocale);
        const fallbackMessages = composer.getLocaleMessage(DEFAULT_LOCALE);
        const leaf = resolveTranslationLeaf(currentLocale, primaryMessages, fallbackMessages, key);
        return formatTranslationLeaf(leaf, params, currentLocale);
    };

    return {
        ...typedComposer,
        locale,
        t,
    };
};
