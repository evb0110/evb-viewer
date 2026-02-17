export const LOCALE_CODES = [
    'en',
    'ru',
    'fr',
    'de',
    'es',
    'it',
    'pt',
    'nl',
] as const;

export type TLocale = typeof LOCALE_CODES[number];

export const DEFAULT_LOCALE: TLocale = 'en';
