import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IOcrWord } from '@app/types/shared';

vi.mock('@app/constants/storage-keys', () => ({STORAGE_KEYS: {OCR_DEBUG_BOXES: 'pdfOcrDebugBoxes'}}));

const {
    transformWordBox,
    isOcrDebugEnabled,
} = await import('@app/composables/pdfWordBoxGeometry');

describe('transformWordBox', () => {
    const baseWord: IOcrWord = {
        text: 'hello',
        x: 100,
        y: 50,
        width: 200,
        height: 30,
    };

    it('scales word box proportionally when scales are equal', () => {
        const result = transformWordBox(baseWord, 1000, 500, 2000, 1000);

        expect(result.x).toBe(200);
        expect(result.y).toBe(100);
        expect(result.width).toBe(400);
        expect(result.height).toBe(60);
        expect(result.isCurrent).toBe(false);
    });

    it('uses uniform (min) scale when scales differ slightly', () => {
        const result = transformWordBox(baseWord, 1000, 500, 2000, 900);

        const expectedScale = Math.min(2000 / 1000, 900 / 500);
        expect(result.x).toBeCloseTo(baseWord.x * expectedScale);
        expect(result.y).toBeCloseTo(baseWord.y * expectedScale);
        expect(result.width).toBeCloseTo(baseWord.width * expectedScale);
        expect(result.height).toBeCloseTo(baseWord.height * expectedScale);
    });

    it('returns zero-size box when image dimensions are missing', () => {
        const result = transformWordBox(baseWord, undefined, undefined, 800, 600);

        expect(result).toEqual({
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            isCurrent: false,
        });
    });

    it('returns zero-size box when imageDimensionWidth is 0', () => {
        const result = transformWordBox(baseWord, 0, 500, 800, 600);

        expect(result).toEqual({
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            isCurrent: false,
        });
    });

    it('handles word at origin (0,0)', () => {
        const originWord: IOcrWord = {
            text: 'origin',
            x: 0,
            y: 0,
            width: 50,
            height: 20,
        };

        const result = transformWordBox(originWord, 1000, 1000, 500, 500);

        expect(result.x).toBe(0);
        expect(result.y).toBe(0);
        expect(result.width).toBe(25);
        expect(result.height).toBe(10);
    });

    it('handles 1:1 scale (no scaling needed)', () => {
        const result = transformWordBox(baseWord, 1000, 500, 1000, 500);

        expect(result.x).toBe(baseWord.x);
        expect(result.y).toBe(baseWord.y);
        expect(result.width).toBe(baseWord.width);
        expect(result.height).toBe(baseWord.height);
    });

    it('handles very small scale factor', () => {
        const result = transformWordBox(baseWord, 10000, 10000, 100, 100);

        const scale = 0.01;
        expect(result.x).toBeCloseTo(baseWord.x * scale);
        expect(result.y).toBeCloseTo(baseWord.y * scale);
        expect(result.width).toBeCloseTo(baseWord.width * scale);
        expect(result.height).toBeCloseTo(baseWord.height * scale);
    });
});

describe('isOcrDebugEnabled', () => {
    it('returns false when localStorage is undefined', () => {
        expect(isOcrDebugEnabled()).toBe(false);
    });
});
