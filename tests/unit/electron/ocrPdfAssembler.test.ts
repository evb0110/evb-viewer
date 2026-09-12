import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    degrees,
    decodePDFRawStream,
    PDFArray,
    PDFContentStream,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFRawStream,
    PDFRef,
    PDFStream,
    rgb,
    StandardFonts,
} from 'pdf-lib';
import {
    getDocument,
    Util,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
    assembleSearchablePdf,
    loadBoundedGeneratedPagePdf,
    MAX_OCR_PAGE_ARTIFACT_BYTES,
    OcrGeneratedPageArtifactLimitError,
    sanitizeOcrContentStreamForEmbedding,
    stripTesseractImageLayer,
} from '@electron/features/ocr/worker/pdfAssembler';
import { createPdfjsNodeDocumentOptions } from '@electron/features/search/public';
import { resolveTestQpdfBinary } from '@tests/helpers/resolveTestQpdfBinary';
import { renderPdfCanvasFidelityMetrics } from '@tests/helpers/renderPdfCanvasFidelityMetrics';
import {adaptPdfjsDocument} from '@app/services/pdfjs/pdfjsCompatibility';

const QPDF_TEST_BINARY = resolveTestQpdfBinary();

async function addHiddenTextLayer(
    pdf: PDFDocument,
    page: ReturnType<PDFDocument['addPage']>,
    text: string,
    position: {
        x: number;
        y: number
    } = {
        x: 20,
        y: 100,
    },
) {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontName = page.node.newFontDictionary('OcrFont', font.ref);
    const encodedText = font.encodeText(text).toString();
    const stream = [
        'BT',
        `3 Tr 1 0 0 1 ${position.x} ${position.y} Tm ${fontName} 12 Tf ${encodedText} Tj`,
        'ET',
        '',
    ].join('\n');
    page.node.addContentStream(pdf.context.register(pdf.context.flateStream(stream)));
}

async function extractTextViewportPositions(filePath: string) {
    const task = getDocument({
        data: new Uint8Array(await readFile(filePath)),
        ...createPdfjsNodeDocumentOptions(),
    });
    const pdf = adaptPdfjsDocument(await task.promise, () => task.destroy());
    try {
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({scale: 1});
        const content = await page.getTextContent();
        return Object.fromEntries(content.items.flatMap((item) => {
            if (!('str' in item) || !item.str.trim()) {
                return [];
            }
            const transformed = Util.transform(viewport.transform, item.transform);
            return [[
                item.str.trim(),
                {
                    x: transformed[4],
                    y: transformed[5],
                },
            ]];
        }));
    } finally {
        await pdf.destroy();
    }
}

async function createPdfWithVisibleAndHiddenText(filePath: string, spec: {
    visibleText?: string;
    hiddenText?: string;
    size?: [number, number];
}) {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage(spec.size ?? [
        200,
        200,
    ]);
    page.drawRectangle({
        x: 10,
        y: 10,
        width: 50,
        height: 30,
        color: rgb(0.8, 0.8, 0.8),
    });
    if (spec.visibleText) {
        page.drawText(spec.visibleText, {
            x: 20,
            y: 140,
            size: 18,
        });
    }
    if (spec.hiddenText) {
        await addHiddenTextLayer(pdf, page, spec.hiddenText);
    }
    await writeFile(filePath, await pdf.save());
}

async function createPdfWithPages(filePath: string, pages: Array<{
    text?: string;
    hiddenText?: string;
    size: [number, number];
}>) {
    const pdf = await PDFDocument.create();
    for (const pageSpec of pages) {
        const page = pdf.addPage(pageSpec.size);
        page.drawRectangle({
            x: 10,
            y: 10,
            width: 50,
            height: 30,
            color: rgb(0.8, 0.8, 0.8),
        });
        if (pageSpec.text) {
            page.drawText(pageSpec.text, {
                x: 20,
                y: Math.max(40, pageSpec.size[1] / 2),
                size: 18,
            });
        }
        if (pageSpec.hiddenText) {
            await addHiddenTextLayer(pdf, page, pageSpec.hiddenText);
        }
    }
    await writeFile(filePath, await pdf.save());
}

async function createPdfWithMixedHiddenTextPreamble(filePath: string) {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([
        220,
        180,
    ]);
    page.drawRectangle({
        x: 10,
        y: 10,
        width: 50,
        height: 30,
        color: rgb(0.8, 0.8, 0.8),
    });
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontName = page.node.newFontDictionary('MixedOcrFont', font.ref);
    const encodedText = font.encodeText('OLD OCR').toString();
    const stream = [
        'BT',
        `${fontName} 12 Tf`,
        '3 Tr',
        'ET',
        'BT',
        `1 0 0 1 20 120 Tm ${encodedText} Tj`,
        'ET',
        '',
    ].join('\n');
    page.node.addContentStream(pdf.context.register(pdf.context.flateStream(stream)));
    await writeFile(filePath, await pdf.save());
}

