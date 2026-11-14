import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolveWheelDirection,
    resolveWheelTargetPage,
} from '@app/modules/document-viewer/single-page-wheel/singlePageWheelNavigation';

describe('singlePageWheelNavigation', () => {
    it('resolves wheel direction from normalized wheel delta', () => {
        expect(resolveWheelDirection(12)).toBe(1);
        expect(resolveWheelDirection(-12)).toBe(-1);
    });

    it('moves one page in single-page mode and one spread in facing modes', () => {
        expect(resolveWheelTargetPage(2, 'single', 5, 1)).toBe(3);
        expect(resolveWheelTargetPage(2, 'single', 5, -1)).toBe(1);
        expect(resolveWheelTargetPage(1, 'facing', 6, 1)).toBe(3);
        expect(resolveWheelTargetPage(4, 'facing', 6, -1)).toBe(1);
        expect(resolveWheelTargetPage(1, 'facing-first-single', 6, 1)).toBe(2);
        expect(resolveWheelTargetPage(4, 'facing-first-single', 6, -1)).toBe(2);
    });
});
