import type {
    PDFDict,
    PDFPage,
    PDFRef,
} from 'pdf-lib';
import {
    PDFArray,
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import type { IShapeAnnotation } from '@app/types/annotations';
import { parseHexColor } from '@app/utils/color';
import { BrowserLogger } from '@app/utils/browser-logger';

const SHAPE_SERIALIZATION_LOG_SECTION = 'pdf-shapes';

function appendAnnotationRefToPage(page: PDFPage, doc: PDFDocument, annotRef: PDFRef) {
    const annots = page.node.Annots() ?? doc.context.obj([]);
    if (annots instanceof PDFArray) {
        annots.push(annotRef);
        page.node.set(PDFName.of('Annots'), annots);
        return;
    }
    page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
}

function setInteriorColor(annotDict: PDFDict, doc: PDFDocument, fillColor: string | undefined) {
    if (!fillColor) {
        return;
    }
    const [
        red,
        green,
        blue,
    ] = parseHexColor(fillColor);
    annotDict.set(PDFName.of('IC'), doc.context.obj([
        red,
        green,
        blue,
    ]));
}

function createRectAnnotationDict(
    doc: PDFDocument,
    shape: IShapeAnnotation,
    subtype: 'Square' | 'Circle',
    pageWidth: number,
    pageHeight: number,
): PDFDict {
    const x = shape.x * pageWidth;
    const y = (1 - shape.y - shape.height) * pageHeight;
    const width = shape.width * pageWidth;
    const height = shape.height * pageHeight;
    const rect = doc.context.obj([
        x,
        y,
        x + width,
        y + height,
    ]);
    const [
        red,
        green,
        blue,
    ] = parseHexColor(shape.color);

    return doc.context.obj({
        Type: 'Annot',
        Subtype: subtype,
        Rect: rect,
        C: [
            red,
            green,
            blue,
        ],
        CA: shape.opacity,
        Border: [
            0,
            0,
            shape.strokeWidth,
        ],
    }) as PDFDict;
}

function createLineAnnotationDict(
    doc: PDFDocument,
    shape: IShapeAnnotation,
    pageWidth: number,
    pageHeight: number,
): PDFDict {
    const x1 = shape.x * pageWidth;
    const y1 = (1 - shape.y) * pageHeight;
    const x2 = (shape.x2 ?? shape.x) * pageWidth;
    const y2 = (1 - (shape.y2 ?? shape.y)) * pageHeight;
    const lineWidth = shape.strokeWidth;

    const minX = Math.min(x1, x2) - lineWidth;
    const minY = Math.min(y1, y2) - lineWidth;
    const maxX = Math.max(x1, x2) + lineWidth;
    const maxY = Math.max(y1, y2) + lineWidth;

    const rect = doc.context.obj([
        minX,
        minY,
        maxX,
        maxY,
    ]);
    const lineCoordinates = doc.context.obj([
        x1,
        y1,
        x2,
        y2,
    ]);
    const [
        red,
        green,
        blue,
    ] = parseHexColor(shape.color);

    const annotDict = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Line',
        Rect: rect,
        L: lineCoordinates,
        C: [
            red,
            green,
            blue,
        ],
        CA: shape.opacity,
        Border: [
            0,
            0,
            lineWidth,
        ],
    }) as PDFDict;

    if (shape.type === 'arrow') {
        const lineEndStyle = shape.lineEndStyle === 'openArrow'
            ? 'OpenArrow'
            : 'ClosedArrow';
        annotDict.set(PDFName.of('LE'), doc.context.obj([
            PDFName.of('None'),
            PDFName.of(lineEndStyle),
        ]));
    }
    return annotDict;
}

export async function serializeShapeAnnotationsToDoc(
    data: Uint8Array,
    shapes: IShapeAnnotation[],
): Promise<Uint8Array> {
    if (shapes.length === 0) {
        return data;
    }

    let doc: PDFDocument;
    try {
        doc = await PDFDocument.load(data, { updateMetadata: false });
    } catch (error) {
        BrowserLogger.warn(SHAPE_SERIALIZATION_LOG_SECTION, 'Failed to load PDF for shape serialization', error);
        return data;
    }

    const pages = doc.getPages();

    for (const shape of shapes) {
        const page = pages[shape.pageIndex];
        if (!page) {
            continue;
        }
        const {
            width: pageWidth,
            height: pageHeight,
        } = page.getSize();

        let annotDict: PDFDict | null = null;
        if (shape.type === 'rectangle') {
            annotDict = createRectAnnotationDict(doc, shape, 'Square', pageWidth, pageHeight);
            setInteriorColor(annotDict, doc, shape.fillColor);
        } else if (shape.type === 'circle') {
            annotDict = createRectAnnotationDict(doc, shape, 'Circle', pageWidth, pageHeight);
            setInteriorColor(annotDict, doc, shape.fillColor);
        } else if (shape.type === 'line' || shape.type === 'arrow') {
            annotDict = createLineAnnotationDict(doc, shape, pageWidth, pageHeight);
        }

        if (!annotDict) {
            continue;
        }

        const annotRef = doc.context.register(annotDict);
        appendAnnotationRefToPage(page, doc, annotRef);
    }

    return new Uint8Array(await doc.save());
}
