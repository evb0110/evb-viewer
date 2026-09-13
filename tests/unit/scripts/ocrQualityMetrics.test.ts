import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    editDistance,
    measureOcrQuality,
    normalizeFaithfulOcrText,
    normalizeOcrText,
    retainsCriticalToken,
    tokenizeFaithfulOcrWords,
    tokenizeOcrWords,
} from '@scripts/ocrQualityMetrics.mjs';

describe('OCR quality metrics', () => {
    it('normalizes multilingual whitespace and dash variants without dropping identifiers', () => {
        expect(normalizeOcrText('  СЧЁТ\nQ7\u20112026  ')).toBe('счёт q7-2026');
        expect(tokenizeOcrWords('СЧЁТ Q7-2026 / 73.45')).toEqual([
            'счёт',
            'q7-2026',
            '73.45',
        ]);
    });

    it('calculates character and word edit rates over Unicode code points', () => {
        expect(editDistance(Array.from('счёт'), Array.from('счет'))).toBe(1);
        expect(measureOcrQuality('alpha beta', 'alpha zeta')).toMatchObject({
            cer: 0.1,
            wer: 0.5,
        });
    });

    it('uses NFC scalar sequences for the faithful score and keeps compatibility scoring explicit', () => {
        const result = measureOcrQuality('Invoice ABC', 'invoice abc');

        expect(result.faithful).toMatchObject({
            cer: expect.any(Number),
            wer: expect.any(Number),
            normalization: 'NFC',
            denominator: {
                cer: 11,
                wer: 2,
            },
            referenceEmpty: false,
        });
        expect(result.faithfulCer).toBeGreaterThan(0);
        expect(result.compatibility).toMatchObject({
            cer: 0,
            wer: 0,
            normalization: 'NFKC + lowercase(und) + Unicode dash folding',
            denominator: {
                cer: 11,
                wer: 2,
            },
        });
        expect(result.compatibilityCer).toBe(0);
    });

    it('treats canonically equivalent text as equal while preserving marks, digits and punctuation errors', () => {
        expect(normalizeFaithfulOcrText('e\u0301lan')).toBe('élan');
        expect(measureOcrQuality('e\u0301lan', 'élan').faithfulCer).toBe(0);
        expect(measureOcrQuality('Version １２３.', 'Version 123').faithfulCer).toBeGreaterThan(0);
        expect(measureOcrQuality('Version 123.', 'Version 124.').faithfulCer).toBeGreaterThan(0);
        expect(measureOcrQuality('Total: 42.', 'Total 42').faithfulCer).toBeGreaterThan(0);
        expect(measureOcrQuality('قَالَ', 'قَال').faithfulCer).toBeGreaterThan(0);
        expect(measureOcrQuality('A😀', 'A😀').faithful.denominator.cer).toBe(2);
    });

    it('keeps combining marks attached in Arabic, Hebrew, Syriac, Greek and Vietnamese words', () => {
        expect(tokenizeFaithfulOcrWords('قَالَ שָׁלוֹם ܫܠܵܡܵܐ ἄνθρωπος Tiếng Việt')).toEqual([
            'قَالَ',
            'שָׁלוֹם',
            'ܫܠܵܡܵܐ',
            'ἄνθρωπος',
            'Tiếng',
            'Việt',
        ]);
        expect(tokenizeFaithfulOcrWords('قَالَ')).toHaveLength(1);

        for (const [
            expected,
            actual,
        ] of [
                [
                    'قَالَ',
                    'قَال',
                ],
                [
                    'שָׁלוֹם',
                    'שלום',
                ],
                [
                    'ܫܠܵܡܵܐ',
                    'ܫܠܡܐ',
                ],
                [
                    'ἄνθρωπος',
                    'ανθρωπος',
                ],
                [
                    'Tiếng Việt',
                    'Tieng Viet',
                ],
            ]) {
            expect(measureOcrQuality(expected, actual).faithfulCer).toBeGreaterThan(0);
        }
    });

    it('reports inserted text against an empty reference instead of hiding it', () => {
        const result = measureOcrQuality('', 'OCR');

        expect(result.faithful).toMatchObject({
            referenceEmpty: true,
            insertedTextWithEmptyReference: true,
            denominator: {
                cer: 1,
                wer: 1,
            },
            cer: 3,
            wer: 1,
        });
    });

    it('changes only evaluation scores when the reference changes', () => {
        const actual = 'Reference text';
        const correctReference = measureOcrQuality(actual, actual);
        const wrongReference = measureOcrQuality('Deliberately wrong text', actual);

        expect(correctReference.faithful.normalizedActual).toBe(wrongReference.faithful.normalizedActual);
        expect(correctReference.faithfulCer).toBe(0);
        expect(wrongReference.faithfulCer).toBeGreaterThan(0);
    });

    it('requires exact normalized critical-token retention', () => {
        expect(retainsCriticalToken('Invoice INV\u20112048 total', 'inv-2048')).toBe(true);
        expect(retainsCriticalToken('Invoice INV-204B total', 'INV-2048')).toBe(false);
        expect(retainsCriticalToken('Archive box 190', '19')).toBe(false);
    });
});
