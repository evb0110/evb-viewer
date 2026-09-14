import {
    describe,
    expect,
    it,
} from 'vitest';
import type { TLocale } from '@i18n-app';
import { LOCALE_CODES } from '@i18n-core';
import {
    AVAILABLE_OCR_LANGUAGES,
    hasSingleOcrLanguageSelection,
} from '@contracts/ocrLanguages';
import type { IOcrLanguage } from '@contracts/shared';
import {
    OCR_LANGUAGE_ENGLISH_FALLBACK_NAMES,
    buildOcrLanguagePickerItems,
    findFailedOcrLanguageCodes,
    resolveOcrLanguageDisplayName,
    resolveOcrLanguageShortCode,
    shouldShowOcrLanguageSearch,
} from '@app/modules/ocr-panel/runtime/useOcrPopupPresenter';

describe('OCR language display names', () => {
    it('resolves every registry code in every UI locale', () => {
        for (const locale of LOCALE_CODES) {
            for (const language of AVAILABLE_OCR_LANGUAGES) {
                const name = resolveOcrLanguageDisplayName(language.code, locale);

                expect(name.trim()).not.toBe('');
                expect(name.toLocaleLowerCase(locale)).not.toBe(
                    language.code.toLocaleLowerCase(locale),
                );
            }
        }
    });

    it('falls back to one English map and finally the raw code', () => {
        for (const language of AVAILABLE_OCR_LANGUAGES) {
            expect(resolveOcrLanguageDisplayName(language.code, 'en', null)).toBe(
                OCR_LANGUAGE_ENGLISH_FALLBACK_NAMES[language.code],
            );
        }
        expect(resolveOcrLanguageDisplayName('qaa', 'en', null)).toBe('qaa');
    });
});

