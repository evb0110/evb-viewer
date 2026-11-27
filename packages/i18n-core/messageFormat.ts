const PLURAL_MESSAGE_KIND = 'plural';

export type TPluralCategory = Intl.LDMLPluralRule;
export type TMessageInterpolationValue = string | number;
export type TMessageParams = Record<string, TMessageInterpolationValue>;

export interface IPluralForms<TText extends string = string> {
    other: TText;
    zero?: TText;
    one?: TText;
    two?: TText;
    few?: TText;
    many?: TText;
}

export interface IPluralMessage<TForms extends IPluralForms = IPluralForms> {
    kind: typeof PLURAL_MESSAGE_KIND;
    forms: TForms;
}

export type TTranslationLeaf = string | IPluralMessage;

export function plural<const TForms extends IPluralForms>(forms: TForms): IPluralMessage<TForms> {
    return {
        kind: PLURAL_MESSAGE_KIND,
        forms,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function isPluralMessage(value: unknown): value is IPluralMessage {
    if (!isRecord(value)) {
        return false;
    }

    return value.kind === PLURAL_MESSAGE_KIND && isRecord(value.forms);
}

export function normalizeTranslationParams(rawParams?: number | TMessageParams): TMessageParams | undefined {
    if (typeof rawParams === 'number') {
        return {count: rawParams};
    }

    return rawParams;
}

export interface ILocaleMessageSource {
    getLocaleMessage: (locale: string) => Record<string, unknown>;
}

// Narrows loosely typed composer access (e.g. `nuxtApp.$i18n` outside a component
// setup context) to the one method the plain-message helpers below need.
export function isLocaleMessageSource(value: unknown): value is ILocaleMessageSource {
    return isRecord(value) && typeof value.getLocaleMessage === 'function';
}

export function getNestedTranslationLeaf(messages: Record<string, unknown>, path: string): TTranslationLeaf | null {
    const parts = path.split('.');
    let current: unknown = messages;

    for (const part of parts) {
        if (!isRecord(current) || !(part in current)) {
            return null;
        }

        current = current[part];
    }

    return typeof current === 'string' || isPluralMessage(current) ? current : null;
}

const pluralRulesCache = new Map<string, Intl.PluralRules>();

function getPluralRules(locale: string): Intl.PluralRules {
    const cached = pluralRulesCache.get(locale);
    if (cached) {
        return cached;
    }

    const rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
    return rules;
}

function getPluralCategory(locale: string, count: number): TPluralCategory {
    return getPluralRules(locale).select(count);
}

function fallbackForm(forms: string[], template: string, ...indices: number[]) {
    for (const index of indices) {
        const form = forms[index];
        if (form !== undefined) {
            return form;
        }
    }

    return template;
}

function selectPluralMessageForm(message: IPluralMessage, count: number | null, locale: string) {
    if (count === null) {
        return message.forms.other;
    }

    if (count === 0 && message.forms.zero) {
        return message.forms.zero;
    }

    const category = getPluralCategory(locale, count);
    return message.forms[category] ?? message.forms.other;
}

function selectLegacyPipeForm(template: string, count: number, locale: string) {
    const forms = template.split('|').map((part) => part.trim());
    if (forms.length === 1) {
        return forms[0] ?? template;
    }

    const category = getPluralCategory(locale, count);
    if (forms.length === 2) {
        return category === 'one' ? fallbackForm(forms, template, 0) : fallbackForm(forms, template, 1, 0);
    }

    if (forms.length === 3) {
        return category === 'one'
            ? fallbackForm(forms, template, 0)
            : category === 'few'
              ? fallbackForm(forms, template, 1, 0)
              : fallbackForm(forms, template, 2, 1, 0);
    }

    return category === 'zero'
        ? fallbackForm(forms, template, 0)
        : category === 'one'
          ? fallbackForm(forms, template, 1, 0)
          : category === 'two' || category === 'few'
            ? fallbackForm(forms, template, 2, 1, 0)
            : (forms.at(-1) ?? template);
}

export function formatTranslationLeaf(leaf: TTranslationLeaf | string, params?: TMessageParams, locale = 'en') {
    const count = typeof params?.count === 'number' ? params.count : null;
    const template = isPluralMessage(leaf)
        ? selectPluralMessageForm(leaf, count, locale)
        : count === null
          ? leaf
          : selectLegacyPipeForm(leaf, count, locale);

    return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
        const value = params?.[key];
        return value === undefined ? `{${key}}` : String(value);
    });
}
