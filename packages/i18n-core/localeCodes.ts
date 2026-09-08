export const LOCALE_CODES = [
    'en',
    'ru',
    'fr',
    'de',
    'es',
    'it',
    'pt',
    'pt-BR',
    'nl',
] as const;

export type TLocale = typeof LOCALE_CODES[number];

export const DEFAULT_LOCALE = 'en' satisfies TLocale;

const LOCALE_CODES_BY_NORMALIZED_VALUE = new Map<string, TLocale>(
    LOCALE_CODES.map(locale => [
        locale.toLowerCase(),
        locale,
    ]),
);

export function isSupportedLocale(value: unknown): boolean {
    if (typeof value !== 'string') {
        return false;
    }

    const normalizedValue = value.trim().toLowerCase();
    return LOCALE_CODES_BY_NORMALIZED_VALUE.has(normalizedValue)
        || LOCALE_CODES_BY_NORMALIZED_VALUE.has(normalizedValue.split('-')[0] ?? '');
}

export function resolveLocale(value: unknown): TLocale {
    if (typeof value !== 'string') {
        return DEFAULT_LOCALE;
    }

    const normalizedValue = value.trim().toLowerCase();
    const exactLocale = LOCALE_CODES_BY_NORMALIZED_VALUE.get(normalizedValue);
    if (exactLocale) {
        return exactLocale;
    }

    const baseLocale = normalizedValue.split('-')[0] ?? '';
    return LOCALE_CODES_BY_NORMALIZED_VALUE.get(baseLocale) ?? DEFAULT_LOCALE;
}
