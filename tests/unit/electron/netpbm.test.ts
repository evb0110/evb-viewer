import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    applyUpFilter,
    extractGrayscaleFromRgb,
    isRgbDataGrayscale,
    parseNetpbm,
} from '@electron/djvu/netpbm';

function netpbm(parts: Array<string | number[]>): Buffer {
    return Buffer.concat(parts.map((part) => {
        if (typeof part === 'string') {
            return Buffer.from(part, 'ascii');
        }
        return Buffer.from(part);
    }));
}

describe('parseNetpbm', () => {
    it('parses P5 grayscale payload with comments', () => {
        const data = netpbm([
            'P5\n# comment\n2 1\n255\n',
            [
                10,
                20,
            ],
        ]);

        const parsed = parseNetpbm(data);
        expect(parsed.width).toBe(2);
        expect(parsed.height).toBe(1);
        expect(parsed.channels).toBe(1);
        expect(Array.from(parsed.pixels)).toEqual([
            10,
            20,
        ]);
    });

    it('parses P6 RGB payload', () => {
        const data = netpbm([
            'P6\n1 1\n255\n',
            [
                200,
                100,
                50,
            ],
        ]);

        const parsed = parseNetpbm(data);
        expect(parsed.channels).toBe(3);
        expect(Array.from(parsed.pixels)).toEqual([
            200,
            100,
            50,
        ]);
    });

    it('throws for unsupported format', () => {
        expect(() => parseNetpbm(netpbm([
            'P4\n1 1\n255\n',
            [0x00],
        ]))).toThrow('Unsupported Netpbm format');
    });

    it('throws for truncated payload', () => {
        expect(() => parseNetpbm(netpbm([
            'P5\n3 1\n255\n',
            [
                1,
                2,
            ],
        ]))).toThrow('Truncated Netpbm payload');
    });
});

describe('netpbm helpers', () => {
    it('detects grayscale RGB data', () => {
        const grayRgb = new Uint8Array([
            10,
            10,
            10,
            20,
            20,
            20,
            30,
            30,
            30,
        ]);
        const colorRgb = new Uint8Array([
            10,
            10,
            10,
            20,
            19,
            20,
        ]);

        expect(isRgbDataGrayscale(grayRgb, 3)).toBe(true);
        expect(isRgbDataGrayscale(colorRgb, 2)).toBe(false);
    });

    it('extracts grayscale channel from RGB data', () => {
        const rgb = new Uint8Array([
            11,
            11,
            11,
            99,
            99,
            99,
        ]);
        expect(Array.from(extractGrayscaleFromRgb(rgb, 2))).toEqual([
            11,
            99,
        ]);
    });

    it('applies PNG Up filter per row', () => {
        const pixels = new Uint8Array([
            10,
            20,
            13,
            18,
        ]);
        const filtered = applyUpFilter(pixels, 2, 2);
        expect(Array.from(filtered)).toEqual([
            2,
            10,
            20,
            2,
            3,
            254,
        ]);
    });
});
