import {
    describe,
    expect,
    it,
} from 'vitest';
import type {IScanCleanupNormalizedZonePolygon} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {
    createScanCleanupRectangleZone,
    moveScanCleanupZonePolygon,
    normalizedZonePointToPreviewPx,
    previewPxToNormalizedZonePoint,
    resizeScanCleanupZonePolygon,
    resolveScanCleanupZoneBounds,
} from '@app/modules/scan-cleanup/geometry/zoneGeometry';

const polygon: IScanCleanupNormalizedZonePolygon = {
    points: [
        {
            xNormalized: 0.2,
            yNormalized: 0.3,
        },
        {
            xNormalized: 0.6,
            yNormalized: 0.3,
        },
        {
            xNormalized: 0.6,
            yNormalized: 0.7,
        },
        {
            xNormalized: 0.2,
            yNormalized: 0.7,
        },
    ],
    rotationDegrees: 90,
};

describe('scan cleanup manual zone geometry', () => {
    it('round-trips normalized rotated-page points through preview pixels', () => {
        const frame = {
            left: 120,
            top: 40,
            width: 640,
            height: 900,
        };
        const normalized = {
            xNormalized: 0.375,
            yNormalized: 0.625,
        };
        const preview = normalizedZonePointToPreviewPx(normalized, frame);

        expect(preview).toEqual({
            xPx: 360,
            yPx: 602.5,
        });
        expect(previewPxToNormalizedZonePoint(preview, frame)).toEqual(normalized);
    });

    it('creates a clockwise four-point rectangle under the active page rotation', () => {
        expect(createScanCleanupRectangleZone({
            xNormalized: 0.8,
            yNormalized: 0.7,
        }, {
            xNormalized: 0.2,
            yNormalized: 0.1,
        }, 270)).toEqual({
            points: [
                {
                    xNormalized: 0.2,
                    yNormalized: 0.1,
                },
                {
                    xNormalized: 0.8,
                    yNormalized: 0.1,
                },
                {
                    xNormalized: 0.8,
                    yNormalized: 0.7,
                },
                {
                    xNormalized: 0.2,
                    yNormalized: 0.7,
                },
            ],
            rotationDegrees: 270,
        });
    });

    it('clamps moves to the normalized page without changing zone size', () => {
        const moved = moveScanCleanupZonePolygon(polygon, 0.8, -0.8);

        const bounds = resolveScanCleanupZoneBounds(moved);
        expect(bounds.left).toBeCloseTo(0.6);
        expect(bounds.right).toBe(1);
        expect(bounds.top).toBe(0);
        expect(bounds.bottom).toBeCloseTo(0.4);
        expect(bounds.width).toBeCloseTo(0.4);
        expect(bounds.height).toBeCloseTo(0.4);
        expect(moved.rotationDegrees).toBe(90);
    });

    it('clamps corner resizing and keeps every polygon point in the normalized page', () => {
        const resized = resizeScanCleanupZonePolygon(polygon, 'nw', {
            xNormalized: -0.5,
            yNormalized: -0.25,
        });
        const bounds = resolveScanCleanupZoneBounds(resized);

        expect(bounds).toEqual({
            left: 0,
            right: 0.6,
            top: 0,
            bottom: 0.7,
            width: 0.6,
            height: 0.7,
        });
        expect(resized.points.every(point => point.xNormalized >= 0
            && point.xNormalized <= 1
            && point.yNormalized >= 0
            && point.yNormalized <= 1)).toBe(true);
    });
});
