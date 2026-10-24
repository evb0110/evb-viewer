import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolvePdfDetailArea } from '@app/modules/pdf-viewer/runtime/sessions/createPdfDetailRaster';

// An A4 page at 1000 % on a 2x display, with the default tier's detail budget.
const page = {
    pageWidth: 5960,
    pageHeight: 8420,
    outputScale: 2,
    budgetPixels: 2 ** 24,
};
const visible = {
    x0: 0.4,
    y0: 0.4,
    x1: 0.55,
    y1: 0.45,
};

describe('resolvePdfDetailArea', () => {
    it('adds a margin of half the visible size around a small visible part', () => {
        const area = resolvePdfDetailArea({
            ...page,
            visible,
            baseDensity: 0.3,
            current: null,
        });
        expect(area).toEqual({
            x0: 0.325,
            y0: 0.375,
            x1: 0.625,
            y1: 0.475,
        });
    });

    it('clips the region to the page edge', () => {
        const area = resolvePdfDetailArea({
            ...page,
            visible: {
                x0: 0,
                y0: 0.95,
                x1: 0.1,
                y1: 1,
            },
            baseDensity: 0.3,
            current: null,
        });
        expect(area).toEqual({
            x0: 0,
            y0: 0.925,
            x1: 0.15,
            y1: 1,
        });
    });

    it('keeps the shown region while it covers the visible part with balanced margins', () => {
        expect(resolvePdfDetailArea({
            ...page,
            visible: {
                x0: 0.42,
                y0: 0.41,
                x1: 0.57,
                y1: 0.46,
            },
            baseDensity: 0.3,
            current: {
                x0: 0.325,
                y0: 0.375,
                x1: 0.625,
                y1: 0.475,
            },
        })).toBe('current');
    });

    it('re-centres once the margin ahead of a pan falls under a third of the one behind', () => {
        expect(resolvePdfDetailArea({
            ...page,
            visible: {
                x0: 0.47,
                y0: 0.4,
                x1: 0.62,
                y1: 0.45,
            },
            baseDensity: 0.3,
            current: {
                x0: 0.325,
                y0: 0.375,
                x1: 0.625,
                y1: 0.475,
            },
        })).toEqual({
            x0: 0.395,
            y0: 0.375,
            x1: 0.695,
            y1: 0.475,
        });
    });

    it('makes no detail where the whole-page raster is already nearly as sharp', () => {
        expect(resolvePdfDetailArea({
            ...page,
            visible,
            baseDensity: 0.95,
            current: null,
        })).toBeNull();
    });

    it('makes no detail when the budget leaves it no sharper than the page raster', () => {
        // The visible part alone exceeds the budget: 0.9 of a 2x A4 page at
        // 1000 % is 1.8e8 device pixels against 1.7e7.
        expect(resolvePdfDetailArea({
            ...page,
            visible: {
                x0: 0,
                y0: 0,
                x1: 0.9,
                y1: 1,
            },
            baseDensity: 0.3,
            current: null,
        })).toBeNull();
    });
});
