import {readFile} from 'node:fs/promises';
import {
    degrees,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFRawStream,
    PDFStream,
    decodePDFRawStream,
    fill,
    popGraphicsState,
    pushGraphicsState,
    rectangle,
    rgb,
    setGraphicsState,
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

async function createSourcePdfWithPrintableSquare(
    flags = 4,
    {
        cropBox, rotation,
        withAppearance = true,
    }: {
        cropBox?: number[];
        rotation?: number;
        withAppearance?: boolean;
    } = {},
) {
    const sourcePdf = await PDFDocument.create();
    const page = sourcePdf.addPage([
        100,
        100,
    ]);
    if (cropBox) {
        page.node.set(PDFName.of('CropBox'), sourcePdf.context.obj(cropBox));
    }
    if (rotation !== undefined) {
        page.setRotation(degrees(rotation));
    }
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
        ...(withAppearance ? {AP: {N: appearanceRef}} : {}),
    }));
    page.node.addAnnot(annotationRef);
    return sourcePdf.save();
}

async function createSourcePdfWithStatefulAppearance(withSelectedState = true) {
    const sourcePdf = await PDFDocument.create();
    const page = sourcePdf.addPage([
        100,
        100,
    ]);
    const offAppearance = sourcePdf.context.formXObject([
        rectangle(0, 0, 10, 10),
        setFillingColor(rgb(1, 0, 0)),
        fill(),
    ], {
        BBox: [
            0,
            0,
            10,
            10,
        ],
        Resources: {},
    });
    const onAppearance = sourcePdf.context.formXObject([
        rectangle(0, 0, 20, 20),
        setFillingColor(rgb(0, 1, 0)),
        fill(),
    ], {
        BBox: [
            0,
            0,
            20,
            20,
        ],
        Resources: {},
    });
    const offAppearanceRef = sourcePdf.context.register(offAppearance);
    const onAppearanceRef = sourcePdf.context.register(onAppearance);
    const annotationRef = sourcePdf.context.register(sourcePdf.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [
            20,
            30,
            60,
            50,
        ],
        F: 4,
        AP: {N: {
            Off: offAppearanceRef,
            On: onAppearanceRef,
        }},
        ...(withSelectedState ? {AS: 'On'} : {}),
    }));
    page.node.addAnnot(annotationRef);
    return sourcePdf.save();
}

async function createSourcePdfWithAnnotationGraphicsState(opacity = 0.4) {
    const sourcePdf = await PDFDocument.create();
    const page = sourcePdf.addPage([
        100,
        100,
    ]);
    const appearanceGraphicsStateRef = sourcePdf.context.register(sourcePdf.context.obj({
        Type: 'ExtGState',
        ca: 0.6,
        CA: 0.6,
        BM: PDFName.of('Screen'),
    }));
    const appearance = sourcePdf.context.formXObject([
        setGraphicsState(PDFName.of('AppearanceGS')),
        rectangle(0, 0, 20, 20),
        setFillingColor(rgb(1, 0, 0)),
        fill(),
    ], {
        BBox: [
            0,
            0,
            20,
            20,
        ],
        Resources: {ExtGState: {AppearanceGS: appearanceGraphicsStateRef}},
    });
    const annotationRef = sourcePdf.context.register(sourcePdf.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [
            20,
            30,
            40,
            50,
        ],
        F: 4,
        CA: opacity,
        BM: 'Multiply',
        AP: {N: sourcePdf.context.register(appearance)},
    }));
    page.node.addAnnot(annotationRef);
    return sourcePdf.save();
}

async function createSourcePdfWithAnnotationTypes() {
    const sourcePdf = await PDFDocument.create();
    const page = sourcePdf.addPage([
        180,
        100,
    ]);
    const addAnnotation = (
        subtype: string,
        rect: number[],
        size: number,
        color: [number, number, number],
    ) => {
        const appearance = sourcePdf.context.formXObject([
            rectangle(0, 0, size, size),
            setFillingColor(rgb(...color)),
            fill(),
        ], {
            BBox: [
                0,
                0,
                size,
                size,
            ],
            Resources: {},
        });
        const annotationRef = sourcePdf.context.register(sourcePdf.context.obj({
            Type: 'Annot',
            Subtype: subtype,
            Rect: rect,
            F: 4,
            AP: {N: sourcePdf.context.register(appearance)},
        }));
        page.node.addAnnot(annotationRef);
    };

    addAnnotation('FreeText', [
        10,
        10,
        50,
        50,
    ], 10, [
        1,
        0,
        0,
    ]);
    addAnnotation('Highlight', [
        60,
        10,
        110,
        50,
    ], 12, [
        0,
        1,
        0,
    ]);
    addAnnotation('Square', [
        120,
        10,
        170,
        50,
    ], 14, [
        0,
        0,
        1,
    ]);

    return sourcePdf.save();
}

