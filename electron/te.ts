import {
    DEFAULT_LOCALE,
    LOCALE_CODES,
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    normalizeTranslationParams,
    type TLocale,
    type TLocaleMessagesShapeFrom,
} from '@i18n-core';
// Main-process startup intentionally imports only the English fallback.
// eslint-disable-next-line no-restricted-imports
import en from '@i18n-app/messages/en';
import type {
    TTranslateArgs,
    TTranslationKey,
} from '@i18n-app';
import { loadSettings } from '@electron/settings';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

type TTeArgs<TKey extends TTranslationKey> = TTranslateArgs<TKey>;
type TMainLocaleMessages =
    TLocaleMessagesShapeFrom<typeof en>;
type TMainLocaleLoader =
    () => Promise<{default: TMainLocaleMessages}>;

const logger = createLogger('electron-translations');
const localeLoaders = {
    de: () => import('@i18n-app/messages/de'),
    es: () => import('@i18n-app/messages/es'),
    fr: () => import('@i18n-app/messages/fr'),
    it: () => import('@i18n-app/messages/it'),
    nl: () => import('@i18n-app/messages/nl'),
    pt: () => import('@i18n-app/messages/pt'),
    'pt-BR': () => import('@i18n-app/messages/ptBr'),
    ru: () => import('@i18n-app/messages/ru'),
} satisfies Record<Exclude<TLocale, typeof DEFAULT_LOCALE>, TMainLocaleLoader>;
const localeMessagePromises = new Map<TLocale, Promise<TMainLocaleMessages>>();
let activeLocale: TLocale = DEFAULT_LOCALE;
let activeMessages: TMainLocaleMessages = en;
let localeRequestGeneration = 0;

function resolveLocale(locale: string): TLocale {
    return LOCALE_CODES.includes(locale as TLocale)
        ? locale as TLocale
        : DEFAULT_LOCALE;
}

function loadLocaleMessages(locale: TLocale) {
    if (locale === DEFAULT_LOCALE) {
        return Promise.resolve(en);
    }
    let localePromise = localeMessagePromises.get(locale);
    if (!localePromise) {
        localePromise = localeLoaders[locale]().then(module => module.default);
        localeMessagePromises.set(locale, localePromise);
    }
    return localePromise;
}

export async function setElectronLocale(locale: TLocale) {
    const resolvedLocale = resolveLocale(locale);
    localeRequestGeneration += 1;
    const requestGeneration = localeRequestGeneration;
    if (resolvedLocale === activeLocale) {
        return;
    }
    try {
        const messages = await loadLocaleMessages(resolvedLocale);
        if (requestGeneration !== localeRequestGeneration) {
            return;
        }
        activeLocale = resolvedLocale;
        activeMessages = messages;
    } catch (error) {
        logger.error(
            `Failed to load Electron locale ${resolvedLocale}: ${getErrorMessage(error)}`,
            {
                code: 'MAIN_ELECTRON_LOCALE_LOAD_FAILED',
                context: {locale: resolvedLocale},
                cause: error,
            },
        );
        if (requestGeneration !== localeRequestGeneration) {
            return;
        }
        activeLocale = DEFAULT_LOCALE;
        activeMessages = en;
    }
}

export async function initializeElectronTranslations() {
    try {
        const settings = await loadSettings();
        await setElectronLocale(settings.locale);
    } catch (error) {
        logger.warn(`Failed to initialize Electron translations: ${getErrorMessage(error)}`);
        activeLocale = DEFAULT_LOCALE;
        activeMessages = en;
    }
}

export function te<TKey extends TTranslationKey>(path: TKey, ...args: TTeArgs<TKey>) {
    const params = normalizeTranslationParams(args[0]);
    const primary = getNestedTranslationLeaf(activeMessages, path);
    const fallback = getNestedTranslationLeaf(en, path);
    const leaf = primary ?? fallback ?? path;
    return formatTranslationLeaf(leaf, params, activeLocale);
}