async function createPdfWithImageAndHiddenText(filePath: string, hiddenText: string) {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([
        220,
        180,
    ]);
    page.drawRectangle({
        x: 10,
        y: 10,
        width: 50,
        height: 30,
        color: rgb(0.8, 0.8, 0.8),
    });
    const image = await pdf.embedPng(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
    ));
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontName = page.node.newFontDictionary('MixedOcrFont', font.ref);
    const imageName = page.node.newXObject('MixedOcrImage', image.ref);
    const encodedText = font.encodeText(hiddenText).toString();
    page.node.addContentStream(pdf.context.register(pdf.context.flateStream([
        'q 120 0 0 90 80 45 cm',
        `${imageName} Do`,
        'Q',
        'BT',
        `3 Tr 1 0 0 1 20 120 Tm ${fontName} 12 Tf ${encodedText} Tj`,
        'ET',
        '',
    ].join('\n'))));
    await writeFile(filePath, await pdf.save());
}

async function createPdfWithEscapedImageResourceNames(filePath: string) {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([
        200,
        200,
    ]);
    page.drawRectangle({
        x: 0,
        y: 0,
        width: 200,
        height: 200,
        color: rgb(0.8, 0.8, 0.8),
    });
    const image = await pdf.embedPng(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
    ));
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const encodedText = font.encodeText('SOURCE').toString();
    const fontDictionary = pdf.context.obj({});
    fontDictionary.set(PDFName.of('Font+1'), font.ref);
    const extGStateDictionary = pdf.context.obj({});
    extGStateDictionary.set(PDFName.of('GS A'), pdf.context.obj({
        Type: PDFName.of('ExtGState'),
        CA: 0.5,
        ca: 0.5,
    }));
    const xObject = pdf.context.obj({});
    for (const name of [
        'Im+1',
        'Im A',
        'ordinary',
        'P!unct',
    ]) {
        xObject.set(PDFName.of(name), image.ref);
    }
    page.node.set(PDFName.of('Resources'), pdf.context.obj({
        ExtGState: extGStateDictionary,
        Font: fontDictionary,
        XObject: xObject,
    }));
    page.node.addContentStream(pdf.context.register(pdf.context.flateStream([
        'q /GS#20A gs',
        `BT /Font#2B1 18 Tf 1 0 0 1 20 150 Tm ${encodedText} Tj ET`,
        'Q',
        'q 40 0 0 40 10 10 cm /Im#2B1 Do Q',
        'q 40 0 0 40 60 10 cm /Im#20A Do Q',
        'q 40 0 0 40 110 10 cm /ordinary Do Q',
        'q 40 0 0 40 160 10 cm /P#21unct Do Q',
        '',
    ].join('\n'))));
    await writeFile(filePath, await pdf.save());
}

function countTextOccurrences(text: string, needle: string) {
    return text.split(needle).length - 1;
}

async function getPdfPageSizes(filePath: string) {
    const pdf = await PDFDocument.load(await readFile(filePath));
    return pdf.getPages().map((page) => {
        const size = page.getSize();
        return [
            size.width,
            size.height,
        ] as const;
    });
}

async function extractPdfText(filePath: string) {
    const task = getDocument({
        data: new Uint8Array(await readFile(filePath)),
        ...createPdfjsNodeDocumentOptions(),
    });
    const pdf = adaptPdfjsDocument(await task.promise, () => task.destroy());

    try {
        const parts: string[] = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            const page = await pdf.getPage(pageNumber);
            const textContent = await page.getTextContent();
            parts.push(textContent.items
                .map(item => ('str' in item ? item.str : ''))
                .join(' '));
        }
        return parts.join('\n').replace(/\s+/g, ' ').trim();
    } finally {
        await pdf.destroy();
    }
}

function decodeContentStream(stream: PDFStream) {
    if (stream instanceof PDFRawStream) {
        return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
    }
    if (stream instanceof PDFContentStream) {
        return Buffer.from(stream.getUnencodedContents()).toString('latin1');
    }
    return '';
}

async function getFirstPageContentText(filePath: string) {
    const pdf = await PDFDocument.load(await readFile(filePath));
    const page = pdf.getPage(0);
    const contentsValue = page.node.get(PDFName.of('Contents'));
    const streams: PDFStream[] = [];

    if (contentsValue instanceof PDFArray) {
        for (let index = 0; index < contentsValue.size(); index += 1) {
            const value = contentsValue.get(index);
            const stream = value instanceof PDFRef
                ? pdf.context.lookup(value)
                : value;
            if (stream instanceof PDFStream) {
                streams.push(stream);
            }
        }
    } else {
        const stream = contentsValue instanceof PDFRef
            ? pdf.context.lookup(contentsValue)
            : contentsValue;
        if (stream instanceof PDFStream) {
            streams.push(stream);
        }
    }

    return streams.map(decodeContentStream).join('\n');
}

