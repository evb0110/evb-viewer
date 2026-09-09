import {
    afterAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAgentTabSnapshot } from '@contracts/agent';
import { requireDocumentRef } from '@contracts/documentRef';
import { requirePaneId } from '@contracts/editorPanes';
import { requireTabId } from '@contracts/windowTabs';
import type * as SearchRequestValidation from '@electron/features/search/main/searchRequestValidation';
import type * as SearchMatch from '@electron/features/search/worker/searchMatch';

const mocks = vi.hoisted(() => ({
    dispatchSearchRequest: vi.fn(),
    cancelSearch: vi.fn(),
    resolveSearchablePdfPath: vi.fn(),
    resolveSearchWorkerPath: vi.fn(() => '/tmp/search-worker.js'),
    stat: vi.fn(),
    loadCompactSearchIndex: vi.fn(),
    loadSearchIndex: vi.fn(),
    classifyXlargeSearchPath: vi.fn((input: {
        pageCount?: number;
        pathSizeBytes?: number;
    }) => ({
        isXlarge: (input.pageCount ?? 0) > 200 || (input.pathSizeBytes ?? 0) > 16 * 1024 * 1024,
        pageCount: input.pageCount,
        pathSizeBytes: input.pathSizeBytes,
        reasons: [],
    })),
    loadPdfjsTextExtractor: vi.fn(async () => ({extractTextWithPdfjs: mocks.extractTextWithPdfjs})),
    extractTextWithPdfjs: vi.fn(),
    extractTextFromPdf: vi.fn(),
    loggerDebug: vi.fn(),
}));

vi.mock('@electron/features/search/public', async () => {
    const validation = await vi.importActual<typeof SearchRequestValidation>(
        '@electron/features/search/main/searchRequestValidation',
    );
    const searchMatch = await vi.importActual<typeof SearchMatch>(
        '@electron/features/search/worker/searchMatch',
    );
    return {
        parseOptionalSearchPageCount: validation.parseOptionalSearchPageCount,
        validateSearchQuery: validation.validateSearchQuery,
        resolveSearchablePdfPath: mocks.resolveSearchablePdfPath,
        resolveSearchWorkerPath: mocks.resolveSearchWorkerPath,
        classifyXlargeSearchPath: mocks.classifyXlargeSearchPath,
        loadCompactSearchIndex: mocks.loadCompactSearchIndex,
        loadSearchIndex: mocks.loadSearchIndex,
        loadPdfjsTextExtractor: mocks.loadPdfjsTextExtractor,
        extractTextFromPdf: mocks.extractTextFromPdf,
        buildExcerpt: searchMatch.buildExcerpt,
        iteratePageMatches: searchMatch.iteratePageMatches,
        SearchWorkerService: class {
            dispatchSearchRequest = mocks.dispatchSearchRequest;
            cancel = mocks.cancelSearch;
        },
    };
});

vi.mock('@electron/features/search/indexBuilder', () => ({ loadSearchIndex: mocks.loadSearchIndex }));

vi.mock('node:fs/promises', () => ({stat: mocks.stat}));

vi.mock('@electron/features/search/searchIndexSidecar', () => ({loadCompactSearchIndex: mocks.loadCompactSearchIndex}));

vi.mock('@electron/features/search/extractTextWithPdfjs', () => ({ extractTextWithPdfjs: mocks.extractTextWithPdfjs }));

vi.mock('@electron/features/search/extractTextFromPdf', () => ({ extractTextFromPdf: mocks.extractTextFromPdf }));

vi.mock('@electron/file-access/documentRevisionStore', () => ({getWorkingCopyRevision: vi.fn(async () => ({
    token: 'revision-token',
    contentRevision: 1,
}))}));

vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => ({debug: mocks.loggerDebug}) }));

const pdfTab: IAgentTabSnapshot = {
    tabId: requireTabId('tab-1'),
    paneId: requirePaneId('pane-1'),
    fileName: 'Grammar.pdf',
    originalPath: requireDocumentRef('/tmp/Grammar.pdf'),
    isDirty: false,
    kind: 'pdf',
    workspaceAttached: true,
    hasPdf: true,
    isDjvu: false,
    isOpeningDocument: false,
    hasOpenError: false,
    currentPage: 1,
    totalPages: 10,
    readiness: {
        status: 'ready',
        reasons: [],
        recommendations: [],
    },
};

