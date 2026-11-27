import {describe, expect, it} from 'vitest';
import {isPdfNativeNormalizedBoxInsidePageBounds, isPdfNativeNormalizedRectInsidePageBounds} from '@contracts/nativePdfPageBounds';

describe('native PDF normalized page bounds', () => {
    it('accepts rectangles and boxes that exactly fit inside normalized page bounds', () => {
        expect(
            isPdfNativeNormalizedRectInsidePageBounds({
                left: 0,
                top: 0,
                width: 1,
                height: 1,
            }),
        ).toBe(true);
        expect(
            isPdfNativeNormalizedBoxInsidePageBounds({
                x: 0.25,
                y: 0.5,
                width: 0.75,
                height: 0.5,
            }),
        ).toBe(true);
    });

    it.each([
        {
            left: 0,
            top: 0,
            width: 0,
            height: 1,
        },
        {
            left: 0.9,
            top: 0,
            width: 0.2,
            height: 1,
        },
        {
            left: 0,
            top: 0.9,
            width: 1,
            height: 0.2,
        },
        {
            left: Number.POSITIVE_INFINITY,
            top: 0,
            width: 1,
            height: 1,
        },
    ])('rejects invalid normalized rectangle %#', (rect) => {
        expect(isPdfNativeNormalizedRectInsidePageBounds(rect)).toBe(false);
    });
});
