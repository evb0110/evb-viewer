import type {IPdfViewport} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts';
import type { IOcrWord } from '@contracts/shared';

const ocrCapability = vi.hoisted(() => ({
    resolveDocumentOcrAvailability: vi.fn(),
    resolveDocumentOcrPage: vi.fn(),
    resolveDocumentTextCatalog: vi.fn(),
}));
vi.mock('@app/utils/getOcrCapability', () => ({getOcrCapability: () => ocrCapability}));
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {warn: vi.fn()}}));

const TEST_DOCUMENT_REVISION = requireDocumentRevisionToken('revision-token');

function createPageSnapshot(words: IOcrWord[]) {
    return {
        documentRevision: TEST_DOCUMENT_REVISION,
        pageCount: 1,
        page: {
            pageNumber: 1,
            text: words.map(word => word.text).join(' '),
            words,
            source: 'evb-ocr',
            languages: ['eng'],
            render: {
                dpi: 300,
                imagePx: {
                    w: 100,
                    h: 100,
                },
            },
            contentDigest: 'page-digest',
        },
    };
}

function createViewport(): IPdfViewport {
    return {
        viewBox: [
            0,
            0,
            100,
            100,
        ],
        userUnit: 1,
        width: 100,
        height: 100,
        scale: 1,
        rotation: 0,
        offsetX: 0,
        offsetY: 0,
        transform: [
            1,
            0,
            0,
            1,
            0,
            0,
        ],
        rawDims: {
            pageWidth: 100,
            pageHeight: 100,
        },
        clone: createViewport,
        convertToViewportPoint: () => [
            0,
            0,
        ],
        convertToViewportRectangle: () => [
            0,
            0,
            0,
            0,
        ],
        convertToPdfPoint: () => [
            0,
            0,
        ],
    };
}

describe('useOcrTextContent', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        ocrCapability.resolveDocumentOcrAvailability.mockResolvedValue({
            documentRevision: TEST_DOCUMENT_REVISION,
            pageCount: 1,
            pageNumbers: [1],
        });
        ocrCapability.resolveDocumentOcrPage.mockResolvedValue(createPageSnapshot([{
            text: 'hello',
            x: 10,
            y: 10,
            width: 20,
            height: 10,
        }]));
        vi.stubGlobal('document', {createElement: () => ({getContext: () => ({
            font: '',
            measureText: () => ({
                actualBoundingBoxAscent: 80,
                actualBoundingBoxDescent: 20,
            }),
        })})});
    });

    afterEach(() => vi.unstubAllGlobals());

    it('shares page-scoped OCR results across composable callers and clears by path', async () => {
        const {useOcrTextContent} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent');
        const first = useOcrTextContent();
        const second = useOcrTextContent();

        await expect(first.hasOcrData('/tmp/doc.pdf', TEST_DOCUMENT_REVISION)).resolves.toBe(true);
        await expect(first.getOcrTextContent('/tmp/doc.pdf', TEST_DOCUMENT_REVISION, 1, createViewport())).resolves.not.toBeNull();
        await expect(second.getOcrTextContent('/tmp/doc.pdf', TEST_DOCUMENT_REVISION, 1, createViewport())).resolves.not.toBeNull();
        expect(ocrCapability.resolveDocumentOcrAvailability).toHaveBeenCalledTimes(1);
        expect(ocrCapability.resolveDocumentOcrPage).toHaveBeenCalledTimes(1);
        expect(ocrCapability.resolveDocumentTextCatalog).not.toHaveBeenCalled();

        first.clearCache('/tmp/doc.pdf');
        await expect(second.hasOcrData('/tmp/doc.pdf', TEST_DOCUMENT_REVISION)).resolves.toBe(true);
        expect(ocrCapability.resolveDocumentOcrAvailability).toHaveBeenCalledTimes(2);
    });

    it('checks a representative large document without resolving its all-page catalog', async () => {
        const pageNumbers = Array.from({length: 406}, (_value, index) => index + 1);
        ocrCapability.resolveDocumentOcrAvailability.mockResolvedValue({
            documentRevision: TEST_DOCUMENT_REVISION,
            pageCount: 406,
            pageNumbers,
        });
        const {useOcrTextContent} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent');
        const reader = useOcrTextContent();

        await expect(reader.hasPageOcrData('/tmp/large.pdf', TEST_DOCUMENT_REVISION, 406)).resolves.toBe(true);
        await expect(reader.hasPageOcrData('/tmp/large.pdf', TEST_DOCUMENT_REVISION, 407)).resolves.toBe(false);

        expect(ocrCapability.resolveDocumentOcrAvailability).toHaveBeenCalledOnce();
        expect(ocrCapability.resolveDocumentOcrPage).not.toHaveBeenCalled();
        expect(ocrCapability.resolveDocumentTextCatalog).not.toHaveBeenCalled();
    });

    it('probes a page when the bounded availability ranges are incomplete', async () => {
        ocrCapability.resolveDocumentOcrAvailability.mockResolvedValue({
            documentRevision: TEST_DOCUMENT_REVISION,
            pageCount: 1_000_001,
            mappedPageCount: 1,
            pageRanges: [],
            rangesComplete: false,
        });
        const {useOcrTextContent} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent');
        const reader = useOcrTextContent();

        await expect(reader.hasPageOcrData('/tmp/large.pdf', TEST_DOCUMENT_REVISION, 900_000)).resolves.toBe(true);
        expect(ocrCapability.resolveDocumentOcrPage).toHaveBeenCalledWith(
            '/tmp/large.pdf',
            TEST_DOCUMENT_REVISION,
            900_000,
        );
    });

    it('uses the visual line box when OCR words in the same line have different heights', async () => {
        ocrCapability.resolveDocumentOcrPage.mockResolvedValue(createPageSnapshot([
            {
                text: 'small',
                x: 10,
                y: 20,
                width: 20,
                height: 10,
            },
            {
                text: 'TALL',
                x: 35,
                y: 12,
                width: 25,
                height: 30,
            },
        ]));
        const {useOcrTextContent} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent');
        const textContent = await useOcrTextContent().getOcrTextContent(
            '/tmp/mixed.pdf', TEST_DOCUMENT_REVISION, 1, createViewport(),
        );

        expect(textContent?.items).toHaveLength(2);
        expect(textContent?.items[0]?.height).toBe(30);
        expect(textContent?.items[1]?.transform[3]).toBe(30);
    });

    it('reuses the resolved ascent ratio for all OCR text items', async () => {
        const createElement = vi.fn(() => ({getContext: () => null}));
        vi.stubGlobal('document', {createElement});
        ocrCapability.resolveDocumentOcrPage.mockResolvedValue(createPageSnapshot([
            {
                text: 'hello',
                x: 10,
                y: 10,
                width: 20,
                height: 10,
            },
            {
                text: 'world',
                x: 35,
                y: 10,
                width: 20,
                height: 10,
            },
        ]));
        const {useOcrTextContent} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent');
        const textContent = await useOcrTextContent().getOcrTextContent(
            '/tmp/fallback.pdf', TEST_DOCUMENT_REVISION, 1, createViewport(),
        );

        expect(textContent?.items).toHaveLength(2);
        expect(textContent?.styles['ocr-sans']?.ascent).toBe(0.8);
        expect(createElement).toHaveBeenCalledTimes(1);
    });
});
