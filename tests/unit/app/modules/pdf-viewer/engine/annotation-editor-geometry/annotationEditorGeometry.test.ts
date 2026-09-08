import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    applyAnnotationHandleResize,
    rotateAnnotationPoint,
    rotateAnnotationPlacementRect,
    unrotateAnnotationPlacementRect,
    rotatedAnnotationBounds,
    rotateAnnotationRect,
    rotateAnnotationPointAround,
    resizeRotatedAnnotationRect,
    clampAnnotationMoveDelta,
    annotationRectContainsPoint,
    createAnnotationRectFromPoints,
    createDefaultTextBoxRect,
    expandTextBoxRectToContentSize,
    moveAnnotationRect,
} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';
import {nudgeMarkerRectByPdfPoints} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/nudgeMarkerRectByPdfPoints';
import type { IAnnotationMarkerRect } from '@app/types/annotations';

const rect: IAnnotationMarkerRect = {
    left: 0.2,
    top: 0.3,
    width: 0.4,
    height: 0.2,
};

function expectRect(actual: IAnnotationMarkerRect, expected: IAnnotationMarkerRect) {
    expect(actual.left).toBeCloseTo(expected.left);
    expect(actual.top).toBeCloseTo(expected.top);
    expect(actual.width).toBeCloseTo(expected.width);
    expect(actual.height).toBeCloseTo(expected.height);
}

