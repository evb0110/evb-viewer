import type { TTranslationKey } from '@app/i18n/locales';

type TTypedTranslate = <TKey extends TTranslationKey>(
    key: TKey,
    params?: Record<string, string | number | undefined> | number,
) => string;

type TTypedComposer<TComposer extends { t: (...args: unknown[]) => string }> = Omit<TComposer, 't'> & {t: TTypedTranslate;};

export function useTypedI18n() {
    const composer = useI18n();
    return {
        ...composer,
        t: composer.t as TTypedTranslate,
    } as TTypedComposer<typeof composer>;
}
