import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtemp,
    rm,
} from 'fs/promises';
import {tmpdir} from 'os';
import {join} from 'path';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {IDocumentTextCatalogPage} from '@contracts/documentTextCatalog';
import type {
    ICompactSearchIndexStreamingFinalizeOptions,
    ICompactSearchIndexStreamingOptions,
    ICompactSearchIndexStreamingWriteResult,
    getCompactSearchIndexPath as getCompactSearchIndexPathType,
    loadCompactSearchIndex as loadCompactSearchIndexType,
    openCompactSearchIndexWriter as openCompactSearchIndexWriterType,
} from '@electron/features/search/searchIndexSidecar';

const mocks = vi.hoisted(() => ({
    assertRevision: vi.fn(),
    openWriter: vi.fn(),
    resolveWindow: vi.fn(),
    writerAbort: vi.fn(),
    writerFinalize: vi.fn(),
    writerWritePage: vi.fn(),
}));

vi.mock('@electron/file-access/documentRevisionSidecar', () => ({assertWorkingCopyRevisionSidecarCurrent: mocks.assertRevision}));
vi.mock('@electron/features/ocr/public/documentTextCatalog', () => ({resolveDocumentTextCatalogWindow: mocks.resolveWindow}));
vi.mock('@electron/features/search/searchIndexSidecar', () => ({
    COMPACT_SEARCH_INDEX_SOURCE_KIND_GENERIC: 0,
    openCompactSearchIndexWriter: mocks.openWriter,
}));

const DOCUMENT_REVISION = requireDocumentRevisionToken('revision-token');

function createPage(pageNumber: number, text: string): IDocumentTextCatalogPage {
    return {
        pageNumber: requirePageNumber(pageNumber),
        text,
        source: 'pdf-native',
        contentDigest: `page-${pageNumber}`,
    };
}

function createWindow(
    firstPage: number,
    lastPage: number,
    pageCount: number,
    pages: IDocumentTextCatalogPage[],
) {
    return {
        documentRevision: DOCUMENT_REVISION,
        pageCount,
        firstPage,
        lastPage,
        pages,
        contentDigest: `window-${firstPage}-${lastPage}`,
    };
}

const writerResult: ICompactSearchIndexStreamingWriteResult = {
    indexPath: '/tmp/document.pdf.index.evb-search-v2.bin',
    pageCount: 3,
    flags: 1,
    pagesScanned: 3,
    pagesWritten: 2,
    bytesWritten: 3,
    complete: true,
    partialCoverage: false,
    truncatedCoverage: false,
};

let activeFinalizeOptions: ICompactSearchIndexStreamingFinalizeOptions | undefined;

interface IActualSidecarModule {
    getCompactSearchIndexPath: typeof getCompactSearchIndexPathType;
    loadCompactSearchIndex: typeof loadCompactSearchIndexType;
    openCompactSearchIndexWriter: typeof openCompactSearchIndexWriterType;
}

