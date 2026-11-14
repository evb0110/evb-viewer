import type * as TViMockOriginalModule from '@app/platform/browser-api/browserYield';
import type * as TExtractBrowserSearchPageTextModule from '@app/platform/browser-api/extractBrowserSearchPageText';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    createPdfjsDocumentInitFromBrowserDocument: vi.fn(),
    destroyDocument: vi.fn(),
    destroyLoadingTask: vi.fn(),
    extractBrowserSearchPageData: vi.fn(),
    getDocument: vi.fn(),
    getPage: vi.fn(),
    pageOps: vi.fn(),
    readableBlob: vi.fn(),
    yieldToBrowser: vi.fn(),
}));

vi.mock('@app/platform/browser-api/browserPageOpsWorkerClient', () => ({runBrowserPageOpsWorkerRequest: mocks.pageOps}));
vi.mock('@app/platform/browserDocumentStore', () => ({browserDocumentStore: {
    stat: async () => ({size: 1}),
    read: async () => Uint8Array.of(1),
    readableBlob: mocks.readableBlob,
}}));

vi.mock('@app/platform/browser-api/browserPdfjsDocumentInit', () => ({
    createPdfjsDocumentInitFromBrowserDocument: mocks.createPdfjsDocumentInitFromBrowserDocument,
    getPdfjsLib: vi.fn(async () => ({
        OPS: {},
        getDocument: mocks.getDocument,
    })),
}));

vi.mock('@app/platform/browser-api/browserYield', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    yieldToBrowser: mocks.yieldToBrowser,
}));

vi.mock('@app/platform/browser-api/extractBrowserSearchPageText', async importOriginal => ({
    ...await importOriginal<typeof TExtractBrowserSearchPageTextModule>(),
    extractBrowserSearchPageData: mocks.extractBrowserSearchPageData,
}));

