import {
    describe,
    expect,
    it,
} from 'vitest';
import { computeInitialImagePlacementDimensions } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/computeInitialImagePlacementDimensions';
import { getImagePlacementResizeCursor } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/getImagePlacementResizeCursor';
import { getImagePlacementResizeCursorStyle } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/getImagePlacementResizeCursorStyle';
import { getShortestImagePlacementAngleDelta } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/getShortestImagePlacementAngleDelta';
import { moveImagePlacementRect } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/moveImagePlacementRect';
import { resizeImagePlacementRect } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/resizeImagePlacementRect';
import { rotateImagePlacementRect } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/rotateImagePlacementRect';
import { snapImagePlacementRotationDegrees } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/snapImagePlacementRotationDegrees';

function toRadians(degrees: number) {
    return (degrees * Math.PI) / 180;
}

function rotatePoint(
    point: {
        x: number;
        y: number;
    },
    rotationDegrees: number,
) {
    const radians = toRadians(rotationDegrees);
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);

    return {
        x: (point.x * cos) - (point.y * sin),
        y: (point.x * sin) + (point.y * cos),
    };
}

function getHandlePoint(
    rect: {
        left: number;
        top: number;
        width: number;
        height: number;
    },
    handle: 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w',
    rotationDegrees: number,
) {
    const center = {
        x: rect.left + (rect.width / 2),
        y: rect.top + (rect.height / 2),
    };
    const vectors = {
        nw: {
            x: -1,
            y: -1,
        },
        n: {
            x: 0,
            y: -1,
        },
        ne: {
            x: 1,
            y: -1,
        },
        e: {
            x: 1,
            y: 0,
        },
        se: {
            x: 1,
            y: 1,
        },
        s: {
            x: 0,
            y: 1,
        },
        sw: {
            x: -1,
            y: 1,
        },
        w: {
            x: -1,
            y: 0,
        },
    } as const;
    const vector = vectors[handle];
    const rotated = rotatePoint({
        x: (vector.x * rect.width) / 2,
        y: (vector.y * rect.height) / 2,
    }, rotationDegrees);

    return {
        x: center.x + rotated.x,
        y: center.y + rotated.y,
    };
}

