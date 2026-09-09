import type { TLocale } from './localeCodes';

interface ICoreLocaleDefinition<TLocaleCode extends string = string> {
    code: TLocaleCode;
    file: `${string}.ts`;
    name: string;
    language: string;
}

export const LOCALE_DEFINITIONS = [
    {
        code: 'en',
        file: 'en.ts',
        name: 'English',
        language: 'en',
    },
    {
        code: 'ru',
        file: 'ru.ts',
        name: 'Русский',
        language: 'ru',
    },
    {
        code: 'fr',
        file: 'fr.ts',
        name: 'Français',
        language: 'fr',
    },
    {
        code: 'de',
        file: 'de.ts',
        name: 'Deutsch',
        language: 'de',
    },
    {
        code: 'es',
        file: 'es.ts',
        name: 'Español',
        language: 'es',
    },
    {
        code: 'it',
        file: 'it.ts',
        name: 'Italiano',
        language: 'it',
    },
    {
        code: 'pt',
        file: 'pt.ts',
        name: 'Português',
        language: 'pt',
    },
    {
        code: 'pt-BR',
        file: 'ptBr.ts',
        name: 'Português (Brasil)',
        language: 'pt-BR',
    },
    {
        code: 'nl',
        file: 'nl.ts',
        name: 'Nederlands',
        language: 'nl',
    },
] as const satisfies ReadonlyArray<ICoreLocaleDefinition<TLocale>>;
