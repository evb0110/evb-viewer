import type { Simplify } from 'type-fest';
import type {
    IPluralMessage,
    TTranslationLeaf,
} from '@evb/i18n-core/messageFormat';

export type TLocaleSchemaFrom<TNode> = {
    [TKey in keyof TNode]: TNode[TKey] extends TTranslationLeaf
        ? string
        : TNode[TKey] extends object
            ? TLocaleSchemaFrom<TNode[TKey]>
            : never;
};

export type TLocaleMessagesShapeFrom<TNode> = {
    [TKey in keyof TNode]: TNode[TKey] extends IPluralMessage
        ? IPluralMessage
        : TNode[TKey] extends string
            ? string
            : TNode[TKey] extends object
                ? TLocaleMessagesShapeFrom<TNode[TKey]>
                : never;
};

export type TTranslationKeyFromNode<TNode extends object> = {
    [TKey in keyof TNode & string]: TNode[TKey] extends TTranslationLeaf
        ? TKey
        : TNode[TKey] extends object
            ? `${TKey}.${TTranslationKeyFromNode<TNode[TKey]>}`
            : never;
}[keyof TNode & string];

type TValueAtPath<TNode, TPath extends string> = TNode extends object
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

type THasPluralForms<TText extends string> = TText extends `${string}|${string}`
    ? true
    : false;

type TTextFromLeaf<TLeaf> = TLeaf extends string
    ? TLeaf
    : TLeaf extends IPluralMessage<infer TForms>
        ? TForms[keyof TForms] & string
        : never;

type TMessageParamNames<TLeaf> = TLeaf extends IPluralMessage<infer TText>
    ? TPlaceholderNames<TText[keyof TText] & string> | 'count'
    : TLeaf extends string
        ? THasPluralForms<TLeaf> extends true
            ? TPlaceholderNames<TLeaf> | 'count'
            : TPlaceholderNames<TLeaf>
        : never;

type TParamsFromMessage<TLeaf> = [TMessageParamNames<TLeaf>] extends [never]
    ? undefined
    : Simplify<{ [TKey in TMessageParamNames<TLeaf>]: TPlaceholderValue<TKey> }>;

export type TTranslationLeafFromSchema<
    TSchema extends object,
    TKey extends TTranslationKeyFromNode<TSchema>,
> = TValueAtPath<TSchema, TKey> extends TTranslationLeaf
    ? TValueAtPath<TSchema, TKey>
    : never;

export type TTranslationMessageFromSchema<
    TSchema extends object,
    TKey extends TTranslationKeyFromNode<TSchema>,
> = TTextFromLeaf<TTranslationLeafFromSchema<TSchema, TKey>>;

export type TTranslationParamsFromSchema<
    TSchema extends object,
    TKey extends TTranslationKeyFromNode<TSchema>,
> = TParamsFromMessage<TTranslationLeafFromSchema<TSchema, TKey>>;