async function getFirstPageExtGStateAlphaEntries(filePath: string) {
    const pdf = await PDFDocument.load(await readFile(filePath));
    const page = pdf.getPage(0);
    const resources = page.node.lookup(PDFName.of('Resources'));
    if (!(resources instanceof PDFDict)) {
        return [];
    }
    const extGState = resources.lookup(PDFName.of('ExtGState'));
    if (!(extGState instanceof PDFDict)) {
        return [];
    }

    return extGState.keys().map(key => {
        const value = extGState.lookup(key);
        if (!(value instanceof PDFDict)) {
            return {
                name: key.toString(),
                ca: null,
                CA: null,
            };
        }
        return {
            name: key.toString(),
            ca: value.get(PDFName.of('ca'))?.toString() ?? null,
            CA: value.get(PDFName.of('CA'))?.toString() ?? null,
        };
    });
}

async function getFirstPageResourceNames(filePath: string, category: string) {
    const pdf = await PDFDocument.load(await readFile(filePath));
    const resources = pdf.getPage(0).node.lookup(PDFName.of('Resources'));
    if (!(resources instanceof PDFDict)) {
        return [];
    }
    const dictionary = resources.lookup(PDFName.of(category));
    return dictionary instanceof PDFDict
        ? dictionary.keys().map(key => key.asString().replace(/^\//u, ''))
        : [];
}

describe('assembleSearchablePdf', () => {
    let tempDir: string | null = null;

    afterEach(async () => {
        if (tempDir) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
            tempDir = null;
        }
    });

    it('rejects an oversized generated page artifact before loading it with pdf-lib', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const artifactPath = join(tempDir, 'oversized-generated-page.pdf');
        await writeFile(artifactPath, Buffer.alloc(MAX_OCR_PAGE_ARTIFACT_BYTES + 1));

        const error = await loadBoundedGeneratedPagePdf(artifactPath, 'Generated OCR PDF page')
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(OcrGeneratedPageArtifactLimitError);
        if (error instanceof OcrGeneratedPageArtifactLimitError) {
            expect(error.code).toBe('OCR_GENERATED_PAGE_ARTIFACT_TOO_LARGE');
            expect(error.size).toBe(MAX_OCR_PAGE_ARTIFACT_BYTES + 1);
        }
    });

    it('preserves visible page content while replacing the hidden OCR text layer', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'original.pdf');
        const ocrPath = join(tempDir, 'ocr.pdf');
        await createPdfWithVisibleAndHiddenText(originalPath, {
            visibleText: 'VISIBLE ORIGINAL',
            hiddenText: 'OLD OCR',
        });
        await createPdfWithVisibleAndHiddenText(ocrPath, { hiddenText: 'NEW OCR' });
        const ocrPages = new Map<number, string>();
        ocrPages.set(1, ocrPath);

        const outputPath = await assembleSearchablePdf(
            QPDF_TEST_BINARY,
            originalPath,
            ocrPages,
            1,
            tempDir,
            'test-session',
            vi.fn(),
            path => path,
        );

        const extractedText = await extractPdfText(outputPath);

        expect(extractedText).toContain('VISIBLE ORIGINAL');
        expect(extractedText).toContain('NEW OCR');
        expect(extractedText).not.toContain('OLD OCR');
    });

    it('keeps text-only Tesseract OCR pages searchable without painting their visible glyphs', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'original.pdf');
        const ocrPath = join(tempDir, 'visible-text-only-ocr.pdf');
        await createPdfWithVisibleAndHiddenText(originalPath, { visibleText: 'VISIBLE ORIGINAL' });
        await createPdfWithVisibleAndHiddenText(ocrPath, { visibleText: 'OCR TEXT ONLY' });
        const ocrPages = new Map<number, string>();
        ocrPages.set(1, ocrPath);

        const outputPath = await assembleSearchablePdf(
            QPDF_TEST_BINARY,
            originalPath,
            ocrPages,
            1,
            tempDir,
            'visible-text-session',
            vi.fn(),
            path => path,
        );

        const extractedText = await extractPdfText(outputPath);
        const firstPageContent = await getFirstPageContentText(outputPath);
        const alphaEntries = await getFirstPageExtGStateAlphaEntries(outputPath);

        expect(extractedText).toContain('VISIBLE ORIGINAL');
        expect(extractedText).toContain('OCR TEXT ONLY');
        expect(firstPageContent).toContain('EVB_VIEWER_OCR_LAYER_BEGIN');
        expect(firstPageContent).toMatch(/\/EvbOcrInvisible\S*\s+gs/u);
        expect(alphaEntries).toContainEqual(expect.objectContaining({
            ca: '0',
            CA: '0',
        }));
    });

    it('assembles OCR output when original page resources are malformed', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'original.pdf');
        const firstOcrPath = join(tempDir, 'ocr-first.pdf');
        const secondOcrPath = join(tempDir, 'ocr-second.pdf');
        const originalPdf = await PDFDocument.create();
        const firstPage = originalPdf.addPage([
            200,
            200,
        ]);
        firstPage.node.set(PDFName.of('Resources'), PDFName.of('Nope'));
        const secondPage = originalPdf.addPage([
            200,
            200,
        ]);
        secondPage.node.set(PDFName.of('Resources'), originalPdf.context.obj({
            Font: PDFName.of('Nope'),
            XObject: PDFName.of('Nope'),
        }));
        await writeFile(originalPath, await originalPdf.save());
        await createPdfWithVisibleAndHiddenText(firstOcrPath, { hiddenText: 'FIRST OCR' });
        await createPdfWithVisibleAndHiddenText(secondOcrPath, { hiddenText: 'SECOND OCR' });

        const ocrPages = new Map<number, string>();
        ocrPages.set(1, firstOcrPath);
        ocrPages.set(2, secondOcrPath);

        const outputPath = await assembleSearchablePdf(
            QPDF_TEST_BINARY,
            originalPath,
            ocrPages,
            2,
            tempDir,
            'malformed-resources-session',
            vi.fn(),
            path => path,
        );

        const extractedText = await extractPdfText(outputPath);

        expect(extractedText).toContain('FIRST OCR');
        expect(extractedText).toContain('SECOND OCR');
    });

    it('retains source resources when removed OCR content cannot be parsed', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'malformed-content-original.pdf');
        const ocrPath = join(tempDir, 'malformed-content-ocr.pdf');
        const originalPdf = await PDFDocument.create();
        const page = originalPdf.addPage([
            200,
            200,
        ]);
        const font = await originalPdf.embedFont(StandardFonts.Helvetica);
        const sourceFontName = page.node.newFontDictionary('Source+Font', font.ref);
        page.node.addContentStream(originalPdf.context.register(originalPdf.context.flateStream([
            'BT',
            `${sourceFontName} 12 Tf`,
            '3 Tr',
            '(BROKEN OCR Tj',
            'ET',
            '',
        ].join('\n'))));
        await writeFile(originalPath, await originalPdf.save());
        await createPdfWithVisibleAndHiddenText(ocrPath, { hiddenText: 'NEW OCR' });

        const outputPath = await assembleSearchablePdf(
            QPDF_TEST_BINARY,
            originalPath,
            new Map([[
                1,
                ocrPath,
            ]]),
            1,
            tempDir,
            'malformed-content-session',
            vi.fn(),
            path => path,
        );

        expect((await getFirstPageResourceNames(outputPath, 'Font'))
            .some(name => name.startsWith('Source+Font'))).toBe(true);
    });

    it('preserves source image resources whose PDF names contain escapes', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'escaped-resource-names-original.pdf');
        const ocrPath = join(tempDir, 'escaped-resource-names-ocr.pdf');
        await createPdfWithEscapedImageResourceNames(originalPath);
        await createPdfWithVisibleAndHiddenText(ocrPath, {hiddenText: 'ESCAPED NAMES'});

        const outputPath = await assembleSearchablePdf(
            QPDF_TEST_BINARY,
            originalPath,
            new Map([[
                1,
                ocrPath,
            ]]),
            1,
            tempDir,
            'escaped-resource-names-session',
            vi.fn(),
            path => path,
        );

        const originalMetrics = await renderPdfCanvasFidelityMetrics(originalPath);
        const outputMetrics = await renderPdfCanvasFidelityMetrics(outputPath);
        expect(outputMetrics.width).toBe(originalMetrics.width);
        expect(outputMetrics.height).toBe(originalMetrics.height);
        expect(outputMetrics.meanLuminance).toBeCloseTo(originalMetrics.meanLuminance, 8);
        expect(outputMetrics.inkPixelRatio).toBeCloseTo(originalMetrics.inkPixelRatio, 8);
        expect(outputMetrics.darkPixelRatio).toBeCloseTo(originalMetrics.darkPixelRatio, 8);
        const outputContent = await getFirstPageContentText(outputPath);
        expect(outputContent).toContain('/Im#2B1 Do');
        expect(outputContent).toContain('/Im#20A Do');
        expect(outputContent).toContain('/ordinary Do');
        expect(outputContent).toContain('/P#21unct Do');
        expect(outputContent).toContain('/GS#20A gs');
        expect(outputContent).toContain('/Font#2B1 18 Tf');
        expect(await getFirstPageResourceNames(outputPath, 'Font')).toContain('Font+1');
        expect(await getFirstPageResourceNames(outputPath, 'ExtGState')).toContain('GS#20A');
    });

    it('replaces previous OCR page text when applying OCR again', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'original.pdf');
        const firstOcrPath = join(tempDir, 'ocr-first.pdf');
        const secondOcrPath = join(tempDir, 'ocr-second.pdf');
        await createPdfWithVisibleAndHiddenText(originalPath, {
            visibleText: 'VISIBLE ORIGINAL',
            hiddenText: 'ORIGINAL OCR',
        });
        await createPdfWithVisibleAndHiddenText(firstOcrPath, { hiddenText: 'FIRST OCR' });
        await createPdfWithVisibleAndHiddenText(secondOcrPath, { hiddenText: 'SECOND OCR' });

        const firstOcrPages = new Map<number, string>();
        firstOcrPages.set(1, firstOcrPath);
        const secondOcrPages = new Map<number, string>();
        secondOcrPages.set(1, secondOcrPath);
        const firstOutputPath = await assembleSearchablePdf(
            QPDF_TEST_BINARY,
            originalPath,
            firstOcrPages,
            1,
            tempDir,
            'first-session',
            vi.fn(),
            path => path,
        );

        // Keep a source Form that reaches the first OCR layer's invisible
        // state through nested resources. Top-level scanning cannot prove
        // that this shared name is obsolete.
        const firstPdf = await PDFDocument.load(await readFile(firstOutputPath));
        const firstPage = firstPdf.getPage(0);
        const firstResources = firstPage.node.lookup(PDFName.of('Resources'));
        expect(firstResources).toBeInstanceOf(PDFDict);
        const firstContent = await getFirstPageContentText(firstOutputPath);
        const firstLayerName = firstContent.match(/\/(EvbOcrLayer-[^\s]+)\s+Do/u)?.[1];
        const firstInvisibleName = firstContent.match(/\/(EvbOcrInvisible-[^\s]+)\s+gs/u)?.[1];
        expect(firstLayerName).toBeTruthy();
        expect(firstInvisibleName).toBeTruthy();
        const firstResourceDict = firstResources as PDFDict;
        const firstExtGState = firstResourceDict.lookup(PDFName.of('ExtGState'));
        expect(firstExtGState).toBeInstanceOf(PDFDict);
        const invisibleRef = (firstExtGState as PDFDict).get(PDFName.of(firstInvisibleName!));
        expect(invisibleRef).toBeTruthy();
        const nestedExtGState = firstPdf.context.obj({});
        nestedExtGState.set(PDFName.of(firstInvisibleName!), invisibleRef!);
        const nestedResources = firstPdf.context.obj({});
        nestedResources.set(PDFName.of('ExtGState'), nestedExtGState);
        const nestedForm = firstPdf.context.flateStream(`q\n/${firstInvisibleName} gs\nQ\n`);
        nestedForm.dict.set(PDFName.of('Type'), PDFName.of('XObject'));
        nestedForm.dict.set(PDFName.of('Subtype'), PDFName.of('Form'));
        nestedForm.dict.set(PDFName.of('BBox'), firstPdf.context.obj([
            0,
            0,
            200,
            200,
        ]));
        nestedForm.dict.set(PDFName.of('Resources'), nestedResources);
        const nestedFormRef = firstPdf.context.register(nestedForm);
        const firstXObject = firstResourceDict.lookup(PDFName.of('XObject'));
        expect(firstXObject).toBeInstanceOf(PDFDict);
        (firstXObject as PDFDict).set(PDFName.of('KeptSharedForm'), nestedFormRef);
        firstPage.node.addContentStream(firstPdf.context.register(firstPdf.context.flateStream('/KeptSharedForm Do\n')));
        await writeFile(firstOutputPath, await firstPdf.save());

        const secondOutputPath = await assembleSearchablePdf(
            QPDF_TEST_BINARY,
            firstOutputPath,
            secondOcrPages,
            1,
            tempDir,
            'second-session',
            vi.fn(),
            path => path,
        );

        const extractedText = await extractPdfText(secondOutputPath);

        expect(extractedText).toContain('VISIBLE ORIGINAL');
        expect(extractedText).toContain('SECOND OCR');
        expect(countTextOccurrences(extractedText, 'SECOND OCR')).toBe(1);
        expect(extractedText).not.toContain('FIRST OCR');
        expect(extractedText).not.toContain('ORIGINAL OCR');
        const secondContent = await getFirstPageContentText(secondOutputPath);
        const secondLayerName = secondContent.match(/\/(EvbOcrLayer-[^\s]+)\s+Do/u)?.[1];
        expect(secondLayerName).toBeTruthy();
        expect(secondContent).toContain(`/${secondLayerName} Do`);
        const secondLayerResources = (await getFirstPageResourceNames(secondOutputPath, 'XObject'))
            .filter(name => name.startsWith('EvbOcrLayer-'));
        expect(secondLayerResources).toEqual(expect.arrayContaining([
            firstLayerName,
            secondLayerName,
        ]));
        expect((await getFirstPageResourceNames(secondOutputPath, 'ExtGState'))
            .filter(name => name.startsWith('EvbOcrInvisible-')))
            .toContain(firstInvisibleName);
    });

    it('removes foreign hidden text from an image-plus-text stream during replacement', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'original.pdf');
        const ocrPath = join(tempDir, 'ocr.pdf');
        await createPdfWithImageAndHiddenText(originalPath, 'OLD OCR');
        await createPdfWithVisibleAndHiddenText(ocrPath, { hiddenText: 'NEW OCR' });

        const outputPath = await assembleSearchablePdf(
            QPDF_TEST_BINARY,
            originalPath,
            new Map([[
                1,
                ocrPath,
            ]]),
            1,
            tempDir,
            'mixed-image-text-session',
            vi.fn(),
            path => path,
        );

        const extractedText = await extractPdfText(outputPath);
        expect(extractedText).toContain('NEW OCR');
        expect(extractedText).not.toContain('OLD OCR');
        const originalMetrics = await renderPdfCanvasFidelityMetrics(originalPath);
        const outputMetrics = await renderPdfCanvasFidelityMetrics(outputPath);
        expect(outputMetrics.inkPixelRatio).toBeCloseTo(originalMetrics.inkPixelRatio, 8);
        expect(outputMetrics.darkPixelRatio).toBeCloseTo(originalMetrics.darkPixelRatio, 8);
    });

    it('keeps original page ranges and replaces selected page OCR text', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'original.pdf');
        const ocrPath = join(tempDir, 'ocr-page-2.pdf');
        await createPdfWithPages(originalPath, [
            {
                text: 'ONE ORIGINAL',
                size: [
                    180,
                    240,
                ],
            },
            {
                text: 'TWO VISIBLE',
                hiddenText: 'TWO OLD OCR',
                size: [
                    220,
                    180,
                ],
            },
            {
                text: 'THREE ORIGINAL',
                size: [
                    260,
                    260,
                ],
            },
        ]);
        await createPdfWithPages(ocrPath, [{
            hiddenText: 'TWO OCR',
            size: [
                220,
                180,
            ],
        }]);

        const ocrPages = new Map<number, string>();
        ocrPages.set(2, ocrPath);

        const outputPath = await assembleSearchablePdf(
            QPDF_TEST_BINARY,
            originalPath,
            ocrPages,
            3,
            tempDir,
            'range-session',
            vi.fn(),
            path => path,
        );

        const extractedText = await extractPdfText(outputPath);
        const pageSizes = await getPdfPageSizes(outputPath);

        expect(extractedText).toContain('ONE ORIGINAL');
        expect(extractedText).toContain('TWO VISIBLE');
        expect(extractedText).toContain('TWO OCR');
        expect(extractedText).not.toContain('TWO OLD OCR');
        expect(extractedText).toContain('THREE ORIGINAL');
        expect(pageSizes).toEqual([
            [
                180,
                240,
            ],
            [
                220,
                180,
            ],
            [
                260,
                260,
            ],
        ]);
    });

    it('preserves mixed-stream invisible text preambles in original page content', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'mixed-original.pdf');
        const ocrPath = join(tempDir, 'ocr.pdf');
        await createPdfWithMixedHiddenTextPreamble(originalPath);
        await createPdfWithVisibleAndHiddenText(ocrPath, { hiddenText: 'NEW OCR' });
        const ocrPages = new Map<number, string>();
        ocrPages.set(1, ocrPath);

        const outputPath = await assembleSearchablePdf(
            QPDF_TEST_BINARY,
            originalPath,
            ocrPages,
            1,
            tempDir,
            'mixed-hidden-preamble-session',
            vi.fn(),
            path => path,
        );

        const firstPageContent = await getFirstPageContentText(outputPath);

        expect(firstPageContent).toMatch(/3 Tr\s+ET\s+BT/u);
        expect(firstPageContent).toContain('EVB_VIEWER_OCR_LAYER_BEGIN');
    });

    it.each([
        0,
        90,
        180,
        270,
    ] as const)(
        'preserves OCR word-box geometry on a real PDF fixture rotated %i degrees',
        async (rotation) => {
            tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
            const originalPath = join(tempDir, `rotated-${rotation}-original.pdf`);
            const ocrPath = join(tempDir, `rotated-${rotation}-ocr.pdf`);
            const originalPdf = await PDFDocument.create();
            const page = originalPdf.addPage([
                200,
                300,
            ]);
            page.setRotation(degrees(rotation));
            await writeFile(originalPath, await originalPdf.save());
            const ocrPdf = await PDFDocument.create();
            const isQuarterTurn = rotation === 90 || rotation === 270;
            const ocrPage = ocrPdf.addPage(isQuarterTurn ? [
                300,
                200,
            ] : [
                200,
                300,
            ]);
            await addHiddenTextLayer(ocrPdf, ocrPage, 'ALPHA', {
                x: 24,
                y: 42,
            });
            await addHiddenTextLayer(ocrPdf, ocrPage, 'BETA', {
                x: isQuarterTurn ? 210 : 110,
                y: isQuarterTurn ? 132 : 232,
            });
            await writeFile(ocrPath, await ocrPdf.save());
            const expectedPositions = await extractTextViewportPositions(ocrPath);

            const ocrPages = new Map<number, string>();
            ocrPages.set(1, ocrPath);

            const outputPath = await assembleSearchablePdf(
                QPDF_TEST_BINARY,
                originalPath,
                ocrPages,
                1,
                tempDir,
                `rotated-${rotation}-session`,
                vi.fn(),
                path => path,
            );
            const actualPositions = await extractTextViewportPositions(outputPath);
            expect(Object.keys(actualPositions).sort()).toEqual([
                'ALPHA',
                'BETA',
            ]);
            for (const word of [
                'ALPHA',
                'BETA',
            ]) {
                expect(actualPositions[word]?.x).toBeCloseTo(expectedPositions[word]?.x ?? NaN, 4);
                expect(actualPositions[word]?.y).toBeCloseTo(expectedPositions[word]?.y ?? NaN, 4);
            }
        });

    it.each([
        0,
        90,
        180,
        270,
    ] as const)(
        'maps a nonzero CropBox into the searchable page at %i degrees',
        async (rotation) => {
            tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
            const originalPath = join(tempDir, `crop-${rotation}-original.pdf`);
            const ocrPath = join(tempDir, `crop-${rotation}-ocr.pdf`);
            const originalPdf = await PDFDocument.create();
            const page = originalPdf.addPage([
                600,
                800,
            ]);
            page.setCropBox(100, 100, 400, 600);
            page.setRotation(degrees(rotation));
            await writeFile(originalPath, await originalPdf.save());

            const ocrPdf = await PDFDocument.create();
            const swapsAxes = rotation === 90 || rotation === 270;
            const ocrPage = ocrPdf.addPage(swapsAxes ? [
                600,
                400,
            ] : [
                400,
                600,
            ]);
            await addHiddenTextLayer(ocrPdf, ocrPage, 'CROP-ALPHA', {
                x: 24,
                y: 42,
            });
            await addHiddenTextLayer(ocrPdf, ocrPage, 'CROP-BETA', {
                x: swapsAxes ? 440 : 240,
                y: swapsAxes ? 260 : 492,
            });
            await writeFile(ocrPath, await ocrPdf.save());
            const expectedPositions = await extractTextViewportPositions(ocrPath);

            const outputPath = await assembleSearchablePdf(
                QPDF_TEST_BINARY,
                originalPath,
                new Map([[
                    1,
                    {
                        path: ocrPath,
                        pageGeometry: {
                            xPoints: 100,
                            yPoints: 100,
                            widthPoints: 400,
                            heightPoints: 600,
                            rotation,
                        },
                    },
                ]]),
                1,
                tempDir,
                `crop-${rotation}-session`,
                vi.fn(),
                path => path,
            );
            const actualPositions = await extractTextViewportPositions(outputPath);
            for (const word of [
                'CROP-ALPHA',
                'CROP-BETA',
            ]) {
                expect(actualPositions[word]?.x).toBeCloseTo(expectedPositions[word]?.x ?? NaN, 4);
                expect(actualPositions[word]?.y).toBeCloseTo(expectedPositions[word]?.y ?? NaN, 4);
            }
        },
    );

    it('maps a nonzero MediaBox origin when the rendered box fills the page', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'media-origin-original.pdf');
        const ocrPath = join(tempDir, 'media-origin-ocr.pdf');
        const originalPdf = await PDFDocument.create();
        const page = originalPdf.addPage([
            600,
            800,
        ]);
        page.setMediaBox(50, 75, 600, 800);
        await writeFile(originalPath, await originalPdf.save());
        const ocrPdf = await PDFDocument.create();
        const ocrPage = ocrPdf.addPage([
            600,
            800,
        ]);
        await addHiddenTextLayer(ocrPdf, ocrPage, 'MEDIA-ORIGIN', {
            x: 24,
            y: 42,
        });
        await writeFile(ocrPath, await ocrPdf.save());
        const expected = await extractTextViewportPositions(ocrPath);
        const outputPath = await assembleSearchablePdf(
            QPDF_TEST_BINARY,
            originalPath,
            new Map([[
                1,
                {
                    path: ocrPath,
                    pageGeometry: {
                        xPoints: 50,
                        yPoints: 75,
                        widthPoints: 600,
                        heightPoints: 800,
                        rotation: 0,
                    },
                },
            ]]),
            1,
            tempDir,
            'media-origin-session',
            vi.fn(),
            path => path,
        );
        const actual = await extractTextViewportPositions(outputPath);
        expect(actual['MEDIA-ORIGIN']?.x).toBeCloseTo(expected['MEDIA-ORIGIN']?.x ?? NaN, 4);
        expect(actual['MEDIA-ORIGIN']?.y).toBeCloseTo(expected['MEDIA-ORIGIN']?.y ?? NaN, 4);
    });

    it('composes a same-size preprocessing inverse with the CropBox mapping', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'preprocess-original.pdf');
        const ocrPath = join(tempDir, 'preprocess-ocr.pdf');
        const originalPdf = await PDFDocument.create();
        const page = originalPdf.addPage([
            600,
            800,
        ]);
        page.setCropBox(100, 100, 400, 600);
        await writeFile(originalPath, await originalPdf.save());
        const ocrPdf = await PDFDocument.create();
        const ocrPage = ocrPdf.addPage([
            400,
            600,
        ]);
        await addHiddenTextLayer(ocrPdf, ocrPage, 'DESKEWED', {
            x: 24,
            y: 42,
        });
        await writeFile(ocrPath, await ocrPdf.save());
        const expected = await extractTextViewportPositions(ocrPath);
        const outputPath = await assembleSearchablePdf(
            QPDF_TEST_BINARY,
            originalPath,
            new Map([[
                1,
                {
                    path: ocrPath,
                    pageGeometry: {
                        xPoints: 100,
                        yPoints: 100,
                        widthPoints: 400,
                        heightPoints: 600,
                        rotation: 0,
                        rasterWidthPx: 400,
                        rasterHeightPx: 600,
                        preprocessInverseTransform: {matrix: [
                            [
                                1,
                                0,
                                10,
                            ],
                            [
                                0,
                                1,
                                5,
                            ],
                            [
                                0,
                                0,
                                1,
                            ],
                        ]},
                    },
                },
            ]]),
            1,
            tempDir,
            'preprocess-session',
            vi.fn(),
            path => path,
        );
        const actual = await extractTextViewportPositions(outputPath);
        expect(actual.DESKEWED?.x).toBeCloseTo((expected.DESKEWED?.x ?? NaN) + 10, 4);
        expect(actual.DESKEWED?.y).toBeCloseTo((expected.DESKEWED?.y ?? NaN) + 5, 4);
    });
});