describe('computeInitialImagePlacementDimensions', () => {
    it('preserves aspect ratio for wide clipboard images when height minimum cannot be met', () => {
        const dimensions = computeInitialImagePlacementDimensions({
            pageWidthPx: 792,
            pageHeightPx: 1120,
            imageCssWidth: 689,
            imageCssHeight: 164,
        });

        expect(dimensions).not.toBeNull();
        expect(dimensions?.width).toBeCloseTo(0.4, 3);
        expect(dimensions?.height).toBeCloseTo((792 * 0.4 * (164 / 689)) / 1120, 3);
    });

    it('scales small images up uniformly without distorting them', () => {
        const dimensions = computeInitialImagePlacementDimensions({
            pageWidthPx: 800,
            pageHeightPx: 1000,
            imageCssWidth: 50,
            imageCssHeight: 50,
        });

        expect(dimensions).not.toBeNull();
        expect(dimensions?.width).toBeCloseTo(0.15, 3);
        expect(dimensions?.height).toBeCloseTo(0.12, 3);
    });

    it('keeps corner resizing locked to the current aspect ratio while Shift is held', () => {
        const rect = resizeImagePlacementRect({
            originRectPx: {
                left: 120,
                top: 80,
                width: 160,
                height: 80,
            },
            containerRect: {
                left: 0,
                top: 0,
                width: 800,
                height: 600,
            },
            handle: 'se',
            startClientX: 0,
            startClientY: 0,
            clientX: 48,
            clientY: 12,
            shiftKey: true,
        });

        expect(rect.width / rect.height).toBeCloseTo(2, 4);
        expect(rect.width).toBeGreaterThan(160);
        expect(rect.height).toBeGreaterThan(80);
    });

    it('allows corner resizing to change the aspect ratio without Shift', () => {
        const rect = resizeImagePlacementRect({
            originRectPx: {
                left: 120,
                top: 80,
                width: 160,
                height: 80,
            },
            containerRect: {
                left: 0,
                top: 0,
                width: 800,
                height: 600,
            },
            handle: 'se',
            startClientX: 0,
            startClientY: 0,
            clientX: 48,
            clientY: 12,
        });

        expect(rect.width).toBe(208);
        expect(rect.height).toBe(92);
        expect(rect.left).toBe(120);
        expect(rect.top).toBe(80);
    });

    it('allows side handles to resize a rotated image on a single axis', () => {
        const originRect = {
            left: 180,
            top: 160,
            width: 140,
            height: 90,
        };
        const rect = resizeImagePlacementRect({
            originRectPx: originRect,
            containerRect: {
                left: 0,
                top: 0,
                width: 900,
                height: 700,
            },
            handle: 'e',
            startClientX: 250,
            startClientY: 205,
            clientX: 250,
            clientY: 241,
            rotationDegrees: 90,
        });
        const originAnchor = getHandlePoint(originRect, 'w', 90);
        const nextAnchor = getHandlePoint(rect, 'w', 90);

        expect(rect.width).toBeGreaterThan(140);
        expect(rect.height).toBeCloseTo(90, 4);
        expect(nextAnchor.x).toBeCloseTo(originAnchor.x, 4);
        expect(nextAnchor.y).toBeCloseTo(originAnchor.y, 4);
    });

    it('keeps the opposite corner fixed while resizing a rotated rect', () => {
        const resizeOptions = {
            originRectPx: {
                left: 220,
                top: 170,
                width: 160,
                height: 100,
            },
            containerRect: {
                left: 0,
                top: 0,
                width: 900,
                height: 700,
            },
            handle: 'se',
            startClientX: 360,
            startClientY: 290,
            clientX: 420,
            clientY: 340,
            rotationDegrees: 30,
            shiftKey: true,
        } satisfies Parameters<typeof resizeImagePlacementRect>[0];
        const rect = resizeImagePlacementRect(resizeOptions);
        const fixedCorner = getHandlePoint(resizeOptions.originRectPx, 'nw', 30);
        const nextFixedCorner = getHandlePoint(rect, 'nw', 30);

        expect(nextFixedCorner.x).toBeCloseTo(fixedCorner.x, 4);
        expect(nextFixedCorner.y).toBeCloseTo(fixedCorner.y, 4);
        expect(rect.width / rect.height).toBeCloseTo(1.6, 4);
    });

    it('quantizes rotation to 15-degree increments', () => {
        expect(snapImagePlacementRotationDegrees(2)).toBe(0);
        expect(snapImagePlacementRotationDegrees(8)).toBe(15);
        expect(snapImagePlacementRotationDegrees(88)).toBe(90);
        expect(snapImagePlacementRotationDegrees(44)).toBe(45);
        expect(snapImagePlacementRotationDegrees(182)).toBe(180);
    });

    it('snaps rotation to 15-degree increments when Shift is held', () => {
        const rotated = rotateImagePlacementRect({
            originRectPx: {
                left: 200,
                top: 140,
                width: 120,
                height: 80,
            },
            containerOrigin: {
                x: 0,
                y: 0,
            },
            originRotationDegrees: 0,
            startClientX: 260,
            startClientY: 80,
            clientX: 320,
            clientY: 180,
            shiftKey: true,
        });

        expect(rotated.rotationDegrees).toBe(90);
        expect(rotated.rectPx.width).toBeCloseTo(120, 4);
        expect(rotated.rectPx.height).toBeCloseTo(80, 4);
    });

    it('rotates freely without snapping when Shift is not held', () => {
        const rotated = rotateImagePlacementRect({
            originRectPx: {
                left: 200,
                top: 140,
                width: 120,
                height: 80,
            },
            containerOrigin: {
                x: 0,
                y: 0,
            },
            originRotationDegrees: 0,
            startClientX: 260,
            startClientY: 80,
            clientX: 310,
            clientY: 160,
        });

        expect(rotated.rotationDegrees % 15).not.toBe(0);
    });

    it('keeps rotation deltas continuous across the angle wrap boundary', () => {
        expect(getShortestImagePlacementAngleDelta(358)).toBeCloseTo(-2, 4);
        expect(getShortestImagePlacementAngleDelta(-358)).toBeCloseTo(2, 4);
    });

    it('rotates resize cursors with the image angle', () => {
        expect(getImagePlacementResizeCursor('n', 0)).toBe('ns-resize');
        expect(getImagePlacementResizeCursor('n', 90)).toBe('ew-resize');
        expect(getImagePlacementResizeCursor('ne', 90)).toBe('nwse-resize');
        expect(getImagePlacementResizeCursor('e', 45)).toBe('nwse-resize');
    });

    it('builds a continuously rotated custom resize cursor style', () => {
        const cursor = getImagePlacementResizeCursorStyle('n', 22.5);

        expect(cursor).toContain('data:image/svg+xml');
        expect(cursor).toContain('rotate(292.5%2016%2016)');
        expect(cursor).toContain('nesw-resize');
    });

    it('keeps rotate drag continuous when crossing the angle wrap boundary', () => {
        const rotated = rotateImagePlacementRect({
            originRectPx: {
                left: 150,
                top: 120,
                width: 100,
                height: 60,
            },
            containerOrigin: {
                x: 0,
                y: 0,
            },
            originRotationDegrees: 15,
            startClientX: 100.152,
            startClientY: 154.792,
            clientX: 101.223,
            clientY: 151.32,
        });

        expect(rotated.rotationDegrees).toBeCloseTo(17, 1);
    });

    it('keeps moved rotated images inside the page bounds', () => {
        const rect = moveImagePlacementRect({
            originRectPx: {
                left: 220,
                top: 200,
                width: 160,
                height: 100,
            },
            containerRect: {
                left: 0,
                top: 0,
                width: 500,
                height: 400,
            },
            deltaX: 500,
            deltaY: 0,
            rotationDegrees: 45,
        });

        expect(rect.left + rect.width).toBeLessThanOrEqual(500);
        expect(rect.top).toBeGreaterThanOrEqual(0);
    });
});
