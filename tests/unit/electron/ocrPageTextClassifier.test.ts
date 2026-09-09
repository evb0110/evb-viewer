import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    PDFDocument,
    PDFNumber,
    PDFOperator,
    PDFOperatorNames,
    StandardFonts,
} from 'pdf-lib';
import {
    classifyOcrPageText,
    inspectPdfTextVisibility,
    inspectPdfPageTextVisibility,
    shouldOcrClassifiedPage,
} from '@electron/features/ocr/worker/pageTextClassifier';
import { resolveTestQpdfBinary } from '@tests/helpers/resolveTestQpdfBinary';

describe('OCR page text classification and supersession', () => {
    it('distinguishes native, foreign hidden OCR, current EVB generation, and missing text', () => {
        const visible = inspectPdfTextVisibility(['BT /F1 12 Tf (Native) Tj ET']);
        const hidden = inspectPdfTextVisibility(['BT 3 Tr /F1 12 Tf (Foreign OCR) Tj ET']);

        expect(classifyOcrPageText({
            extractedText: '',
            visibility: visible,
        }).classification).toBe('no-text');
        expect(classifyOcrPageText({
            extractedText: 'Native',
            visibility: visible,
        }).classification).toBe('native-text');
        expect(classifyOcrPageText({
            extractedText: 'Foreign OCR',
            visibility: hidden,
        }).classification).toBe('foreign-hidden-ocr');
        expect(classifyOcrPageText({
            extractedText: 'EVB OCR',
            visibility: hidden,
            evbGeneration: 'generation-2',
        })).toMatchObject({
            classification: 'evb-current-generation',
            evbGeneration: 'generation-2',
        });
    });

    it('keeps native text under every policy and makes foreign replacement explicit', () => {
        const classifications = [
            'native-text',
            'foreign-hidden-ocr',
            'evb-current-generation',
            'no-text',
        ] as const;

        expect(classifications.filter(value => shouldOcrClassifiedPage(value, 'missing-only')))
            .toEqual(['no-text']);
        expect(classifications.filter(value => shouldOcrClassifiedPage(value, 'replace-evb')))
            .toEqual([
                'evb-current-generation',
                'no-text',
            ]);
        expect(classifications.filter(value => shouldOcrClassifiedPage(value, 'replace-all')))
            .toEqual([
                'foreign-hidden-ocr',
                'evb-current-generation',
                'no-text',
            ]);
    });

    it('does not mistake mixed visible and hidden content for a replaceable foreign-only layer', () => {
        const visibility = inspectPdfTextVisibility(['BT /F1 12 Tf (Visible) Tj 3 Tr (Hidden metadata) Tj ET']);
        expect(classifyOcrPageText({
            extractedText: 'Visible Hidden metadata',
            visibility,
        }).classification)
            .toBe('native-text');
    });

    it('inspects a real mixed PDF corpus page by page', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-ocr-classifier-'));
        const pdfPath = join(directory, 'mixed.pdf');
        try {
            const pdf = await PDFDocument.create();
            const font = await pdf.embedFont(StandardFonts.Helvetica);
            pdf.addPage().drawText('Native visible text', {font});
            pdf.addPage();
            const foreignPage = pdf.addPage();
            foreignPage.pushOperators(PDFOperator.of(PDFOperatorNames.SetTextRenderingMode, [PDFNumber.of(3)]));
            foreignPage.drawText('Foreign hidden OCR', {font});
            await writeFile(pdfPath, await pdf.save());

            const visibilityAnalysis = await inspectPdfPageTextVisibility(pdfPath, [
                1,
                2,
                3,
            ], resolveTestQpdfBinary());
            expect(visibilityAnalysis.status).toBe('available');
            if (visibilityAnalysis.status !== 'available') {
                throw new Error(visibilityAnalysis.message);
            }
            const visibility = visibilityAnalysis.visibility;
            expect(classifyOcrPageText({
                extractedText: 'Native visible text',
                visibility: visibility.get(1)!,
            }).classification).toBe('native-text');
            expect(classifyOcrPageText({
                extractedText: '',
                visibility: visibility.get(2)!,
            }).classification).toBe('no-text');
            expect(classifyOcrPageText({
                extractedText: 'Foreign hidden OCR',
                visibility: visibility.get(3)!,
            }).classification).toBe('foreign-hidden-ocr');
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });
});