describe('annotation editor geometry', () => {
    it('moves a rectangle without allowing it to leave the page', () => {
        expectRect(moveAnnotationRect(rect, 0.7, -0.5), {
            left: 0.6,
            top: 0,
            width: 0.4,
            height: 0.2,
        });
    });

    it.each([
        [
            0,
            {
                left: 0.2,
                top: 0.3,
            },
        ],
        [
            90,
            {
                left: 0.2,
                top: 0.3,
            },
        ],
        [
            180,
            {
                left: 0.2,
                top: 0.3,
            },
        ],
        [
            270,
            {
                left: 0.2,
                top: 0.3,
            },
        ],
    ] as const)('moves one PDF point in every page rotation without changing marker size', (rotation, expectedStart) => {
        const result = nudgeMarkerRectByPdfPoints(
            {
                left: expectedStart.left,
                top: expectedStart.top,
                width: 0.1,
                height: 0.1,
            },
            1,
            0,
            [
                0,
                0,
                612,
                792,
            ],
            rotation,
        );
        expect(result.width).toBeCloseTo(0.1);
        expect(result.height).toBeCloseTo(0.1);
        const xOffset = 1 / 612;
        const expectedLeft = rotation === 180
            ? expectedStart.left - xOffset
            : rotation === 0
                ? expectedStart.left + xOffset
                : expectedStart.left;
        const expectedTop = rotation === 90
            ? expectedStart.top + xOffset
            : rotation === 270
                ? expectedStart.top - xOffset
                : expectedStart.top;
        expect(result.left).toBeCloseTo(expectedLeft);
        expect(result.top).toBeCloseTo(expectedTop);
    });

    it('creates a bounded rectangle for a reverse drag and enforces its minimum size', () => {
        expectRect(createAnnotationRectFromPoints({
            x: 0.8,
            y: 0.7,
        }, {
            x: 0.2,
            y: 0.1,
        }, 0.1), {
            left: 0.2,
            top: 0.1,
            width: 0.6,
            height: 0.6,
        });
        expectRect(createAnnotationRectFromPoints({
            x: 0.99,
            y: 0.99,
        }, {
            x: 0.99,
            y: 0.99,
        }, 0.1), {
            left: 0.9,
            top: 0.9,
            width: 0.1,
            height: 0.1,
        });
    });

    it.each([
        [
            'nw',
            {
                x: 0.1,
                y: 0.1,
            },
            {
                left: 0.1,
                top: 0.1,
                width: 0.5,
                height: 0.4,
            },
        ],
        [
            'n',
            {
                x: 0.1,
                y: 0.1,
            },
            {
                left: 0.2,
                top: 0.1,
                width: 0.4,
                height: 0.4,
            },
        ],
        [
            'ne',
            {
                x: 0.9,
                y: 0.1,
            },
            {
                left: 0.2,
                top: 0.1,
                width: 0.7,
                height: 0.4,
            },
        ],
        [
            'e',
            {
                x: 0.9,
                y: 0.1,
            },
            {
                left: 0.2,
                top: 0.3,
                width: 0.7,
                height: 0.2,
            },
        ],
        [
            'se',
            {
                x: 0.9,
                y: 0.9,
            },
            {
                left: 0.2,
                top: 0.3,
                width: 0.7,
                height: 0.6,
            },
        ],
        [
            's',
            {
                x: 0.1,
                y: 0.9,
            },
            {
                left: 0.2,
                top: 0.3,
                width: 0.4,
                height: 0.6,
            },
        ],
        [
            'sw',
            {
                x: 0.1,
                y: 0.9,
            },
            {
                left: 0.1,
                top: 0.3,
                width: 0.5,
                height: 0.6,
            },
        ],
        [
            'w',
            {
                x: 0.1,
                y: 0.1,
            },
            {
                left: 0.1,
                top: 0.3,
                width: 0.5,
                height: 0.2,
            },
        ],
    ] as const)('resizes from the %s handle while keeping the opposite edge fixed', (handle, point, expected) => {
        expectRect(applyAnnotationHandleResize(rect, handle, point), expected);
    });

    it('clamps an overlarge resize to the page and the minimum size', () => {
        expectRect(applyAnnotationHandleResize(rect, 'nw', {
            x: 2,
            y: 2,
        }, 0.1), {
            left: 0.5,
            top: 0.4,
            width: 0.1,
            height: 0.1,
        });
    });

    it('places a click-created text box around the pointer and keeps it on the page', () => {
        expectRect(createDefaultTextBoxRect({
            x: 0.99,
            y: 0.01,
        }, {
            pageView: [
                0,
                0,
                612,
                792,
            ],
            fontSize: 14,
        }), {
            left: 1 - (14 * 2 / 612),
            top: 0.01,
            width: 14 * 2 / 612,
            height: 14 * 1.65 / 792,
        });
    });

    it('uses a compact one-line default rectangle anchored at the pointer', () => {
        expectRect(createDefaultTextBoxRect({
            x: 0.5,
            y: 0.5,
        }, {
            pageView: [
                0,
                0,
                612,
                792,
            ],
            fontSize: 14,
        }), {
            left: 0.5,
            top: 0.5,
            width: 14 * 2 / 612,
            height: 14 * 1.65 / 792,
        });
    });

    it('converts the same PDF-space dimensions on portrait and landscape pages', () => {
        const portrait = createDefaultTextBoxRect({
            x: 0.5,
            y: 0.5,
        }, {
            pageView: [
                0,
                0,
                612,
                792,
            ],
            fontSize: 18,
        });
        const landscape = createDefaultTextBoxRect({
            x: 0.5,
            y: 0.5,
        }, {
            pageView: [
                0,
                0,
                792,
                612,
            ],
            fontSize: 18,
        });
        expect(portrait.width * 612).toBeCloseTo(landscape.width * 792);
        expect(portrait.height * 792).toBeCloseTo(landscape.height * 612);
        expect(portrait.width * 612).toBeCloseTo(18 * 2);
        expect(portrait.height * 792).toBeCloseTo(18 * 1.65);
    });

    it('scales the PDF-space default dimensions with the selected font size', () => {
        const small = createDefaultTextBoxRect({
            x: 0.2,
            y: 0.2,
        }, {
            pageView: [
                0,
                0,
                612,
                792,
            ],
            fontSize: 12,
        });
        const large = createDefaultTextBoxRect({
            x: 0.2,
            y: 0.2,
        }, {
            pageView: [
                0,
                0,
                612,
                792,
            ],
            fontSize: 24,
        });
        expect(large.width * 612).toBeCloseTo(small.width * 612 * 2);
        expect(large.height * 792).toBeCloseTo(small.height * 792 * 2);
    });

    it('clamps the anchored default rectangle inside the page at an edge click', () => {
        expectRect(createDefaultTextBoxRect({
            x: 0.99,
            y: 0.99,
        }, {
            pageView: [
                0,
                0,
                612,
                792,
            ],
            fontSize: 14,
        }), {
            left: 1 - (14 * 2 / 612),
            top: 1 - (14 * 1.65 / 792),
            width: 14 * 2 / 612,
            height: 14 * 1.65 / 792,
        });
    });

    it('grows a new text box upward when multiline content reaches the page edge', () => {
        expectRect(expandTextBoxRectToContentSize({
            left: 0.2,
            top: 0.9,
            width: 0.2,
            height: 0.05,
        }, 0.3, 0.2), {
            left: 0.2,
            top: 0.8,
            width: 0.3,
            height: 0.2,
        });
    });

    it('keeps the insertion edge fixed when content reaches the page edge', () => {
        expectRect(expandTextBoxRectToContentSize({
            left: 0.8,
            top: 0.2,
            width: 0.1,
            height: 0.1,
        }, 0.9, 0.4), {
            left: 0.8,
            top: 0.2,
            width: 0.2,
            height: 0.4,
        });
    });

    it('detects points inside a bounded annotation rectangle', () => {
        expect(annotationRectContainsPoint(rect, {
            x: 0.2,
            y: 0.3,
        })).toBe(true);
        expect(annotationRectContainsPoint(rect, {
            x: 0.6,
            y: 0.5,
        })).toBe(true);
        expect(annotationRectContainsPoint(rect, {
            x: 0.61,
            y: 0.5,
        })).toBe(false);
        expect(annotationRectContainsPoint(rect, {
            x: 0.5,
            y: 0.51,
        })).toBe(false);
    });
});


