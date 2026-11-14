import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    matchCanonicalTextMarkupGeometry,
    TEXT_MARKUP_COORDINATE_TOLERANCE,
    toCanonicalTextMarkupGeometry,
    toCanonicalTextMarkupRect,
} from '@app/modules/pdf-viewer/engine/annotation-geometry/canonicalTextMarkupGeometry';
import { MIN_MARKER_RECT_SIZE } from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerRectFromPdfRect';

const LINE_RECT = {
    left: 0.25,
    top: 0.25,
    width: 0.3,
    height: 0.02,
};

describe('canonical text markup geometry', () => {
    it('is idempotent, so geometry normalized twice does not drift', () => {
        const rects = [
            LINE_RECT,
            {
                left: 0.5,
                top: 0.5,
                width: 0.0009,
                height: 0.02,
            },
            {
                left: 0.94,
                top: 0.5,
                width: 0.09,
                height: 0.02,
            },
            {
                left: 0.9995,
                top: 0.5,
                width: 0.0004,
                height: 0.0004,
            },
            {
                left: 0.2,
                top: -0.004,
                width: 0.2,
                height: 0.02,
            },
        ];
        rects.forEach((rect) => {
            const once = toCanonicalTextMarkupRect(rect);
            expect(once).not.toBeNull();
            expect(toCanonicalTextMarkupRect(once!)).toEqual(once);
        });
    });

    it('widens a fragment narrower than the minimum around its centre', () => {
        const canonical = toCanonicalTextMarkupRect({
            left: 0.5,
            top: 0.25,
            width: 0.0009,
            height: 0.02,
        });

        expect(canonical?.width).toBeCloseTo(MIN_MARKER_RECT_SIZE, 10);
        expect((canonical!.left + canonical!.width / 2)).toBeCloseTo(0.5 + 0.00045, 6);
    });

    it('keeps a rect that overhangs the page inside the page box', () => {
        const canonical = toCanonicalTextMarkupRect({
            left: 0.94,
            top: 0.25,
            width: 0.09,
            height: 0.02,
        });

        expect(canonical).toEqual({
            left: 0.94,
            top: 0.25,
            width: 0.06,
            height: 0.02,
        });
    });

    it('matches reordered geometry without matching moved geometry', () => {
        const first = {
            left: 0.1,
            top: 0.2,
            width: 0.2,
            height: 0.02,
        };
        const second = {
            left: 0.35,
            top: 0.2,
            width: 0.2,
            height: 0.02,
        };
        const expected = toCanonicalTextMarkupGeometry([
            first,
            second,
        ]);

        expect(matchCanonicalTextMarkupGeometry(expected, toCanonicalTextMarkupGeometry([
            second,
            first,
        ])).matched).toBe(true);
        const moved = matchCanonicalTextMarkupGeometry(expected, toCanonicalTextMarkupGeometry([
            first,
            {
                ...second,
                left: second.left + 0.01,
            },
        ]));
        expect(moved.matched).toBe(false);
        expect(moved.maxCoordinateDelta).toBeCloseTo(0.01, 6);
        expect(moved.worstRectIndex).toBe(1);
    });

    it('accepts a difference at the tolerance and rejects one past it', () => {
        const expected = toCanonicalTextMarkupGeometry([LINE_RECT]);
        const withinTolerance = toCanonicalTextMarkupGeometry([{
            ...LINE_RECT,
            left: LINE_RECT.left + TEXT_MARKUP_COORDINATE_TOLERANCE,
        }]);
        const pastTolerance = toCanonicalTextMarkupGeometry([{
            ...LINE_RECT,
            left: LINE_RECT.left + TEXT_MARKUP_COORDINATE_TOLERANCE * 2,
        }]);

        expect(matchCanonicalTextMarkupGeometry(expected, withinTolerance).matched).toBe(true);
        expect(matchCanonicalTextMarkupGeometry(expected, pastTolerance).matched).toBe(false);
    });

    it('reports a count difference instead of pairing what is left', () => {
        const match = matchCanonicalTextMarkupGeometry(
            toCanonicalTextMarkupGeometry([
                LINE_RECT,
                {
                    ...LINE_RECT,
                    left: 0.6,
                },
            ]),
            toCanonicalTextMarkupGeometry([LINE_RECT]),
        );

        expect(match.countMatches).toBe(false);
        expect(match.matched).toBe(false);
        expect(match.expectedCount).toBe(2);
        expect(match.reopenedCount).toBe(1);
    });
});