async function createSourcePdfWithRotatedAppearance(matrix = [
    0,
    1,
    -1,
    0,
    40,
    0,
]) {
    const sourcePdf = await PDFDocument.create();
    const page = sourcePdf.addPage([
        100,
        100,
    ]);
    const appearance = sourcePdf.context.formXObject([
        pushGraphicsState(),
        rectangle(0, 0, 10, 20),
        setFillingColor(rgb(1, 0, 0)),
        fill(),
        popGraphicsState(),
    ], {
        BBox: [
            0,
            0,
            10,
            20,
        ],
        Matrix: matrix,
        Resources: {},
    });
    const appearanceRef = sourcePdf.context.register(appearance);
    const annotationRef = sourcePdf.context.register(sourcePdf.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [
            20,
            30,
            60,
            50,
        ],
        F: 4,
        AP: {N: appearanceRef},
    }));
    page.node.addAnnot(annotationRef);
    return sourcePdf.save();
}

function hasPrintAnnotationUse(object: PDFStream) {
    const xObjects = object.dict.lookupMaybe(PDFName.of('Resources'), PDFDict)
        ?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const key = xObjects?.keys().find(candidate => candidate.decodeText().startsWith('PrintAnnot'));
    if (!key || !(object instanceof PDFRawStream)) {
        return false;
    }

    const content = new TextDecoder().decode(decodePDFRawStream(object).decode());
    return content.includes(`${key.asString()} Do`);
}

function findPrintAnnotationHost(pdf: PDFDocument) {
    for (const [
        , object,
    ] of pdf.context.enumerateIndirectObjects()) {
        if (!(object instanceof PDFRawStream)) {
            continue;
        }

        const xObjects = object.dict.lookupMaybe(PDFName.of('Resources'), PDFDict)
            ?.lookupMaybe(PDFName.of('XObject'), PDFDict);
        const key = xObjects?.keys().find(candidate => candidate.decodeText().startsWith('PrintAnnot'));
        if (key) {
            return object;
        }
    }

    return null;
}

function findPrintAnnotationContent(pdf: PDFDocument) {
    const host = findPrintAnnotationHost(pdf);
    return host ? new TextDecoder().decode(decodePDFRawStream(host).decode()) : null;
}

