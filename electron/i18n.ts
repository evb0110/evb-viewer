import {
    DEFAULT_LOCALE,
    LOCALE_MESSAGES,
    type TLocale,
    type TTranslationKey,
    type TTranslationParams,
} from '@app/i18n/locales';
import { getCurrentLocaleSync } from '@electron/settings';

type TMessageParams = Record<string, string | number>;
type TTeArgs<TKey extends TTranslationKey> = TTranslationParams<TKey> extends undefined
    ? [params?: undefined]
    : [params: TTranslationParams<TKey>];

function getNestedMessage(messages: Record<string, unknown>, path: TTranslationKey): string | null {
    const parts = path.split('.');
    let current: unknown = messages;

    for (const part of parts) {
        if (!current || typeof current !== 'object' || !(part in current)) {
            return null;
        }
        current = (current as Record<string, unknown>)[part];
    }

    return typeof current === 'string' ? current : null;
}

function selectPluralForm(template: string, count: number, locale: TLocale): string {
    const forms = template.split('|').map(part => part.trim());
    if (forms.length === 1) {
        return forms[0] ?? template;
    }

    if (locale === 'ru' && forms.length >= 3) {
        const mod10 = Math.abs(count) % 10;
        const mod100 = Math.abs(count) % 100;
        if (mod10 === 1 && mod100 !== 11) {
            return forms[0] ?? template;
        }
        if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
            return forms[1] ?? forms[0] ?? template;
        }
        return forms[2] ?? forms[1] ?? forms[0] ?? template;
    }

    return count === 1
        ? (forms[0] ?? template)
        : (forms[1] ?? forms[0] ?? template);
}

function interpolate(template: string, params?: TMessageParams, locale: TLocale = DEFAULT_LOCALE): string {
    const count = typeof params?.count === 'number' ? params.count : null;
    const withPlural = count === null
        ? template
        : selectPluralForm(template, count, locale);

    return withPlural.replace(/\{(\w+)\}/g, (_match, key: string) => {
        const value = params?.[key];
        return value === undefined
            ? `{${key}}`
            : String(value);
    });
}

function resolveLocale(locale: string): TLocale {
    return locale in LOCALE_MESSAGES
        ? locale as TLocale
        : DEFAULT_LOCALE;
}

export function te<TKey extends TTranslationKey>(path: TKey, ...args: TTeArgs<TKey>): string {
    const params = args[0] as TMessageParams | undefined;
    const locale = getCurrentLocaleSync();
    const resolvedLocale = resolveLocale(locale);
    const primary = getNestedMessage(LOCALE_MESSAGES[resolvedLocale], path);
    const fallback = getNestedMessage(LOCALE_MESSAGES[DEFAULT_LOCALE], path);
    const template = primary ?? fallback ?? path;
    return interpolate(template, params, resolvedLocale);
}
