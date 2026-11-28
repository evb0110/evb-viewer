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

    it('caches EVBSIDX4 indexes per document inside the worker, serves cache-only searches, and evicts on control or new revision', async () => {
        const {dispatch} = await loadWorker();
        const pagesV1 = encodePdfSearchPagesPayload([{pageNumber: 1, text: 'alpha v1'}]);
        const indexedV1 = await dispatch({
            id: 30,
            type: 'index',
            payload: {
                documentKey: 'browser://doc/1',
                documentRevision: 'rev-1',
                pageCount: 1,
                pagesBuffer: pagesV1,
            },
        });
        expect(indexedV1.ok).toBe(true);

        // Cache-only search without sending indexBytes hits the worker cache.
        const hitV1 = await dispatch({
            id: 31,
            type: 'search',
            payload: {
                documentKey: 'browser://doc/1',
                documentRevision: 'rev-1',
                query: 'alpha',
                options: {matchCase: false, wholeWord: false, useRegex: false},
                limit: 20,
                contextChars: 10,
            },
        });
        expect(hitV1.ok).toBe(true);
        expect(hitV1.data.results).toHaveLength(1);

        // Indexing a new revision immediately evicts rev-1 and caches rev-2.
        const pagesV2 = encodePdfSearchPagesPayload([{pageNumber: 1, text: 'beta v2'}]);
        await dispatch({
            id: 32,
            type: 'index',
            payload: {
                documentKey: 'browser://doc/1',
                documentRevision: 'rev-2',
                pageCount: 1,
                pagesBuffer: pagesV2,
            },
        });
        const missOldRev = await dispatch({
            id: 33,
            type: 'search',
            payload: {
                documentKey: 'browser://doc/1',
                documentRevision: 'rev-1',
                query: 'alpha',
                options: {matchCase: false, wholeWord: false, useRegex: false},
                limit: 20,
                contextChars: 10,
            },
        });
        expect(missOldRev.data).toEqual({cacheMiss: true});

        // Explicit eviction control message clears the cached index.
        await dispatch({
            type: 'evictCache',
            documentKey: 'browser://doc/1',
        });
        const missAfterEvict = await dispatch({
            id: 34,
            type: 'search',
            payload: {
                documentKey: 'browser://doc/1',
                documentRevision: 'rev-2',
                query: 'beta',
                options: {matchCase: false, wholeWord: false, useRegex: false},
                limit: 20,
                contextChars: 10,
            },
        });
        expect(missAfterEvict.data).toEqual({cacheMiss: true});
    });

    it('does not refill the worker index cache when evictCache arrives while a hydrating search is in flight', async () => {
        const {dispatch} = await loadWorker();
        const pages = encodePdfSearchPagesPayload([{pageNumber: 1, text: 'needle in worker'}]);
        const built = await dispatch({
            id: 50,
            type: 'index',
            payload: {
                documentRevision: 'rev-evict-race',
                pageCount: 1,
                pagesBuffer: pages,
            },
        });
        expect(built.ok).toBe(true);

        // Start a hydrating search, then immediately post evictCache before its async WASM completion resolves.
        const searchPromise = dispatch({
            id: 51,
            type: 'search',
            payload: {
                documentKey: 'browser://doc/race',
                indexBytes: built.data.indexBytes,
                documentRevision: 'rev-evict-race',
                query: 'needle',
                options: {matchCase: false, wholeWord: false, useRegex: false},
                limit: 20,
                contextChars: 10,
            },
        });
        const evictPromise = dispatch({
            type: 'evictCache',
            documentKey: 'browser://doc/race',
        });
        const [searchResp] = await Promise.all([searchPromise, evictPromise]);
        expect(searchResp.ok).toBe(true);
        expect(searchResp.data.results).toHaveLength(1);

        // Because eviction arrived while the search was awaiting WASM, the index must NOT have been cached.
        const followUp = await dispatch({
            id: 52,
            type: 'search',
            payload: {
                documentKey: 'browser://doc/race',
                documentRevision: 'rev-evict-race',
                query: 'needle',
                options: {matchCase: false, wholeWord: false, useRegex: false},
                limit: 20,
                contextChars: 10,
            },
        });
        expect(followUp.data).toEqual({cacheMiss: true});
    });

    it('matches a bounded page batch in strict order with continuation offset and early stop', async () => {
        const {dispatch} = await loadWorker();
        const batch = await dispatch({
            id: 40,
            type: 'matchPageBatch',
            payload: {
                pages: [
                    {pageNumber: 1, text: 'hit hit'},
                    {pageNumber: 2, text: 'empty'},
                    {pageNumber: 3, text: 'hit hit hit'},
                    {pageNumber: 4, text: 'hit'},
                ],
                query: 'hit',
                options: {matchCase: false, wholeWord: false, useRegex: false},
                maxMatches: 2,
                resultOffset: 1,
            },
        });
        expect(batch.ok).toBe(true);
        expect(batch.data.pages).toEqual([
            {
                pageNumber: 1,
                matches: [{pageMatchIndex: 1, startOffset: 4, endOffset: 7}],
                truncated: false,
                matchCount: 2,
            },
            {
                pageNumber: 2,
                matches: [],
                truncated: false,
                matchCount: 0,
            },
            {
                pageNumber: 3,
                matches: [{pageMatchIndex: 0, startOffset: 0, endOffset: 3}],
                truncated: true,
                matchCount: 2,
            },
        ]);
    });
});
