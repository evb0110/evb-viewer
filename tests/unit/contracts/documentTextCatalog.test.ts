import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    decodeDocumentOcrAvailability,
    decodeDocumentOcrPageSnapshot,
    MAX_DOCUMENT_TEXT_CATALOG_PAGE_WORDS,
} from '@contracts/documentTextCatalog';

const DOCUMENT_REVISION = 'drt1:document-text-catalog-test';

function createPage(words: unknown[]) {
    return {
        pageNumber: 1,
        text: 'page text',
        source: 'evb-ocr',
        words,
        render: {
            dpi: 300,
            imagePx: {
                w: 1200,
                h: 1600,
            },
        },
        contentDigest: 'page-digest',
    };
}

describe('document text catalog page-scoped decoders', () => {
    it('decodes compact OCR availability without page geometry', () => {
        expect(decodeDocumentOcrAvailability({
            documentRevision: DOCUMENT_REVISION,
            pageCount: 406,
            pageNumbers: [
                1,
                406,
            ],
        })).toEqual({
            documentRevision: DOCUMENT_REVISION,
            pageCount: 406,
            pageNumbers: [
                1,
                406,
            ],
        });
    });

    it('decodes bounded OCR availability ranges with a scalar mapped count', () => {
        expect(decodeDocumentOcrAvailability({
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1_000_001,
            mappedPageCount: 2,
            pageRanges: [
                {
                    firstPage: 1,
                    lastPage: 1,
                },
                {
                    firstPage: 900_000,
                    lastPage: 900_000,
                },
            ],
            rangesComplete: true,
        })).toEqual({
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1_000_001,
            mappedPageCount: 2,
            pageRanges: [
                {
                    firstPage: 1,
                    lastPage: 1,
                },
                {
                    firstPage: 900_000,
                    lastPage: 900_000,
                },
            ],
            rangesComplete: true,
        });
    });

    it('rejects duplicate or out-of-range availability page numbers', () => {
        expect(decodeDocumentOcrAvailability({
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2,
            pageNumbers: [
                1,
                1,
            ],
        })).toBeNull();
        expect(decodeDocumentOcrAvailability({
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2,
            pageNumbers: [3],
        })).toBeNull();
    });

    it('rejects a page before validating an excessive word collection', () => {
        const word = {
            text: 'word',
            x: 1,
            y: 1,
            width: 1,
            height: 1,
        };
        expect(decodeDocumentOcrPageSnapshot({
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
            page: createPage(Array.from(
                {length: MAX_DOCUMENT_TEXT_CATALOG_PAGE_WORDS + 1},
                () => word,
            )),
        })).toBeNull();
    });
});
