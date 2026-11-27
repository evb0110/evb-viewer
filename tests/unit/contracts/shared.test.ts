import {describe, expect, it} from 'vitest';
import {isOcrWord, normalizeNonEmptyStringPaths} from '@contracts/shared';

describe('shared contract guards', () => {
    it('normalizes only non-empty trimmed string paths', () => {
        expect(normalizeNonEmptyStringPaths([' /tmp/a.pdf ', '', '   ', 42, null, '/tmp/b.pdf'])).toEqual(['/tmp/a.pdf', '/tmp/b.pdf']);
    });

    it('accepts OCR words with finite geometry and string text', () => {
        expect(
            isOcrWord({
                text: 'word',
                x: 0,
                y: 1,
                width: 2,
                height: 3,
                extra: true,
            }),
        ).toBe(true);
    });

    it.each([
        [{}],
        [
            {
                text: 123,
                x: 0,
                y: 0,
                width: 1,
                height: 1,
            },
        ],
        [
            {
                text: 'word',
                y: 0,
                width: 1,
                height: 1,
            },
        ],
        [
            {
                text: 'word',
                x: Number.NaN,
                y: 0,
                width: 1,
                height: 1,
            },
        ],
        [
            {
                text: 'word',
                x: 0,
                y: Number.POSITIVE_INFINITY,
                width: 1,
                height: 1,
            },
        ],
        [
            {
                text: 'word',
                x: 0,
                y: 0,
                width: Number.NEGATIVE_INFINITY,
                height: 1,
            },
        ],
        [
            {
                text: 'word',
                x: 0,
                y: 0,
                width: 1,
                height: Number.NaN,
            },
        ],
    ])('rejects invalid OCR word %s', (value) => {
        expect(isOcrWord(value)).toBe(false);
    });
});
