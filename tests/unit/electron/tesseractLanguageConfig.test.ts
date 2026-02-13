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

    it('moves rtl languages before latin languages and disables latin spacing config', () => {
        const config = resolveTesseractLanguageConfig([
            'eng',
            'ara',
            'fra',
            'heb',
        ]);

        expect(config.orderedLanguages).toEqual([
            'ara',
            'heb',
            'eng',
            'fra',
        ]);
        expect(config.hasRtl).toBe(true);
        expect(config.extraConfigArgs).toEqual([]);
    });

    it('deduplicates languages while preserving relative order within groups', () => {
        const config = resolveTesseractLanguageConfig([
            'eng',
            'ara',
            'eng',
            'ara',
            'deu',
        ]);

        expect(config.orderedLanguages).toEqual([
            'ara',
            'eng',
            'deu',
        ]);
    });
});

describe('isRtlOcrLanguage', () => {
    it('returns true for rtl language codes and false otherwise', () => {
        expect(isRtlOcrLanguage('ara')).toBe(true);
        expect(isRtlOcrLanguage('heb')).toBe(true);
        expect(isRtlOcrLanguage('syr')).toBe(true);
        expect(isRtlOcrLanguage('eng')).toBe(false);
    });
});
