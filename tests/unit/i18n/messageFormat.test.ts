import {
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    normalizeTranslationParams,
    plural,
} from '@i18n-core';
import {
    LOCALE_MESSAGES,
    type TTranslateFn,
} from '@i18n-app';
import {formatBytes} from '@app/utils/formatters';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('message formatting', () => {
    it('selects plural message categories and zero overrides', () => {
        const leaf = plural({
            zero: 'no files',
            one: '{count} file',
            few: '{count} files few',
            many: '{count} files many',
            other: '{count} files',
        });

        expect(formatTranslationLeaf(leaf, { count: 0 }, 'en')).toBe('no files');
        expect(formatTranslationLeaf(leaf, { count: 1 }, 'en')).toBe('1 file');
        expect(formatTranslationLeaf(leaf, { count: 2 }, 'ru')).toBe('2 files few');
        expect(formatTranslationLeaf(leaf, { count: 5 }, 'ru')).toBe('5 files many');
        expect(formatTranslationLeaf(leaf, { count: 3 }, 'en')).toBe('3 files');
    });

    it('formats the Russian scan cleanup selection message with the correct case', () => {
        const selected = LOCALE_MESSAGES.ru.scanCleanup.settings.scope.selected;

        expect(formatTranslationLeaf(selected, {count: 1}, 'ru')).toBe('Выбрана 1');
        expect(formatTranslationLeaf(selected, {count: 2}, 'ru')).toBe('Выбрано 2');
        expect(formatTranslationLeaf(selected, {count: 5}, 'ru')).toBe('Выбрано 5');
        expect(formatTranslationLeaf(selected, {count: 21}, 'ru')).toBe('Выбрана 21');
        expect(formatTranslationLeaf(selected, {count: 22}, 'ru')).toBe('Выбрано 22');
        expect(formatTranslationLeaf(selected, {count: 25}, 'ru')).toBe('Выбрано 25');
    });

    it('names a single page in the singular where a count can be one', () => {
        const en = LOCALE_MESSAGES.en;
        expect(formatTranslationLeaf(en.print.summary, {
            count: 1,
            layout: 'Single page',
            orientation: 'Portrait',
        }, 'en')).toBe('Printing 1 page with Single page and Portrait orientation.');
        expect(formatTranslationLeaf(en.scanCleanup.pages.count, {count: 1}, 'en')).toBe('1 source page');
        expect(formatTranslationLeaf(en.pageNumbering.targetAllPages, {count: 1}, 'en')).toBe('Target: all pages (1).');
        expect(formatTranslationLeaf(LOCALE_MESSAGES.de.print.summary, {
            count: 1,
            layout: 'Einzelseite',
            orientation: 'Hochformat',
        }, 'de')).toBe('1 Seite wird mit Einzelseite und Hochformat gedruckt.');
    });

    it.each([
        [
            'en',
            0,
            '0 source pages',
            'Printing 0 pages with L and O orientation.',
        ],
        [
            'en',
            1,
            '1 source page',
            'Printing 1 page with L and O orientation.',
        ],
        [
            'en',
            2,
            '2 source pages',
            'Printing 2 pages with L and O orientation.',
        ],
        [
            'de',
            0,
            '0 Quellseiten',
            '0 Seiten werden mit L und O gedruckt.',
        ],
        [
            'de',
            1,
            '1 Quellseite',
            '1 Seite wird mit L und O gedruckt.',
        ],
        [
            'de',
            2,
            '2 Quellseiten',
            '2 Seiten werden mit L und O gedruckt.',
        ],
        [
            'fr',
            0,
            '0 page source',
            'Impression de 0 page avec L et l’orientation O.',
        ],
        [
            'fr',
            1,
            '1 page source',
            'Impression de 1 page avec L et l’orientation O.',
        ],
        [
            'fr',
            2,
            '2 pages sources',
            'Impression de 2 pages avec L et l’orientation O.',
        ],
        [
            'es',
            0,
            '0 páginas de origen',
            'Imprimiendo 0 páginas con diseño L y orientación O.',
        ],
        [
            'es',
            1,
            '1 página de origen',
            'Imprimiendo 1 página con diseño L y orientación O.',
        ],
        [
            'es',
            2,
            '2 páginas de origen',
            'Imprimiendo 2 páginas con diseño L y orientación O.',
        ],
        [
            'it',
            0,
            '0 pagine di origine',
            'Stampa di 0 pagine con layout L e orientamento O.',
        ],
        [
            'it',
            1,
            '1 pagina di origine',
            'Stampa di 1 pagina con layout L e orientamento O.',
        ],
        [
            'it',
            2,
            '2 pagine di origine',
            'Stampa di 2 pagine con layout L e orientamento O.',
        ],
        [
            'nl',
            0,
            '0 bronpagina\'s',
            '0 pagina\'s afdrukken met L en O oriëntatie.',
        ],
        [
            'nl',
            1,
            '1 bronpagina',
            '1 pagina afdrukken met L en O oriëntatie.',
        ],
        [
            'nl',
            2,
            '2 bronpagina\'s',
            '2 pagina\'s afdrukken met L en O oriëntatie.',
        ],
        [
            'pt',
            0,
            '0 páginas de origem',
            'A imprimir 0 página com L e orientação O.',
        ],
        [
            'pt',
            1,
            '1 página de origem',
            'A imprimir 1 página com L e orientação O.',
        ],
        [
            'pt',
            2,
            '2 páginas de origem',
            'A imprimir 2 páginas com L e orientação O.',
        ],
        [
            'pt-BR',
            0,
            '0 páginas de origem',
            'Imprimindo 0 página com layout L e orientação O.',
        ],
        [
            'pt-BR',
            1,
            '1 página de origem',
            'Imprimindo 1 página com layout L e orientação O.',
        ],
        [
            'pt-BR',
            2,
            '2 páginas de origem',
            'Imprimindo 2 páginas com layout L e orientação O.',
        ],
        [
            'ru',
            0,
            '0 исходных страниц',
            'Печать страниц: 0; макет: L; ориентация: O.',
        ],
        [
            'ru',
            1,
            '1 исходная страница',
            'Печать страниц: 1; макет: L; ориентация: O.',
        ],
        [
            'ru',
            2,
            '2 исходные страницы',
            'Печать страниц: 2; макет: L; ориентация: O.',
        ],
    ] as const)('renders source and print counts in %s at %s', (locale, count, rail, summary) => {
        const messages = LOCALE_MESSAGES[locale];
        expect(formatTranslationLeaf(messages.scanCleanup.pages.count, {count}, locale)).toBe(rail);
        expect(formatTranslationLeaf(messages.print.summary, {
            count,
            layout: 'L',
            orientation: 'O',
        }, locale)).toBe(summary);
    });

    it.each([
        [
            5,
            '5 исходных страниц',
        ],
        [
            11,
            '11 исходных страниц',
        ],
        [
            21,
            '21 исходная страница',
        ],
        [
            22,
            '22 исходные страницы',
        ],
        [
            25,
            '25 исходных страниц',
        ],
        [
            1.5,
            '1.5 исходной страницы',
        ],
    ] as const)('renders Russian source count %s', (count, expected) => {
        expect(formatTranslationLeaf(LOCALE_MESSAGES.ru.scanCleanup.pages.count, {count}, 'ru')).toBe(expected);
        expect(formatTranslationLeaf(LOCALE_MESSAGES.ru.print.summary, {
            count,
            layout: 'L',
            orientation: 'O',
        }, 'ru'))
            .toBe(`Печать страниц: ${count}; макет: L; ориентация: O.`);
    });

    it.each([
        [
            'fr',
            '1000000 pages sources',
            'Impression de 1000000 pages avec L et l’orientation O.',
        ],
        [
            'es',
            '1000000 páginas de origen',
            'Imprimiendo 1000000 páginas con diseño L y orientación O.',
        ],
        [
            'it',
            '1000000 pagine di origine',
            'Stampa di 1000000 pagine con layout L e orientamento O.',
        ],
        [
            'pt',
            '1000000 páginas de origem',
            'A imprimir 1000000 páginas com L e orientação O.',
        ],
        [
            'pt-BR',
            '1000000 páginas de origem',
            'Imprimindo 1000000 páginas com layout L e orientação O.',
        ],
    ] as const)('falls back to the other Romance form in %s', (locale, rail, summary) => {
        expect(formatTranslationLeaf(LOCALE_MESSAGES[locale].scanCleanup.pages.count, {count: 1_000_000}, locale)).toBe(rail);
        expect(formatTranslationLeaf(LOCALE_MESSAGES[locale].print.summary, {
            count: 1_000_000,
            layout: 'L',
            orientation: 'O',
        }, locale)).toBe(summary);
    });

    it('continues to support legacy pipe-delimited messages', () => {
        expect(formatTranslationLeaf('{count} note | {count} notes', { count: 2 }, 'en')).toBe('2 notes');
        expect(formatTranslationLeaf('{count} note | {count} notes', { count: 1 }, 'en')).toBe('1 note');
    });

    it('supports three-form and four-form legacy pipe messages', () => {
        expect(formatTranslationLeaf('{count} file | {count} files few | {count} files many', { count: 2 }, 'ru')).toBe('2 files few');
        expect(formatTranslationLeaf('{count} file | {count} files few | {count} files many', { count: 5 }, 'ru')).toBe('5 files many');
        expect(formatTranslationLeaf('none | {count} one | {count} few | {count} many', { count: 0 }, 'ar')).toBe('none');
        expect(formatTranslationLeaf('none | {count} one | {count} few | {count} many', { count: 1 }, 'en')).toBe('1 one');
        expect(formatTranslationLeaf('none | {count} one | {count} few | {count} many', { count: 3 }, 'ru')).toBe('3 few');
        expect(formatTranslationLeaf('none | {count} one | {count} few | {count} many', { count: 5 }, 'ru')).toBe('5 many');
    });

    it('falls back to other plural forms when count or locale-specific category is missing', () => {
        const leaf = plural({
            one: '{count} exact',
            other: 'fallback',
        });

        expect(formatTranslationLeaf(leaf, undefined, 'en')).toBe('fallback');
        expect(formatTranslationLeaf(leaf, { count: 2 }, 'ru')).toBe('fallback');
    });

    it('leaves missing interpolation placeholders intact', () => {
        expect(formatTranslationLeaf('Hello {name}, {missing}', { name: 'Ada' })).toBe('Hello Ada, {missing}');
    });

    it('normalizes numeric shorthand params to count', () => {
        expect(normalizeTranslationParams(3)).toEqual({ count: 3 });
        expect(normalizeTranslationParams({ count: 4 })).toEqual({ count: 4 });
    });

    it('returns null for missing nested keys and non-leaf values', () => {
        const messages = {nested: {
            hit: 'Hello',
            object: { value: true },
        }};

        expect(getNestedTranslationLeaf(messages, 'nested.hit')).toBe('Hello');
        expect(getNestedTranslationLeaf(messages, 'nested.missing')).toBeNull();
        expect(getNestedTranslationLeaf(messages, 'nested.object')).toBeNull();
    });
});

function translator(locale: 'en' | 'fr' | 'ru'): TTranslateFn {
    return ((key: string) => formatTranslationLeaf(
        key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], LOCALE_MESSAGES[locale]) as string,
        undefined,
        locale,
    )) as TTranslateFn;
}

describe('formatBytes', () => {
    it('states a size with the language units and decimal separator', () => {
        expect(formatBytes(1536, {
            t: translator('fr'),
            locale: 'fr',
        })).toBe('1,50 Ko');
        expect(formatBytes(1536, {
            t: translator('en'),
            locale: 'en',
        })).toBe('1.50 KB');
        expect(formatBytes(5 * 1024 ** 3, {
            t: translator('ru'),
            locale: 'ru',
        })).toBe('5,00 ГБ');
        expect(formatBytes(1024 ** 4, {
            t: translator('en'),
            locale: 'en',
        })).toBe('1.00 TB');
        expect(formatBytes(512, {
            t: translator('en'),
            locale: 'en',
        })).toBe('512 B');
    });
});
