import type {Merge, Simplify} from 'type-fest';

export interface ILocaleComposerMethods<TLocale extends string> {
    setLocale: (locale: TLocale) => Promise<void>;
    loadLocaleMessages: (locale: TLocale) => Promise<void>;
}

export type TTypedI18nComposer<TComposer extends object, TTranslateFn, TLocale extends string> = Simplify<
    Merge<TComposer, ILocaleComposerMethods<TLocale> & {t: TTranslateFn}>
>;

export function createTypedI18nComposer<
    TComposer extends {t: TTranslateFn} & Partial<ILocaleComposerMethods<TLocale>>,
    TTranslateFn,
    TLocale extends string,
>(composer: TComposer): TTypedI18nComposer<TComposer, TTranslateFn, TLocale> {
    const setLocale = async (locale: TLocale) => {
        await composer.setLocale?.(locale);
    };
    const loadLocaleMessages = async (locale: TLocale) => {
        await composer.loadLocaleMessages?.(locale);
    };

    return {
        ...composer,
        setLocale,
        loadLocaleMessages,
    } as TTypedI18nComposer<TComposer, TTranslateFn, TLocale>;
}