function findPrintAnnotationAppearanceContent(pdf: PDFDocument) {
    const host = findPrintAnnotationHost(pdf);
    if (host) {
        const xObjects = host.dict.lookupMaybe(PDFName.of('Resources'), PDFDict)
            ?.lookupMaybe(PDFName.of('XObject'), PDFDict);
        const key = xObjects?.keys().find(candidate => candidate.decodeText().startsWith('PrintAnnot'));
        const appearance = key ? xObjects?.lookup(key, PDFStream) : undefined;
        if (appearance instanceof PDFRawStream) {
            return new TextDecoder().decode(decodePDFRawStream(appearance).decode());
        }
    }

    return null;
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
        ]) => object instanceof PDFStream && hasPrintAnnotationUse(object))).toBe(true);
        expect(findPrintAnnotationContent(printablePdf)).toContain('20 30 20 20 re');
        expect(findPrintAnnotationContent(printablePdf)).toContain('W');
    });

    it.each([
        {
            flags: 4 | 32,
            name: 'NoView',
            expected: true,
        },
        {
            flags: 4 | 1,
            name: 'Invisible',
            expected: false,
        },
        {
            flags: 4 | 2,
            name: 'Hidden',
            expected: false,
        },
        {
            flags: 0,
            name: 'non-printable',
            expected: false,
        },
    ])('handles $name print flags', async ({
        flags, expected,
    }) => {
        const sourcePdfData = await createSourcePdfWithPrintableSquare(flags);

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'landscape',
        });

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.context.enumerateIndirectObjects().some(([
            , object,
        ]) => object instanceof PDFStream && hasPrintAnnotationUse(object))).toBe(expected);
    });

    it('maps an appearance matrix once when flattening into the annotation rectangle', async () => {
        const sourcePdfData = await createSourcePdfWithRotatedAppearance();

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'landscape',
        });

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(findPrintAnnotationContent(printablePdf)).toContain('2 0 0 2 -20 30 cm');
    });

    it('fails before composition when an appearance matrix is malformed', async () => {
        const sourcePdfData = await createSourcePdfWithRotatedAppearance([
            1,
            0,
            0,
        ]);
        const originalSourcePdfData = sourcePdfData.slice();

        await expect(buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'portrait',
        })).rejects.toThrow('invalid appearance Matrix');
        expect(sourcePdfData).toEqual(originalSourcePdfData);
    });

    it('preserves annotation opacity and blend mode around the appearance', async () => {
        const sourcePdfData = await createSourcePdfWithAnnotationGraphicsState();

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'portrait',
        });

        const printablePdf = await PDFDocument.load(printablePdfData!);
        const host = findPrintAnnotationHost(printablePdf)!;
        const resources = host.dict.lookup(PDFName.of('Resources'), PDFDict);
        const extGStates = resources.lookup(PDFName.of('ExtGState'), PDFDict);
        const key = extGStates.keys().find(candidate => candidate.decodeText().startsWith('PrintAnnot'))!;
        const extGState = extGStates.lookup(key, PDFDict);
        const content = new TextDecoder().decode(decodePDFRawStream(host).decode());

        expect(content).toContain(`${key.asString()} gs`);
        expect(extGState.lookup(PDFName.of('ca'), PDFNumber).asNumber()).toBeCloseTo(0.4);
        expect(extGState.lookup(PDFName.of('CA'), PDFNumber).asNumber()).toBeCloseTo(0.4);
        expect(extGState.lookup(PDFName.of('BM'), PDFName).decodeText()).toBe('Multiply');
        expect(findPrintAnnotationAppearanceContent(printablePdf)).toContain('AppearanceGS gs');
        const appearanceKey = host.dict.lookup(PDFName.of('Resources'), PDFDict)
            .lookup(PDFName.of('XObject'), PDFDict)
            .keys()
            .find(candidate => candidate.decodeText().startsWith('PrintAnnot'))!;
        const appearance = host.dict.lookup(PDFName.of('Resources'), PDFDict)
            .lookup(PDFName.of('XObject'), PDFDict)
            .lookup(appearanceKey, PDFStream);
        expect(appearance.dict.lookup(PDFName.of('Resources'), PDFDict)
            .lookup(PDFName.of('ExtGState'), PDFDict)
            .has(PDFName.of('AppearanceGS'))).toBe(true);
    });

    it('fails before composition when annotation opacity is outside the PDF range', async () => {
        const sourcePdfData = await createSourcePdfWithAnnotationGraphicsState(2);
        const originalSourcePdfData = sourcePdfData.slice();

        await expect(buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'portrait',
        })).rejects.toThrow('invalid opacity');
        expect(sourcePdfData).toEqual(originalSourcePdfData);
    });

    it('flattens FreeText, Highlight, and Square appearances into one composed page', async () => {
        const sourcePdfData = await createSourcePdfWithAnnotationTypes();

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'facing',
            orientation: 'portrait',
        });

        const printablePdf = await PDFDocument.load(printablePdfData!);
        const host = findPrintAnnotationHost(printablePdf)!;
        const xObjects = host.dict.lookup(PDFName.of('Resources'), PDFDict)
            .lookup(PDFName.of('XObject'), PDFDict);
        const keys = xObjects.keys().filter(key => key.decodeText().startsWith('PrintAnnot'));
        const content = new TextDecoder().decode(decodePDFRawStream(host).decode());

        expect(keys).toHaveLength(3);
        expect(keys.every(key => content.includes(`${key.asString()} Do`))).toBe(true);
    });

    it('rejects an interoperability fixture with an unsupported printable annotation before handoff', async () => {
        const sourcePdfData = new Uint8Array(await readFile(new URL(
            '../../../fixtures/electron/interop/stock-pdfjs-save-of-synthetic.pdf',
            import.meta.url,
        )));
        const originalSourcePdfData = sourcePdfData.slice();

        await expect(buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'landscape',
        })).rejects.toThrow('no normal appearance');

        expect(sourcePdfData).toEqual(originalSourcePdfData);
    });

    it('selects the requested normal appearance state before flattening', async () => {
        const sourcePdfData = await createSourcePdfWithStatefulAppearance();

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'portrait',
        });

        const printablePdf = await PDFDocument.load(printablePdfData!);
        const appearanceContent = findPrintAnnotationAppearanceContent(printablePdf);
        expect(appearanceContent).toContain('20 20 re');
        expect(appearanceContent).not.toContain('10 10 re');
    });

    it('fails before composition when a stateful appearance has no selected state', async () => {
        const sourcePdfData = await createSourcePdfWithStatefulAppearance(false);
        const originalSourcePdfData = sourcePdfData.slice();

        await expect(buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'portrait',
        })).rejects.toThrow('no normal appearance');
        expect(sourcePdfData).toEqual(originalSourcePdfData);
    });

    it('fails before composition when a printable annotation has no appearance', async () => {
        const sourcePdfData = await createSourcePdfWithPrintableSquare(4, {withAppearance: false});
        const originalSourcePdfData = sourcePdfData.slice();

        await expect(buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'portrait',
        })).rejects.toThrow('no normal appearance');
        expect(sourcePdfData).toEqual(originalSourcePdfData);
    });

    it('includes appearances in facing composition of a selected page', async () => {
        const sourcePdfData = await createSourcePdfWithPrintableSquare();

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'facing',
            orientation: 'landscape',
        });

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.getPageCount()).toBe(1);
        expect(printablePdf.context.enumerateIndirectObjects().some(([
            , object,
        ]) => object instanceof PDFStream && hasPrintAnnotationUse(object))).toBe(true);
    });

    it('maps annotation placement from a nonzero CropBox on a rotated page', async () => {
        const sourcePdfData = await createSourcePdfWithPrintableSquare(4, {
            cropBox: [
                20,
                30,
                120,
                130,
            ],
            rotation: 90,
        });

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'landscape',
        });

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(findPrintAnnotationContent(printablePdf)).toContain('0 0 20 20 re');
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
