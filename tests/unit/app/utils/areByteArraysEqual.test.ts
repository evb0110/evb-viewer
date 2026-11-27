import {describe, expect, it} from 'vitest';
import {areByteArraysEqual} from '@app/utils/areByteArraysEqual';

describe('areByteArraysEqual', () => {
    it('compares equal aligned byte arrays', () => {
        const left = new Uint8Array(64);
        const right = new Uint8Array(64);
        for (let index = 0; index < left.byteLength; index += 1) {
            left[index] = index % 251;
            right[index] = index % 251;
        }

        expect(areByteArraysEqual(left, right)).toBe(true);
    });

    it('detects differences in word and tail regions', () => {
        const left = new Uint8Array(19).fill(7);
        const wordDifference = new Uint8Array(left);
        wordDifference[9] = 8;
        const tailDifference = new Uint8Array(left);
        tailDifference[18] = 8;

        expect(areByteArraysEqual(left, wordDifference)).toBe(false);
        expect(areByteArraysEqual(left, tailDifference)).toBe(false);
    });

    it('handles matching misaligned slices and differing offsets', () => {
        const source = Uint8Array.from([99, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        const left = source.subarray(1, 12);
        const right = new Uint8Array(left);

        expect(areByteArraysEqual(left, right)).toBe(true);
    });

    it('preserves null and length mismatch behavior', () => {
        expect(areByteArraysEqual(null, null)).toBe(false);
        expect(areByteArraysEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    });
});
