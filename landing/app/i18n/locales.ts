import de from '../locales/de';
import en from '../locales/en';
import es from '../locales/es';
import fr from '../locales/fr';
import it from '../locales/it';
import nl from '../locales/nl';
import pt from '../locales/pt';
import ptBr from '../locales/ptBr';
import ru from '../locales/ru';
import type {EN_MESSAGE_SCHEMA} from './enMessageSchema';
import {
    DEFAULT_LOCALE,
    LOCALE_CODES,
    LOCALE_DEFINITIONS,
    type TLocale,
    type TMessageParams,
    type TLocaleSchemaFrom,
    type TTranslationKeyFromNode,
    type TTranslationParamsFromSchema,
} from './core';

export {DEFAULT_LOCALE, LOCALE_CODES, LOCALE_DEFINITIONS, type TLocale};

type TBaseLocaleSchema = typeof EN_MESSAGE_SCHEMA;
export type TLocaleSchema = TLocaleSchemaFrom<TBaseLocaleSchema>;

export const LOCALE_MESSAGES = {
    de,
    en,
    es,
    fr,
    it,
    nl,
    pt,
    'pt-BR': ptBr,
    ru,
} as const satisfies Record<TLocale, TLocaleSchema>;

export type TTranslationKey = TTranslationKeyFromNode<TBaseLocaleSchema>;

export type TTranslationParams<TKey extends TTranslationKey> = TTranslationParamsFromSchema<TBaseLocaleSchema, TKey>;

export type TTranslateFn = (key: TTranslationKey, params?: TMessageParams | number) => string;
