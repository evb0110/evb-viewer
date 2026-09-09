import {
    describe,
    expect,
    it,
} from 'vitest';
import { collectSearchMatchWords } from '@pdf-core';
import type { IOcrWord } from '@contracts/shared';
import type { IPageIndex } from '@electron/features/search/indexBuilder';

describe('search result geometry', () => {
    it('uses glyph boxes to crop a match inside a punctuation-wrapped OCR word', () => {
        const text = '«История»/ \n';
        type TTestGlyph = IOcrWord & {
            startOffset: number;
            endOffset: number;
        };
        const word: IOcrWord & { chars: TTestGlyph[] } = {
            text: '«История»/',
            x: 0,
            y: 5,
            width: 90,
            height: 10,
            chars: [
                {
                    text: '«',
                    x: 0,
                    y: 5,
                    width: 2,
                    height: 10,
                    startOffset: 0,
                    endOffset: 1,
                },
                ...Array.from('История').map((char, index) => ({
                    text: char,
                    x: 2 + index * 10,
                    y: 5,
                    width: 10,
                    height: 10,
                    startOffset: index + 1,
                    endOffset: index + 2,
                })),
                {
                    text: '»',
                    x: 72,
                    y: 5,
                    width: 8,
                    height: 10,
                    startOffset: 8,
                    endOffset: 9,
                },
                {
                    text: '/',
                    x: 80,
                    y: 5,
                    width: 10,
                    height: 10,
                    startOffset: 9,
                    endOffset: 10,
                },
            ],
        };
        const page: IPageIndex = {
            pageNumber: 1,
            text,
            pageWidth: 120,
            pageHeight: 80,
            words: [word],
        };
        const startOffset = text.indexOf('История');
        const endOffset = startOffset + 'История'.length;

        const words = collectSearchMatchWords(page, startOffset, endOffset);

        expect(words).toEqual([{
            text: 'История',
            x: 2,
            y: 5,
            width: 70,
            height: 10,
        }]);
    });
});
