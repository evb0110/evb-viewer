import type {PDFDict} from 'pdf-lib';
import {
    PDFArray,
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import type { IShapeAnnotation } from '@app/types/annotations';
import { parseHexColor } from '@app/utils/color';

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
    } catch {
        return data;
    }

    const pages = doc.getPages();

    for (const shape of shapes) {
        const page = pages[shape.pageIndex];
        if (!page) continue;

        const {
            width: pageWidth,
            height: pageHeight,
        } = page.getSize();
        const [
            r,
            g,
            b,
        ] = parseHexColor(shape.color);
        const lineWidth = shape.strokeWidth;

        if (shape.type === 'rectangle') {
            const x = shape.x * pageWidth;
            const y = (1 - shape.y - shape.height) * pageHeight;
            const w = shape.width * pageWidth;
            const h = shape.height * pageHeight;

            const rect = doc.context.obj([
                x,
                y,
                x + w,
                y + h,
            ]);
            const annotDict = doc.context.obj({
                Type: 'Annot',
                Subtype: 'Square',
                Rect: rect,
                C: [
                    r,
                    g,
                    b,
                ],
                CA: shape.opacity,
                Border: [
                    0,
                    0,
                    lineWidth,
                ],
            });

            if (shape.fillColor) {
                const [
                    fr,
                    fg,
                    fb,
                ] = parseHexColor(shape.fillColor);
                (annotDict as PDFDict).set(PDFName.of('IC'), doc.context.obj([
                    fr,
                    fg,
                    fb,
                ]));
            }

            const annotRef = doc.context.register(annotDict);
            const annots = page.node.Annots() ?? doc.context.obj([]);
            if (annots instanceof PDFArray) {
                annots.push(annotRef);
            }
            page.node.set(PDFName.of('Annots'), annots instanceof PDFArray ? annots : doc.context.obj([annotRef]));
        } else if (shape.type === 'circle') {
            const x = shape.x * pageWidth;
            const y = (1 - shape.y - shape.height) * pageHeight;
            const w = shape.width * pageWidth;
            const h = shape.height * pageHeight;

            const rect = doc.context.obj([
                x,
                y,
                x + w,
                y + h,
            ]);
            const annotDict = doc.context.obj({
                Type: 'Annot',
                Subtype: 'Circle',
                Rect: rect,
                C: [
                    r,
                    g,
                    b,
                ],
                CA: shape.opacity,
                Border: [
                    0,
                    0,
                    lineWidth,
                ],
            });

            if (shape.fillColor) {
                const [
                    fr,
                    fg,
                    fb,
                ] = parseHexColor(shape.fillColor);
                (annotDict as PDFDict).set(PDFName.of('IC'), doc.context.obj([
                    fr,
                    fg,
                    fb,
                ]));
            }

            const annotRef = doc.context.register(annotDict);
            const annots = page.node.Annots() ?? doc.context.obj([]);
            if (annots instanceof PDFArray) {
                annots.push(annotRef);
            }
            page.node.set(PDFName.of('Annots'), annots instanceof PDFArray ? annots : doc.context.obj([annotRef]));
        } else if (shape.type === 'line' || shape.type === 'arrow') {
            const x1 = shape.x * pageWidth;
            const y1 = (1 - shape.y) * pageHeight;
            const x2 = (shape.x2 ?? shape.x) * pageWidth;
            const y2 = (1 - (shape.y2 ?? shape.y)) * pageHeight;

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
            const l = doc.context.obj([
                x1,
                y1,
                x2,
                y2,
            ]);

            const annotDict = doc.context.obj({
                Type: 'Annot',
                Subtype: 'Line',
                Rect: rect,
                L: l,
                C: [
                    r,
                    g,
                    b,
                ],
                CA: shape.opacity,
                Border: [
                    0,
                    0,
                    lineWidth,
                ],
            });

            if (shape.type === 'arrow') {
                const leStyle = shape.lineEndStyle === 'openArrow' ? 'OpenArrow' : 'ClosedArrow';
                (annotDict as PDFDict).set(PDFName.of('LE'), doc.context.obj([
                    PDFName.of('None'),
                    PDFName.of(leStyle),
                ]));
            }

            const annotRef = doc.context.register(annotDict);
            const annots = page.node.Annots() ?? doc.context.obj([]);
            if (annots instanceof PDFArray) {
                annots.push(annotRef);
            }
            page.node.set(PDFName.of('Annots'), annots instanceof PDFArray ? annots : doc.context.obj([annotRef]));
        }
    }

    return new Uint8Array(await doc.save());
}
