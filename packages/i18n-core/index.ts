export {
    DEFAULT_LOCALE,
    isSupportedLocale,
    LOCALE_CODES,
    resolveLocale,
    type TLocale,
} from '@i18n-core/localeCodes';

export { LOCALE_DEFINITIONS } from '@i18n-core/localeDefinitions';

export {
    PRIVACY_MESSAGES,
    type IPrivacyMessages,
    type IPrivacySectionMessages,
} from '@i18n-core/privacyMessages';

export {
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    isLocaleMessageSource,
    isPluralMessage,
    normalizeTranslationParams,
    plural,
    type ILocaleMessageSource,
    type IPluralMessage,
    type TMessageInterpolationValue,
    type TMessageParams,
    type TPluralCategory,
    type IPluralForms,
    type TTranslationLeaf,
} from '@i18n-core/messageFormat';

export type {
    TLocaleMessagesShapeFrom,
    TLocaleSchemaFrom,
    TTranslationLeafFromSchema,
    TTranslationKeyFromNode,
    TTranslationMessageFromSchema,
    TTranslationParamsFromSchema,
} from '@i18n-core/schemaTypes';

export type {
    ILocaleComposerMethods,
    TTypedI18nComposer,
} from '@i18n-core/createTypedI18nComposer';

export { createTypedI18nComposer } from '@i18n-core/createTypedI18nComposer';
