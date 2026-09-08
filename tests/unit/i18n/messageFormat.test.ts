import {
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    normalizeTranslationParams,
    plural,
} from '@i18n-core';
import { LOCALE_MESSAGES } from '@i18n-app';
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

        expect(formatTranslationLeaf(selected, {count: 1}, 'ru')).toBe('Выбрана: 1 страница');
        expect(formatTranslationLeaf(selected, {count: 2}, 'ru')).toBe('Выбрано: 2 страницы');
        expect(formatTranslationLeaf(selected, {count: 5}, 'ru')).toBe('Выбрано: 5 страниц');
        expect(formatTranslationLeaf(selected, {count: 21}, 'ru')).toBe('Выбрана: 21 страница');
        expect(formatTranslationLeaf(selected, {count: 22}, 'ru')).toBe('Выбрано: 22 страницы');
        expect(formatTranslationLeaf(selected, {count: 25}, 'ru')).toBe('Выбрано: 25 страниц');
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
