import {
    describe,
    expect,
    it,
} from 'vitest';
import { resizeTextAnnotation } from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/resizeTextAnnotation';
import { rotateAnnotationPointAround } from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';

const page = {
    width: 600,
    height: 800,
};
const rect = {
    left: 0.2,
    top: 0.2,
    width: 0.2,
    height: 0.1,
};

describe('text annotation resizing', () => {
    it.each([
        0,
        90,
        180,
        270,
    ])('scales glyphs and rectangle together at rotation %s', rotation => {
        const center = {
            x: 0.3,
            y: 0.25,
        };
        const point = rotateAnnotationPointAround({
            x: 0.6,
            y: 0.4,
        }, center, rotation, page);
        const next = resizeTextAnnotation(rect, 20, 'se', point, rotation, page);
        expect(next.fontSize).toBeCloseTo(40);
        expect(next.rect.width).toBeCloseTo(0.4);
        expect(next.rect.height).toBeCloseTo(0.2);
        const beforeAnchor = rotateAnnotationPointAround({
            x: rect.left,
            y: rect.top,
        }, center, rotation, page);
        const afterAnchor = rotateAnnotationPointAround({
            x: next.rect.left,
            y: next.rect.top,
        }, {
            x: next.rect.left + next.rect.width / 2,
            y: next.rect.top + next.rect.height / 2,
        }, rotation, page);
        expect(afterAnchor.x).toBeCloseTo(beforeAnchor.x);
        expect(afterAnchor.y).toBeCloseTo(beforeAnchor.y);
    });
    it.each([
        'nw',
        'ne',
        'sw',
        'se',
    ] as const)('keeps the opposite corner fixed for %s', handle => {
        const anchor = {
            x: rect.left + (handle.includes('w') ? rect.width : 0),
            y: rect.top + (handle.includes('n') ? rect.height : 0),
        };
        const next = resizeTextAnnotation(rect, 20, handle, {
            x: anchor.x + rect.width * 1.5 * (handle.includes('w') ? -1 : 1),
            y: anchor.y + rect.height * 1.5 * (handle.includes('n') ? -1 : 1),
        }, 0, page);
        expect(next.fontSize).toBeCloseTo(30);
        expect(next.rect.left + (handle.includes('w') ? next.rect.width : 0)).toBeCloseTo(anchor.x);
        expect(next.rect.top + (handle.includes('n') ? next.rect.height : 0)).toBeCloseTo(anchor.y);
    });

    it('preserves exact geometry and font when the page blocks corner growth', () => {
        const atEdge = {
            ...rect,
            left: 0.8,
        };
        const next = resizeTextAnnotation(atEdge, 20, 'se', {
            x: 1,
            y: 0.9,
        }, 0, page);
        expect(next.rect).toBe(atEdge);
        expect(next.fontSize).toBe(20);
    });

    it('keeps font size when changing wrapping width', () => {
        const next = resizeTextAnnotation(rect, 20, 'e', {
            x: 0.6,
            y: 0.25,
        }, 0, page);
        expect(next.fontSize).toBe(20);
        expect(next.rect.width).toBeCloseTo(0.4);
        expect(next.rect.height).toBeCloseTo(rect.height);
    });
    it('clamps scaling at page boundary without distorting the font or rectangle', () => {
        const next = resizeTextAnnotation(rect, 20, 'se', {
            x: 2,
            y: 2,
        }, 0, page);
        expect(next.rect.left + next.rect.width).toBeLessThanOrEqual(1.00000001);
        expect(next.rect.width / rect.width).toBeCloseTo(next.fontSize / 20);
        expect(next.rect.height / rect.height).toBeCloseTo(next.fontSize / 20);
    });
});
