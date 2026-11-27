import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import searchConformanceCorpus from '@contracts/searchConformanceCorpus.json';
import {encodePdfSearchPagesPayload} from '@contracts/searchIndexWire';
import {afterEach, describe, expect, it, vi} from 'vitest';

const wasmBytes = new Uint8Array(readFileSync(resolve(process.cwd(), 'public/wasm/evb-pdf-search.wasm')));

async function loadWorker() {
    const messageHandlers: Array<(event: MessageEvent<unknown>) => Promise<void> | void> = [];
    const postMessage = vi.fn();
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if (!url.includes('/wasm/evb-pdf-search.wasm')) {
                return new Response('Not found', {status: 404});
            }
            return new Response(wasmBytes.slice(), {
                status: 200,
                headers: {'Content-Type': 'application/wasm'},
            });
        }),
    );
    vi.stubGlobal('location', {
        origin: 'http://localhost',
        href: 'http://localhost/',
    });
    vi.stubGlobal('self', {
        location: {
            origin: 'http://localhost',
            href: 'http://localhost/',
        },
        addEventListener: vi.fn((type: string, handler: (event: MessageEvent<unknown>) => Promise<void> | void) => {
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
    const dispatch = async (data: unknown) => {
        await handler({data} as MessageEvent<unknown>);
        return postMessage.mock.lastCall?.[0];
    };
    return {
        dispatch,
        handler,
        postMessage,
    };
}

describe('browserSearch worker (evb-pdf-search.wasm)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    // Page text comes from the renderer's PDF.js document; the worker never
    // opens one, so a document request is not part of its protocol.
    it('refuses a document text request instead of opening a PDF', async () => {
        const {dispatch, postMessage} = await loadWorker();

        await dispatch({
            id: 3,
            type: 'streamDocumentText',
            payload: {pdfPath: 'browser://documents/a/search.pdf'},
        });

        expect(postMessage).toHaveBeenCalledExactlyOnceWith({
            id: 3,
            ok: false,
            error: 'Invalid browser search worker request',
        });
    });

    it('matches page text in the WASM worker with bounded range output', async () => {
        const {dispatch} = await loadWorker();

        const response = await dispatch({
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
        });

        expect(response).toEqual({
            id: 7,
            type: 'matchPageText',
            ok: true,
            data: {
                matches: [
                    {
                        pageMatchIndex: 0,
                        startOffset: 0,
                        endOffset: 1,
                    },
                    {
                        pageMatchIndex: 1,
                        startOffset: 2,
                        endOffset: 3,
                    },
                ],
                truncated: true,
                matchCount: 3,
                matchingMs: expect.any(Number),
            },
        });
    });

    it.each(searchConformanceCorpus.cases)('keeps corpus case $id and UTF-16 offsets inside the WASM worker', async (fixture) => {
        const {dispatch} = await loadWorker();
        const response = await dispatch({
            id: 8,
            type: 'matchPageText',
            payload: {
                text: fixture.text,
                query: fixture.query,
                options: {
                    matchCase: Reflect.get(fixture.options, 'matchCase') === true,
                    wholeWord: Reflect.get(fixture.options, 'wholeWord') === true,
                    useRegex: Reflect.get(fixture.options, 'useRegex') === true,
                },
                maxMatches: 500,
            },
        });
        expect(response).toEqual({
            id: 8,
            type: 'matchPageText',
            ok: true,
            data: {
                matches: fixture.expectedMatches.map(({startOffset, endOffset}, pageMatchIndex) => ({
                    pageMatchIndex,
                    startOffset,
                    endOffset,
                })),
                truncated: false,
                matchCount: fixture.expectedMatches.length,
                matchingMs: expect.any(Number),
            },
        });
    });

    it.each([false, true])('returns bounded continuation and tail ordinals for regex=%s', async (useRegex) => {
        const {dispatch} = await loadWorker();
        for (const [resultOffset, first, count, truncated] of [
            [500, 500, 60, false],
            ['last', 60, 500, false],
        ] as const) {
            const response = await dispatch({
                id: 10,
                type: 'matchPageText',
                payload: {
                    text: 'valve '.repeat(560),
                    query: 'valve',
                    options: {
                        matchCase: false,
                        wholeWord: false,
                        useRegex,
                    },
                    maxMatches: 500,
                    resultOffset,
                },
            });
            expect(response.ok).toBe(true);
            expect(response.data.matches).toHaveLength(count);
            expect(response.data.matches[0]).toEqual({
                startOffset: first * 6,
                endOffset: first * 6 + 5,
                pageMatchIndex: first,
            });
            expect(response.data.matches.at(-1).pageMatchIndex).toBe(559);
            expect(response.data.matchCount).toBe(560);
            expect(response.data.truncated).toBe(truncated);
        }
    });

    it('builds and searches an EVBSIDX4 index inside the WASM worker and rejects stale revisions', async () => {
        const {dispatch} = await loadWorker();
        const pagesBuffer = encodePdfSearchPagesPayload([
            {
                pageNumber: 1,
                text: 'Café résumé naïve',
            },
            {
                pageNumber: 2,
                text: 'Second page with needle and NEEDLE',
            },
        ]);
        const indexed = await dispatch({
            id: 20,
            type: 'index',
            payload: {
                documentRevision: 'rev-1',
                pageCount: 2,
                pagesBuffer,
            },
        });
        expect(indexed.ok).toBe(true);
        expect(indexed.data.coverage).toEqual({
            pageCount: 2,
            pagesScanned: 2,
            pagesWritten: 2,
            truncated: false,
            missingTextPageSample: [],
        });
        expect(new TextDecoder().decode(indexed.data.indexBytes.subarray(0, 8))).toBe('EVBSIDX4');

        // NFD decomposed query matches NFC precomposed page text via unified Unicode normalization.
        const unicodeNormalizedHit = await dispatch({
            id: 21,
            type: 'search',
            payload: {
                indexBytes: indexed.data.indexBytes,
                documentRevision: 'rev-1',
                query: 'cafe\u0301 re\u0301sume\u0301',
                options: {
                    matchCase: false,
                    wholeWord: true,
                    useRegex: false,
                },
                limit: 50,
                contextChars: 12,
                resultOffset: 0,
            },
        });
        expect(unicodeNormalizedHit.ok).toBe(true);
        expect(unicodeNormalizedHit.data.results).toEqual([
            expect.objectContaining({
                pageNumber: 1,
                startOffset: 0,
                endOffset: 11,
                excerpt: expect.objectContaining({match: 'Café résumé'}),
            }),
        ]);

        const stale = await dispatch({
            id: 22,
            type: 'search',
            payload: {
                indexBytes: indexed.data.indexBytes,
                documentRevision: 'rev-2',
                query: 'needle',
                options: {
                    matchCase: false,
                    wholeWord: false,
                    useRegex: false,
                },
                limit: 50,
                contextChars: 12,
                resultOffset: 0,
            },
        });
        expect(stale).toEqual({
            id: 22,
            type: 'search',
            ok: true,
            data: {stale: true},
        });
    });

    it('keeps the regex budget through empty pages before searchable PDF text', async () => {
        const {dispatch} = await loadWorker();
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        let remainingMs = 250;
        for (const [id, text] of ['', '', 'Z'].entries()) {
            const response = await dispatch({
                id,
                type: 'matchPageText',
                payload: {
                    text,
                    query: '^Z',
                    options: {
                        matchCase: true,
                        wholeWord: false,
                        useRegex: true,
                    },
                    maxMatches: 2,
                    budgetMs: remainingMs,
                },
            });
            expect(response.ok).toBe(true);
            expect(response.data.matchingMs).toBe(0);
            remainingMs -= response.data.matchingMs;
            expect(response.data.matches).toHaveLength(text ? 1 : 0);
        }
        expect(remainingMs).toBe(250);
    });

    it('returns a typed protocol code for an unsafe regex before matching', async () => {
        const {dispatch} = await loadWorker();

        const response = await dispatch({
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
        });

        expect(response).toEqual({
            id: 9,
            ok: false,
            error: 'Invalid search regex: pattern is too complex for document search',
            errorCode: 'SEARCH_REGEX_LIMIT',
        });
    });
});
