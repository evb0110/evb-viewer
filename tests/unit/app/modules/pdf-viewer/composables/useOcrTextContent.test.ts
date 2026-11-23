import type {IPdfViewport} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import type { IOcrWord } from '@contracts/shared';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

const ocrCapability = vi.hoisted(() => ({
    resolveDocumentOcrAvailability: vi.fn(),
    resolveDocumentOcrPage: vi.fn(),
    resolveDocumentTextCatalog: vi.fn(),
}));
const platformApi = createElectronPlatformApiFixture({ocr: ocrCapability});
vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => platformApi}));
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {warn: vi.fn()}}));

const TEST_DOCUMENT_REVISION = requireDocumentRevisionToken('revision-token');

function createPageSnapshot(words: IOcrWord[], languages: string[] = ['eng']) {
    return {
        documentRevision: TEST_DOCUMENT_REVISION,
        pageCount: 1,
        page: {
            pageNumber: 1,
            text: words.map(word => word.text).join(' '),
            words,
            source: 'evb-ocr',
            languages,
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

        await expect(first.hasOcrData(requireDocumentRef('/tmp/doc.pdf'), TEST_DOCUMENT_REVISION)).resolves.toBe(true);
        await expect(first.getOcrTextContent(requireDocumentRef('/tmp/doc.pdf'), TEST_DOCUMENT_REVISION, requirePageNumber(1), createViewport())).resolves.not.toBeNull();
        await expect(second.getOcrTextContent(requireDocumentRef('/tmp/doc.pdf'), TEST_DOCUMENT_REVISION, requirePageNumber(1), createViewport())).resolves.not.toBeNull();
        expect(ocrCapability.resolveDocumentOcrAvailability).toHaveBeenCalledTimes(1);
        expect(ocrCapability.resolveDocumentOcrPage).toHaveBeenCalledTimes(1);
        expect(ocrCapability.resolveDocumentTextCatalog).not.toHaveBeenCalled();

        first.clearCache(requireDocumentRef('/tmp/doc.pdf'));
        await expect(second.hasOcrData(requireDocumentRef('/tmp/doc.pdf'), TEST_DOCUMENT_REVISION)).resolves.toBe(true);
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

        await expect(reader.hasPageOcrData(requireDocumentRef('/tmp/large.pdf'), TEST_DOCUMENT_REVISION, requirePageNumber(406))).resolves.toBe(true);
        await expect(reader.hasPageOcrData(requireDocumentRef('/tmp/large.pdf'), TEST_DOCUMENT_REVISION, requirePageNumber(407))).resolves.toBe(false);

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

        await expect(reader.hasPageOcrData(requireDocumentRef('/tmp/large.pdf'), TEST_DOCUMENT_REVISION, requirePageNumber(900_000))).resolves.toBe(true);
        expect(ocrCapability.resolveDocumentOcrPage).toHaveBeenCalledWith(
            '/tmp/large.pdf',
            TEST_DOCUMENT_REVISION,
            900_000,
        );
    });

    it('caches negative page probes and short-circuits absent pages without redundant IPC roundtrips', async () => {
        ocrCapability.resolveDocumentOcrAvailability.mockResolvedValue({
            documentRevision: TEST_DOCUMENT_REVISION,
            pageCount: 2_000,
            mappedPageCount: 2,
            pageRanges: [{
                firstPage: 1,
                lastPage: 1,
            }],
            rangesComplete: false,
        });
        ocrCapability.resolveDocumentOcrPage.mockResolvedValue({
            documentRevision: TEST_DOCUMENT_REVISION,
            pageCount: 2_000,
            page: null,
        });
        const {useOcrTextContent} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent');
        const reader = useOcrTextContent();
        const docRef = requireDocumentRef('/tmp/incomplete-ranges.pdf');

        await expect(reader.hasPageOcrData(docRef, TEST_DOCUMENT_REVISION, requirePageNumber(1))).resolves.toBe(true);
        expect(reader.peekPageOcrData(docRef, TEST_DOCUMENT_REVISION, requirePageNumber(1))).toBe(true);
        expect(ocrCapability.resolveDocumentOcrPage).not.toHaveBeenCalled();

        // First probe of an unmapped page sends one IPC and records the negative probe.
        await expect(reader.hasPageOcrData(docRef, TEST_DOCUMENT_REVISION, requirePageNumber(500))).resolves.toBe(false);
        expect(ocrCapability.resolveDocumentOcrPage).toHaveBeenCalledTimes(1);
        expect(reader.peekPageOcrData(docRef, TEST_DOCUMENT_REVISION, requirePageNumber(500))).toBe(false);

        // Subsequent checks and getOcrTextContent short-circuit synchronously with zero IPC.
        await expect(reader.hasPageOcrData(docRef, TEST_DOCUMENT_REVISION, requirePageNumber(500))).resolves.toBe(false);
        await expect(reader.getOcrTextContent(docRef, TEST_DOCUMENT_REVISION, requirePageNumber(500), createViewport())).resolves.toBeNull();
        expect(ocrCapability.resolveDocumentOcrAvailability).toHaveBeenCalledTimes(1);
        expect(ocrCapability.resolveDocumentOcrPage).toHaveBeenCalledTimes(1);
    });

    it('invalidates cached availability and page snapshots cleanly when document revision changes', async () => {
        const rev1 = requireDocumentRevisionToken('revision-1');
        const rev2 = requireDocumentRevisionToken('revision-2');
        const docRef = requireDocumentRef('/tmp/revised.pdf');
        ocrCapability.resolveDocumentOcrAvailability
            .mockResolvedValueOnce({
                documentRevision: rev1,
                pageCount: 10,
                mappedPageCount: 0,
                pageRanges: [],
                rangesComplete: true,
            })
            .mockResolvedValueOnce({
                documentRevision: rev2,
                pageCount: 10,
                mappedPageCount: 2,
                pageRanges: [{
                    firstPage: 2,
                    lastPage: 3,
                }],
                rangesComplete: true,
            });

        const {useOcrTextContent} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent');
        const reader = useOcrTextContent();

        await expect(reader.hasPageOcrData(docRef, rev1, requirePageNumber(2))).resolves.toBe(false);
        await expect(reader.getOcrTextContent(docRef, rev1, requirePageNumber(2), createViewport())).resolves.toBeNull();
        expect(ocrCapability.resolveDocumentOcrAvailability).toHaveBeenCalledTimes(1);
        expect(ocrCapability.resolveDocumentOcrPage).not.toHaveBeenCalled();

        // Revision change invalidates rev1 cache and resolves rev2 once across pages.
        await expect(reader.hasPageOcrData(docRef, rev2, requirePageNumber(2))).resolves.toBe(true);
        await expect(reader.hasPageOcrData(docRef, rev2, requirePageNumber(3))).resolves.toBe(true);
        await expect(reader.hasPageOcrData(docRef, rev2, requirePageNumber(4))).resolves.toBe(false);
        expect(ocrCapability.resolveDocumentOcrAvailability).toHaveBeenCalledTimes(2);
        // Old rev1 entry was pruned rather than retained as stale cache.
        expect(reader.peekPageOcrData(docRef, rev1, requirePageNumber(2))).toBeNull();
    });

    it('does not permanently poison availability cache after a transient IPC error', async () => {
        const docRef = requireDocumentRef('/tmp/transient.pdf');
        ocrCapability.resolveDocumentOcrAvailability
            .mockRejectedValueOnce(new Error('transient ipc disconnect'))
            .mockResolvedValueOnce({
                documentRevision: TEST_DOCUMENT_REVISION,
                pageCount: 5,
                mappedPageCount: 1,
                pageRanges: [{
                    firstPage: 1,
                    lastPage: 1,
                }],
                rangesComplete: true,
            });

        const {useOcrTextContent} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent');
        const reader = useOcrTextContent();

        await expect(reader.hasPageOcrData(docRef, TEST_DOCUMENT_REVISION, requirePageNumber(1))).resolves.toBe(false);
        await expect(reader.hasPageOcrData(docRef, TEST_DOCUMENT_REVISION, requirePageNumber(1))).resolves.toBe(true);
        expect(ocrCapability.resolveDocumentOcrAvailability).toHaveBeenCalledTimes(2);
    });

    it('does not let a stale in-flight null page probe poison a newly created availability entry after cache clear', async () => {
        const docRef = requireDocumentRef('/tmp/stale-probe.pdf');
        let resolveStaleProbe!: (value: {
            documentRevision: typeof TEST_DOCUMENT_REVISION;
            pageCount: number;
            page: null;
        }) => void;
        ocrCapability.resolveDocumentOcrAvailability.mockResolvedValue({
            documentRevision: TEST_DOCUMENT_REVISION,
            pageCount: 100,
            mappedPageCount: 1,
            pageRanges: [],
            rangesComplete: false,
        });
        ocrCapability.resolveDocumentOcrPage
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveStaleProbe = resolve;
            }))
            .mockResolvedValueOnce(createPageSnapshot([{
                text: 'fresh',
                x: 10,
                y: 10,
                width: 20,
                height: 10,
            }]));

        const {useOcrTextContent} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent');
        const reader = useOcrTextContent();

        const staleProbe = reader.hasPageOcrData(docRef, TEST_DOCUMENT_REVISION, requirePageNumber(5));
        await vi.waitFor(() => expect(ocrCapability.resolveDocumentOcrPage).toHaveBeenCalledTimes(1));

        // Clear cache and create a fresh availability entry for the same revision before stale probe settles.
        reader.clearCache(docRef);
        await expect(reader.hasOcrData(docRef, TEST_DOCUMENT_REVISION)).resolves.toBe(true);

        // Stale probe resolves with null: it must not poison the fresh entry's missingPages.
        resolveStaleProbe({
            documentRevision: TEST_DOCUMENT_REVISION,
            pageCount: 100,
            page: null,
        });
        await expect(staleProbe).resolves.toBe(false);
        expect(reader.peekPageOcrData(docRef, TEST_DOCUMENT_REVISION, requirePageNumber(5))).toBeNull();

        await expect(reader.hasPageOcrData(docRef, TEST_DOCUMENT_REVISION, requirePageNumber(5))).resolves.toBe(true);
        expect(ocrCapability.resolveDocumentOcrPage).toHaveBeenCalledTimes(2);
    });

    it('reports OCR availability when pageNumbers is empty but pageRanges is non-empty', async () => {
        const docRef = requireDocumentRef('/tmp/ranges-with-empty-numbers.pdf');
        ocrCapability.resolveDocumentOcrAvailability.mockResolvedValue({
            documentRevision: TEST_DOCUMENT_REVISION,
            pageCount: 10,
            pageNumbers: [],
            pageRanges: [{
                firstPage: 2,
                lastPage: 3,
            }],
            rangesComplete: true,
        });

        const {useOcrTextContent} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent');
        const reader = useOcrTextContent();

        await expect(reader.hasOcrData(docRef, TEST_DOCUMENT_REVISION)).resolves.toBe(true);
        await expect(reader.hasPageOcrData(docRef, TEST_DOCUMENT_REVISION, requirePageNumber(2))).resolves.toBe(true);
        await expect(reader.hasPageOcrData(docRef, TEST_DOCUMENT_REVISION, requirePageNumber(4))).resolves.toBe(false);
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
            requireDocumentRef('/tmp/mixed.pdf'), TEST_DOCUMENT_REVISION, requirePageNumber(1), createViewport(),
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
            requireDocumentRef('/tmp/fallback.pdf'), TEST_DOCUMENT_REVISION, requirePageNumber(1), createViewport(),
        );

        expect(textContent?.items).toHaveLength(2);
        expect(textContent?.styles['ocr-sans']?.ascent).toBe(0.8);
        expect(createElement).toHaveBeenCalledTimes(1);
    });

    it('resolves direction per OCR word while leaving digits and punctuation neutral', async () => {
        ocrCapability.resolveDocumentOcrPage.mockResolvedValue(createPageSnapshot([
            {
                text: 'Latin',
                x: 10,
                y: 10,
                width: 20,
                height: 10,
            },
            {
                text: 'ذلك.',
                x: 35,
                y: 10,
                width: 20,
                height: 10,
            },
            {
                text: '123',
                x: 60,
                y: 10,
                width: 20,
                height: 10,
            },
            {
                text: '٤٥٦',
                x: 85,
                y: 10,
                width: 20,
                height: 10,
            },
            {
                text: 'العَرَبِيَّة',
                x: 10,
                y: 30,
                width: 20,
                height: 10,
            },
            {
                text: 'שלום',
                x: 35,
                y: 30,
                width: 20,
                height: 10,
            },
            {
                text: 'ܫܠܡܐ',
                x: 60,
                y: 30,
                width: 20,
                height: 10,
            },
            {
                text: 'ἄνθρωπος',
                x: 85,
                y: 30,
                width: 20,
                height: 10,
            },
            {
                text: '؟',
                x: 110,
                y: 30,
                width: 20,
                height: 10,
            },
        ], [
            'ara',
            'eng',
        ]));
        const {useOcrTextContent} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent');
        const textContent = await useOcrTextContent().getOcrTextContent(
            requireDocumentRef('/tmp/directions.pdf'), TEST_DOCUMENT_REVISION, requirePageNumber(1), createViewport(),
        );

        expect(textContent?.items.map(item => [
            item.str.trim(),
            item.dir,
        ])).toEqual([
            [
                'Latin',
                'ltr',
            ],
            [
                'ذلك.',
                'rtl',
            ],
            [
                '123',
                'ltr',
            ],
            [
                '٤٥٦',
                'ltr',
            ],
            [
                'العَرَبِيَّة',
                'rtl',
            ],
            [
                'שלום',
                'rtl',
            ],
            [
                'ܫܠܡܐ',
                'rtl',
            ],
            [
                'ἄνθρωπος',
                'ltr',
            ],
            [
                '؟',
                'ltr',
            ],
        ]);
    });
});
