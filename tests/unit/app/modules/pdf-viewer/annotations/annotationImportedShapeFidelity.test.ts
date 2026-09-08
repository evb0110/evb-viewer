import {
    describe,
    expect,
    it,
} from 'vitest';
import {mapPdfAnnotationParseEntity} from '@app/modules/pdf-viewer/runtime/sessions/mapPdfAnnotationParseEntity';
import {
    toCanonicalShapeEntity,
    AnnotationApplication,
} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {
    toLegacyShapeAnnotation,
    semanticEntityFingerprint,
    type IShapeEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    isNativeShapeEligible,
    toNativeShapeAnnotation,
} from '@app/modules/pdf-viewer/runtime/save/nativeShapeMutations';
import type {IPdfAnnotationShapeEntry} from '@contracts/pdfAnnotationParseTypes';
import {requirePageIndex} from '@contracts/pageNumbers';

function parsedShape(overrides: Partial<IPdfAnnotationShapeEntry> = {}): IPdfAnnotationShapeEntry {
    return {
        kind: 'shape',
        name: 'imported-shape',
        objectNumber: 10,
        generationNumber: 0,
        pageIndex: requirePageIndex(0),
        author: 'Original author',
        createdAt: null,
        modifiedAt: null,
        stableKey: null,
        pdfSubtype: 'Line',
        type: 'arrow',
        x: 0.8,
        y: 0.8,
        width: 0.6,
        height: 0.6,
        x2: 0.2,
        y2: 0.2,
        color: '#123456',
        fillColor: null,
        opacity: 0.5,
        strokeWidth: 2,
        points: null,
        strokes: null,
        lineStartStyle: 'openArrow',
        lineEndStyle: 'closedArrow',
        ...overrides,
    };
}
function canonical(entry: IPdfAnnotationShapeEntry): IShapeEntity {
    const result = mapPdfAnnotationParseEntity(entry);
    if (result.kind !== 'shape') throw new Error('Expected canonical shape');
    return result;
}

describe('imported shape canonical fidelity', () => {
    it.each([
        [
            0.8,
            0.8,
            0.2,
            0.2,
        ],
        [
            0.8,
            0.2,
            0.2,
            0.8,
        ],
        [
            0.2,
            0.8,
            0.8,
            0.2,
        ],
        [
            0.2,
            0.2,
            0.8,
            0.8,
        ],
        [
            0.2,
            0.5,
            0.8,
            0.5,
        ],
        [
            0.5,
            0.8,
            0.5,
            0.2,
        ],
    ])('preserves ordered line endpoints (%s,%s) -> (%s,%s) through edits and native projection', (x, y, x2, y2) => {
        const imported = canonical(parsedShape({
            x,
            y,
            x2,
            y2,
            width: Math.abs(x2 - x),
            height: Math.abs(y2 - y),
        }));
        expect(imported.points).toEqual([
            {
                x,
                y,
            },
            {
                x: x2,
                y: y2,
            },
        ]);
        expect(imported.rect.left).toBe(Math.min(x, x2));
        expect(imported.rect.top).toBe(Math.min(y, y2));
        const app = new AnnotationApplication('shape-fidelity');
        app.store.replaceFromDocument([imported], []);
        app.store.updateShape(imported.identity.id, {strokeColor: '#ff0000'});
        const changed = app.beginSave().plan.expected[0] as IShapeEntity;
        const projected = toLegacyShapeAnnotation(changed);
        expect(isNativeShapeEligible(projected, 1)).toBe(true);
        expect(toNativeShapeAnnotation(projected)).toMatchObject({
            x,
            y,
            x2,
            y2,
            color: '#ff0000',
            lineStartStyle: 'openArrow',
            lineEndStyle: 'closedArrow',
            pdfSubtype: 'Line',
        });
        const returned = toCanonicalShapeEntity(projected, changed.identity.id);
        expect(returned.points).toEqual(changed.points);
        expect(returned.lineStartStyle).toBe('openArrow');
        expect(returned.lineEndStyle).toBe('closedArrow');
    });

    it.each([
        'Polygon',
        'PolyLine',
    ] as const)('preserves %s subtype and fill through canonical commands', pdfSubtype => {
        const points = [
            {
                x: 0.2,
                y: 0.2,
            },
            {
                x: 0.8,
                y: 0.3,
            },
            {
                x: 0.5,
                y: 0.8,
            },
        ];
        const imported = canonical(parsedShape({
            pdfSubtype,
            type: pdfSubtype === 'Polygon' ? 'polygon' : 'polyline',
            x: 0.2,
            y: 0.2,
            x2: null,
            y2: null,
            points,
            fillColor: '#abcdef',
            lineStartStyle: 'none',
            lineEndStyle: 'none',
        }));
        expect(imported.tool).toBe('draw');
        const projected = toLegacyShapeAnnotation(imported);
        expect(projected).toMatchObject({
            pdfSubtype,
            points,
            fillColor: '#abcdef',
        });
        expect(projected.type).toBe(pdfSubtype === 'Polygon' ? 'polygon' : 'polyline');
        expect(toCanonicalShapeEntity(projected, imported.identity.id).pdfSubtype).toBe(pdfSubtype);
        expect(semanticEntityFingerprint({
            ...imported,
            pdfSubtype: 'Ink',
        })).not.toBe(semanticEntityFingerprint(imported));
    });
});