describe('stripTesseractImageLayer', () => {
    it('removes the generated page image while keeping the hidden text stream', () => {
        const qdfSource = [
            '50 0 obj',
            '<<',
            '  /Contents 404 0 R',
            '  /Resources <<',
            '    /Font << /f-0-0 73 0 R >>',
            '    /XObject <<',
            '      /Im1 407 0 R',
            '    >>',
            '  >>',
            '>>',
            'endobj',
            '404 0 obj',
            '<< /Length 123 >>',
            'stream',
            'q 423.8 0 0 640.8 0 0 cm /Im1 Do Q',
            'BT',
            '3 Tr 1 0 0 1 28 100.8 Tm /f-0-0 8 Tf [ <04200438043C> ] TJ',
            'ET',
            'endstream',
            'endobj',
        ].join('\n');

        const stripped = stripTesseractImageLayer(qdfSource);

        expect(stripped).not.toContain('/Im1 Do');
        expect(stripped).not.toContain('/XObject');
        expect(stripped).toContain('3 Tr');
        expect(stripped).toContain('<04200438043C>');
    });
});

describe('sanitizeOcrContentStreamForEmbedding', () => {
    it('forces visible OCR text objects to invisible rendering mode and drops Tesseract image paint', () => {
        const source = [
            'q 423.8 0 0 640.8 0 0 cm /Im1 Do Q',
            '/I6 Do',
            'BT',
            '1 0 0 1 28 100.8 Tm /f-0-0 8 Tf [ <004F00430052> ] TJ',
            'ET',
            'BT',
            '0 Tr 1 0 0 1 28 80 Tm /f-0-0 8 Tf (VISIBLE) Tj',
            'ET',
        ].join('\n');

        const sanitized = sanitizeOcrContentStreamForEmbedding(source);

        expect(sanitized).not.toContain('/Im1 Do');
        expect(sanitized).not.toContain('/I6 Do');
        expect(sanitized).toContain('BT\n3 Tr\n1 0 0 1 28 100.8 Tm');
        expect(sanitized).toContain('BT\n3 Tr\n3 Tr 1 0 0 1 28 80 Tm');
        expect(sanitized).toContain('<004F00430052>');
        expect(sanitized).toContain('(VISIBLE) Tj');
    });
});
