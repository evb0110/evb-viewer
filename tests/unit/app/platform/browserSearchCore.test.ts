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
    readEvbLayerLines: vi.fn(),
    yieldToBrowser: vi.fn(),
}));

vi.mock('@app/platform/browser-api/browserOcrTextCatalog', () => ({readEvbLayerLines: mocks.readEvbLayerLines}));

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
    });

    it('reads a right-to-left page from its EVB OCR lines under the search signal', async () => {
        mocks.extractBrowserSearchPageData.mockResolvedValue({text: 'ש ל ו ם'});
        mocks.readEvbLayerLines.mockResolvedValue(new Map([[
            1,
            {text: 'שלום'},
        ]]));
        const signal = new AbortController().signal;
        const { loadBrowserSearchDocument } = await import('@app/platform/browser-api/browserSearchCore');
        const document = await loadBrowserSearchDocument('/tmp/rtl.pdf');

        await expect(document.extractPage(1, {signal})).resolves.toMatchObject({text: 'שלום'});
        expect(mocks.readEvbLayerLines).toHaveBeenCalledWith('/tmp/rtl.pdf', [1], signal);
    });

    it('stops at the canceled search instead of returning the EVB read', async () => {
        mocks.extractBrowserSearchPageData.mockResolvedValue({text: 'ש ל ו ם'});
        let continueSearch = true;
        mocks.readEvbLayerLines.mockImplementation(async () => {
            continueSearch = false;
            return new Map();
        });
        const { loadBrowserSearchDocument } = await import('@app/platform/browser-api/browserSearchCore');
        const document = await loadBrowserSearchDocument('/tmp/rtl.pdf');

        await expect(document.extractPage(1, {shouldContinue: () => continueSearch}))
            .rejects.toThrow('ERR_BROWSER_SEARCH_CANCELED');
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
