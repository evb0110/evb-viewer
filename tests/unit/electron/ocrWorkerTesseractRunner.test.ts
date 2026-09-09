import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    parseTsvOcrData,
    parseTsvOutput,
    shouldNormalizeGreekMicroSign,
} from '@electron/features/ocr/worker/tesseractRunner';

describe('parseTsvOutput', () => {
    it('preserves line boxes positioned at the top of the page', () => {
        const tsv = [
            'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
            '4\t1\t1\t1\t1\t0\t10\t0\t40\t12\t-1\t',
            '5\t1\t1\t1\t1\t1\t10\t2\t40\t8\t95\tHeader',
        ].join('\n');

        expect(parseTsvOutput(tsv)).toEqual([{
            text: 'Header',
            x: 10,
            y: 0,
            width: 40,
            height: 12,
        }]);
    });

    it('accepts a valid header-only TSV as an empty OCR result', () => {
        const tsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

        expect(parseTsvOcrData(tsv)).toEqual({
            words: [],
            text: '',
        });
    });

    it('rejects prose output instead of treating it as empty TSV', () => {
        expect(() => parseTsvOcrData('Tesseract Open Source OCR Engine v5.5.0')).toThrow('Invalid Tesseract TSV output');
    });

    it('drops word rows with malformed non-finite geometry or confidence', () => {
        const tsv = [
            'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
            '5\t1\t1\t1\t1\t1\tInfinity\t2\t40\t8\t95\tBadLeft',
            '5\t1\t1\t1\t1\t2\t10\tNaN\t40\t8\t95\tBadTop',
            '5\t1\t1\t1\t1\t3\t10\t2\tInfinity\t8\t95\tBadWidth',
            '5\t1\t1\t1\t1\t4\t10\t2\t40\t8\tNaN\tBadConfidence',
            '5\t1\t1\t1\t1\t5\t10\t2\t40\t8\t95\tGood',
        ].join('\n');

        expect(parseTsvOcrData(tsv)).toEqual({
            words: [{
                text: 'Good',
                x: 10,
                y: 2,
                width: 40,
                height: 8,
            }],
            text: 'Good',
        });
    });

    it('normalizes Greek micro signs for every registry Greek OCR language', () => {
        expect(shouldNormalizeGreekMicroSign(['ell'])).toBe(true);
        expect(shouldNormalizeGreekMicroSign(['grc'])).toBe(true);
        expect(shouldNormalizeGreekMicroSign(['eng'])).toBe(false);
    });
});
