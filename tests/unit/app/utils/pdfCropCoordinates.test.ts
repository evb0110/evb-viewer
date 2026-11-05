import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    boxToDisplayNormalizedRect,
    boxToNormalizedRect,
    marginsToDisplayNormalizedRect,
    marginsToNormalizedRect,
    screenRectToMargins,
    pointsToUnit,
    unitToPoints,
} from '@app/utils/pdfCropCoordinates';

describe('pdf crop coordinates', () => {
    it.each([
        1,
        2,
    ])('converts a physical inch at UserUnit %s', (userUnit) => {
        expect(unitToPoints(1, 'in', userUnit)).toBe(72 / userUnit);
        expect(unitToPoints(25.4, 'mm', userUnit)).toBeCloseTo(72 / userUnit, 12);
        expect(pointsToUnit(72 / userUnit, 'in', userUnit)).toBe(1);
        expect(pointsToUnit(72 / userUnit, 'mm', userUnit)).toBeCloseTo(25.4, 12);
        expect(pointsToUnit(36, 'pt', userUnit)).toBe(36 * userUnit);
    });

    it('clamps each selection edge independently when the drag starts outside the page', () => {
        expect(screenRectToMargins(
            {
                x: -10,
                y: 20,
                width: 60,
                height: 40,
            },
            {
                left: 0,
                top: 0,
                width: 100,
                height: 100,
            },
            {
                x: 0,
                y: 0,
                width: 200,
                height: 100,
            },
            {
                x: 0,
                y: 0,
                width: 200,
                height: 100,
            },
            0,
        )).toEqual({
            left: 0,
            right: 100,
            top: 20,
            bottom: 40,
        });
    });

    it('maps rotated selections into media-box margins', () => {
        expect(screenRectToMargins(
            {
                x: 0,
                y: 0,
                width: 50,
                height: 50,
            },
            {
                left: 0,
                top: 0,
                width: 100,
                height: 100,
            },
            {
                x: 0,
                y: 0,
                width: 200,
                height: 200,
            },
            {
                x: 0,
                y: 0,
                width: 200,
                height: 200,
            },
            90,
        )).toEqual({
            left: 0,
            right: 100,
            top: 100,
            bottom: 0,
        });
    });

    it('maps unrotated landscape selections into media-box margins', () => {
        const margins = screenRectToMargins(
            {
                x: 50,
                y: 20,
                width: 120,
                height: 50,
            },
            {
                left: 0,
                top: 0,
                width: 200,
                height: 100,
            },
            {
                x: 0,
                y: 0,
                width: 400,
                height: 200,
            },
            {
                x: 0,
                y: 0,
                width: 400,
                height: 200,
            },
            0,
        );

        expect(margins.left).toBeCloseTo(100, 6);
        expect(margins.right).toBeCloseTo(60, 6);
        expect(margins.top).toBeCloseTo(40, 6);
        expect(margins.bottom).toBeCloseTo(60, 6);
    });

    it('normalizes arbitrary crop boxes for preview rendering', () => {
        expect(boxToNormalizedRect(
            {
                x: 50,
                y: 10,
                width: 100,
                height: 70,
            },
            {
                x: 0,
                y: 0,
                width: 200,
                height: 100,
            },
        )).toEqual({
            x: 0.25,
            y: 0.2,
            width: 0.5,
            height: 0.7,
        });

        expect(marginsToNormalizedRect({
            top: 20,
            bottom: 10,
            left: 50,
            right: 50,
        }, {
            x: 0,
            y: 0,
            width: 200,
            height: 100,
        })).toEqual({
            x: 0.25,
            y: 0.2,
            width: 0.5,
            height: 0.7,
        });
    });

    it('rotates preview rects into display orientation', () => {
        const rotatedBoxRect = boxToDisplayNormalizedRect(
            {
                x: 50,
                y: 10,
                width: 100,
                height: 70,
            },
            {
                x: 0,
                y: 0,
                width: 200,
                height: 100,
            },
            90,
        );

        expect(rotatedBoxRect.x).toBeCloseTo(0.1, 6);
        expect(rotatedBoxRect.y).toBeCloseTo(0.25, 6);
        expect(rotatedBoxRect.width).toBeCloseTo(0.7, 6);
        expect(rotatedBoxRect.height).toBeCloseTo(0.5, 6);

        const rotatedMarginRect = marginsToDisplayNormalizedRect({
            top: 20,
            bottom: 10,
            left: 50,
            right: 50,
        }, {
            x: 0,
            y: 0,
            width: 200,
            height: 100,
        }, 90);

        expect(rotatedMarginRect.x).toBeCloseTo(0.1, 6);
        expect(rotatedMarginRect.y).toBeCloseTo(0.25, 6);
        expect(rotatedMarginRect.width).toBeCloseTo(0.7, 6);
        expect(rotatedMarginRect.height).toBeCloseTo(0.5, 6);
    });

    it('normalizes 270-degree preview rects for landscape pages', () => {
        const rotatedBoxRect = boxToDisplayNormalizedRect(
            {
                x: 40,
                y: 30,
                width: 120,
                height: 90,
            },
            {
                x: 0,
                y: 0,
                width: 200,
                height: 120,
            },
            270,
        );

        expect(rotatedBoxRect.x).toBeCloseTo(0, 6);
        expect(rotatedBoxRect.y).toBeCloseTo(0.2, 6);
        expect(rotatedBoxRect.width).toBeCloseTo(0.75, 6);
        expect(rotatedBoxRect.height).toBeCloseTo(0.6, 6);
    });
});
