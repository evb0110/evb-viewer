import type { TTranslationKey } from '@app/i18n/locales';
import type { TI18nComposer } from '@app/types/i18n';

type TTypedTranslate = <TKey extends TTranslationKey>(
    key: TKey,
    params?: Record<string, string | number | undefined> | number,
) => string;

type TTypedComposer = Omit<TI18nComposer, 't'> & {t: TTypedTranslate;};

export function useTypedI18n(): TTypedComposer {
    const composer = useI18n() as TI18nComposer;
    return {
        ...composer,
        t: composer.t as TTypedTranslate,
    };
}