describe('OCR language picker ordering and filtering', () => {
    const languages = [
        {
            code: 'spa',
            script: 'latin',
            modelState: 'missing',
        },
        {
            code: 'eng',
            script: 'latin',
            modelState: 'installed',
        },
        {
            code: 'fra',
            script: 'latin',
            modelState: 'installed',
        },
        {
            code: 'rus',
            script: 'cyrillic',
            modelState: 'missing',
        },
        {
            code: 'deu',
            script: 'latin',
            modelState: 'downloading',
        },
    ] satisfies IOcrLanguage[];

    it('orders the selected language before installed and not-installed languages', () => {
        const items = buildOcrLanguagePickerItems(
            languages,
            ['rus'],
            'en',
            '',
            new Set(),
        );

        expect(items.map(item => [
            item.value,
            item.group,
        ])).toEqual([
            [
                'rus',
                'selected',
            ],
            [
                'eng',
                'installed',
            ],
            [
                'fra',
                'installed',
            ],
            [
                'deu',
                'missing',
            ],
            [
                'spa',
                'missing',
            ],
        ]);
    });

    it('carries the code every chip renders so the list explains itself', () => {
        const items = buildOcrLanguagePickerItems(
            AVAILABLE_OCR_LANGUAGES,
            [],
            'en',
            '',
            new Set(),
        );

        expect(items).toHaveLength(AVAILABLE_OCR_LANGUAGES.length);
        for (const item of items) {
            expect(item.value).toMatch(/^[a-z]{3}$/u);
        }
    });

    it('uses the supplied localized registry names and keeps unknown availability explicit', () => {
        const items = buildOcrLanguagePickerItems(
            [
                {
                    code: 'grc',
                    script: 'greek',
                },
                {
                    code: 'syr',
                    script: 'rtl',
                },
            ],
            [],
            'en',
            '',
            new Set(),
            code => code === 'grc' ? 'Ancient Greek' : 'Syriac',
        );

        expect(items.map(item => [
            item.label,
            item.modelState,
        ])).toEqual([
            [
                'Ancient Greek',
                'unavailable',
            ],
            [
                'Syriac',
                'unavailable',
            ],
        ]);
    });

    it('finds a language by its familiar two-letter code in every UI locale', () => {
        const byQuery = (query: string, locale: TLocale) => buildOcrLanguagePickerItems(
            AVAILABLE_OCR_LANGUAGES,
            [],
            locale,
            query,
            new Set(),
        ).map(item => item.value);

        for (const locale of LOCALE_CODES) {
            expect(byQuery('pt', locale)).toContain('por');
            expect(byQuery('ru', locale)).toContain('rus');
            expect(byQuery('de', locale)).toContain('deu');
            expect(byQuery('el', locale)).toContain('ell');
        }
    });

    it('accepts the bibliographic code a user is likely to remember', () => {
        const byQuery = (query: string, locale: TLocale = 'en') => buildOcrLanguagePickerItems(
            AVAILABLE_OCR_LANGUAGES,
            [],
            locale,
            query,
            new Set(),
        ).map(item => item.value);

        // `rum` shares no substring with "Romanian" or "румынский", so only the
        // canonicalized query can find it.
        expect(byQuery('rum')).toEqual(['ron']);
        expect(byQuery('rum', 'ru')).toEqual(['ron']);
        expect(byQuery('ger', 'ru')).toEqual(['deu']);
    });

    it('finds a language by its English name while the UI runs in another locale', () => {
        expect(buildOcrLanguagePickerItems(
            AVAILABLE_OCR_LANGUAGES,
            [],
            'ru',
            'Portuguese',
            new Set(),
        ).map(item => item.value)).toEqual(['por']);
    });

    it('derives short codes rather than inventing them', () => {
        expect(resolveOcrLanguageShortCode('por')).toBe('pt');
        expect(resolveOcrLanguageShortCode('srp')).toBe('sr');
        expect(resolveOcrLanguageShortCode('grc')).toBeNull();
        expect(resolveOcrLanguageShortCode('syr')).toBeNull();
        expect(resolveOcrLanguageShortCode('not a locale')).toBeNull();
    });

    it('returns nothing for a query that matches no language', () => {
        expect(buildOcrLanguagePickerItems(
            AVAILABLE_OCR_LANGUAGES,
            [],
            'en',
            'zzzz',
            new Set(),
        )).toEqual([]);
    });

    it('filters by localized name and Tesseract code', () => {
        expect(buildOcrLanguagePickerItems(
            languages,
            [],
            'es',
            'alemán',
            new Set(),
        ).map(item => item.value)).toEqual(['deu']);
        expect(buildOcrLanguagePickerItems(
            languages,
            [],
            'es',
            'spa',
            new Set(),
        ).map(item => item.value)).toEqual(['spa']);
    });

    it('marks a language named in a job error as failed', () => {
        const failedCodes = findFailedOcrLanguageCodes(
            languages,
            'Failed to download OCR language model "spa" after 3 attempts',
        );
        const items = buildOcrLanguagePickerItems(languages, [], 'en', '', failedCodes);

        expect(failedCodes).toEqual(new Set(['spa']));
        expect(items.find(item => item.value === 'spa')?.modelState).toBe('error');
    });

    it('only treats quoted codes as failures, not prose words', () => {
        const withNorwegian = [
            ...languages,
            {
                code: 'nor',
                script: 'latin',
                modelState: 'missing',
            },
        ] satisfies IOcrLanguage[];

        expect(findFailedOcrLanguageCodes(
            withNorwegian,
            'Neither the proxy nor the network allowed the download',
        )).toEqual(new Set());
        expect(findFailedOcrLanguageCodes(
            withNorwegian,
            'OCR language model "nor" is unavailable (HTTP 404). Verify language configuration and try again.',
        )).toEqual(new Set(['nor']));
    });

    it('shows the language search at its threshold and accepts one language only', () => {
        expect(shouldShowOcrLanguageSearch(12)).toBe(false);
        expect(shouldShowOcrLanguageSearch(13)).toBe(true);
        expect(hasSingleOcrLanguageSelection(['eng'])).toBe(true);
        expect(hasSingleOcrLanguageSelection([
            'eng',
            'rus',
        ])).toBe(false);
    });
});
