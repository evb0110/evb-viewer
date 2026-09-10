import {
    degrees,
    PDFArray,
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFStream,
    fill,
    popGraphicsState,
    pushGraphicsState,
    rectangle,
    rgb,
    setFillingColor,
} from 'pdf-lib';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildPrintablePdfData,
    buildPrintSpreadGroups,
} from '@pdf-core';

async function createRotatedSourcePdf(
    rotations: readonly number[],
    {withContent = true}: {withContent?: boolean} = {},
) {
    const sourcePdf = await PDFDocument.create();

    for (const rotation of rotations) {
        const page = sourcePdf.addPage([
            100,
            200,
        ]);
        page.setRotation(degrees(rotation));
        if (withContent) {
            page.drawRectangle({
                x: 10,
                y: 20,
                width: 30,
                height: 50,
            });
        }
    }

    return sourcePdf.save();
}

async function createSourcePdfWithPrintableSquare(flags = 4) {
    const sourcePdf = await PDFDocument.create();
    const page = sourcePdf.addPage([
        100,
        100,
    ]);
    const appearance = sourcePdf.context.formXObject([
        pushGraphicsState(),
        rectangle(0, 0, 20, 20),
        setFillingColor(rgb(1, 0, 0)),
        fill(),
        popGraphicsState(),
    ], {
        BBox: [
            0,
            0,
            20,
            20,
        ],
        Resources: {},
    });
    const appearanceRef = sourcePdf.context.register(appearance);
    const annotationRef = sourcePdf.context.register(sourcePdf.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [
            20,
            30,
            40,
            50,
        ],
        F: flags,
        AP: {N: appearanceRef},
    }));
    page.node.addAnnot(annotationRef);
    return sourcePdf.save();
}

describe('pdf print layout', () => {
    it('flattens printable annotation appearances into composed pages', async () => {
        const sourcePdfData = await createSourcePdfWithPrintableSquare();
        const originalSourcePdfData = sourcePdfData.slice();

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'landscape',
        });

        expect(sourcePdfData).toEqual(originalSourcePdfData);
        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.getPage(0)?.node.Annots()?.size()).toBe(0);
        expect(printablePdf.context.enumerateIndirectObjects().some(([
            , object,
        ]) => {
            if (!(object instanceof PDFStream)) {
                return false;
            }
            const bbox = object.dict.lookupMaybe(PDFName.of('BBox'), PDFArray);
            return bbox?.asArray().every((value, index) => (
                value instanceof PDFNumber && value.asNumber() === [
                    0,
                    0,
                    20,
                    20,
                ][index]
            )) ?? false;
        })).toBe(true);
    });

    it('does not flatten NoView annotations into composed pages', async () => {
        const sourcePdfData = await createSourcePdfWithPrintableSquare(4 | 32);

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'landscape',
        });

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.context.enumerateIndirectObjects().some(([
            , object,
        ]) => object instanceof PDFStream
            && object.dict.lookupMaybe(PDFName.of('BBox'), PDFArray))).toBe(false);
    });

    it('uses the displayed dimensions of a rotated page for single-page printing', async () => {
        const sourcePdfData = await createRotatedSourcePdf([90]);

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'auto',
        });

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.getPage(0)?.getSize()).toEqual({
            width: 841.89,
            height: 595.28,
        });
    });

    it('uses the displayed dimensions of rotated pages for facing-page printing', async () => {
        const sourcePdfData = await createRotatedSourcePdf([
            90,
            90,
        ]);

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [
                1,
                2,
            ],
            viewMode: 'facing',
            orientation: 'auto',
        });

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.getPage(0)?.getSize()).toEqual({
            width: 841.89,
            height: 595.28,
        });
    });

    it('keeps first-page-single spreads on uniform landscape sheets', async () => {
        const sourcePdfData = await createRotatedSourcePdf([
            0,
            0,
            0,
            0,
        ]);

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [
                1,
                2,
                3,
                4,
            ],
            viewMode: 'facing-first-single',
            orientation: 'auto',
        });

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.getPageCount()).toBe(3);
        expect(printablePdf.getPages().map(page => page.getSize())).toEqual([
            {
                width: 841.89,
                height: 595.28,
            },
            {
                width: 841.89,
                height: 595.28,
            },
            {
                width: 841.89,
                height: 595.28,
            },
        ]);
    });

    it('composes all 486 reported pages into ordered facing sheets without changing the source', async () => {
        const pageNumbers = Array.from({length: 486}, (_, index) => index + 1);
        const groups = buildPrintSpreadGroups(pageNumbers, 'facing');
        expect(groups).toHaveLength(243);
        expect(groups[0]).toEqual([
            1,
            2,
        ]);
        expect(groups[121]).toEqual([
            243,
            244,
        ]);
        expect(groups.at(-1)).toEqual([
            485,
            486,
        ]);

        const firstSingleGroups = buildPrintSpreadGroups(pageNumbers, 'facing-first-single');
        expect(firstSingleGroups).toHaveLength(244);
        expect(firstSingleGroups.slice(0, 2)).toEqual([
            [1],
            [
                2,
                3,
            ],
        ]);
        expect(firstSingleGroups.at(-1)).toEqual([486]);

        const sourcePdfData = await createRotatedSourcePdf(
            Array<number>(486).fill(0),
            {withContent: false},
        );
        const originalSourcePdfData = sourcePdfData.slice();
        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers,
            viewMode: 'facing',
            orientation: 'auto',
        });

        expect(sourcePdfData).toEqual(originalSourcePdfData);
        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.getPageCount()).toBe(243);
        expect(printablePdf.getPages().every(page => {
            const size = page.getSize();
            return size.width === 841.89 && size.height === 595.28;
        })).toBe(true);
    });
});
