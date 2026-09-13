import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IOcrWord } from '@contracts/shared';
import {
    buildOcrTextLayerItemText,
    buildOcrWordKey,
    isLastOcrWordInLine,
} from '@contracts/ocrText';
import { buildOcrTextLayerIndexText } from '@pdf-core';

function word(text: string, y: number, height = 10): IOcrWord {
    return {
        text,
        x: 0,
        y,
        width: 10,
        height,
    };
}

describe('OCR text contracts', () => {
    it('builds item text with a trailing word separator', () => {
        expect(buildOcrTextLayerItemText(word('alpha', 0))).toBe('alpha ');
    });

    it('builds stable OCR word keys from text and geometry', () => {
        expect(buildOcrWordKey({
            text: 'alpha',
            x: 1,
            y: 2,
            width: 3,
            height: 4,
        })).toBe('alpha|1|2|3|4');
    });

    it('returns empty index text for empty word arrays', () => {
        expect(buildOcrTextLayerIndexText([])).toBe('');
    });

    it('joins same-line words and terminates the final word with a newline', () => {
        expect(buildOcrTextLayerIndexText([
            word('hello', 0),
            word('world', 2),
        ])).toBe('hello world \n');
    });

    it('splits lines only when the next word crosses the half-height threshold', () => {
        const words = [
            word('same', 0, 10),
            word('edge', 5, 10),
            word('next', 11, 10),
        ];

        expect(isLastOcrWordInLine(words, 0)).toBe(false);
        expect(isLastOcrWordInLine(words, 1)).toBe(true);
        expect(buildOcrTextLayerIndexText(words)).toBe('same edge \nnext \n');
    });

    it('treats missing neighbor indexes as line endings', () => {
        expect(isLastOcrWordInLine([word('only', 0)], 9)).toBe(true);
    });
});
