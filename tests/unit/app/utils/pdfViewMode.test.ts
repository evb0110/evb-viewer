import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getSpreadStartForPage,
    getViewColumnCount,
    isStandaloneSpreadPage,
    stepBySpread,
} from '@app/utils/pdf-view-mode';

describe('pdf view mode helpers', () => {
    it('returns expected columns for each mode', () => {
        expect(getViewColumnCount('single', 10)).toBe(1);
        expect(getViewColumnCount('facing', 10)).toBe(2);
        expect(getViewColumnCount('facing-first-single', 10)).toBe(2);
        expect(getViewColumnCount('facing', 1)).toBe(1);
    });

    it('computes spread start for facing mode', () => {
        expect(getSpreadStartForPage(1, 'facing', 6)).toBe(1);
        expect(getSpreadStartForPage(2, 'facing', 6)).toBe(1);
        expect(getSpreadStartForPage(3, 'facing', 6)).toBe(3);
        expect(getSpreadStartForPage(6, 'facing', 6)).toBe(5);
    });

    it('computes spread start for facing-first-single mode', () => {
        expect(getSpreadStartForPage(1, 'facing-first-single', 6)).toBe(1);
        expect(getSpreadStartForPage(2, 'facing-first-single', 6)).toBe(2);
        expect(getSpreadStartForPage(3, 'facing-first-single', 6)).toBe(2);
        expect(getSpreadStartForPage(4, 'facing-first-single', 6)).toBe(4);
        expect(getSpreadStartForPage(6, 'facing-first-single', 6)).toBe(6);
    });

    it('marks standalone spread pages for facing-first-single mode', () => {
        expect(isStandaloneSpreadPage(1, 'facing-first-single', 5)).toBe(true);
        expect(isStandaloneSpreadPage(5, 'facing-first-single', 5)).toBe(false);
        expect(isStandaloneSpreadPage(6, 'facing-first-single', 6)).toBe(true);
        expect(isStandaloneSpreadPage(4, 'facing-first-single', 6)).toBe(false);
    });

    it('steps through spreads based on view mode', () => {
        expect(stepBySpread(1, 'single', 8, 1, 1)).toBe(2);
        expect(stepBySpread(2, 'facing', 8, 1, 1)).toBe(3);
        expect(stepBySpread(3, 'facing', 8, -1, 1)).toBe(1);
        expect(stepBySpread(1, 'facing-first-single', 8, 1, 1)).toBe(2);
        expect(stepBySpread(3, 'facing-first-single', 8, 1, 1)).toBe(4);
        expect(stepBySpread(7, 'facing-first-single', 8, 1, 2)).toBe(8);
    });
});
