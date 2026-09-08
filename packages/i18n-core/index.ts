export {
    DEFAULT_LOCALE,
    isSupportedLocale,
    LOCALE_CODES,
    resolveLocale,
    type TLocale,
} from '@evb/i18n-core/localeCodes';

export { LOCALE_DEFINITIONS } from '@evb/i18n-core/localeDefinitions';

export {
    PRIVACY_MESSAGES,
    type IPrivacyMessages,
    type IPrivacySectionMessages,
} from '@evb/i18n-core/privacyMessages';

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
} from '@evb/i18n-core/messageFormat';

export type {
    TLocaleMessagesShapeFrom,
    TLocaleSchemaFrom,
    TTranslationLeafFromSchema,
    TTranslationKeyFromNode,
    TTranslationMessageFromSchema,
    TTranslationParamsFromSchema,
} from '@evb/i18n-core/schemaTypes';

export type {
    ILocaleComposerMethods,
    TTypedI18nComposer,
} from '@evb/i18n-core/createTypedI18nComposer';

export { createTypedI18nComposer } from '@evb/i18n-core/createTypedI18nComposer';
