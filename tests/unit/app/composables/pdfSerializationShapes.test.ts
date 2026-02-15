import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFRef,
} from 'pdf-lib';
import type { IShapeAnnotation } from '@app/types/annotations';
import { serializeShapeAnnotationsToDoc } from '@app/composables/pdf/pdfSerializationShapes';

async function createPdfDataWithSinglePage() {
    const doc = await PDFDocument.create();
    doc.addPage([
        600,
        800,
    ]);
    return new Uint8Array(await doc.save());
}

function getPageAnnotationDicts(doc: PDFDocument, pageIndex = 0) {
    const annots = doc.getPage(pageIndex).node.Annots();
    if (!(annots instanceof PDFArray)) {
        return [];
    }
    const dicts: PDFDict[] = [];
    for (let index = 0; index < annots.size(); index += 1) {
        const ref = annots.get(index);
        if (!(ref instanceof PDFRef)) {
            continue;
        }
        const dict = doc.context.lookupMaybe(ref, PDFDict);
        if (dict) {
            dicts.push(dict);
        }
    }
    return dicts;
}

function getName(dict: PDFDict, key: string) {
    const value = dict.get(PDFName.of(key));
    return value instanceof PDFName ? value.toString() : null;
}

describe('serializeShapeAnnotationsToDoc', () => {
    it('returns source bytes when no shapes are provided', async () => {
        const source = await createPdfDataWithSinglePage();
        const result = await serializeShapeAnnotationsToDoc(source, []);
        expect(result).toBe(source);
    });

    it('returns original payload when PDF bytes are invalid', async () => {
        const source = Uint8Array.from([
            1,
            2,
            3,
        ]);
        const result = await serializeShapeAnnotationsToDoc(source, [{
            id: 'shape-1',
            type: 'rectangle',
            pageIndex: 0,
            x: 0.1,
            y: 0.1,
            width: 0.2,
            height: 0.2,
            color: '#ff0000',
            opacity: 0.8,
            strokeWidth: 2,
        }]);
        expect(result).toBe(source);
    });

    it('serializes rectangle and arrow annotations into page Annots', async () => {
        const source = await createPdfDataWithSinglePage();
        const shapes: IShapeAnnotation[] = [
            {
                id: 'shape-rect',
                type: 'rectangle',
                pageIndex: 0,
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.2,
                color: '#336699',
                fillColor: '#abcdef',
                opacity: 0.5,
                strokeWidth: 3,
            },
            {
                id: 'shape-arrow',
                type: 'arrow',
                pageIndex: 0,
                x: 0.4,
                y: 0.4,
                x2: 0.7,
                y2: 0.45,
                width: 0,
                height: 0,
                color: '#000000',
                opacity: 1,
                strokeWidth: 2,
                lineEndStyle: 'openArrow',
            },
        ];

        const result = await serializeShapeAnnotationsToDoc(source, shapes);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dicts = getPageAnnotationDicts(doc);

        expect(dicts).toHaveLength(2);
        expect(getName(dicts[0]!, 'Subtype')).toBe('/Square');
        expect(getName(dicts[1]!, 'Subtype')).toBe('/Line');
        expect(dicts[0]!.get(PDFName.of('IC'))).toBeTruthy();
        expect(dicts[1]!.get(PDFName.of('LE'))).toBeTruthy();
    });

    it('ignores shapes whose page index does not exist', async () => {
        const source = await createPdfDataWithSinglePage();
        const result = await serializeShapeAnnotationsToDoc(source, [{
            id: 'shape-missing-page',
            type: 'circle',
            pageIndex: 5,
            x: 0.1,
            y: 0.1,
            width: 0.2,
            height: 0.2,
            color: '#ff0000',
            opacity: 1,
            strokeWidth: 1,
        }]);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        expect(getPageAnnotationDicts(doc)).toEqual([]);
    });
});
