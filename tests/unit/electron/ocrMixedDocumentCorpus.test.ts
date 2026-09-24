import type * as TOcrCatalogV4Module from '@electron/features/ocr/main/ocrCatalogV4';
import type * as TFsPromises from 'node:fs/promises';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    MIXED_OCR_CORPUS_PATH,
    MIXED_OCR_CORPUS_REVISION,
    mixedEmbeddedTextPages,
    mixedEvbPage,
    mixedOcrCorpusExpectedSources,
} from '@tests/fixtures/ocr/mixedDocumentCorpus';

// The EVB catalog maps only page 4, the scanned page that EVB recognized.
vi.mock('@electron/features/ocr/main/ocrCatalogV4', async importOriginal => ({
    ...await importOriginal<typeof TOcrCatalogV4Module>(),
    openCatalog: async () => ({
        header: {
            version: 4,
            source: {pdfPath: MIXED_OCR_CORPUS_PATH},
            documentRevision: {token: MIXED_OCR_CORPUS_REVISION},
            pageCount: 4,
            generation: 2,
            mappedPageCount: 1,
            complete: false,
        },
        async* iterateMappedPages() {
            yield {
                pageNumber: 4,
                artifact: mixedEvbPage,
            };
        },
        close: async () => undefined,
    }),
}));
vi.mock('node:fs/promises', async importOriginal => ({
    ...await importOriginal<typeof TFsPromises>(),
    stat: vi.fn(async () => ({size: 1})),
}));
vi.mock('@electron/features/search/loadPdfjsTextExtractor', () => ({loadPdfjsTextExtractor: async () => ({extractTextWithPdfjsWordBoxes: vi.fn(async () => mixedEmbeddedTextPages)})}));
vi.mock('@electron/file-access/documentRevisionSidecar', () => ({assertWorkingCopyRevisionSidecarCurrent: vi.fn(async () => undefined)}));

const {resolveDocumentTextCatalogSnapshot} = await import('@electron/features/ocr/main/documentTextCatalog');

describe('mixed native/scanned/foreign/EVB OCR corpus', () => {
    it('selects exactly one canonical source per text-bearing page', async () => {
        const snapshot = await resolveDocumentTextCatalogSnapshot(
            MIXED_OCR_CORPUS_PATH,
            MIXED_OCR_CORPUS_REVISION,
            4,
        );

        expect(snapshot.pageCount).toBe(4);
        expect(snapshot.pages.map(page => ({
            pageNumber: page.pageNumber,
            source: page.source,
        })))
            .toEqual(mixedOcrCorpusExpectedSources);
        expect(snapshot.pages.find(page => page.pageNumber === 2)).toBeUndefined();
        expect(snapshot.pages.find(page => page.pageNumber === 4)).toMatchObject({
            generation: 'generation-2',
            text: mixedEvbPage.text,
        });
    });
});