function createWindow() {
    return {webContents: {id: 42}};
}

describe('agent document search validation', () => {
    afterAll(() => {
        vi.doUnmock('node:fs/promises');
        vi.resetModules();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.resolveSearchablePdfPath.mockResolvedValue('/tmp/Grammar.pdf');
        mocks.stat.mockRejectedValue(new Error('missing test path'));
        mocks.loadCompactSearchIndex.mockResolvedValue(null);
        mocks.dispatchSearchRequest.mockResolvedValue({
            results: [],
            truncated: false,
        });
        mocks.loadSearchIndex.mockResolvedValue({
            pageCount: 10,
            pages: [],
        });
        mocks.extractTextWithPdfjs.mockResolvedValue([]);
        mocks.extractTextFromPdf.mockResolvedValue([]);
    });

    it('rejects unsafe regex before resolving paths or dispatching worker search', async () => {
        const { searchAgentDocument } = await import('@electron/features/agent/documentText');

        await expect(searchAgentDocument(
            createWindow() as never,
            {
                tab: pdfTab,
                options: {
                    query: '(a+)+$',
                    useRegex: true,
                },
            },
        )).rejects.toThrow('pattern is too complex for document search');

        expect(mocks.resolveSearchablePdfPath).not.toHaveBeenCalled();
        expect(mocks.dispatchSearchRequest).not.toHaveBeenCalled();
    });

    it('applies the renderer search query length limit to agent search', async () => {
        const { searchAgentDocument } = await import('@electron/features/agent/documentText');

        await expect(searchAgentDocument(
            createWindow() as never,
            {
                tab: pdfTab,
                options: {query: 'x'.repeat(2_049)},
            },
        )).rejects.toThrow('maximum length is 2048 characters');

        expect(mocks.resolveSearchablePdfPath).not.toHaveBeenCalled();
        expect(mocks.dispatchSearchRequest).not.toHaveBeenCalled();
    });

    it('searches bounded page ranges without dispatching a global worker search', async () => {
        const { searchAgentDocument } = await import('@electron/features/agent/documentText');
        mocks.loadSearchIndex.mockResolvedValue({
            pageCount: 2136,
            pages: [
                {
                    pageNumber: 7,
                    text: 'Kurdish introduction',
                },
                {
                    pageNumber: 8,
                    text: '',
                },
            ],
        });
        mocks.extractTextWithPdfjs.mockResolvedValue([
            {
                pageNumber: 7,
                text: 'Kurdish introduction',
            },
            {
                pageNumber: 8,
                text: 'Kurdan front matter Kurdan',
            },
        ]);

        const result = await searchAgentDocument(
            createWindow() as never,
            {
                tab: {
                    ...pdfTab,
                    totalPages: 2136,
                },
                options: {
                    query: 'Kurdan',
                    pages: [
                        7,
                        8,
                    ],
                    maxResults: 1,
                },
            },
        );

        expect(mocks.dispatchSearchRequest).not.toHaveBeenCalled();
        expect(mocks.loadSearchIndex).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            bounded: true,
            returnedResults: 1,
            totalAvailableResults: 2,
            truncated: true,
            options: { pages: [
                7,
                8,
            ] },
            textStatus: {
                coverageScope: 'requested-pages',
                inspectedPages: [
                    7,
                    8,
                ],
            },
        });
        expect(result.results[0]).toMatchObject({
            pageNumber: 8,
            excerpt: { match: 'Kurdan' },
        });
    });

    it('uses a bounded direct page probe when no cached search index is available', async () => {
        const { readAgentDocumentPages } = await import('@electron/features/agent/documentText');
        mocks.loadSearchIndex.mockRejectedValue(new Error('missing index'));
        mocks.extractTextWithPdfjs.mockResolvedValue([
            {
                pageNumber: 2,
                text: 'Second page text',
            },
            {
                pageNumber: 4,
                text: '',
            },
        ]);

        const result = await readAgentDocumentPages(
            createWindow() as never,
            {
                tab: pdfTab,
                options: {
                    pages: [
                        4,
                        2,
                    ],
                    maxCharsPerPage: 20,
                },
            },
        );

        expect(mocks.dispatchSearchRequest).not.toHaveBeenCalled();
        expect(mocks.extractTextWithPdfjs).toHaveBeenCalledWith('/tmp/Grammar.pdf', {
            pages: [
                2,
                4,
            ],
            pageCount: 10,
        });
        expect(mocks.extractTextFromPdf).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            source: 'direct-pdfjs',
            usedCachedSearchIndex: false,
            pages: [
                {
                    page: 2,
                    source: 'direct-pdfjs',
                    hasText: true,
                    text: 'Second page text',
                },
                {
                    page: 4,
                    source: 'direct-pdfjs',
                    hasText: false,
                    text: '',
                },
            ],
            textStatus: {
                status: 'partial',
                coverageScope: 'requested-pages',
                globalCoverageKnown: false,
                inspectedPages: [
                    2,
                    4,
                ],
                missingTextPages: [4],
            },
        });
    });

    it('direct-probes cached blank pages and reports requested-page coverage', async () => {
        const { readAgentDocumentPages } = await import('@electron/features/agent/documentText');
        mocks.loadSearchIndex.mockResolvedValue({
            pageCount: 2136,
            pages: [
                {
                    pageNumber: 1,
                    text: '',
                },
                {
                    pageNumber: 3,
                    text: '',
                },
                {
                    pageNumber: 5,
                    text: '',
                },
                {
                    pageNumber: 25,
                    text: 'cached dictionary text',
                },
            ],
        });
        mocks.extractTextWithPdfjs.mockResolvedValue([
            {
                pageNumber: 1,
                text: '',
            },
            {
                pageNumber: 3,
                text: 'title page text',
            },
            {
                pageNumber: 5,
                text: 'front matter text',
            },
            {
                pageNumber: 25,
                text: 'cached dictionary text',
            },
        ]);

        const result = await readAgentDocumentPages(
            createWindow() as never,
            {
                tab: {
                    ...pdfTab,
                    totalPages: 2136,
                },
                options: {pages: [
                    1,
                    3,
                    5,
                    25,
                ]},
            },
        );

        expect(mocks.extractTextWithPdfjs).toHaveBeenCalledWith('/tmp/Grammar.pdf', {
            pages: [
                1,
                3,
                5,
                25,
            ],
            pageCount: 2136,
        });
        expect(result).toMatchObject({
            usedCachedSearchIndex: false,
            pages: [
                {
                    page: 1,
                    source: 'direct-pdfjs',
                    hasText: false,
                },
                {
                    page: 3,
                    source: 'direct-pdfjs',
                    hasText: true,
                    text: 'title page text',
                },
                {
                    page: 5,
                    source: 'direct-pdfjs',
                    hasText: true,
                    text: 'front matter text',
                },
                {
                    page: 25,
                    source: 'direct-pdfjs',
                    hasText: true,
                    text: 'cached dictionary text',
                },
            ],
            textStatus: {
                status: 'partial',
                coverageScope: 'requested-pages',
                globalCoverageKnown: false,
                inspectedPages: [
                    1,
                    3,
                    5,
                    25,
                ],
                coverage: 0.75,
                missingTextPages: [1],
            },
        });
    });

    it('does not recommend OCR from unknown text coverage alone', async () => {
        const { inspectAgentDocumentText } = await import('@electron/features/agent/documentText');
        mocks.loadSearchIndex.mockResolvedValue(null);

        const result = await inspectAgentDocumentText(
            createWindow() as never,
            {
                tab: pdfTab,
                options: {},
            },
        );

        expect(result.textStatus.status).toBe('unknown');
        expect(result.recommendations).toEqual([]);
    });

    it('cancels an in-flight warmup worker request when its caller disconnects', async () => {
        const {inspectAgentDocumentText} = await import('@electron/features/agent/documentText');
        const controller = new AbortController();
        mocks.dispatchSearchRequest.mockReturnValue(new Promise(() => undefined));

        const inspection = inspectAgentDocumentText(
            createWindow() as never,
            {
                tab: pdfTab,
                options: {},
            },
            controller.signal,
        );
        await vi.waitFor(() => expect(mocks.dispatchSearchRequest).toHaveBeenCalledOnce());
        const dispatchedPayload = mocks.dispatchSearchRequest.mock.calls[0]?.[1] as {requestId: string};

        controller.abort(new Error('client disconnected'));

        await expect(inspection).rejects.toThrow('client disconnected');
        expect(mocks.cancelSearch).toHaveBeenCalledWith(
            expect.objectContaining({senderId: 42}),
            dispatchedPayload.requestId,
        );
    });

    it('aborts direct page extraction without falling back to another backend', async () => {
        const {readAgentDocumentPages} = await import('@electron/features/agent/documentText');
        const controller = new AbortController();
        const started = Promise.withResolvers<undefined>();
        mocks.loadSearchIndex.mockResolvedValue(null);
        mocks.extractTextWithPdfjs.mockImplementation(async (
            _path,
            options: {signal?: AbortSignal},
        ) => {
            expect(options.signal).toBe(controller.signal);
            started.resolve(undefined);
            await new Promise<undefined>((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {once: true});
            });
            return [];
        });

        const read = readAgentDocumentPages(
            createWindow() as never,
            {
                tab: pdfTab,
                options: {pages: [1]},
            },
            controller.signal,
        );
        await started.promise;
        controller.abort(new Error('client disconnected'));

        await expect(read).rejects.toThrow('client disconnected');
        expect(mocks.extractTextFromPdf).not.toHaveBeenCalled();
    });

    it('keeps xlarge agent warm/status scalar and avoids the legacy index', async () => {
        const pageCount = 1_000_001;
        mocks.stat.mockResolvedValue({size: 17 * 1024 * 1024});
        mocks.loadCompactSearchIndex.mockResolvedValue({
            documentRevision: 'revision-token',
            pageCount,
            pages: [],
            textSource: {
                kind: 0,
                version: 0,
            },
            coverage: {
                flags: 1,
                pagesScanned: pageCount,
                pagesWritten: 1,
                bytesWritten: 1,
                complete: true,
                partialCoverage: false,
                truncatedCoverage: false,
            },
        });
        const {inspectAgentDocumentText} = await import('@electron/features/agent/documentText');

        const result = await inspectAgentDocumentText(
            createWindow() as never,
            {
                tab: {
                    ...pdfTab,
                    totalPages: pageCount,
                },
                options: {},
            },
        );

        expect(mocks.dispatchSearchRequest).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                warmup: true,
                pageCount,
            }),
        );
        expect(mocks.loadCompactSearchIndex).toHaveBeenCalledWith('/tmp/Grammar.pdf', expect.objectContaining({
            metadataOnly: true,
            expectedPageCount: pageCount,
        }));
        expect(mocks.loadSearchIndex).not.toHaveBeenCalled();
        expect(result.textStatus).toMatchObject({
            status: 'complete',
            pageCount,
            pagesScanned: pageCount,
            textPageCount: 1,
            missingTextPages: [],
        });
    });

    it('keeps unbounded xlarge agent search native and scalar-only', async () => {
        const pageCount = 1_000_001;
        mocks.stat.mockResolvedValue({size: 17 * 1024 * 1024});
        mocks.dispatchSearchRequest.mockResolvedValue({
            results: [{
                pageNumber: pageCount,
                pageMatchIndex: 0,
                matchIndex: 0,
                startOffset: 0,
                endOffset: 6,
                excerpt: {
                    prefix: false,
                    suffix: false,
                    before: '',
                    match: 'needle',
                    after: '',
                },
            }],
            truncated: false,
        });
        mocks.loadCompactSearchIndex.mockResolvedValue({
            documentRevision: 'revision-token',
            pageCount,
            pages: [],
            textSource: {
                kind: 0,
                version: 0,
            },
            coverage: {
                flags: 1,
                pagesScanned: pageCount,
                pagesWritten: 1,
                bytesWritten: 1,
                complete: true,
                partialCoverage: false,
                truncatedCoverage: false,
            },
        });
        const {searchAgentDocument} = await import('@electron/features/agent/documentText');

        const result = await searchAgentDocument(
            createWindow() as never,
            {
                tab: {
                    ...pdfTab,
                    totalPages: pageCount,
                },
                options: {query: 'needle'},
            },
        );

        expect(mocks.loadSearchIndex).not.toHaveBeenCalled();
        expect(mocks.loadCompactSearchIndex).toHaveBeenCalledWith('/tmp/Grammar.pdf', expect.objectContaining({
            metadataOnly: true,
            expectedPageCount: pageCount,
        }));
        expect(result).toMatchObject({
            returnedResults: 1,
            textStatus: {
                pageCount,
                missingTextPages: [],
                pagesScanned: pageCount,
            },
        });
    });
});
