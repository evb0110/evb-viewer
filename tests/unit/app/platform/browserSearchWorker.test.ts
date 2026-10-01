import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

async function loadWorker() {
    const messageHandlers: Array<(event: MessageEvent<unknown>) => void> = [];
    const postMessage = vi.fn();
    vi.stubGlobal('self', {
        addEventListener: vi.fn((type: string, handler: (event: MessageEvent<unknown>) => void) => {
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
    return {
        handler,
        postMessage,
    };
}

describe('browserSearch worker', () => {
    afterEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    // Page text comes from the renderer's PDF.js document; the worker never
    // opens one, so a document request is not part of its protocol.
    it('refuses a document text request instead of opening a PDF', async () => {
        const {
            handler,
            postMessage,
        } = await loadWorker();

        handler({data: {
            id: 3,
            type: 'streamDocumentText',
            payload: {pdfPath: 'browser://documents/a/search.pdf'},
        }} as MessageEvent<unknown>);

        expect(postMessage).toHaveBeenCalledExactlyOnceWith({
            id: 3,
            ok: false,
            error: 'Invalid browser search worker request',
        });
    });

    it('matches page text in the worker with bounded range output', async () => {
        const {
            handler,
            postMessage,
        } = await loadWorker();

        handler({data: {
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
                matchingMs: expect.any(Number),
            },
        });
    });

    it('keeps safe regex matching and UTF-16 offsets inside the worker', async () => {
        const {
            handler,
            postMessage,
        } = await loadWorker();

        handler({data: {
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

        expect(postMessage).toHaveBeenNthCalledWith(1, {
            id: 8,
            started: true,
        });
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
                matchingMs: expect.any(Number),
            },
        });
    });

    it('returns a typed protocol code for an unsafe regex before matching', async () => {
        const {
            handler,
            postMessage,
        } = await loadWorker();

        handler({data: {
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
