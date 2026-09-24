import { createHash } from 'node:crypto';
import type {TOcrPageArtifact} from '@contracts/ocrIndex';
import {
    requireDocumentRevisionToken,
    type IDocumentRevisionStamp,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    OcrCatalogFencedError,
    type IOcrCatalogHandle,
    type IOcrCatalogOpenOptions,
} from '@electron/features/ocr/main/ocrCatalogV4';

export const OCR_CATALOG_FIXTURE_PATH = '/tmp/evb-ocr-catalog-agreement.pdf';
export const OCR_CATALOG_FIXTURE_REVISION = requireDocumentRevisionToken('ocr-catalog-agreement-r1');

export interface IOcrCatalogFixturePage {
    pageNumber: number;
    text: string;
}

function expectedRevisionToken(value: TDocumentRevisionToken | IDocumentRevisionStamp | undefined) {
    return typeof value === 'object' ? value.token : value;
}

/**
 * An in-memory v4 catalog for the OCR text readers: `open` stands in for
 * `openCatalog` and serves the fixture pages through the catalog handle API.
 */
export function createOcrDocumentTextCatalogFixture(
    pages: readonly IOcrCatalogFixturePage[],
    options: {revision?: string} = {},
) {
    const revision = requireDocumentRevisionToken(options.revision ?? OCR_CATALOG_FIXTURE_REVISION);
    const artifacts = new Map<number, TOcrPageArtifact>(pages.map(page => [
        page.pageNumber,
        {
            rotation: 0,
            render: {
                dpi: 300,
                imagePx: {
                    w: 1200,
                    h: 1600,
                },
            },
            text: page.text,
            words: page.text.split(/\s+/u).filter(Boolean).map((text, index) => ({
                text,
                x: 20 + index * 80,
                y: 30,
                width: 70,
                height: 24,
            })),
            canonicalText: {
                source: 'evb-ocr',
                generation: 'fixture-generation',
                contentDigest: createHash('sha256').update(page.text).digest('hex'),
            },
        },
    ]));
    const pageCount = Math.max(1, ...pages.map(page => page.pageNumber));
    const pageNumbers = (start: number, count: number) => Array.from({length: count}, (_value, index) => start + index);

    function createHandle(): IOcrCatalogHandle {
        return {
            header: {
                version: 4,
                source: {pdfPath: OCR_CATALOG_FIXTURE_PATH},
                documentRevision: {token: revision},
                pageCount,
                generation: 1,
                mappedPageCount: artifacts.size,
                complete: artifacts.size === pageCount,
            },
            readPage: async pageNumber => artifacts.get(pageNumber) ?? null,
            async* readWindow(start, count) {
                for (const pageNumber of pageNumbers(start, count)) {
                    yield {
                        pageNumber,
                        artifact: artifacts.get(pageNumber) ?? null,
                    };
                }
            },
            readWindowMappings: async (start, count) => pageNumbers(start, count).map(pageNumber => ({
                pageNumber,
                mapping: artifacts.has(pageNumber)
                    ? {
                        path: `gen-00000001/pages/${pageNumber}.json`,
                        generation: 1,
                    }
                    : null,
            })),
            windowAvailability: async (start, count) => Uint8Array.from(
                pageNumbers(start, count).map(pageNumber => (artifacts.has(pageNumber) ? 1 : 0)),
            ),
            async* iterateMappedPages(fromPage = 1) {
                for (const [
                    pageNumber,
                    artifact,
                ] of [...artifacts].sort(([left], [right]) => left - right)) {
                    if (pageNumber >= fromPage) {
                        yield {
                            pageNumber,
                            artifact,
                        };
                    }
                }
            },
            findFirstUnmapped: async (fromPage = 1) => pageNumbers(fromPage, Math.max(0, pageCount - fromPage + 1))
                .find(pageNumber => !artifacts.has(pageNumber)) ?? null,
            close: async () => undefined,
        };
    }

    return {
        path: OCR_CATALOG_FIXTURE_PATH,
        revision,
        open(catalogRoot: string, openOptions: IOcrCatalogOpenOptions = {}) {
            if (catalogRoot !== `${OCR_CATALOG_FIXTURE_PATH}.ocr`) {
                return null;
            }
            const expected = expectedRevisionToken(openOptions.expectedDocumentRevision ?? openOptions.documentRevision);
            if (expected !== undefined && expected !== revision) {
                throw new OcrCatalogFencedError('OCR catalog document revision does not match the requested revision', expected, revision);
            }
            return createHandle();
        },
    };
}