describe('xlarge search index builder', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        activeFinalizeOptions = undefined;
        mocks.assertRevision.mockResolvedValue(undefined);
        mocks.writerAbort.mockResolvedValue(undefined);
        mocks.writerWritePage.mockResolvedValue(undefined);
        mocks.writerFinalize.mockImplementation(async (options) => {
            activeFinalizeOptions = options;
            await options?.beforePublish?.();
            return writerResult;
        });
        mocks.openWriter.mockImplementation(async (
            _pdfPath: string,
            _options: ICompactSearchIndexStreamingOptions,
        ) => {
            return {
                indexPath: writerResult.indexPath,
                writePage: mocks.writerWritePage,
                finalize: mocks.writerFinalize,
                abort: mocks.writerAbort,
            };
        });
        mocks.resolveWindow.mockImplementation(async (
            _pdfPath: string,
            _revision: string,
            firstPage: number,
            lastPage: number,
            pageCount: number,
        ) => createWindow(firstPage, lastPage, pageCount, []));
    });

    it('keeps retained pages bounded for a million-page sparse document', async () => {
        const {buildXlargeSearchIndex} = await import('@electron/features/search/xlargeIndexBuilder');
        const pageCount = 1_000_001;
        let largestWindow = 0;
        let windowsVisited = 0;
        mocks.resolveWindow.mockImplementation(async (
            _pdfPath: string,
            _revision: string,
            firstPage: number,
            lastPage: number,
            resolvedPageCount: number,
        ) => {
            windowsVisited += 1;
            const pages = firstPage === 1
                ? [createPage(1, 'first page')]
                : [];
            largestWindow = Math.max(largestWindow, pages.length);
            return createWindow(firstPage, lastPage, resolvedPageCount, pages);
        });

        const result = await buildXlargeSearchIndex({
            pdfPath: '/tmp/document.pdf',
            documentRevision: DOCUMENT_REVISION,
            pageCount,
        });

        expect(windowsVisited).toBe(Math.ceil(pageCount / 64));
        expect(largestWindow).toBe(1);
        expect(mocks.writerWritePage).toHaveBeenCalledOnce();
        expect(activeFinalizeOptions?.pagesScanned).toBe(pageCount);
        expect(result).toMatchObject({
            pageCount,
            pagesScanned: pageCount,
            pagesWritten: 1,
            complete: true,
            truncated: false,
        });
    });

    it('aborts and publishes nothing when the revision changes during extraction', async () => {
        const {buildXlargeSearchIndex} = await import('@electron/features/search/xlargeIndexBuilder');
        let revisionChecks = 0;
        mocks.assertRevision.mockImplementation(async () => {
            revisionChecks += 1;
            if (revisionChecks === 3) {
                throw new Error('Document revision is stale');
            }
        });
        mocks.resolveWindow.mockResolvedValue(createWindow(
            1,
            2,
            2,
            [createPage(1, 'stale page')],
        ));

        await expect(buildXlargeSearchIndex({
            pdfPath: '/tmp/document.pdf',
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2,
            pageWindow: 2,
        })).rejects.toThrow('Document revision is stale');

        expect(mocks.writerWritePage).not.toHaveBeenCalled();
        expect(mocks.writerFinalize).not.toHaveBeenCalled();
        expect(mocks.writerAbort).toHaveBeenCalledOnce();
    });

    it('removes writer temp state when cancellation arrives in a window', async () => {
        const {buildXlargeSearchIndex} = await import('@electron/features/search/xlargeIndexBuilder');
        const controller = new AbortController();
        mocks.resolveWindow.mockImplementation(async () => {
            controller.abort();
            return createWindow(1, 1, 1, [createPage(1, 'cancelled page')]);
        });

        await expect(buildXlargeSearchIndex({
            pdfPath: '/tmp/document.pdf',
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
            signal: controller.signal,
        })).rejects.toMatchObject({name: 'AbortError'});

        expect(mocks.writerWritePage).not.toHaveBeenCalled();
        expect(mocks.writerFinalize).not.toHaveBeenCalled();
        expect(mocks.writerAbort).toHaveBeenCalledOnce();
    });

    it('writes the resolver result after page-level OCR precedence has been applied', async () => {
        const {buildXlargeSearchIndex} = await import('@electron/features/search/xlargeIndexBuilder');
        const controller = new AbortController();
        mocks.resolveWindow.mockResolvedValue(createWindow(
            1,
            1,
            1,
            [createPage(1, 'OCR text wins')],
        ));

        await buildXlargeSearchIndex({
            pdfPath: '/tmp/document.pdf',
            sourcePdfPath: '/tmp/physical.pdf',
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
            signal: controller.signal,
        });

        expect(mocks.resolveWindow).toHaveBeenCalledWith(
            '/tmp/document.pdf',
            DOCUMENT_REVISION,
            1,
            1,
            1,
            expect.objectContaining({
                pageWindow: 64,
                signal: controller.signal,
                sourcePdfPath: '/tmp/physical.pdf',
            }),
        );
        expect(mocks.writerWritePage).toHaveBeenCalledWith({
            pageNumber: 1,
            text: 'OCR text wins',
        });
    });

    it('finalizes a valid truncated sidecar when an explicit text budget is reached', async () => {
        const {buildXlargeSearchIndex} = await import('@electron/features/search/xlargeIndexBuilder');
        mocks.resolveWindow.mockResolvedValue(createWindow(
            1,
            2,
            3,
            [
                createPage(1, 'four'),
                createPage(2, 'six'),
            ],
        ));

        const result = await buildXlargeSearchIndex({
            pdfPath: '/tmp/document.pdf',
            documentRevision: DOCUMENT_REVISION,
            pageCount: 3,
            pageWindow: 2,
            maxTotalTextBytes: 5,
        });

        expect(mocks.resolveWindow).toHaveBeenCalledOnce();
        expect(mocks.writerWritePage).toHaveBeenCalledOnce();
        expect(activeFinalizeOptions).toMatchObject({
            pagesScanned: 2,
            truncatedCoverage: true,
        });
        expect(mocks.writerFinalize).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            pageCount: 3,
            pagesScanned: 2,
            pagesWritten: 1,
            textBytes: 4,
            truncated: true,
            complete: false,
        });
    });

    it('publishes complete coverage after scanning blank pages without padding records', async () => {
        const {buildXlargeSearchIndex} = await import('@electron/features/search/xlargeIndexBuilder');
        mocks.resolveWindow
            .mockResolvedValueOnce(createWindow(1, 2, 3, [createPage(1, 'a')]))
            .mockResolvedValueOnce(createWindow(3, 3, 3, []));

        const progress: Array<{
            pagesScanned: number;
            pagesWritten: number;
            complete: boolean;
        }> = [];
        const result = await buildXlargeSearchIndex({
            pdfPath: '/tmp/document.pdf',
            documentRevision: DOCUMENT_REVISION,
            pageCount: 3,
            pageWindow: 2,
            onProgress: value => {
                progress.push({
                    pagesScanned: value.pagesScanned,
                    pagesWritten: value.pagesWritten,
                    complete: value.complete,
                });
            },
        });

        expect(activeFinalizeOptions).toMatchObject({
            pagesScanned: 3,
            truncatedCoverage: false,
        });
        expect(result).toMatchObject({
            pagesScanned: 3,
            pagesWritten: 1,
            complete: true,
            truncated: false,
        });
        expect(progress.at(-1)).toEqual({
            pagesScanned: 3,
            pagesWritten: 1,
            complete: true,
        });
    });

    it('atomically publishes a reloadable streaming sidecar with coverage metadata', async () => {
        const {buildXlargeSearchIndex} = await import('@electron/features/search/xlargeIndexBuilder');
        const sidecar = await vi.importActual<IActualSidecarModule>(
            '@electron/features/search/searchIndexSidecar',
        );
        const tempRoot = await mkdtemp(join(tmpdir(), 'evb-xlarge-index-builder-'));
        const pdfPath = join(tempRoot, 'document.pdf');
        mocks.openWriter.mockImplementation((path, options) => (
            sidecar.openCompactSearchIndexWriter(path, options)
        ));
        mocks.resolveWindow.mockResolvedValue(createWindow(
            1,
            2,
            2,
            [
                createPage(1, 'first'),
                createPage(2, 'second'),
            ],
        ));

        try {
            const result = await buildXlargeSearchIndex({
                pdfPath,
                documentRevision: DOCUMENT_REVISION,
                pageCount: 2,
                pageWindow: 2,
            });
            const loaded = await sidecar.loadCompactSearchIndex(pdfPath, {
                documentRevision: DOCUMENT_REVISION,
                expectedPageCount: 2,
            });

            expect(result).toMatchObject({
                indexPath: sidecar.getCompactSearchIndexPath(pdfPath),
                pagesScanned: 2,
                pagesWritten: 2,
                complete: true,
                truncated: false,
            });
            expect(loaded).toMatchObject({
                documentRevision: DOCUMENT_REVISION,
                pageCount: 2,
                pages: [
                    {
                        pageNumber: 1,
                        text: 'first',
                    },
                    {
                        pageNumber: 2,
                        text: 'second',
                    },
                ],
                coverage: {
                    pagesScanned: 2,
                    pagesWritten: 2,
                    partialCoverage: false,
                    truncatedCoverage: false,
                },
            });
        } finally {
            await rm(tempRoot, {
                recursive: true,
                force: true,
            });
        }
    });

    it('reloads an explicitly truncated sidecar without treating it as full coverage', async () => {
        const {buildXlargeSearchIndex} = await import('@electron/features/search/xlargeIndexBuilder');
        const sidecar = await vi.importActual<IActualSidecarModule>(
            '@electron/features/search/searchIndexSidecar',
        );
        const tempRoot = await mkdtemp(join(tmpdir(), 'evb-xlarge-index-builder-'));
        const pdfPath = join(tempRoot, 'document.pdf');
        mocks.openWriter.mockImplementation((path, options) => (
            sidecar.openCompactSearchIndexWriter(path, options)
        ));
        mocks.resolveWindow.mockResolvedValue(createWindow(
            1,
            2,
            2,
            [
                createPage(1, 'first'),
                createPage(2, 'second'),
            ],
        ));

        try {
            const result = await buildXlargeSearchIndex({
                pdfPath,
                documentRevision: DOCUMENT_REVISION,
                pageCount: 2,
                pageWindow: 2,
                maxTotalTextBytes: Buffer.byteLength('first', 'utf8'),
            });
            const loaded = await sidecar.loadCompactSearchIndex(pdfPath, {documentRevision: DOCUMENT_REVISION});

            expect(result).toMatchObject({
                pagesScanned: 2,
                pagesWritten: 1,
                complete: false,
                truncated: true,
            });
            expect(loaded).toMatchObject({
                documentRevision: DOCUMENT_REVISION,
                pageCount: 2,
                pages: [{
                    pageNumber: 1,
                    text: 'first',
                }],
                coverage: {
                    pagesScanned: 2,
                    pagesWritten: 1,
                    partialCoverage: false,
                    truncatedCoverage: true,
                },
            });
            await expect(sidecar.loadCompactSearchIndex(pdfPath, {
                documentRevision: DOCUMENT_REVISION,
                expectedPageCount: 2,
            })).resolves.toBeNull();
        } finally {
            await rm(tempRoot, {
                recursive: true,
                force: true,
            });
        }
    });
});