describe('browserSearchCore', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readableBlob.mockResolvedValue(new Blob([Uint8Array.of(1)]));
        mocks.createPdfjsDocumentInitFromBrowserDocument.mockResolvedValue({url: '/tmp/search.pdf'});
        mocks.destroyDocument.mockResolvedValue(undefined);
        mocks.destroyLoadingTask.mockResolvedValue(undefined);
        mocks.extractBrowserSearchPageData.mockResolvedValue({text: 'alpha'});
        mocks.getPage.mockResolvedValue({});
        mocks.getDocument.mockReturnValue({
            destroy: mocks.destroyLoadingTask,
            promise: Promise.resolve({
                loadingTask: {destroy: mocks.destroyDocument},
                getPage: mocks.getPage,
                numPages: 1,
            }),
        });
        mocks.yieldToBrowser.mockResolvedValue(undefined);
        mocks.pageOps.mockResolvedValue({pages: []});
    });

    it('reads a right-to-left page from its EVB OCR lines under the search signal', async () => {
        mocks.extractBrowserSearchPageData.mockResolvedValue({text: 'ש ל ו ם'});
        mocks.pageOps.mockResolvedValue({pages: [{
            pageNumber: 1,
            paintedText: false,
            evbOcrLayer: true,
            evbOcrLines: [{
                text: 'שלום',
                words: [],
            }],
        }]});
        const signal = new AbortController().signal;
        const { loadBrowserSearchDocument } = await import('@app/platform/browser-api/browserSearchCore');
        const document = await loadBrowserSearchDocument('/tmp/rtl.pdf');

        await expect(document.extractPage(1, {signal})).resolves.toMatchObject({text: 'שלום'});
        expect(mocks.pageOps).toHaveBeenCalledWith('ocrTextVisibility', {
            source: expect.any(Blob),
            pages: [1],
            withEvbOcrText: true,
        }, {signal});
        const source: Blob = mocks.pageOps.mock.calls[0]![1].source;
        expect(new Uint8Array(await source.arrayBuffer())).toEqual(Uint8Array.of(1));
    });

    it.each([
        {
            paintedText: true,
            evbOcrLayer: true,
        },
        {
            paintedText: false,
            evbOcrLayer: false,
        },
    ])('keeps repaired foreign or painted RTL text ($paintedText, $evbOcrLayer)', async metadata => {
        mocks.extractBrowserSearchPageData.mockResolvedValue({text: 'הַקְדְשָה'});
        mocks.pageOps.mockResolvedValue({pages: [{
            pageNumber: 1,
            ...metadata,
            evbOcrLines: [{
                text: 'wrong override',
                words: [],
            }],
        }]});
        const {loadBrowserSearchDocument} = await import('@app/platform/browser-api/browserSearchCore');
        const document = await loadBrowserSearchDocument('/tmp/foreign.pdf');
        await expect(document.extractPage(1)).resolves.toMatchObject({text: 'הַקְדְשָה'});
    });

    it('stops at the canceled search instead of returning the EVB read', async () => {
        mocks.extractBrowserSearchPageData.mockResolvedValue({text: 'ש ל ו ם'});
        let continueSearch = true;
        mocks.pageOps.mockImplementation(async () => {
            continueSearch = false;
            return {pages: []};
        });
        const { loadBrowserSearchDocument } = await import('@app/platform/browser-api/browserSearchCore');
        const document = await loadBrowserSearchDocument('/tmp/rtl.pdf');

        await expect(document.extractPage(1, {shouldContinue: () => continueSearch}))
            .rejects.toThrow('ERR_BROWSER_SEARCH_CANCELED');
    });

    it('preserves RTL results while requesting EVB layers in windows of at most 2,048 pages', async () => {
        const pageCount = 4_097;
        mocks.getDocument.mockReturnValue({
            destroy: mocks.destroyLoadingTask,
            promise: Promise.resolve({
                loadingTask: {destroy: mocks.destroyDocument},
                getPage: mocks.getPage,
                numPages: pageCount,
            }),
        });
        mocks.extractBrowserSearchPageData.mockResolvedValue({text: 'ש ל ו ם'});
        mocks.pageOps.mockImplementation(async (_type, {pages}: {pages: number[]}) => ({pages: pages.map(pageNumber => ({
            pageNumber,
            paintedText: false,
            evbOcrLayer: true,
            evbOcrLines: [{
                text: `שלום ${pageNumber}`,
                words: [],
            }],
        }))}));
        const {streamBrowserSearchDocumentPages} = await import('@app/platform/browser-api/browserSearchCore');
        const {findPdfSearchMatches} = await import('@pdf-core/pdfSearchAlgorithms');
        const results: Array<{
            pageNumber: number;
            startOffset: number;
            endOffset: number
        }> = [];
        for await (const page of streamBrowserSearchDocumentPages('/tmp/long-rtl.pdf')) {
            expect(page.text).toBe(`שלום ${page.pageNumber}`);
            for (const match of findPdfSearchMatches(page.text, 'שלום', {})) results.push({
                pageNumber: page.pageNumber,
                ...match,
            });
        }
        expect(results).toEqual(Array.from({length: pageCount}, (_, index) => ({
            pageNumber: index + 1,
            startOffset: 0,
            endOffset: 4,
        })));
        const requests = mocks.pageOps.mock.calls.map(([
            , payload,
        ]) => (payload as {pages: number[]}).pages);
        expect(requests.map(pages => pages.length)).toEqual([
            2_048,
            2_048,
            1,
        ]);
        expect(requests.flat()).toEqual(Array.from({length: pageCount}, (_, index) => index + 1));
    });

    it('cancels after getPage resolves without starting page text extraction', async () => {
        const { iterateBrowserSearchDocumentPages } =
            await import('@app/platform/browser-api/browserSearchCore');
        let shouldContinue = true;
        mocks.getPage.mockImplementation(async () => {
            shouldContinue = false;
            return {};
        });

        await expect(iterateBrowserSearchDocumentPages(
            '/tmp/search.pdf',
            vi.fn(),
            {shouldContinue: () => shouldContinue},
        )).rejects.toThrow('ERR_BROWSER_SEARCH_CANCELED');

        expect(mocks.getPage).toHaveBeenCalledWith(1);
        expect(mocks.extractBrowserSearchPageData).not.toHaveBeenCalled();
        expect(mocks.destroyDocument).toHaveBeenCalledOnce();
    });

    it('streams a million-page document with one-page backpressure', async () => {
        const arrayFrom = vi.spyOn(Array, 'from');
        mocks.getDocument.mockReturnValue({
            destroy: mocks.destroyLoadingTask,
            promise: Promise.resolve({
                loadingTask: {destroy: mocks.destroyDocument},
                getPage: mocks.getPage,
                numPages: 1_000_000,
            }),
        });
        const { streamBrowserSearchDocumentPages } =
            await import('@app/platform/browser-api/browserSearchCore');
        const stream = streamBrowserSearchDocumentPages('/tmp/million.pdf');

        const first = await stream.next();
        expect(first).toEqual({
            done: false,
            value: expect.objectContaining({
                pageNumber: 1,
                pageCount: 1_000_000,
                text: 'alpha',
            }),
        });
        expect(mocks.getPage).toHaveBeenCalledTimes(1);
        expect(mocks.yieldToBrowser).not.toHaveBeenCalled();

        await Promise.resolve();
        expect(mocks.getPage).toHaveBeenCalledTimes(1);
        await stream.return(undefined);
        expect(mocks.destroyDocument).toHaveBeenCalledOnce();
        expect(arrayFrom.mock.calls.some(([value]) => (
            typeof value === 'object'
            && value !== null
            && 'length' in value
            && Number((value as {length?: unknown}).length) >= 1_000_000
        ))).toBe(false);
        arrayFrom.mockRestore();
    });

    it('streams the 2,646-page acceptance boundary without an array result', async () => {
        mocks.getDocument.mockReturnValue({
            destroy: mocks.destroyLoadingTask,
            promise: Promise.resolve({
                loadingTask: {destroy: mocks.destroyDocument},
                getPage: mocks.getPage,
                numPages: 2_646,
            }),
        });
        const { streamBrowserSearchDocumentPages } =
            await import('@app/platform/browser-api/browserSearchCore');
        const stream = streamBrowserSearchDocumentPages('/tmp/2646.pdf');

        await expect(stream.next()).resolves.toEqual({
            done: false,
            value: expect.objectContaining({
                pageNumber: 1,
                pageCount: 2_646,
                text: 'alpha',
            }),
        });
        expect(mocks.getPage).toHaveBeenCalledTimes(1);
        await stream.return(undefined);
        expect(mocks.destroyDocument).toHaveBeenCalledOnce();
    });
});
