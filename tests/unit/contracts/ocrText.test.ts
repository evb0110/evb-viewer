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

const REPEATED_LINE = 'The quick brown fox jumps over the lazy dog near the old stone bridge.';

function lineWords(text: string, y: number): IOcrWord[] {
    return text.split(' ').map((wordText, index) => ({
        text: wordText,
        x: index * 40,
        y,
        width: 30,
        height: 10,
    }));
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

    // #937: identical lines down a page are separate text. Only copies of a
    // text layer drawn in the same place are one repeated stream.
    it('keeps identical lines at different heights as separate text', () => {
        const words = [
            0,
            40,
            80,
            120,
            160,
        ].flatMap(y => lineWords(REPEATED_LINE, y));

        expect(buildOcrTextLayerIndexText(words).match(/fox/gu)).toHaveLength(5);
    });

    it('collapses a text layer drawn several times in the same place', () => {
        const layer = [
            ...lineWords(REPEATED_LINE, 0),
            ...lineWords('A second line of the same page, long enough to count.', 20),
        ];

        expect(buildOcrTextLayerIndexText([
            ...layer,
            ...layer,
            ...layer,
        ])).toBe(buildOcrTextLayerIndexText(layer));
    });

    it('treats missing neighbor indexes as line endings', () => {
        expect(isLastOcrWordInLine([word('only', 0)], 9)).toBe(true);
    });
});
