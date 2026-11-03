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
        expect(formatTranslationLeaf(en.scanCleanup.pages.count, {count: 1}, 'en')).toBe('Source pages: 1');
        expect(formatTranslationLeaf(en.pageNumbering.targetAllPages, {count: 1}, 'en')).toBe('Target: all pages (1).');
        expect(formatTranslationLeaf(LOCALE_MESSAGES.de.print.summary, {
            count: 1,
            layout: 'Einzelseite',
            orientation: 'Hochformat',
        }, 'de')).toBe('1 Seite wird mit Einzelseite und Hochformat gedruckt.');
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
        expect(formatBytes(512, {
            t: translator('en'),
            locale: 'en',
        })).toBe('512 B');
    });
});
