import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFString,
} from 'pdf-lib';
import { collectEmbeddedShapeAnnotationIds } from '@app/modules/pdf-viewer/annotations/pdf-embedded-shape-annotations/collectEmbeddedShapeAnnotationIds';
import { importEmbeddedShapeAnnotations } from '@app/modules/pdf-viewer/annotations/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations';
import { formatPdfJsAnnotationRef } from '@app/utils/pdfAnnotationRefs';
import type { IShapeAnnotation } from '@app/types/annotations';
import { createEmbeddedShapeColorPdf } from '@tests/unit/app/fixtures/createEmbeddedShapeColorPdf';

async function createPdfWithEmbeddedShapes(options: { managedInk?: boolean } = {}) {
    const { managedInk = true } = options;
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        600,
        800,
    ]);

    const squareDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Square'),
        Rect: [
            60,
            480,
            240,
            720,
        ],
        C: [
            0.2,
            0.4,
            0.6,
        ],
        IC: [
            0.67,
            0.8,
            0.94,
        ],
        CA: 0.6,
        CreationDate: PDFString.of('D:20260525100000+00\'00\''),
        M: PDFString.of('D:20260525100100+00\'00\''),
        Border: [
            0,
            0,
            3,
        ],
    });
    const circleDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Circle'),
        Rect: [
            300,
            420,
            450,
            600,
        ],
        C: [
            0.1,
            0.7,
            0.2,
        ],
        CA: 0.4,
        Border: [
            0,
            0,
            2,
        ],
    });
    const lineDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Line'),
        Rect: [
            100,
            300,
            340,
            520,
        ],
        L: [
            120,
            500,
            320,
            340,
        ],
        C: [
            0,
            0,
            0,
        ],
        CA: 1,
        Border: [
            0,
            0,
            2,
        ],
        LE: [
            PDFName.of('None'),
            PDFName.of('ClosedArrow'),
        ],
    });
    const polyLineDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('PolyLine'),
        Rect: [
            110,
            110,
            280,
            250,
        ],
        Vertices: [
            120,
            220,
            160,
            180,
            250,
            130,
        ],
        C: [
            0.8,
            0.1,
            0.1,
        ],
        CA: 0.7,
        Border: [
            0,
            0,
            4,
        ],
        LE: [
            PDFName.of('OpenArrow'),
            PDFName.of('None'),
        ],
    });
    const polygonDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Polygon'),
        Rect: [
            260,
            140,
            500,
            340,
        ],
        Vertices: [
            280,
            320,
            480,
            300,
            430,
            180,
        ],
        C: [
            1,
            0,
            0,
        ],
        IC: [
            1,
            0.9,
            0.78,
        ],
        CA: 0.7,
        Border: [
            0,
            0,
            4,
        ],
    });
    const inkDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Ink'),
        Rect: [
            70,
            260,
            420,
            520,
        ],
        InkList: [
            [
                80,
                500,
                160,
                470,
                240,
                430,
                320,
                380,
            ],
            [
                180,
                360,
                240,
                340,
                300,
                320,
            ],
        ],
        C: [
            0.95,
            0.75,
            0.05,
        ],
        CA: 0.9,
        Border: [
            0,
            0,
            6,
        ],
    });
    if (managedInk) {
        inkDict.set(PDFName.of('EVBShapeKey'), PDFHexString.fromText('evb-shape:test-ink'));
    }

    const squareRef = doc.context.register(squareDict);
    const circleRef = doc.context.register(circleDict);
    const lineRef = doc.context.register(lineDict);
    const polyLineRef = doc.context.register(polyLineDict);
    const polygonRef = doc.context.register(polygonDict);
    const inkRef = doc.context.register(inkDict);

    page.node.set(PDFName.of('Annots'), doc.context.obj([
        squareRef,
        circleRef,
        lineRef,
        polyLineRef,
        polygonRef,
        inkRef,
    ]));

    return {
        bytes: new Uint8Array(await doc.save()),
        squareRef,
        circleRef,
        lineRef,
        polyLineRef,
        polygonRef,
        inkRef,
    };
}

