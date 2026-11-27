import de from '@i18n-app/messages/de';
import en from '@i18n-app/messages/en';
import es from '@i18n-app/messages/es';
import fr from '@i18n-app/messages/fr';
import it from '@i18n-app/messages/it';
import nl from '@i18n-app/messages/nl';
import pt from '@i18n-app/messages/pt';
import ptBr from '@i18n-app/messages/ptBr';
import ru from '@i18n-app/messages/ru';
import {
    DEFAULT_LOCALE,
    type TLocaleMessagesShapeFrom,
    type TLocaleSchemaFrom,
    type TLocale,
    type TTranslationKeyFromNode,
    type TTranslationParamsFromSchema,
} from '@i18n-core';

export {
    DEFAULT_LOCALE,
    type TLocale,
};

type TBaseLocaleSchema = typeof en;
export type TLocaleSchema = TLocaleSchemaFrom<TBaseLocaleSchema>;
export const EN_MESSAGE_SCHEMA = en;

export const LOCALE_MESSAGES = {
    en,
    ru,
    fr,
    de,
    es,
    it,
    pt,
    'pt-BR': ptBr,
    nl,
} as const satisfies Record<TLocale, TLocaleMessagesShapeFrom<TBaseLocaleSchema>>;

export type TTranslationKey = TTranslationKeyFromNode<TBaseLocaleSchema>;

export type TTranslationParams<TKey extends TTranslationKey> = TTranslationParamsFromSchema<TBaseLocaleSchema, TKey>;

type TAllowsCountShortcut<TKey extends TTranslationKey> = [TKey] extends [never]
    ? false
    : TKey extends unknown
        ? TTranslationParams<TKey> extends { count: number }
            ? [Exclude<keyof TTranslationParams<TKey>, 'count'>] extends [never]
                ? true
                : false
            : false
        : never;

export type TTranslateArgs<TKey extends TTranslationKey> = TTranslationParams<TKey> extends undefined
    ? [params?: undefined]
    : [TAllowsCountShortcut<TKey>] extends [true]
        ? [params: TTranslationParams<TKey> | number]
        : [params: TTranslationParams<TKey>];

export type TTranslateFn = <TKey extends TTranslationKey>(
    key: TKey,
    ...args: TTranslateArgs<TKey>
) => string;
