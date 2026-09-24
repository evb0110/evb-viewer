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
} from '@electron/features/ocr/pipeline/pageTextClassifier';
import { resolveTestQpdfBinary } from '@tests/helpers/resolveTestQpdfBinary';

describe('OCR page text classification and supersession', () => {
    it('distinguishes native, foreign hidden OCR, current EVB generation, and missing text', () => {
        const visible = inspectPdfTextVisibility(['BT /F1 12 Tf (Native) Tj ET']);
        const hidden = inspectPdfTextVisibility(['BT 3 Tr /F1 12 Tf (Foreign OCR) Tj ET']);
        const evbLayer = inspectPdfTextVisibility(['% EVB_VIEWER_OCR_LAYER_BEGIN\n/EvbOcrLayer Do\n% EVB_VIEWER_OCR_LAYER_END']);

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
            visibility: evbLayer,
        }).classification).toBe('evb-current-generation');
    });

    it('keeps native text under every policy and repairs hidden OCR with no visible text', () => {
        const classifications = [
            'native-text',
            'foreign-hidden-ocr',
            'evb-current-generation',
            'no-text',
        ] as const;

        expect(classifications.filter(value => shouldOcrClassifiedPage(value, 'missing-only')))
            .toEqual([
                'foreign-hidden-ocr',
                'no-text',
            ]);
        expect(classifications.filter(value => shouldOcrClassifiedPage(value, 'replace-evb')))
            .toEqual([
                'foreign-hidden-ocr',
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

    it('recognizes an EVB OCR Form XObject marker in the page stream', () => {
        const visibility = inspectPdfTextVisibility(['% EVB_VIEWER_OCR_LAYER_BEGIN\n/EvbOcrLayer Do\n% EVB_VIEWER_OCR_LAYER_END']);

        expect(visibility).toMatchObject({
            hasHiddenTextOperators: true,
            hasVisibleTextOperators: false,
            hasEvbOcrLayer: true,
        });
        expect(classifyOcrPageText({
            extractedText: 'readable hidden layer',
            visibility,
        }).classification).toBe('evb-current-generation');
        expect(shouldOcrClassifiedPage('evb-current-generation', 'missing-only')).toBe(false);
    });

    it('recognizes the inline EVB OCR layer that pdf-page-ops writes', () => {
        const visibility = inspectPdfTextVisibility(['% EVB_VIEWER_OCR_LAYER_BEGIN\nq\nBT\n3 Tr\n/EVBOcr_f_0_0_1 30 Tf\n<0054> Tj\nET\nQ\n% EVB_VIEWER_OCR_LAYER_END\n']);

        expect(visibility).toEqual({
            hasHiddenTextOperators: true,
            hasVisibleTextOperators: false,
            hasEvbOcrLayer: true,
        });
        expect(classifyOcrPageText({
            extractedText: 'The Roman republic expanded',
            visibility,
        }).classification).toBe('evb-current-generation');
    });

    it('does not treat unusable current-generation OCR as complete', () => {
        const visibility = inspectPdfTextVisibility(['% EVB_VIEWER_OCR_LAYER_BEGIN\n/EvbOcrLayer Do\n% EVB_VIEWER_OCR_LAYER_END']);
        const garbage = classifyOcrPageText({
            extractedText: 'и,\nАаоЗта НЫ)\nРГ. М\nА\nЧ\nК\nи\nУАТАИ,',
            visibility,
            languages: ['rus'],
        });
        const latinGarbage = classifyOcrPageText({
            extractedText: 'sAtFL4w',
            visibility,
            languages: ['rus'],
        });

        expect(garbage.classification).toBe('foreign-hidden-ocr');
        expect(latinGarbage.classification).toBe('foreign-hidden-ocr');
        expect(shouldOcrClassifiedPage(garbage.classification, 'missing-only')).toBe(true);
        expect(shouldOcrClassifiedPage(latinGarbage.classification, 'missing-only')).toBe(true);
    });

    it('keeps known non-Latin scripts and does not guess Latin for unknown models', () => {
        const visibility = inspectPdfTextVisibility(['% EVB_VIEWER_OCR_LAYER_BEGIN\n/EvbOcrLayer Do\n% EVB_VIEWER_OCR_LAYER_END']);
        for (const languages of [
            ['chi_sim'],
            ['unknown-model'],
        ]) {
            expect(classifyOcrPageText({
                extractedText: '这是中文文本 内容测试',
                visibility,
                languages,
            }).classification).toBe('evb-current-generation');
        }
    });

    it('recognizes extended Latin characters through Script_Extensions', () => {
        const visibility = inspectPdfTextVisibility(['% EVB_VIEWER_OCR_LAYER_BEGIN\n/EvbOcrLayer Do\n% EVB_VIEWER_OCR_LAYER_END']);
        expect(classifyOcrPageText({
            extractedText: 'Žluťoučký kůň',
            visibility,
            languages: ['ces'],
        }).classification).toBe('evb-current-generation');
    });

    it('accepts a valid isolated word without weakening the garbage guard', () => {
        const visibility = inspectPdfTextVisibility(['% EVB_VIEWER_OCR_LAYER_BEGIN\n/EvbOcrLayer Do\n% EVB_VIEWER_OCR_LAYER_END']);
        expect(classifyOcrPageText({
            extractedText: 'ГРАММАТИЧЕСКИЙ',
            visibility,
            languages: ['rus'],
        }).classification).toBe('evb-current-generation');
        expect(classifyOcrPageText({
            extractedText: 'sAtFL4w',
            visibility,
            languages: ['unknown-model'],
        }).classification).toBe('foreign-hidden-ocr');
    });

    it('accepts numeric-only pages and short headings with a page number', () => {
        const visibility = inspectPdfTextVisibility(['% EVB_VIEWER_OCR_LAYER_BEGIN\n/EvbOcrLayer Do\n% EVB_VIEWER_OCR_LAYER_END']);
        expect(classifyOcrPageText({
            extractedText: '2026',
            visibility,
            languages: ['rus'],
        }).classification).toBe('evb-current-generation');
        expect(classifyOcrPageText({
            extractedText: '1',
            visibility,
            languages: ['rus'],
        }).classification).toBe('evb-current-generation');
        expect(classifyOcrPageText({
            extractedText: 'Глава 1',
            visibility,
            languages: ['rus'],
        }).classification).toBe('evb-current-generation');
    });

    it('does not treat an unrelated marker comment or incomplete block as EVB OCR', () => {
        expect(inspectPdfTextVisibility(['% copied from EVB_VIEWER_OCR_LAYER_BEGIN in a PDF comment']))
            .toMatchObject({
                hasHiddenTextOperators: false,
                hasVisibleTextOperators: false,
                hasEvbOcrLayer: false,
            });
        expect(inspectPdfTextVisibility(['% EVB_VIEWER_OCR_LAYER_BEGIN\n/EvbOcrLayer Do']))
            .toMatchObject({
                hasHiddenTextOperators: false,
                hasVisibleTextOperators: false,
                hasEvbOcrLayer: false,
            });
        expect(inspectPdfTextVisibility(['BT 3 Tr (text) Tj ET\n% EVB_VIEWER_OCR_LAYER_END']).hasEvbOcrLayer).toBe(false);
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