describe('importEmbeddedShapeAnnotations', () => {
    it('decodes PDF Gray, RGB, and CMYK shape colors while preserving a zero border width', async () => {
        const shapes = await importEmbeddedShapeAnnotations(await createEmbeddedShapeColorPdf());

        expect(shapes).toEqual([
            expect.objectContaining({
                stableKey: 'evb-shape:gray-cmyk-square',
                color: '#808080',
                fillColor: '#ff0000',
                strokeWidth: 0,
            }),
            expect.objectContaining({
                stableKey: 'evb-shape:rgb-circle',
                color: '#336699',
            }),
            expect.objectContaining({stableKey: 'evb-shape:unsupported-color-polygon'}),
        ]);
    });

    it('keeps the existing stroke and fill fallbacks for unsupported color array shapes', async () => {
        const shapes = await importEmbeddedShapeAnnotations(await createEmbeddedShapeColorPdf());
        const unsupported = shapes.find(shape => shape.stableKey === 'evb-shape:unsupported-color-polygon');

        expect(unsupported).toMatchObject({
            color: '#ff0000',
            fillColor: undefined,
        });
    });

    it('clamps out-of-range Gray and mixed-range RGB components independently', async () => {
        const shapes = await importEmbeddedShapeAnnotations(await createEmbeddedShapeColorPdf({includeOutOfRangeColors: true}));

        expect(shapes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                stableKey: 'evb-shape:out-of-range-gray',
                color: '#ffffff',
            }),
            expect.objectContaining({
                stableKey: 'evb-shape:mixed-range-rgb',
                color: '#80ff00',
            }),
        ]));
    });

    it('imports geometric PDF annotations from bytes with editable metadata intact', async () => {
        const {
            bytes,
            squareRef,
            circleRef,
            lineRef,
            polyLineRef,
            polygonRef,
            inkRef,
        } = await createPdfWithEmbeddedShapes();

        const shapes = await importEmbeddedShapeAnnotations(bytes);

        expect(shapes).toHaveLength(6);

        expect(shapes[0]).toMatchObject({
            type: 'rectangle',
            pageIndex: 0,
            annotationId: formatPdfJsAnnotationRef(squareRef),
            source: 'embedded',
            pdfSubtype: 'Square',
            color: '#336699',
            fillColor: '#abccf0',
            opacity: 0.6,
            strokeWidth: 3,
            createdAt: Date.UTC(2026, 4, 25, 10, 0, 0),
            modifiedAt: Date.UTC(2026, 4, 25, 10, 1, 0),
        });
        expect(shapes[0]?.x).toBeCloseTo(0.1, 6);
        expect(shapes[0]?.y).toBeCloseTo(0.1, 6);
        expect(shapes[0]?.width).toBeCloseTo(0.3, 6);
        expect(shapes[0]?.height).toBeCloseTo(0.3, 6);

        expect(shapes[1]).toMatchObject({
            type: 'circle',
            annotationId: formatPdfJsAnnotationRef(circleRef),
            pdfSubtype: 'Circle',
            color: '#1ab333',
            opacity: 0.4,
        });
        expect(shapes[1]?.fillColor).toBeUndefined();

        expect(shapes[2]).toMatchObject({
            type: 'arrow',
            annotationId: formatPdfJsAnnotationRef(lineRef),
            pdfSubtype: 'Line',
            lineStartStyle: 'none',
            lineEndStyle: 'closedArrow',
        });
        expect(shapes[2]?.x).toBeCloseTo(0.2, 6);
        expect(shapes[2]?.y).toBeCloseTo(0.375, 6);
        expect(shapes[2]?.x2).toBeCloseTo(0.533333, 6);
        expect(shapes[2]?.y2).toBeCloseTo(0.575, 6);

        expect(shapes[3]).toMatchObject({
            type: 'polyline',
            annotationId: formatPdfJsAnnotationRef(polyLineRef),
            pdfSubtype: 'PolyLine',
            lineStartStyle: 'openArrow',
            lineEndStyle: 'none',
            strokeWidth: 4,
        });
        expect(shapes[3]?.points).toHaveLength(3);

        expect(shapes[4]).toMatchObject({
            type: 'polygon',
            annotationId: formatPdfJsAnnotationRef(polygonRef),
            pdfSubtype: 'Polygon',
            fillColor: '#ffe6c7',
            opacity: 0.7,
        });
        expect(shapes[4]?.points).toHaveLength(3);

        expect(shapes[5]).toMatchObject({
            type: 'polyline',
            annotationId: formatPdfJsAnnotationRef(inkRef),
            pdfSubtype: 'Ink',
            color: '#f2bf0d',
            opacity: 0.9,
            strokeWidth: 6,
        });
        expect(shapes[5]?.points).toHaveLength(4);
        expect(shapes[5]?.strokes).toHaveLength(2);
        expect(shapes[5]?.strokes?.[1]).toHaveLength(3);
    });

    it('leaves native Ink annotations owned by PDF.js unless they were created by EVB', async () => {
        const { bytes } = await createPdfWithEmbeddedShapes({ managedInk: false });

        const shapes = await importEmbeddedShapeAnnotations(bytes);

        expect(shapes).toHaveLength(5);
        expect(shapes.map(shape => shape.pdfSubtype)).toEqual([
            'Square',
            'Circle',
            'Line',
            'PolyLine',
            'Polygon',
        ]);
    });

    it('collects embedded annotation ids from imported shapes only', () => {
        const shapes: IShapeAnnotation[] = [
            {
                id: 'shape-embedded-1',
                type: 'rectangle',
                pageIndex: 0,
                x: 0.1,
                y: 0.1,
                width: 0.2,
                height: 0.2,
                color: '#ff0000',
                opacity: 1,
                strokeWidth: 1,
                source: 'embedded',
                annotationId: '20R',
            },
            {
                id: 'shape-local-1',
                type: 'line',
                pageIndex: 0,
                x: 0.1,
                y: 0.1,
                x2: 0.3,
                y2: 0.3,
                width: 0.2,
                height: 0.2,
                color: '#000000',
                opacity: 1,
                strokeWidth: 1,
                source: 'local',
            },
        ];

        expect([...collectEmbeddedShapeAnnotationIds(shapes)]).toEqual(['20R']);
    });
});
