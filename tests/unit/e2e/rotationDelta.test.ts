import {describe, expect, it} from 'vitest';
import {resolveClockwiseRotationDelta} from '@tests/e2e/electron/helpers/resolveClockwiseRotationDelta';

describe('resolveClockwiseRotationDelta', () => {
    it('converges a fresh page to the requested quarter turn', () => {
        expect(resolveClockwiseRotationDelta(0, 90)).toBe(90);
    });

    it('makes a retry idempotent after the target rotation already persisted', () => {
        expect(resolveClockwiseRotationDelta(90, 90)).toBe(0);
    });

    it('resolves wrapped and superseding quarter turns clockwise', () => {
        expect(resolveClockwiseRotationDelta(270, 90)).toBe(180);
        expect(resolveClockwiseRotationDelta(-90, 0)).toBe(90);
        expect(resolveClockwiseRotationDelta(450, 0)).toBe(270);
    });
});