describe('annotation display geometry', () => {
    it.each([
        0,
        90,
        180,
        270,
    ])('round trips display points and rectangles at %s degrees', rotation => {
        const point = {
            x: 0.2,
            y: 0.3,
        };
        const projected = rotateAnnotationPoint(point, rotation);
        const restored = rotateAnnotationPoint(projected, -rotation);
        expect(restored.x).toBeCloseTo(point.x);
        expect(restored.y).toBeCloseTo(point.y);
        expectRect(rotateAnnotationRect(rotateAnnotationRect(rect, rotation), -rotation), rect);
    });

    it('constrains a group once so every selected annotation keeps its relative position', () => {
        const delta = clampAnnotationMoveDelta([
            rect,
            {
                left: 0.8,
                top: 0.1,
                width: 0.1,
                height: 0.1,
            },
        ], {
            x: 0.3,
            y: -0.3,
        });
        expect(delta.x).toBeCloseTo(0.1);
        expect(delta.y).toBeCloseTo(-0.1);
    });

    it.each([
        90,
        180,
        270,
        35,
    ])('holds the opposite physical corner fixed while resizing an entity rotated %s degrees', rotation => {
        const page = {
            width: 600,
            height: 900,
        };
        const center = {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
        const originalAnchor = rotateAnnotationPointAround({
            x: rect.left,
            y: rect.top,
        }, center, rotation, page);
        const pointer = rotateAnnotationPointAround({
            x: 0.7,
            y: 0.6,
        }, center, rotation, page);
        const resized = resizeRotatedAnnotationRect(rect, 'se', pointer, rotation, page);
        const nextCenter = {
            x: resized.left + resized.width / 2,
            y: resized.top + resized.height / 2,
        };
        const anchor = rotateAnnotationPointAround({
            x: resized.left,
            y: resized.top,
        }, nextCenter, rotation, page);
        expect(anchor.x).toBeCloseTo(originalAnchor.x);
        expect(anchor.y).toBeCloseTo(originalAnchor.y);
        expect(resized.width).toBeCloseTo(0.5);
        expect(resized.height).toBeCloseTo(0.3);
    });
});


describe('rotated annotation edge constraints', () => {
    it.each([
        90,
        180,
        270,
        35,
    ])('keeps resized painted corners inside the page at %s degrees', rotation => {
        const page = {
            width: 600,
            height: 900,
        };
        const resized = resizeRotatedAnnotationRect(rect, 'se', {
            x: 1.5,
            y: 1.5,
        }, rotation, page);
        const bounds = rotatedAnnotationBounds(resized, rotation, page);
        expect(bounds.left).toBeGreaterThanOrEqual(-1e-7);
        expect(bounds.top).toBeGreaterThanOrEqual(-1e-7);
        expect(bounds.left + bounds.width).toBeLessThanOrEqual(1 + 1e-7);
        expect(bounds.top + bounds.height).toBeLessThanOrEqual(1 + 1e-7);
    });
    it.each([
        0,
        90,
        180,
        270,
    ])('round trips separately rotated image/text placement dimensions at view %s', rotation => {
        const page = {
            width: 600,
            height: 900,
        };
        const display = rotateAnnotationPlacementRect(rect, rotation, page);
        expectRect(unrotateAnnotationPlacementRect(display, rotation, page), rect);
        const swapped = rotation % 180 !== 0;
        expect(display.width * (swapped ? page.height : page.width)).toBeCloseTo(rect.width * page.width);
        expect(display.height * (swapped ? page.width : page.height)).toBeCloseTo(rect.height * page.height);
    });
});
