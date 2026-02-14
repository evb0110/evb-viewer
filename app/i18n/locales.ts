/* eslint-disable no-restricted-imports */
import de from '../locales/de';
import en from '../locales/en';
import es from '../locales/es';
import fr from '../locales/fr';
import it from '../locales/it';
import nl from '../locales/nl';
import pt from '../locales/pt';
import ru from '../locales/ru';
import type { EN_MESSAGE_SCHEMA } from './message-schema';

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

export const LOCALE_DEFINITIONS: ReadonlyArray<{
    code: TLocale;
    file: `${TLocale}.ts`;
    name: string;
}> = [
    {
        code: 'en',
        file: 'en.ts',
        name: 'English', 
    },
    {
        code: 'ru',
        file: 'ru.ts',
        name: 'Русский', 
    },
    {
        code: 'fr',
        file: 'fr.ts',
        name: 'Français', 
    },
    {
        code: 'de',
        file: 'de.ts',
        name: 'Deutsch', 
    },
    {
        code: 'es',
        file: 'es.ts',
        name: 'Español', 
    },
    {
        code: 'it',
        file: 'it.ts',
        name: 'Italiano', 
    },
    {
        code: 'pt',
        file: 'pt.ts',
        name: 'Português', 
    },
    {
        code: 'nl',
        file: 'nl.ts',
        name: 'Nederlands', 
    },
];

type TLocaleSchemaFrom<TNode> = {
    [TKey in keyof TNode]: TNode[TKey] extends string
        ? string
        : TNode[TKey] extends Record<string, unknown>
            ? TLocaleSchemaFrom<TNode[TKey]>
            : never;
};

type TBaseLocaleSchema = typeof EN_MESSAGE_SCHEMA;
export type TLocaleSchema = TLocaleSchemaFrom<TBaseLocaleSchema>;

export const LOCALE_MESSAGES = {
    en,
    ru,
    fr,
    de,
    es,
    it,
    pt,
    nl,
} as const satisfies Record<TLocale, TLocaleSchema>;

type TTranslationKeyFromNode<TNode extends Record<string, unknown>> = {
    [TKey in keyof TNode & string]: TNode[TKey] extends string
        ? TKey
        : TNode[TKey] extends Record<string, unknown>
            ? `${TKey}.${TTranslationKeyFromNode<TNode[TKey]>}`
            : never;
}[keyof TNode & string];

type TValueAtPath<TNode, TPath extends string> = TNode extends Record<string, unknown>
    ? TPath extends `${infer THead}.${infer TTail}`
        ? THead extends keyof TNode
            ? TValueAtPath<TNode[THead], TTail>
            : never
        : TPath extends keyof TNode
            ? TNode[TPath]
            : never
    : never;

type TTrim<TText extends string> = TText extends ` ${infer TRest}`
    ? TTrim<TRest>
    : TText extends `${infer TRest} `
        ? TTrim<TRest>
        : TText;

type TNormalizePlaceholder<TPlaceholder extends string> = TPlaceholder extends `${infer TKey},${string}`
    ? TTrim<TKey>
    : TTrim<TPlaceholder>;

type TPlaceholderNames<TText extends string> = TText extends `${string}{${infer TPlaceholder}}${infer TRest}`
    ? TNormalizePlaceholder<TPlaceholder> | TPlaceholderNames<TRest>
    : never;

type TPlaceholderValue<TKey extends string> = TKey extends 'count'
    ? number
    : string | number;

type TParamsFromMessage<TText extends string> = [TPlaceholderNames<TText>] extends [never]
    ? undefined
    : { [TKey in TPlaceholderNames<TText>]: TPlaceholderValue<TKey> };

export type TTranslationKey = TTranslationKeyFromNode<TBaseLocaleSchema>;

export type TTranslationMessage<TKey extends TTranslationKey> = TValueAtPath<TBaseLocaleSchema, TKey> extends string
    ? TValueAtPath<TBaseLocaleSchema, TKey>
    : never;

export type TTranslationParams<TKey extends TTranslationKey> = TParamsFromMessage<TTranslationMessage<TKey>>;

export type TTranslateFn = (
    key: TTranslationKey,
    params?: Record<string, string | number | undefined> | number,
) => string;
