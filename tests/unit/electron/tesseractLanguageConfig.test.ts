import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    isRtlOcrLanguage,
    resolveTesseractLanguageConfig,
} from '@electron/ocr/tesseract-language-config';

describe('resolveTesseractLanguageConfig', () => {
    it('keeps non-rtl language order and applies spacing config', () => {
        const config = resolveTesseractLanguageConfig([
            'eng',
            'fra',
            'deu',
        ]);

        expect(config.orderedLanguages).toEqual([
            'eng',
            'fra',
            'deu',
        ]);
        expect(config.hasRtl).toBe(false);
        expect(config.extraConfigArgs).toContain('preserve_interword_spaces=1');
    });

    it('moves rtl languages before latin languages and skips latin config', () => {
        const config = resolveTesseractLanguageConfig([
            'eng',
            'heb',
            'fra',
            'syr',
        ]);

        expect(config.orderedLanguages).toEqual([
            'heb',
            'syr',
            'eng',
            'fra',
        ]);
        expect(config.hasRtl).toBe(true);
        expect(config.extraConfigArgs).toEqual([]);
    });

    it('uses empty config for rtl-only languages', () => {
        const config = resolveTesseractLanguageConfig(['heb']);

        expect(config.hasRtl).toBe(true);
        expect(config.extraConfigArgs).toEqual([]);
    });

    it('deduplicates languages while preserving relative order within groups', () => {
        const config = resolveTesseractLanguageConfig([
            'eng',
            'heb',
            'eng',
            'heb',
            'deu',
        ]);

        expect(config.orderedLanguages).toEqual([
            'heb',
            'eng',
            'deu',
        ]);
    });
});

describe('isRtlOcrLanguage', () => {
    it('returns true for rtl language codes and false otherwise', () => {
        expect(isRtlOcrLanguage('heb')).toBe(true);
        expect(isRtlOcrLanguage('syr')).toBe(true);
        expect(isRtlOcrLanguage('eng')).toBe(false);
        expect(isRtlOcrLanguage('ara')).toBe(false);
    });
});
