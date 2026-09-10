import type * as TViMockOriginalModule from '@app/platform/browser-api/browserYield';

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
    yieldToBrowser: vi.fn(),
}));

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

vi.mock('@app/platform/browser-api/extractBrowserSearchPageText', () => ({extractBrowserSearchPageData: mocks.extractBrowserSearchPageData}));

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
                destroy: mocks.destroyDocument,
                getPage: mocks.getPage,
                numPages: 1,
            }),
        });
        mocks.yieldToBrowser.mockResolvedValue(undefined);
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

    it('keeps the legacy array API at the explicit 1,024-page boundary', async () => {
        mocks.getDocument.mockReturnValue({
            destroy: mocks.destroyLoadingTask,
            promise: Promise.resolve({
                destroy: mocks.destroyDocument,
                getPage: mocks.getPage,
                numPages: 1_024,
            }),
        });

        const { extractBrowserSearchDocumentText } =
            await import('@app/platform/browser-api/browserSearchCore');

        const result = await extractBrowserSearchDocumentText('/tmp/1024.pdf');

        expect(result.pageCount).toBe(1_024);
        expect(result.pageTexts).toHaveLength(1_024);
        expect(result.pageTexts[1_023]).toBe('alpha');
    });

    it('requires the page stream immediately above the legacy array boundary', async () => {
        mocks.getDocument.mockReturnValue({
            destroy: mocks.destroyLoadingTask,
            promise: Promise.resolve({
                destroy: mocks.destroyDocument,
                getPage: mocks.getPage,
                numPages: 1_025,
            }),
        });

        const { extractBrowserSearchDocumentText } =
            await import('@app/platform/browser-api/browserSearchCore');

        await expect(extractBrowserSearchDocumentText('/tmp/1025.pdf'))
            .rejects.toThrow('ERR_BROWSER_SEARCH_STREAM_REQUIRED');
        expect(mocks.getPage).not.toHaveBeenCalled();
        expect(mocks.destroyDocument).toHaveBeenCalledOnce();
    });

    it('rejects legacy array extraction before allocating a million-page result', async () => {
        const arrayFrom = vi.spyOn(Array, 'from');
        mocks.getDocument.mockReturnValue({
            destroy: mocks.destroyLoadingTask,
            promise: Promise.resolve({
                destroy: mocks.destroyDocument,
                getPage: mocks.getPage,
                numPages: 1_000_000,
            }),
        });

        const { extractBrowserSearchDocumentText } =
            await import('@app/platform/browser-api/browserSearchCore');

        await expect(extractBrowserSearchDocumentText('/tmp/million.pdf'))
            .rejects.toThrow('ERR_BROWSER_SEARCH_STREAM_REQUIRED');

        expect(mocks.getPage).not.toHaveBeenCalled();
        expect(mocks.destroyDocument).toHaveBeenCalledOnce();
        expect(arrayFrom.mock.calls.some(([value]) => (
            typeof value === 'object'
            && value !== null
            && 'length' in value
            && Number((value as {length?: unknown}).length) >= 1_000_000
        ))).toBe(false);
        arrayFrom.mockRestore();
    });

    it('streams a million-page document with one-page backpressure', async () => {
        const arrayFrom = vi.spyOn(Array, 'from');
        mocks.getDocument.mockReturnValue({
            destroy: mocks.destroyLoadingTask,
            promise: Promise.resolve({
                destroy: mocks.destroyDocument,
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
                destroy: mocks.destroyDocument,
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
