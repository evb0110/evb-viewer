import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    createPdfjsDocumentInitFromBrowserDocument: vi.fn(),
    extractBrowserSearchPageText: vi.fn(),
    getDocument: vi.fn(),
    yieldToBrowser: vi.fn(),
}));

vi.mock('pdfjs-dist', () => ({getDocument: mocks.getDocument}));
vi.mock('@app/platform/browser-api/browserPdfjsDocumentInit', () => ({createPdfjsDocumentInitFromBrowserDocument: mocks.createPdfjsDocumentInitFromBrowserDocument}));
vi.mock('@app/platform/browser-api/extractBrowserSearchPageText', () => ({extractBrowserSearchPageText: mocks.extractBrowserSearchPageText}));
vi.mock('@app/platform/browser-api/browserYield', () => ({yieldToBrowser: mocks.yieldToBrowser}));

describe('browserSearch worker extraction', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        mocks.createPdfjsDocumentInitFromBrowserDocument.mockReset();
        mocks.createPdfjsDocumentInitFromBrowserDocument.mockResolvedValue({url: '/tmp/search.pdf'});
        mocks.extractBrowserSearchPageText.mockReset();
        mocks.extractBrowserSearchPageText.mockResolvedValue('alpha');
        mocks.getDocument.mockReset();
        mocks.yieldToBrowser.mockReset();
        mocks.yieldToBrowser.mockResolvedValue(undefined);
    });

    it('streams million-page text one acknowledged page at a time', async () => {
        const messageHandlers: Array<(event: MessageEvent<unknown>) => Promise<void>> = [];
        const postMessage = vi.fn();
        const getPage = vi.fn(async () => ({}));
        const destroy = vi.fn(async () => {});
        mocks.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1_000_000,
                getPage,
                destroy,
            }),
            destroy: vi.fn(async () => {}),
        });
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type: string, handler: (event: MessageEvent<unknown>) => Promise<void>) => {
                if (type === 'message') {
                    messageHandlers.push(handler);
                }
            }),
            postMessage,
        });
        const arrayFrom = vi.spyOn(Array, 'from');

        await import('@app/platform/browser-api/browserSearch.worker');
        const handler = messageHandlers[0];
        if (!handler) {
            throw new Error('Expected a browser search worker message handler');
        }
        const extraction = handler({data: {
            id: 1,
            type: 'streamDocumentText',
            payload: {pdfPath: '/tmp/million.pdf'},
        }} as MessageEvent<unknown>);

        await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            id: 1,
            type: 'streamDocumentText',
            page: expect.objectContaining({
                pageNumber: 1,
                pageCount: 1_000_000,
            }),
        })));
        expect(getPage).toHaveBeenCalledTimes(1);

        await handler({data: {
            id: 2,
            type: 'acknowledgePage',
            payload: {requestId: 1},
        }} as MessageEvent<unknown>);
        await vi.waitFor(() => expect(getPage).toHaveBeenCalledTimes(2));
        expect(postMessage).toHaveBeenCalledTimes(2);

        await handler({data: {
            id: 3,
            type: 'cancel',
            payload: {requestId: 1},
        }} as MessageEvent<unknown>);
        await extraction;

        expect(destroy).toHaveBeenCalledOnce();
        expect(arrayFrom.mock.calls.some(([value]) => (
            typeof value === 'object'
            && value !== null
            && 'length' in value
            && Number((value as {length?: unknown}).length) >= 1_000_000
        ))).toBe(false);
        arrayFrom.mockRestore();
    });

    it('keeps the legacy worker array API at 1,024 pages', async () => {
        const messageHandlers: Array<(event: MessageEvent<unknown>) => Promise<void>> = [];
        const postMessage = vi.fn();
        const getPage = vi.fn(async () => ({}));
        const destroy = vi.fn(async () => {});
        mocks.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1_024,
                getPage,
                destroy,
            }),
            destroy: vi.fn(async () => {}),
        });
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type: string, handler: (event: MessageEvent<unknown>) => Promise<void>) => {
                if (type === 'message') {
                    messageHandlers.push(handler);
                }
            }),
            postMessage,
        });

        await import('@app/platform/browser-api/browserSearch.worker');
        const handler = messageHandlers[0];
        if (!handler) {
            throw new Error('Expected a browser search worker message handler');
        }

        await handler({data: {
            id: 5,
            type: 'extractDocumentText',
            payload: {pdfPath: '/tmp/1024.pdf'},
        }} as MessageEvent<unknown>);

        expect(getPage).toHaveBeenCalledTimes(1_024);
        expect(postMessage).toHaveBeenLastCalledWith({
            id: 5,
            type: 'extractDocumentText',
            ok: true,
            data: {
                pageCount: 1_024,
                pageTexts: expect.any(Array),
            },
        });
        const response = postMessage.mock.calls[postMessage.mock.calls.length - 1]?.[0] as {data?: {pageTexts?: string[]}};
        expect(response.data?.pageTexts).toHaveLength(1_024);
        expect(response.data?.pageTexts?.[1_023]).toBe('alpha');
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('requires the worker page stream at 1,025 pages', async () => {
        const messageHandlers: Array<(event: MessageEvent<unknown>) => Promise<void>> = [];
        const postMessage = vi.fn();
        const getPage = vi.fn(async () => ({}));
        const destroy = vi.fn(async () => {});
        mocks.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1_025,
                getPage,
                destroy,
            }),
            destroy: vi.fn(async () => {}),
        });
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type: string, handler: (event: MessageEvent<unknown>) => Promise<void>) => {
                if (type === 'message') {
                    messageHandlers.push(handler);
                }
            }),
            postMessage,
        });

        await import('@app/platform/browser-api/browserSearch.worker');
        const handler = messageHandlers[0];
        if (!handler) {
            throw new Error('Expected a browser search worker message handler');
        }

        await handler({data: {
            id: 6,
            type: 'extractDocumentText',
            payload: {pdfPath: '/tmp/1025.pdf'},
        }} as MessageEvent<unknown>);

        expect(getPage).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledOnce();
        expect(postMessage).toHaveBeenCalledWith({
            id: 6,
            ok: false,
            error: 'ERR_BROWSER_SEARCH_STREAM_REQUIRED',
        });
    });

    it('rejects a million-page legacy array request before allocating page texts', async () => {
        const messageHandlers: Array<(event: MessageEvent<unknown>) => Promise<void>> = [];
        const postMessage = vi.fn();
        const getPage = vi.fn(async () => ({}));
        const destroy = vi.fn(async () => {});
        mocks.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1_000_000,
                getPage,
                destroy,
            }),
            destroy: vi.fn(async () => {}),
        });
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type: string, handler: (event: MessageEvent<unknown>) => Promise<void>) => {
                if (type === 'message') {
                    messageHandlers.push(handler);
                }
            }),
            postMessage,
        });

        await import('@app/platform/browser-api/browserSearch.worker');
        const handler = messageHandlers[0];
        if (!handler) {
            throw new Error('Expected a browser search worker message handler');
        }

        await handler({data: {
            id: 4,
            type: 'extractDocumentText',
            payload: {pdfPath: '/tmp/million.pdf'},
        }} as MessageEvent<unknown>);

        expect(getPage).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledOnce();
        expect(postMessage).toHaveBeenCalledWith({
            id: 4,
            ok: false,
            error: 'ERR_BROWSER_SEARCH_STREAM_REQUIRED',
        });
    });

    it('matches page text in the worker with bounded range output', async () => {
        const messageHandlers: Array<(event: MessageEvent<unknown>) => Promise<void>> = [];
        const postMessage = vi.fn();
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type: string, handler: (event: MessageEvent<unknown>) => Promise<void>) => {
                if (type === 'message') {
                    messageHandlers.push(handler);
                }
            }),
            postMessage,
        });

        await import('@app/platform/browser-api/browserSearch.worker');
        const handler = messageHandlers[0];
        if (!handler) {
            throw new Error('Expected a browser search worker message handler');
        }

        await handler({data: {
            id: 7,
            type: 'matchPageText',
            payload: {
                text: 'a a a',
                query: 'a',
                options: {
                    matchCase: true,
                    wholeWord: false,
                    useRegex: false,
                },
                maxMatches: 2,
            },
        }} as MessageEvent<unknown>);

        expect(postMessage).toHaveBeenLastCalledWith({
            id: 7,
            type: 'matchPageText',
            ok: true,
            data: {
                matches: [
                    {
                        startOffset: 0,
                        endOffset: 1,
                    },
                    {
                        startOffset: 2,
                        endOffset: 3,
                    },
                ],
                truncated: true,
            },
        });
    });

    it('keeps safe regex matching and UTF-16 offsets inside the worker', async () => {
        const messageHandlers: Array<(event: MessageEvent<unknown>) => Promise<void>> = [];
        const postMessage = vi.fn();
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type: string, handler: (event: MessageEvent<unknown>) => Promise<void>) => {
                if (type === 'message') {
                    messageHandlers.push(handler);
                }
            }),
            postMessage,
        });

        await import('@app/platform/browser-api/browserSearch.worker');
        const handler = messageHandlers[0];
        if (!handler) {
            throw new Error('Expected a browser search worker message handler');
        }

        await handler({data: {
            id: 8,
            type: 'matchPageText',
            payload: {
                text: '😀 needle 😃needle',
                query: 'n.edle',
                options: {
                    matchCase: true,
                    wholeWord: false,
                    useRegex: true,
                },
                maxMatches: 2,
            },
        }} as MessageEvent<unknown>);

        expect(postMessage).toHaveBeenLastCalledWith({
            id: 8,
            type: 'matchPageText',
            ok: true,
            data: {
                matches: [
                    {
                        startOffset: 3,
                        endOffset: 9,
                    },
                    {
                        startOffset: 12,
                        endOffset: 18,
                    },
                ],
                truncated: false,
            },
        });
    });

    it('returns a typed protocol code for an unsafe regex before matching', async () => {
        const messageHandlers: Array<(event: MessageEvent<unknown>) => Promise<void>> = [];
        const postMessage = vi.fn();
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type: string, handler: (event: MessageEvent<unknown>) => Promise<void>) => {
                if (type === 'message') {
                    messageHandlers.push(handler);
                }
            }),
            postMessage,
        });

        await import('@app/platform/browser-api/browserSearch.worker');
        const handler = messageHandlers[0];
        if (!handler) {
            throw new Error('Expected a browser search worker message handler');
        }

        await handler({data: {
            id: 9,
            type: 'matchPageText',
            payload: {
                text: 'a'.repeat(80_000),
                query: '(a|aa)+b',
                options: {
                    matchCase: true,
                    wholeWord: false,
                    useRegex: true,
                },
                maxMatches: 2,
            },
        }} as MessageEvent<unknown>);

        expect(postMessage).toHaveBeenLastCalledWith({
            id: 9,
            ok: false,
            error: 'Invalid search regex: pattern is too complex for document search',
            errorCode: 'SEARCH_REGEX_LIMIT',
        });
    });
});
