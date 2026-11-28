import type {IPdfTextContent} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type * as TSearchContractsModule from '@contracts/search';
import type * as TViMockOriginalModule from '@app/platform/browser-api/browserYield';

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {buildPdfSearchExcerpt, validateSearchQuery} from '@pdf-core';
import {
    decodePdfSearchIndexWasmOutput,
    decodePdfSearchJsonOutput,
    encodePdfSearchWasmRequest,
    isStaleSearchIndexAnswer,
    SEARCH_INDEX_TEXT_BUDGET,
} from '@contracts/searchIndexWire';
import {FakeIndexedDbFactory} from '@tests/unit/app/platform/browserPlatformTestDoubles';
import {requireRequestId} from '@contracts/shared';

const pdfSearchWasmModule = new WebAssembly.Module(readFileSync(resolve(process.cwd(), 'public/wasm/evb-pdf-search.wasm')));
const testTextEncoder = new TextEncoder();
const testTextDecoder = new TextDecoder();

function createTestPdfSearchWasmExecutor() {
    const instance = new WebAssembly.Instance(pdfSearchWasmModule, {});
    const exports = instance.exports as {
        memory: WebAssembly.Memory;
        evb_pdf_search_alloc: (len: number) => number;
        evb_pdf_search_free: (ptr: number, len: number) => void;
        evb_pdf_search_run: (ptr: number, len: number) => number;
        evb_pdf_search_output_ptr: () => number;
        evb_pdf_search_output_len: () => number;
        evb_pdf_search_error_ptr: () => number;
        evb_pdf_search_error_len: () => number;
    };
    const runRaw = (request: Uint8Array): Uint8Array => {
        const ptr = exports.evb_pdf_search_alloc(request.byteLength);
        try {
            new Uint8Array(exports.memory.buffer, ptr, request.byteLength).set(request);
            const status = exports.evb_pdf_search_run(ptr, request.byteLength);
            if (status !== 0) {
                const errPtr = exports.evb_pdf_search_error_ptr();
                const errLen = exports.evb_pdf_search_error_len();
                const msg = testTextDecoder.decode(new Uint8Array(exports.memory.buffer, errPtr, errLen));
                throw new Error(msg);
            }
            const outPtr = exports.evb_pdf_search_output_ptr();
            const outLen = exports.evb_pdf_search_output_len();
            return new Uint8Array(exports.memory.buffer, outPtr, outLen).slice();
        } finally {
            exports.evb_pdf_search_free(ptr, request.byteLength);
        }
    };
    let nextRequestId = 1;
    const workerIndexCache = new Map<string, {documentRevision: string; indexBytes: Uint8Array}>();
    const evictCache = (documentKey?: string) => {
        if (documentKey === undefined) {
            workerIndexCache.clear();
        } else {
            workerIndexCache.delete(documentKey);
        }
    };
    const execute = (type: unknown, payload: unknown) => {
        const requestId = nextRequestId++;
        const promise = Promise.resolve().then(() => {
            if (type === 'index') {
                const p = payload as {
                    documentKey?: string;
                    documentRevision: string;
                    pageCount: number;
                    pagesBuffer: Uint8Array;
                    maxPageTextBytes?: number;
                    maxTotalTextBytes?: number;
                };
                if (p.documentKey !== undefined) {
                    workerIndexCache.delete(p.documentKey);
                }
                const output = runRaw(
                    encodePdfSearchWasmRequest(
                        {
                            op: 'index',
                            documentRevision: p.documentRevision,
                            pageCount: p.pageCount,
                            maxPageTextBytes: p.maxPageTextBytes ?? SEARCH_INDEX_TEXT_BUDGET.maxPageTextBytes,
                            maxTotalTextBytes: p.maxTotalTextBytes ?? SEARCH_INDEX_TEXT_BUDGET.maxTotalTextBytes,
                        },
                        p.pagesBuffer,
                    ),
                );
                const decoded = decodePdfSearchIndexWasmOutput(output);
                if (p.documentKey !== undefined) {
                    workerIndexCache.set(p.documentKey, {
                        documentRevision: p.documentRevision,
                        indexBytes: decoded.indexBytes.slice(),
                    });
                }
                return decoded;
            }
            if (type === 'search') {
                const p = payload as {
                    documentKey?: string;
                    indexBytes?: Uint8Array;
                    documentRevision: string;
                    query: string;
                    options: {
                        matchCase: boolean;
                        wholeWord: boolean;
                        useRegex: boolean;
                    };
                    limit: number;
                    contextChars: number;
                    resultOffset?: number | 'last';
                };
                validateSearchQuery(p.query, p.options);
                const cachedEntry = p.documentKey === undefined ? undefined : workerIndexCache.get(p.documentKey);
                const effectiveIndexBytes =
                    p.indexBytes ?? (cachedEntry?.documentRevision === p.documentRevision ? cachedEntry.indexBytes : undefined);
                if (effectiveIndexBytes === undefined) {
                    return {cacheMiss: true};
                }
                const output = runRaw(
                    encodePdfSearchWasmRequest(
                        {
                            op: 'search',
                            documentRevision: p.documentRevision,
                            query: p.query,
                            limit: p.limit,
                            contextChars: p.contextChars,
                            ...(p.resultOffset === undefined ? {} : {resultOffset: p.resultOffset}),
                            matchCase: p.options.matchCase,
                            wholeWord: p.options.wholeWord,
                            useRegex: p.options.useRegex,
                        },
                        effectiveIndexBytes,
                    ),
                );
                const decoded = decodePdfSearchJsonOutput(output);
                if (isStaleSearchIndexAnswer(decoded)) {
                    if (p.documentKey !== undefined) {
                        workerIndexCache.delete(p.documentKey);
                    }
                    return {stale: true};
                }
                if (p.indexBytes !== undefined && p.documentKey !== undefined) {
                    workerIndexCache.set(p.documentKey, {
                        documentRevision: p.documentRevision,
                        indexBytes: p.indexBytes,
                    });
                }
                return decoded;
            }
            if (type === 'matchPageText') {
                const p = payload as {
                    text: string;
                    query: string;
                    options: {
                        matchCase: boolean;
                        wholeWord: boolean;
                        useRegex: boolean;
                    };
                    maxMatches: number;
                    resultOffset?: number | 'last';
                };
                validateSearchQuery(p.query, p.options);
                if (p.text.length === 0) {
                    return {
                        matches: [],
                        truncated: false,
                        matchCount: 0,
                        matchingMs: 0,
                    };
                }
                const output = runRaw(
                    encodePdfSearchWasmRequest(
                        {
                            op: 'matchPage',
                            query: p.query,
                            matchCase: p.options.matchCase,
                            wholeWord: p.options.wholeWord,
                            useRegex: p.options.useRegex,
                            maxMatches: p.maxMatches,
                            ...(p.resultOffset === undefined ? {} : {resultOffset: p.resultOffset}),
                        },
                        testTextEncoder.encode(p.text),
                    ),
                );
                return {
                    ...(decodePdfSearchJsonOutput(output) as Record<string, unknown>),
                    matchingMs: 0,
                };
            }
            if (type === 'matchPageBatch') {
                const p = payload as {
                    pages: Array<{pageNumber: number; text: string}>;
                    query: string;
                    options: {
                        matchCase: boolean;
                        wholeWord: boolean;
                        useRegex: boolean;
                    };
                    maxMatches: number;
                    resultOffset?: number | 'last';
                };
                validateSearchQuery(p.query, p.options);
                const pages: Array<Record<string, unknown>> = [];
                let batchMatchedCount = 0;
                let collectedCount = 0;
                for (const page of p.pages) {
                    if (page.text.length === 0) {
                        pages.push({
                            pageNumber: page.pageNumber,
                            matches: [],
                            truncated: false,
                            matchCount: 0,
                        });
                        continue;
                    }
                    const pageOffset = p.resultOffset === 'last' ? 'last' : Math.max(0, (p.resultOffset ?? 0) - batchMatchedCount);
                    const pageMaxMatches = p.resultOffset === 'last' ? p.maxMatches : p.maxMatches - collectedCount;
                    if (p.resultOffset !== 'last' && pageMaxMatches <= 0) {
                        break;
                    }
                    const output = runRaw(
                        encodePdfSearchWasmRequest(
                            {
                                op: 'matchPage',
                                query: p.query,
                                matchCase: p.options.matchCase,
                                wholeWord: p.options.wholeWord,
                                useRegex: p.options.useRegex,
                                maxMatches: pageMaxMatches,
                                ...(pageOffset === undefined ? {} : {resultOffset: pageOffset}),
                            },
                            testTextEncoder.encode(page.text),
                        ),
                    );
                    const decoded = decodePdfSearchJsonOutput(output) as {
                        matches: unknown[];
                        truncated: boolean;
                        matchCount: number;
                    };
                    pages.push({
                        pageNumber: page.pageNumber,
                        ...decoded,
                    });
                    batchMatchedCount += decoded.matchCount;
                    collectedCount += decoded.matches.length;
                    if (p.resultOffset !== 'last' && (decoded.truncated || collectedCount >= p.maxMatches)) {
                        break;
                    }
                }
                return {
                    pages,
                    matchingMs: 0,
                };
            }
            throw new Error(`Unexpected search worker request type: ${String(type)}`);
        });
        return {
            requestId,
            promise,
        };
    };
    return {
        execute,
        evictCache,
    };
}

const defaultTestWasmWorker = createTestPdfSearchWasmExecutor();
const defaultTestWasmWorkerRequest = defaultTestWasmWorker.execute;

interface ISearchConformanceCase {
    id: string;
    text: string;
    query: string;
    options?: {
        matchCase?: boolean;
        wholeWord?: boolean;
        useRegex?: boolean;
    };
    expectedMatches: Array<{
        startOffset: number;
        endOffset: number;
    }>;
}

interface ISearchConformanceCorpus {
    cases: ISearchConformanceCase[];
}

const searchPageView = [0, 0, 612, 792];

function makeTextContent(str = ''): IPdfTextContent {
    return {
        styles: {
            f1: {
                fontFamily: 'sans-serif',
                vertical: false,
            },
        },
        lang: null,
        items: [
            {
                str,
                dir: 'ltr',
                transform: [10, 0, 0, 10, 20, 100],
                width: Math.max(1, str.length * 5),
                height: 10,
                fontName: 'f1',
                hasEOL: false,
            },
        ],
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireFakeIndexedDbFactory(): FakeIndexedDbFactory {
    const value: unknown = globalThis.indexedDB;
    if (!(value instanceof FakeIndexedDbFactory)) {
        throw new TypeError('Expected the browser search test IndexedDB factory');
    }
    return value;
}

function requirePersistedRecord(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new TypeError('Expected a persisted browser search record');
    }
    return value;
}

const searchConformanceCorpus = JSON.parse(
    readFileSync(new URL('../../../../packages/contracts/searchConformanceCorpus.json', import.meta.url), 'utf8'),
) as ISearchConformanceCorpus;

async function flushMicrotasks(turns = 12) {
    for (let step = 0; step < turns; step += 1) {
        await Promise.resolve();
    }
}

function makeBrowserRevision(documentRef: string, token: string, contentRevision = 1) {
    return {
        version: 1,
        documentRef,
        authority: 'browser-document-store',
        contentRevision,
        mintedAt: 1,
        token,
    };
}

const yieldToBrowserMock = vi.hoisted(() => vi.fn(async () => {}));
const browserDocumentStoreMock = vi.hoisted(() => ({
    stat: vi.fn(),
    getContentSignature: vi.fn(),
    getContentSnapshot: vi.fn(),
    getDocumentRevision: vi.fn(),
    read: vi.fn(),
    readRange: vi.fn(),
}));
const browserSearchWorkerClientMock = vi.hoisted(() => ({
    canUseBrowserSearchWorker: vi.fn(() => false),
    createBrowserSearchWorkerRequest: vi.fn(),
    cancelBrowserSearchWorkerRequest: vi.fn(async () => {}),
    evictBrowserSearchWorkerCache: vi.fn(),
    BrowserSearchWorkerUnavailableError: class BrowserSearchWorkerUnavailableError extends Error {},
    BrowserSearchWorkerTimeoutError: class BrowserSearchWorkerTimeoutError extends Error {},
}));
const pdfjsModule = vi.hoisted(() => ({
    version: '6.3.311',
    GlobalWorkerOptions: {workerSrc: undefined as string | undefined},
    PDFDataRangeTransport: function MockPdfDataRangeTransport() {},
    OPS: {
        beginText: 1,
        setFont: 2,
        setTextMatrix: 3,
        showText: 4,
        endText: 5,
    },
    VerbosityLevel: {ERRORS: 3},
    getDocument: vi.fn(),
}));

vi.mock('@app/platform/browser-api/browserYield', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    yieldToBrowser: () => yieldToBrowserMock(),
}));
vi.mock('@app/platform/browser-api/browserSearchWorkerClient', () => ({
    BROWSER_SEARCH_REGEX_WORKER_TIMEOUT_MS: 1_250,
    canUseBrowserSearchWorker: () => browserSearchWorkerClientMock.canUseBrowserSearchWorker(),
    createBrowserSearchWorkerRequest: (type: unknown, payload: unknown, options: unknown) =>
        (
            browserSearchWorkerClientMock.createBrowserSearchWorkerRequest as (
                nextType: unknown,
                nextPayload: unknown,
                nextOptions: unknown,
            ) => unknown
        )(type, payload, options),
    cancelBrowserSearchWorkerRequest: (requestId: unknown) =>
        (browserSearchWorkerClientMock.cancelBrowserSearchWorkerRequest as (nextRequestId: unknown) => unknown)(requestId),
    evictBrowserSearchWorkerCache: (documentKey?: string) =>
        (browserSearchWorkerClientMock.evictBrowserSearchWorkerCache as (nextDocumentKey?: string) => void)(documentKey),
    BrowserSearchWorkerUnavailableError: browserSearchWorkerClientMock.BrowserSearchWorkerUnavailableError,
    BrowserSearchWorkerTimeoutError: browserSearchWorkerClientMock.BrowserSearchWorkerTimeoutError,
}));
vi.mock('@app/platform/browserDocumentStore', () => ({
    BROWSER_DOCUMENT_CHUNK_SIZE: 4 * 1024 * 1024,
    browserDocumentStore: browserDocumentStoreMock,
}));
vi.mock('pdfjs-dist', () => pdfjsModule);

describe('createBrowserSearchCapability', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doUnmock('@contracts/search');
        vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
        yieldToBrowserMock.mockClear();
        browserDocumentStoreMock.stat.mockReset();
        browserDocumentStoreMock.getContentSignature.mockReset();
        browserDocumentStoreMock.getContentSignature.mockResolvedValue('content-token-1');
        browserDocumentStoreMock.getContentSnapshot.mockReset();
        browserDocumentStoreMock.getContentSnapshot.mockImplementation(async (path: string) => ({
            ...(await browserDocumentStoreMock.stat(path)),
            contentSignature: await browserDocumentStoreMock.getContentSignature(path),
        }));
        browserDocumentStoreMock.getDocumentRevision.mockReset();
        browserDocumentStoreMock.getDocumentRevision.mockImplementation(async (documentRef: string) =>
            makeBrowserRevision(documentRef, 'drt1:browser:content-token-1'),
        );
        browserDocumentStoreMock.read.mockReset();
        browserDocumentStoreMock.readRange.mockReset();
        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReset();
        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReturnValue(true);
        browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mockReset();
        browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mockImplementation((type: unknown, payload: unknown) =>
            defaultTestWasmWorkerRequest(type, payload),
        );
        browserSearchWorkerClientMock.cancelBrowserSearchWorkerRequest.mockReset();
        browserSearchWorkerClientMock.cancelBrowserSearchWorkerRequest.mockResolvedValue(undefined);
        browserSearchWorkerClientMock.evictBrowserSearchWorkerCache.mockReset();
        browserSearchWorkerClientMock.evictBrowserSearchWorkerCache.mockImplementation((documentKey?: string) =>
            defaultTestWasmWorker.evictCache(documentKey),
        );
        defaultTestWasmWorker.evictCache();
        pdfjsModule.getDocument.mockReset();
    });

    it('returns an observable cache-clear rejection and allows the caller to retry', async () => {
        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {clearSearchCaches} = createBrowserSearchCapability();
        await clearSearchCaches();
        const database = requireFakeIndexedDbFactory().getDatabase('evb-browser-search-cache-v2');
        database?.rejectNextTransaction(new Error('clear transaction failed'));

        await expect(clearSearchCaches()).rejects.toThrow('clear transaction failed');
        await expect(clearSearchCaches()).resolves.toBeUndefined();
    });

    it.each([24, 25, 1_000])('matches complete cached text for a %i-page PDF without requiring geometry', async (pageCount) => {
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: pageCount,
                getPage: async (pageNumber: number) => ({
                    view: searchPageView,
                    getTextContent: async () => makeTextContent(pageNumber === 12 ? '' : `page ${pageNumber} foo`),
                }),
                loadingTask: {destroy: async () => {}},
            }),
        });
        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        await expect(capability.run('/tmp/cached.pdf', 'absent-first')).resolves.toEqual({
            results: [],
            truncated: false,
        });
        // Complete text is sufficient to answer a no-hit query even when
        // page geometry cannot be read. Both live and persisted reuse must
        // return the public result without reopening the PDF source.
        pdfjsModule.getDocument.mockImplementation(() => {
            throw new Error('PDF source unavailable');
        });
        await expect(capability.run('/tmp/cached.pdf', 'absent-repeat')).resolves.toEqual({
            results: [],
            truncated: false,
        });
        await vi.waitFor(() => {
            expect(
                requireFakeIndexedDbFactory()
                    .getDatabase('evb-browser-search-cache-v2')
                    ?.getStoreRecords('document-text')
                    .has('/tmp/cached.pdf'),
            ).toBe(true);
        });
        await expect(createBrowserSearchCapability().capability.run('/tmp/cached.pdf', 'absent-persisted')).resolves.toEqual({
            results: [],
            truncated: false,
        });
    });

    it.each([
        ['cannot open', 'open'],
        ['rejects its read transaction', 'transaction'],
    ])('searches a readable PDF when the optional search cache %s', async (_label, failure) => {
        const pdfPath = 'browser://documents/test/cache-failure.pdf';
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage: async () => ({
                    view: searchPageView,
                    getTextContent: async () => makeTextContent('readable needle'),
                    cleanup: async () => {},
                }),
                loadingTask: {destroy: async () => {}},
            }),
        });
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        const indexedDbFactory = requireFakeIndexedDbFactory();
        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        if (failure === 'open') {
            const open = indexedDbFactory.open.bind(indexedDbFactory);
            vi.spyOn(indexedDbFactory, 'open').mockImplementation((name, version) => {
                if (name === 'evb-browser-search-cache-v2') {
                    throw new DOMException('Search cache storage is unavailable', 'InvalidStateError');
                }
                return open(name, version);
            });
        } else {
            await createBrowserSearchCapability().clearSearchCaches();
            indexedDbFactory
                .getDatabase('evb-browser-search-cache-v2')
                ?.rejectNextTransaction(new Error('search cache transaction failed'));
        }

        const {capability} = createBrowserSearchCapability();
        const result = await capability.run(pdfPath, 'needle');

        expect(result.results).toEqual([expect.objectContaining({pageNumber: 1})]);
    });

    it('extracts browser search text from the current PDF bytes without OCR sidecars', async () => {
        const pdfPath = 'browser://documents/test/search.pdf';
        const getPage = vi.fn(async () => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent('pdf fallback needle')),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        const result = await capability.run(pdfPath, 'fallback');

        expect(result.results).toEqual([expect.objectContaining({pageNumber: 1})]);
        expect(pdfjsModule.getDocument).toHaveBeenCalledOnce();
        expect(getPage).toHaveBeenCalledOnce();
    });

    it('executes regex page matching in the browser search worker and keeps UTF-16 offsets', async () => {
        const pageText = '😀 needle';
        const getPage = vi.fn(async () => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent(pageText)),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReturnValue(true);
        browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mockImplementation((type, payload) =>
            type === 'matchPageText'
                ? {
                      requestId: 41,
                      promise: Promise.resolve({
                          matches: [
                              {
                                  pageMatchIndex: 0,
                                  startOffset: 3,
                                  endOffset: 9,
                              },
                          ],
                          truncated: false,
                          matchCount: 1,
                          matchingMs: 1,
                      }),
                  }
                : defaultTestWasmWorkerRequest(type, payload),
        );

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        const result = await capability.run('/tmp/regex.pdf', 'n.edle', {
            matchCase: true,
            useRegex: true,
            requestId: requireRequestId('regex-worker'),
        });

        expect(result.results).toEqual([
            expect.objectContaining({
                startOffset: 3,
                endOffset: 9,
                excerpt: expect.objectContaining({match: 'needle'}),
            }),
        ]);
        expect(browserSearchWorkerClientMock.createBrowserSearchWorkerRequest).toHaveBeenCalledWith(
            'matchPageText',
            {
                text: pageText,
                query: 'n.edle',
                options: {
                    matchCase: true,
                    wholeWord: false,
                    useRegex: true,
                },
                maxMatches: 501,
                resultOffset: 0,
                budgetMs: 250,
            },
            {matchTimeoutMs: 1_250},
        );
    });

    it('gives every page its own regex budget, as the shared search core does', async () => {
        const getPage = vi.fn(async () => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent('aaaaaaaa')),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 3,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReturnValue(true);
        // Each page spends most of a page budget; together they exceed it.
        const reportedMatchingMs = [200, 200, 200];
        browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mockImplementation((type, payload) =>
            type === 'matchPageText'
                ? {
                      requestId: 41,
                      promise: Promise.resolve({
                          matches: [],
                          truncated: false,
                          matchCount: 0,
                          matchingMs: reportedMatchingMs.shift() ?? 0,
                      }),
                  }
                : defaultTestWasmWorkerRequest(type, payload),
        );

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();

        await expect(
            capability.run('/tmp/regex-budget.pdf', 'a+b', {
                matchCase: true,
                useRegex: true,
                requestId: requireRequestId('regex-budget'),
            }),
        ).resolves.toMatchObject({results: []});
        expect(
            browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mock.calls
                .filter((call) => call[0] === 'matchPageText')
                .map((call) => (call[1] as {budgetMs: number}).budgetMs),
        ).toEqual([250, 250, 250]);
    });

    it('turns a stalled regex worker into a typed bounded failure', async () => {
        const getPage = vi.fn(async () => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent('aaaaaaaa')),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 2,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReturnValue(true);
        const timeoutError = new browserSearchWorkerClientMock.BrowserSearchWorkerTimeoutError(
            'Browser search worker request timed out after 1250ms',
        );
        const stalledWorkerPromise = Promise.resolve().then(() => {
            throw timeoutError;
        });
        void stalledWorkerPromise.catch(() => undefined);
        let matchRequestCount = 0;
        browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mockImplementation(() => {
            matchRequestCount += 1;
            return matchRequestCount === 1
                ? {
                      requestId: 41,
                      promise: Promise.resolve({
                          matches: [
                              {
                                  pageMatchIndex: 0,
                                  startOffset: 0,
                                  endOffset: 4,
                              },
                          ],
                          truncated: false,
                          matchCount: 1,
                          matchingMs: 1,
                      }),
                  }
                : {
                      requestId: 42,
                      promise: stalledWorkerPromise,
                  };
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        const progress: unknown[] = [];
        const stopProgress = capability.onProgress((value) => progress.push(value));

        await expect(
            capability.run('/tmp/regex-timeout.pdf', 'a+b', {
                matchCase: true,
                useRegex: true,
                requestId: requireRequestId('regex-timeout'),
            }),
        ).rejects.toMatchObject({
            name: 'SearchRegexLimitError',
            code: 'SEARCH_REGEX_LIMIT',
        });
        stopProgress();
        expect(progress).toEqual(expect.arrayContaining([expect.objectContaining({processed: 1})]));
        expect(progress.every((value) => typeof value === 'object' && value !== null && !('results' in value))).toBe(true);
    });

    it('does not run regex matching on the renderer when the worker is unavailable', async () => {
        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReturnValue(false);

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();

        await expect(capability.run('/tmp/regex-unavailable.pdf', 'a+', {useRegex: true})).rejects.toThrow(
            'Browser search worker is required for regular expression search',
        );
        expect(browserDocumentStoreMock.stat).not.toHaveBeenCalled();
        expect(browserSearchWorkerClientMock.createBrowserSearchWorkerRequest).not.toHaveBeenCalled();
    });

    it('resets the search worker when a canceled search has a regex match pending', async () => {
        const getPage = vi.fn(async () => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent('aaaaaaaa')),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReturnValue(true);
        let failWorkerRequest!: (error: Error) => void;
        browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mockReturnValue({
            requestId: 41,
            promise: new Promise((_resolve, reject) => {
                failWorkerRequest = reject;
            }),
        });
        browserSearchWorkerClientMock.cancelBrowserSearchWorkerRequest.mockImplementation(async () => {
            failWorkerRequest(new Error('ERR_BROWSER_SEARCH_CANCELED'));
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        const requestId = requireRequestId('regex-cancel');
        const search = capability.run('/tmp/regex-cancel.pdf', 'a+b', {
            matchCase: true,
            useRegex: true,
            requestId,
        });
        await vi.waitFor(() => expect(browserSearchWorkerClientMock.createBrowserSearchWorkerRequest).toHaveBeenCalled());

        await capability.cancel(requestId);

        await expect(search).resolves.toEqual({
            results: [],
            truncated: false,
        });
        expect(browserSearchWorkerClientMock.cancelBrowserSearchWorkerRequest).toHaveBeenCalledWith(41);
    });

    // Every literal and regex conformance corpus case runs through evb-pdf-search.wasm
    // across cold streaming, in-memory cached EVBSIDX4 search, and IndexedDB-hydrated search.
    it.each(searchConformanceCorpus.cases)('matches the shared conformance corpus case $id in the browser capability', async (fixture) => {
        const pdfPath = `browser://documents/test/${fixture.id}.pdf`;
        const getPage = vi.fn(async () => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent(fixture.text)),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockImplementation(
            async (_path: string, _offset: number, length: number) => new Uint8Array(length),
        );
        browserDocumentStoreMock.getContentSignature.mockResolvedValue(`content-token-${fixture.id}`);

        const {SEARCH_EXCERPT_CONTEXT_CHARS} = await import('@contracts/search');
        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        const result = await capability.run(pdfPath, fixture.query, fixture.options);

        await expect(capability.run(pdfPath, fixture.query, fixture.options)).resolves.toEqual(result);
        await expect(createBrowserSearchCapability().capability.run(pdfPath, fixture.query, fixture.options)).resolves.toEqual(result);
        expect(
            result.results.map((match) => ({
                startOffset: match.startOffset,
                endOffset: match.endOffset,
                excerpt: match.excerpt,
            })),
        ).toEqual(
            fixture.expectedMatches.map((match) => ({
                startOffset: match.startOffset,
                endOffset: match.endOffset,
                excerpt: buildPdfSearchExcerpt(fixture.text, match.startOffset, match.endOffset, SEARCH_EXCERPT_CONTEXT_CHARS),
            })),
        );
    });

    it('attaches pdfjs operator-list geometry to browser search results', async () => {
        const glyphs = Array.from('«История»').map((unicode) => ({
            unicode,
            width: unicode === '«' || unicode === '»' ? 200 : 600,
        }));
        const getTextContent = vi.fn(async () => makeTextContent('«История»'));
        const getPage = vi.fn(async () => ({
            view: [0, 0, 200, 200],
            getOperatorList: vi.fn(async () => ({
                fnArray: [
                    pdfjsModule.OPS.beginText,
                    pdfjsModule.OPS.setFont,
                    pdfjsModule.OPS.setTextMatrix,
                    pdfjsModule.OPS.showText,
                    pdfjsModule.OPS.endText,
                ],
                argsArray: [[], ['f1', 10], [new Float32Array([1, 0, 0, 1, 10, 50])], [glyphs], []],
            })),
            getTextContent,
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        const result = await capability.run('/tmp/test.pdf', 'история');
        const word = result.results[0]?.words?.[0];

        expect(result.results).toHaveLength(1);
        expect(result.results[0]).toMatchObject({
            pageNumber: 1,
            pageWidth: 200,
            pageHeight: 200,
        });
        expect(word).toMatchObject({
            text: 'История',
            y: 140,
            height: 10,
        });
        expect(word?.x).toBeCloseTo(12, 5);
        expect(word?.width).toBeCloseTo(42, 5);
    });

    it('keeps Unicode excerpts and word rectangles when complete cached text needs evicted geometry', async () => {
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 30,
                getPage: async () => ({
                    view: [0, 0, 200, 200],
                    getTextContent: async () => makeTextContent('«История»'),
                    getOperatorList: async () => ({
                        fnArray: [
                            pdfjsModule.OPS.beginText,
                            pdfjsModule.OPS.setFont,
                            pdfjsModule.OPS.setTextMatrix,
                            pdfjsModule.OPS.showText,
                            pdfjsModule.OPS.endText,
                        ],
                        argsArray: [
                            [],
                            ['f1', 10],
                            [new Float32Array([1, 0, 0, 1, 10, 50])],
                            [
                                Array.from('«История»', (unicode) => ({
                                    unicode,
                                    width: 600,
                                })),
                            ],
                            [],
                        ],
                    }),
                }),
                loadingTask: {destroy: async () => {}},
            }),
        });
        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        const cold = await capability.run('/tmp/geometry.pdf', 'история');
        expect(cold.results).toHaveLength(30);
        expect(cold.results[0]).toMatchObject({
            startOffset: 1,
            endOffset: 8,
            excerpt: expect.objectContaining({match: 'История'}),
            words: [
                expect.objectContaining({
                    text: 'История',
                    x: 16,
                    y: 140,
                    width: 42,
                    height: 10,
                }),
            ],
            pageWidth: 200,
            pageHeight: 200,
        });
        await expect(capability.run('/tmp/geometry.pdf', 'история')).resolves.toEqual(cold);
        await expect(createBrowserSearchCapability().capability.run('/tmp/geometry.pdf', 'история')).resolves.toEqual(cold);
    });

    it('invalidates browser page text caches when same-size document content changes', async () => {
        const firstDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({
                view: searchPageView,
                getTextContent: vi.fn(async () => makeTextContent('alpha foo')),
                cleanup: vi.fn(async () => {}),
            })),
            loadingTask: {destroy: vi.fn(async () => {})},
        };
        const secondDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({
                view: searchPageView,
                getTextContent: vi.fn(async () => makeTextContent('beta bar')),
                cleanup: vi.fn(async () => {}),
            })),
            loadingTask: {destroy: vi.fn(async () => {})},
        };
        const firstDocumentGetPage = firstDocument.getPage;
        const secondDocumentGetPage = secondDocument.getPage;

        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        browserDocumentStoreMock.getContentSignature.mockResolvedValue('content-token-1');
        pdfjsModule.getDocument
            .mockReturnValueOnce({promise: Promise.resolve(firstDocument)})
            .mockReturnValueOnce({promise: Promise.resolve(secondDocument)});

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();

        await expect(capability.run('/tmp/test.pdf', 'foo')).resolves.toEqual({
            results: [expect.objectContaining({pageNumber: 1})],
            truncated: false,
        });
        browserDocumentStoreMock.getContentSignature.mockResolvedValue('content-token-2');
        browserDocumentStoreMock.getDocumentRevision.mockImplementation(async (documentRef: string) =>
            makeBrowserRevision(documentRef, 'drt1:browser:content-token-2', 2),
        );
        await expect(capability.run('/tmp/test.pdf', 'bar')).resolves.toEqual({
            results: [expect.objectContaining({pageNumber: 1})],
            truncated: false,
        });

        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(2);
        expect(firstDocumentGetPage).toHaveBeenCalledTimes(1);
        expect(secondDocumentGetPage).toHaveBeenCalledTimes(1);
    });

    it('invalidates browser page text caches when only document revision changes', async () => {
        const firstDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({
                view: searchPageView,
                getTextContent: vi.fn(async () => makeTextContent('alpha foo')),
                cleanup: vi.fn(async () => {}),
            })),
            loadingTask: {destroy: vi.fn(async () => {})},
        };
        const secondDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({
                view: searchPageView,
                getTextContent: vi.fn(async () => makeTextContent('beta bar')),
                cleanup: vi.fn(async () => {}),
            })),
            loadingTask: {destroy: vi.fn(async () => {})},
        };
        const firstDocumentGetPage = firstDocument.getPage;
        const secondDocumentGetPage = secondDocument.getPage;

        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        browserDocumentStoreMock.getContentSignature.mockResolvedValue('same-content-signature');
        browserDocumentStoreMock.getDocumentRevision.mockImplementation(async (documentRef: string) =>
            makeBrowserRevision(documentRef, 'drt1:browser:revision-1'),
        );
        pdfjsModule.getDocument
            .mockReturnValueOnce({promise: Promise.resolve(firstDocument)})
            .mockReturnValueOnce({promise: Promise.resolve(secondDocument)});

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();

        await expect(capability.run('/tmp/test.pdf', 'foo')).resolves.toEqual({
            results: [expect.objectContaining({pageNumber: 1})],
            truncated: false,
        });
        browserDocumentStoreMock.getDocumentRevision.mockImplementation(async (documentRef: string) =>
            makeBrowserRevision(documentRef, 'drt1:browser:revision-2', 2),
        );
        await expect(capability.run('/tmp/test.pdf', 'bar')).resolves.toEqual({
            results: [expect.objectContaining({pageNumber: 1})],
            truncated: false,
        });

        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(2);
        expect(firstDocumentGetPage).toHaveBeenCalledTimes(1);
        expect(secondDocumentGetPage).toHaveBeenCalledTimes(1);
    });

    it.each([
        [
            'schema version changes',
            (record: Record<string, unknown>) => {
                record.version = 0;
            },
        ],
        [
            'page count mismatches',
            (record: Record<string, unknown>) => {
                record.pageCount = 2;
            },
        ],
        [
            'text byte metadata is corrupt',
            (record: Record<string, unknown>) => {
                record.textBytes = 999;
            },
        ],
    ] as const)('rebuilds persisted browser page text when %s', async (_label, mutateRecord) => {
        const firstDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({
                view: searchPageView,
                getTextContent: vi.fn(async () => makeTextContent('alpha foo')),
                cleanup: vi.fn(async () => {}),
            })),
            loadingTask: {destroy: vi.fn(async () => {})},
        };
        const secondDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({
                view: searchPageView,
                getTextContent: vi.fn(async () => makeTextContent('beta bar')),
                cleanup: vi.fn(async () => {}),
            })),
            loadingTask: {destroy: vi.fn(async () => {})},
        };
        const secondDocumentGetPage = secondDocument.getPage;

        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument
            .mockReturnValueOnce({promise: Promise.resolve(firstDocument)})
            .mockReturnValueOnce({promise: Promise.resolve(secondDocument)});

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const firstCapability = createBrowserSearchCapability().capability;
        await firstCapability.run('/tmp/test.pdf', 'foo', {pageCount: 1});

        const indexedDbFactory = requireFakeIndexedDbFactory();
        await vi.waitFor(() => {
            expect(indexedDbFactory.getDatabase('evb-browser-search-cache-v2')?.getStoreRecords('document-text').has('/tmp/test.pdf')).toBe(
                true,
            );
        });
        const record = indexedDbFactory.getDatabase('evb-browser-search-cache-v2')?.getStoreRecords('document-text').get('/tmp/test.pdf');
        mutateRecord(requirePersistedRecord(record));

        const secondCapability = createBrowserSearchCapability().capability;
        await expect(secondCapability.run('/tmp/test.pdf', 'bar', {pageCount: 1})).resolves.toEqual({
            results: [expect.objectContaining({pageNumber: 1})],
            truncated: false,
        });

        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(2);
        expect(secondDocumentGetPage).toHaveBeenCalledTimes(1);
    });

    it('clears persisted browser page text indexes on resetCache', async () => {
        const pageTexts = ['alpha foo', 'beta foo'];
        const getPage = vi.fn(async (pageNumber: number) => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent(pageTexts[pageNumber - 1] ?? '')),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: pageTexts.length,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const firstCapability = createBrowserSearchCapability().capability;
        await firstCapability.run('/tmp/test.pdf', 'foo');
        await firstCapability.resetCache();

        const secondCapability = createBrowserSearchCapability().capability;
        await secondCapability.run('/tmp/test.pdf', 'foo');

        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(2);
    });

    it('prunes persisted browser page text indexes by LRU record limit', async () => {
        let documentIndex = 0;
        pdfjsModule.getDocument.mockImplementation(() => {
            documentIndex += 1;
            const pageText = `document ${documentIndex} foo`;
            return {
                promise: Promise.resolve({
                    numPages: 1,
                    getPage: vi.fn(async () => ({
                        view: searchPageView,
                        getTextContent: vi.fn(async () => makeTextContent(pageText)),
                        cleanup: vi.fn(async () => {}),
                    })),
                    loadingTask: {destroy: vi.fn(async () => {})},
                }),
            };
        });
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();

        for (let index = 1; index <= 17; index += 1) {
            await capability.warmIndex(`/tmp/lru-${index}.pdf`);
        }

        const indexedDbFactory = requireFakeIndexedDbFactory();
        const database = indexedDbFactory.getDatabase('evb-browser-search-cache-v2');
        expect(database?.getStoreRecords('document-text').size).toBe(16);
        expect(database?.getStoreRecords('document-text').has('/tmp/lru-1.pdf')).toBe(false);
        expect(database?.getStoreRecords('document-text').has('/tmp/lru-17.pdf')).toBe(true);
    });

    it('searches documents above 64 MiB with metadata-only admission and range reads', async () => {
        const getPage = vi.fn(async () => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent('foo')),
            cleanup: vi.fn(async () => {}),
        }));
        browserDocumentStoreMock.stat.mockResolvedValue({size: 64 * 1024 * 1024 + 1});
        browserDocumentStoreMock.readRange.mockImplementation(
            async (_path: string, _offset: number, length: number) => new Uint8Array(length),
        );
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();

        await expect(capability.run('/tmp/huge.pdf', 'foo')).resolves.toMatchObject({
            results: [expect.objectContaining({pageNumber: 1})],
            truncated: false,
        });
        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.readRange).toHaveBeenCalled();
        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(1);
    });

    it('persists sparse page records without page-count blank slots', async () => {
        const pageTexts = ['', 'needle', ''];
        const getPage = vi.fn(async (pageNumber: number) => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent(pageTexts[pageNumber - 1] ?? '')),
            cleanup: vi.fn(async () => {}),
        }));
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: pageTexts.length,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        await expect(capability.warmIndex('/tmp/sparse.pdf')).resolves.toBe(true);

        const database = requireFakeIndexedDbFactory().getDatabase('evb-browser-search-cache-v2');
        const record = requirePersistedRecord(database?.getStoreRecords('document-text').get('/tmp/sparse.pdf'));
        expect(record.version).toBe(12);
        expect(record.pageCount).toBe(3);
        expect(record.indexBytes).toBeInstanceOf(Uint8Array);
        const indexBytes = record.indexBytes as Uint8Array;
        expect(testTextDecoder.decode(indexBytes.subarray(0, 8))).toBe('EVBSIDX4');
        expect(record.textBytes).toBe(indexBytes.byteLength);
        expect('pageTexts' in record).toBe(false);
        expect('pages' in record).toBe(false);
    });

    it('discards cache records an older extractor wrote and reads the page again', async () => {
        const path = '/tmp/older-extractor.pdf';
        const getPage = vi.fn(async () => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent('fresh')),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        await capability.resetCache();
        const database = requireFakeIndexedDbFactory().getDatabase('evb-browser-search-cache-v2');
        // Version 10 predates faithful glyph text and vertical-writing fallback.
        database?.getStoreRecords('document-text').set(path, {
            version: 10,
            pdfPath: path,
            fileSize: 3,
            contentSignature: 'content-token-1',
            documentRevision: 'drt1:browser:content-token-1',
            pageCount: 1,
            pages: [
                {
                    pageNumber: 1,
                    text: 'stale',
                },
            ],
            textBytes: 10,
        });

        await expect(capability.run(path, 'stale', {requestId: requireRequestId('older-extractor')})).resolves.toMatchObject({results: []});
        expect(getPage).toHaveBeenCalledWith(1);
    });

    it('cancels a million-page direct scan after one delivered page', async () => {
        const arrayFrom = vi.spyOn(Array, 'from');
        const getPage = vi.fn(async (pageNumber: number) => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent(pageNumber === 1 ? 'needle' : '')),
            cleanup: vi.fn(async () => {}),
        }));
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1_000_000,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        capability.onProgress((progress) => {
            if (progress.processed === 1) {
                void capability.cancel(requireRequestId('million-direct'));
            }
        });
        await expect(capability.run('/tmp/million-direct.pdf', 'needle', {requestId: requireRequestId('million-direct')})).resolves.toEqual(
            {
                results: [],
                truncated: false,
            },
        );
        expect(getPage).toHaveBeenCalledTimes(1);
        expect(
            arrayFrom.mock.calls.some(
                ([value]) => typeof value === 'object' && value !== null && 'length' in value && Number(value.length) >= 1_000_000,
            ),
        ).toBe(false);
        arrayFrom.mockRestore();
    });

    it('returns no browser search results for empty queries before loading PDF.js', async () => {
        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();

        await expect(capability.run('/tmp/test.pdf', '')).resolves.toEqual({
            results: [],
            truncated: false,
        });
        expect(browserDocumentStoreMock.stat).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.readRange).not.toHaveBeenCalled();
        expect(pdfjsModule.getDocument).not.toHaveBeenCalled();
    });

    it('streams uncached browser search results as direct extraction scans pages', async () => {
        const pageTexts = ['alpha sign', 'beta sign'];
        const getPage = vi.fn(async (pageNumber: number) => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent(pageTexts[pageNumber - 1] ?? '')),
            cleanup: vi.fn(async () => {}),
        }));

        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: pageTexts.length,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        const progressUpdates: Array<{
            processed: number;
            resultCount: number;
            resultsStartIndex?: number;
        }> = [];
        capability.onProgress((progress) => {
            progressUpdates.push({
                processed: progress.processed,
                resultCount: progress.results?.length ?? 0,
                ...(progress.resultsStartIndex === undefined ? {} : {resultsStartIndex: progress.resultsStartIndex}),
            });
        });
        const result = await capability.run('/tmp/test.pdf', 'sign', {requestId: requireRequestId('stream-search')});

        expect(result.results).toEqual([expect.objectContaining({pageNumber: 1}), expect.objectContaining({pageNumber: 2})]);
        expect(progressUpdates).toContainEqual({
            processed: 1,
            resultCount: 1,
            resultsStartIndex: 0,
        });
        expect(progressUpdates).toContainEqual({
            processed: 2,
            resultCount: 1,
            resultsStartIndex: 1,
        });
        expect(browserSearchWorkerClientMock.createBrowserSearchWorkerRequest).toHaveBeenCalledWith(
            'matchPageText',
            expect.objectContaining({query: 'sign'}),
            expect.any(Object),
        );
        expect(pdfjsModule.getDocument).toHaveBeenCalledOnce();
        expect(getPage).toHaveBeenCalledTimes(2);
    });

    it('stops direct extraction after truncated streaming search without persisting a full index', async () => {
        vi.doMock('@contracts/search', async (importOriginal) => ({
            ...(await importOriginal<typeof TSearchContractsModule>()),
            SEARCH_EXCERPT_CONTEXT_CHARS: 10,
            SEARCH_RESULT_LIMIT: 2,
        }));
        const pageTexts = ['alpha foo', 'beta foo', 'gamma foo', 'delta foo'];
        const getPage = vi.fn(async (pageNumber: number) => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent(pageTexts[pageNumber - 1] ?? '')),
            cleanup: vi.fn(async () => {}),
        }));

        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: pageTexts.length,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const firstCapability = createBrowserSearchCapability().capability;
        const firstRun = await firstCapability.run('/tmp/test.pdf', 'foo');
        const secondCapability = createBrowserSearchCapability().capability;
        const secondRun = await secondCapability.run('/tmp/test.pdf', 'foo');

        expect(firstRun).toEqual({
            results: expect.arrayContaining([expect.objectContaining({pageNumber: 1}), expect.objectContaining({pageNumber: 2})]),
            truncated: true,
        });
        expect(secondRun.truncated).toBe(true);
        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(2);
        expect(getPage).toHaveBeenCalledTimes(6);

        const indexedDbFactory = requireFakeIndexedDbFactory();
        const database = indexedDbFactory.getDatabase('evb-browser-search-cache-v2');
        expect(database?.getStoreRecords('document-text').size ?? 0).toBe(0);
    });

    it.each([false, true])('continues through bounded browser windows with regex=%s', async (useRegex) => {
        const lines = Array.from({length: 70}, (_, row) => `Inspection ${row}: valve valve valve valve valve valve valve valve`).join('\n');
        const pageTexts = [lines, 'valve later'];
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 2,
                getPage: async (page: number) => ({
                    view: searchPageView,
                    getTextContent: async () => makeTextContent(pageTexts[page - 1]),
                    cleanup: async () => {},
                }),
                loadingTask: {destroy: async () => {}},
            }),
        });
        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        for (const [resultOffset, firstOrdinal, length, truncated] of [
            [0, 0, 500, true],
            [500, 500, 61, false],
            ['last', 61, 500, false],
        ] as const) {
            const response = await capability.run('/tmp/windowed.pdf', 'valve', {
                useRegex,
                resultOffset,
            });
            expect(response.results).toHaveLength(length);
            expect(response.results[0]?.matchIndex).toBe(firstOrdinal);
            expect(response.truncated).toBe(truncated);
            if (resultOffset !== 0) {
                expect(response.results.at(-1)).toMatchObject({
                    matchIndex: 560,
                    pageNumber: 2,
                    pageMatchIndex: 0,
                });
            }
        }
    });

    it('keeps an exact-limit result set complete and scans every remaining page', async () => {
        vi.doMock('@contracts/search', async (importOriginal) => ({
            ...(await importOriginal<typeof TSearchContractsModule>()),
            SEARCH_EXCERPT_CONTEXT_CHARS: 10,
            SEARCH_RESULT_LIMIT: 2,
        }));
        const pageTexts = ['alpha foo', 'beta foo', 'gamma without a match'];
        const getPage = vi.fn(async (pageNumber: number) => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent(pageTexts[pageNumber - 1] ?? '')),
            cleanup: vi.fn(async () => {}),
        }));

        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: pageTexts.length,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        const truncatedProgress: boolean[] = [];
        capability.onProgress((progress) => truncatedProgress.push(Boolean(progress.truncated)));
        const result = await capability.run('/tmp/test.pdf', 'foo', {requestId: requireRequestId('exact-limit')});

        expect(result.truncated).toBe(false);
        expect(result.results.map((match) => Number(match.pageNumber))).toEqual([1, 2]);
        expect(getPage).toHaveBeenCalledTimes(3);
        expect(truncatedProgress).not.toContain(true);
    });

    it('truncates only after discovering the first match beyond the limit', async () => {
        vi.doMock('@contracts/search', async (importOriginal) => ({
            ...(await importOriginal<typeof TSearchContractsModule>()),
            SEARCH_EXCERPT_CONTEXT_CHARS: 10,
            SEARCH_RESULT_LIMIT: 2,
        }));
        const pageTexts = ['alpha foo', 'beta foo', 'gamma foo', 'delta foo'];
        const getPage = vi.fn(async (pageNumber: number) => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent(pageTexts[pageNumber - 1] ?? '')),
            cleanup: vi.fn(async () => {}),
        }));

        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: pageTexts.length,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        const progressUpdates: Array<{
            processed: number;
            truncated: boolean;
            pageNumbers: number[];
        }> = [];
        capability.onProgress((progress) =>
            progressUpdates.push({
                processed: progress.processed,
                truncated: Boolean(progress.truncated),
                pageNumbers: (progress.results ?? []).map((match) => Number(match.pageNumber)),
            }),
        );
        const result = await capability.run('/tmp/test.pdf', 'foo', {requestId: requireRequestId('over-limit')});

        expect(result.truncated).toBe(true);
        expect(result.results.map((match) => Number(match.pageNumber))).toEqual([1, 2]);
        expect(result.results.map((match) => match.matchIndex)).toEqual([0, 1]);
        expect(getPage).toHaveBeenCalledTimes(3);
        expect(progressUpdates.filter((update) => update.truncated)).toEqual([
            {
                processed: 3,
                truncated: true,
                pageNumbers: [],
            },
        ]);
        expect(progressUpdates.flatMap((update) => update.pageNumbers)).toEqual([1, 2]);
    });

    it('assigns page match indexes without scanning prior results', async () => {
        const getPage = vi.fn(async () => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent('foo foo foo')),
            cleanup: vi.fn(async () => {}),
        }));

        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        const result = await capability.run('/tmp/test.pdf', 'foo');

        expect(result.results.map((match) => match.pageMatchIndex)).toEqual([0, 1, 2]);
    });

    // The search worker only matches text. Warming reads the document through
    // the same prepared PDF.js loader as a search, whether or not a worker is
    // available, and persists what it read.
    it('warms the text index from the current PDF bytes even when the worker is available', async () => {
        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReturnValue(true);
        pdfjsModule.GlobalWorkerOptions.workerSrc = undefined;
        const pageTexts = ['alpha', ''];
        const getPage = vi.fn(async (pageNumber: number) => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent(pageTexts[pageNumber - 1] ?? '')),
            cleanup: vi.fn(async () => {}),
        }));
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: pageTexts.length,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();

        await expect(capability.warmIndex('/tmp/warm.pdf')).resolves.toBe(true);

        const database = requireFakeIndexedDbFactory().getDatabase('evb-browser-search-cache-v2');
        const record = requirePersistedRecord(database?.getStoreRecords('document-text').get('/tmp/warm.pdf'));
        expect(record.version).toBe(12);
        expect(record.pageCount).toBe(2);
        expect(record.indexBytes).toBeInstanceOf(Uint8Array);
        expect(testTextDecoder.decode((record.indexBytes as Uint8Array).subarray(0, 8))).toBe('EVBSIDX4');
        // The loader prepared the PDF.js runtime before opening the document.
        expect(pdfjsModule.GlobalWorkerOptions.workerSrc).toBeTruthy();
    });

    it.each(['cold', 'cached'])('cancels %s browser page extraction without publishing partial results', async (mode) => {
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        let firstPageRead = false;
        let holdPageRead = false;
        let releaseFirstPageRead: () => void = () => {};
        const firstPageReadGate = new Promise<void>((resolve) => {
            releaseFirstPageRead = resolve;
        });
        const getPage = vi.fn(async (pageNumber: number) => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => {
                if (holdPageRead && pageNumber === 1) {
                    firstPageRead = true;
                    await firstPageReadGate;
                }
                return makeTextContent(`page ${pageNumber} foo`);
            }),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 3,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        if (mode === 'cached') {
            await capability.warmIndex('/tmp/test.pdf');
        }
        holdPageRead = true;
        const runPromise = capability.run('/tmp/test.pdf', 'foo', {requestId: requireRequestId('cancel-me')});

        await vi.waitFor(() => {
            expect(firstPageRead).toBe(true);
        });
        await capability.cancel(requireRequestId('cancel-me'));
        releaseFirstPageRead();

        await expect(runPromise).resolves.toEqual({
            results: [],
            truncated: false,
        });

        const nextRun = await capability.run('/tmp/test.pdf', 'foo', {requestId: requireRequestId('cancel-me')});

        expect(nextRun.results.length).toBeGreaterThan(0);
    });

    it('reuses the in-worker search index across keystrokes without resending indexBytes and rehydrates on cache miss', async () => {
        const getPage = vi.fn(async (pageNumber: number) => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent(`page ${pageNumber} alpha beta`)),
            cleanup: vi.fn(async () => {}),
        }));
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 2,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        await expect(capability.warmIndex('/tmp/in-worker-cache.pdf')).resolves.toBe(true);

        browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mockClear();
        const first = await capability.run('/tmp/in-worker-cache.pdf', 'alpha');
        const second = await capability.run('/tmp/in-worker-cache.pdf', 'beta');
        expect(first.results).toHaveLength(2);
        expect(second.results).toHaveLength(2);

        const searchCalls = browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mock.calls.filter(
            (call) => call[0] === 'search',
        );
        expect(searchCalls).toHaveLength(2);
        expect((searchCalls[0]![1] as {indexBytes?: unknown}).indexBytes).toBeUndefined();
        expect((searchCalls[1]![1] as {indexBytes?: unknown}).indexBytes).toBeUndefined();

        // Simulate worker idle eviction / restart: next query hits cacheMiss and transparently re-hydrates once.
        defaultTestWasmWorker.evictCache();
        browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mockClear();
        const afterEvict = await capability.run('/tmp/in-worker-cache.pdf', 'alpha');
        expect(afterEvict.results).toHaveLength(2);
        const recoveryCalls = browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mock.calls.filter(
            (call) => call[0] === 'search',
        );
        expect(recoveryCalls).toHaveLength(2);
        expect((recoveryCalls[0]![1] as {indexBytes?: unknown}).indexBytes).toBeUndefined();
        expect((recoveryCalls[1]![1] as {indexBytes?: unknown}).indexBytes).toBeInstanceOf(Uint8Array);
    });

    it('touches only the tiny IDB metadata store on cache hit without rewriting indexBytes', async () => {
        const getPage = vi.fn(async () => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent('needle payload')),
            cleanup: vi.fn(async () => {}),
        }));
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        await createBrowserSearchCapability().capability.warmIndex('/tmp/idb-split.pdf');

        const database = requireFakeIndexedDbFactory().getDatabase('evb-browser-search-cache-v2');
        expect(database).not.toBeNull();
        const dataRecordBefore = database!.getStoreRecords('document-text').get('/tmp/idb-split.pdf') as Record<string, unknown>;
        const metaRecordBefore = database!.getStoreRecords('document-meta').get('/tmp/idb-split.pdf') as Record<string, unknown>;
        expect(dataRecordBefore.indexBytes).toBeInstanceOf(Uint8Array);
        expect('lastAccessedAt' in dataRecordBefore).toBe(false);
        expect(typeof metaRecordBefore.lastAccessedAt).toBe('number');
        expect('indexBytes' in metaRecordBefore).toBe(false);

        const transactionSpy = vi.spyOn(database!, 'transaction');
        const hydratedCapability = createBrowserSearchCapability().capability;
        const result = await hydratedCapability.run('/tmp/idb-split.pdf', 'needle');
        expect(result.results).toHaveLength(1);

        await vi.waitFor(() => {
            const metaAfter = database!.getStoreRecords('document-meta').get('/tmp/idb-split.pdf') as Record<string, unknown>;
            expect(Number(metaAfter.lastAccessedAt)).toBeGreaterThan(Number(metaRecordBefore.lastAccessedAt));
        });

        // No readwrite transaction ever touched the payload store (`document-text`) during a cache hit.
        const readwriteStores = transactionSpy.mock.calls
            .filter(([, mode]) => mode === 'readwrite')
            .flatMap(([names]) => (Array.isArray(names) ? names : [names]));
        expect(readwriteStores).toEqual(['document-meta']);
        expect(database!.getStoreRecords('document-text').get('/tmp/idb-split.pdf')).toBe(dataRecordBefore);
    });

    it('detaches IDB persistence off cold terminal response and never overwrites a newer revision', async () => {
        const getPage = vi.fn(async () => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent('detached needle')),
            cleanup: vi.fn(async () => {}),
        }));
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });

        const indexedDbFactory = requireFakeIndexedDbFactory();
        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        // Ensure database exists first so we can gate the revision check inside detached persistence.
        await capability.resetCache();

        const persistRevisionGate = Promise.withResolvers<ReturnType<typeof makeBrowserRevision>>();
        let revisionReads = 0;
        browserDocumentStoreMock.getDocumentRevision.mockImplementation((documentRef: string) => {
            revisionReads += 1;
            if (revisionReads === 1) {
                return Promise.resolve(makeBrowserRevision(documentRef, 'drt1:browser:rev-1', 1));
            }
            return persistRevisionGate.promise;
        });

        // Cold search returns immediately even while detached IDB persistence is still gated.
        const coldResult = await capability.run('/tmp/detached.pdf', 'needle');
        expect(coldResult.results).toHaveLength(1);
        expect(indexedDbFactory.getDatabase('evb-browser-search-cache-v2')?.getStoreRecords('document-text').has('/tmp/detached.pdf')).toBe(
            false,
        );

        // Revision advances to rev-2 before rev-1's detached persistence completes: rev-1 must NOT be written.
        persistRevisionGate.resolve(makeBrowserRevision('/tmp/detached.pdf', 'drt1:browser:rev-2', 2));
        await flushMicrotasks();
        expect(indexedDbFactory.getDatabase('evb-browser-search-cache-v2')?.getStoreRecords('document-text').has('/tmp/detached.pdf')).toBe(
            false,
        );
    });

    it('batches cold literal browser matching with bounded page/byte chunks while preserving order, offsets, and last tail', async () => {
        const pageCount = 40;
        const getPage = vi.fn(async (pageNumber: number) => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent(`page ${pageNumber} token`)),
            cleanup: vi.fn(async () => {}),
        }));
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: pageCount,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        const progressPages: number[] = [];
        capability.onProgress((progress) => {
            progressPages.push(progress.processed);
        });

        const response = await capability.run('/tmp/batched-cold.pdf', 'token', {
            requestId: requireRequestId('batched-cold'),
        });
        expect(response.truncated).toBe(false);
        expect(response.results).toHaveLength(pageCount);
        expect(response.results.map((hit) => Number(hit.pageNumber))).toEqual(Array.from({length: pageCount}, (_, idx) => idx + 1));
        expect(response.results.map((hit) => hit.matchIndex)).toEqual(Array.from({length: pageCount}, (_, idx) => idx));
        // Strictly monotonic progressive updates, starting at page 1 and ending at page 40.
        expect(progressPages[0]).toBe(1);
        expect(progressPages.at(-1)).toBe(pageCount);
        for (let i = 1; i < progressPages.length; i += 1) {
            expect(progressPages[i]!).toBeGreaterThanOrEqual(progressPages[i - 1]!);
        }
        // Batching dramatically cuts worker RPC count compared to 40 single-page requests.
        const matchWorkerCalls = browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mock.calls.filter(
            ([type]) => type === 'matchPageText' || type === 'matchPageBatch',
        );
        expect(matchWorkerCalls.length).toBeLessThan(10);
        expect(matchWorkerCalls.some(([type]) => type === 'matchPageBatch')).toBe(true);

        // Fresh uncached capability with resultOffset='last' over batched cold scan keeps exact global ordinals.
        const freshCapability = createBrowserSearchCapability().capability;
        await freshCapability.resetCache();
        const lastResponse = await freshCapability.run('/tmp/batched-cold-last.pdf', 'token', {
            resultOffset: 'last',
        });
        expect(lastResponse.results.map((hit) => hit.matchIndex)).toEqual(Array.from({length: pageCount}, (_, idx) => idx));
    });

    it.each([
        {
            label: 'ASCII literal',
            densePageText: Array.from({length: 505}, (_, index) => `valve-${index}`).join(' '),
            query: 'valve',
        },
        {
            label: 'typographic apostrophe folding',
            densePageText: Array.from({length: 505}, (_, index) => `a’${index}`).join(' '),
            query: "'",
        },
        {
            label: 'long-s folding',
            densePageText: Array.from({length: 505}, (_, index) => `ſ${index}`).join(' '),
            query: 's',
        },
        {
            label: 'Greek sigma case folding',
            densePageText: Array.from({length: 505}, (_, index) => `ς${index}`).join(' '),
            query: 'Σ',
        },
        {
            label: 'Unicode 16+ case folding (Ᲊ/ᲊ)',
            densePageText: Array.from({length: 505}, (_, index) => `ᲊ${index}`).join(' '),
            query: 'Ᲊ',
        },
    ])(
        'flushes a dense overflow page ($label) before extracting the next page so a failing later page never breaks truncated search',
        async ({densePageText, query}) => {
            const getPage = vi.fn(async (pageNumber: number) => {
                if (pageNumber === 3) {
                    throw new Error('Page 3 extraction should never be requested after page 2 overflows the limit');
                }
                return {
                    view: searchPageView,
                    getTextContent: vi.fn(async () => makeTextContent(pageNumber === 1 ? 'no hits here' : densePageText)),
                    cleanup: vi.fn(async () => {}),
                };
            });
            browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
            browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
            pdfjsModule.getDocument.mockReturnValue({
                promise: Promise.resolve({
                    numPages: 3,
                    getPage,
                    loadingTask: {destroy: vi.fn(async () => {})},
                }),
            });

            const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
            const {capability} = createBrowserSearchCapability();
            const response = await capability.run('/tmp/dense-overflow.pdf', query);
            expect(response.truncated).toBe(true);
            expect(response.results).toHaveLength(500);
            expect(getPage).toHaveBeenCalledTimes(2);
        },
    );

    it('omits documentKey on an indexed search retry after resetCache() so stale bytes never rehydrate the worker cache', async () => {
        const getPage = vi.fn(async () => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent('indexed needle')),
            cleanup: vi.fn(async () => {}),
        }));
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        await capability.warmIndex('/tmp/indexed-reset-race.pdf');

        // Intercept the first cache-only search so resetCache() runs while it is awaiting, causing a cacheMiss retry.
        const firstSearchGate = Promise.withResolvers<void>();
        const firstSearchStarted = Promise.withResolvers<void>();
        let intercepted = false;
        browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mockImplementation((type: unknown, payload: unknown) => {
            if (type === 'search' && !intercepted) {
                intercepted = true;
                firstSearchStarted.resolve();
                return {
                    requestId: 999,
                    promise: firstSearchGate.promise.then(() => ({cacheMiss: true})),
                };
            }
            return defaultTestWasmWorkerRequest(type, payload);
        });

        const searchPromise = capability.run('/tmp/indexed-reset-race.pdf', 'needle');
        await firstSearchStarted.promise;
        await capability.resetCache();
        firstSearchGate.resolve();
        const response = await searchPromise;
        expect(response.results).toHaveLength(1);

        // The retry search must have omitted documentKey so it could not re-hydrate the worker cache.
        const searchPayloads = browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mock.calls
            .filter(([type]) => type === 'search')
            .map(([, payload]) => payload as {documentKey?: string; indexBytes?: Uint8Array});
        expect(searchPayloads).toHaveLength(2);
        expect(searchPayloads[1]!.documentKey).toBeUndefined();
        expect(searchPayloads[1]!.indexBytes).toBeInstanceOf(Uint8Array);
    });

    it('clears legacy v2 document-text payloads during v2-to-v3 IndexedDB upgrade so no orphan rows escape pruning', async () => {
        const v2DataClear = vi.fn();
        const metaIndexCreate = vi.fn();
        const createdStores: string[] = [];
        vi.stubGlobal('indexedDB', {
            open: vi.fn(() => {
                const request: Record<string, unknown> = {};
                const fakeDb = {
                    objectStoreNames: {
                        contains: (storeName: string) => storeName === 'document-text' || createdStores.includes(storeName),
                    },
                    createObjectStore: (storeName: string) => {
                        createdStores.push(storeName);
                        return {
                            indexNames: {contains: () => false},
                            createIndex: metaIndexCreate,
                        };
                    },
                    transaction: () => {
                        const tx: Record<string, unknown> = {
                            objectStore: () => ({
                                clear: () => {
                                    const req: Record<string, unknown> = {};
                                    queueMicrotask(() => {
                                        (req.onsuccess as (() => void) | undefined)?.();
                                    });
                                    return req;
                                },
                            }),
                        };
                        queueMicrotask(() => {
                            queueMicrotask(() => {
                                (tx.oncomplete as (() => void) | undefined)?.();
                            });
                        });
                        return tx;
                    },
                    close: vi.fn(),
                };
                request.result = fakeDb;
                request.transaction = {
                    objectStore: (storeName: string) => {
                        if (storeName === 'document-text') {
                            return {clear: v2DataClear};
                        }
                        throw new Error(`Unexpected upgrade store lookup: ${storeName}`);
                    },
                };
                queueMicrotask(() => {
                    (request.onupgradeneeded as (() => void) | undefined)?.();
                    (request.onsuccess as (() => void) | undefined)?.();
                });
                return request;
            }),
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        await createBrowserSearchCapability().clearSearchCaches();
        expect(v2DataClear).toHaveBeenCalledTimes(1);
        expect(createdStores).toEqual(['document-meta']);
        expect(metaIndexCreate).toHaveBeenCalledWith('last-accessed-at', 'lastAccessedAt');
    });

    it('does not recreate deleted metadata or overwrite newer revision metadata on an IDB cache-hit touch', async () => {
        const getPage = vi.fn(async () => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => makeTextContent('needle payload')),
            cleanup: vi.fn(async () => {}),
        }));
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        await createBrowserSearchCapability().capability.warmIndex('/tmp/meta-guard.pdf');

        const database = requireFakeIndexedDbFactory().getDatabase('evb-browser-search-cache-v2')!;
        // Case 1: Metadata row was deleted before the cache-hit touch runs -> touch must not recreate it.
        database.getStoreRecords('document-meta').delete('/tmp/meta-guard.pdf');
        const firstHit = await createBrowserSearchCapability().capability.run('/tmp/meta-guard.pdf', 'needle');
        expect(firstHit.results).toHaveLength(1);
        await flushMicrotasks();
        expect(database.getStoreRecords('document-meta').has('/tmp/meta-guard.pdf')).toBe(false);

        // Case 2: Metadata row already belongs to a newer revision -> touch must not downgrade it.
        const newerMeta = {
            version: 12,
            pdfPath: '/tmp/meta-guard.pdf',
            documentRevision: 'drt1:browser:newer-rev',
            textBytes: 99,
            lastAccessedAt: 9_999_999,
        };
        database.getStoreRecords('document-meta').set('/tmp/meta-guard.pdf', newerMeta);
        const secondHit = await createBrowserSearchCapability().capability.run('/tmp/meta-guard.pdf', 'needle');
        expect(secondHit.results).toHaveLength(1);
        await flushMicrotasks();
        expect(database.getStoreRecords('document-meta').get('/tmp/meta-guard.pdf')).toEqual(newerMeta);
    });

    it('prevents an in-flight cold search paused during extraction from refilling memory, worker, or IDB after resetCache()', async () => {
        const pageGate = Promise.withResolvers<void>();
        const pageStarted = Promise.withResolvers<void>();
        const getPage = vi.fn(async () => ({
            view: searchPageView,
            getTextContent: vi.fn(async () => {
                pageStarted.resolve();
                await pageGate.promise;
                return makeTextContent('needle');
            }),
            cleanup: vi.fn(async () => {}),
        }));
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
        pdfjsModule.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage,
                loadingTask: {destroy: vi.fn(async () => {})},
            }),
        });

        const {createBrowserSearchCapability} = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const {capability} = createBrowserSearchCapability();
        const coldPromise = capability.run('/tmp/reset-during-cold.pdf', 'needle');
        await pageStarted.promise;

        // Reset cache while the cold search is paused mid-extraction.
        await capability.resetCache();
        pageGate.resolve();
        const result = await coldPromise;
        expect(result.results).toHaveLength(1);

        // Give any microtasks a chance to settle; neither IDB nor memory/worker cache may be repopulated.
        await flushMicrotasks();
        const db = requireFakeIndexedDbFactory().getDatabase('evb-browser-search-cache-v2');
        expect(db?.getStoreRecords('document-text').has('/tmp/reset-during-cold.pdf')).toBe(false);
        expect(db?.getStoreRecords('document-meta').has('/tmp/reset-during-cold.pdf')).toBe(false);
        // Next search must re-open PDF.js (proving memory cache was not repopulated either).
        await capability.run('/tmp/reset-during-cold.pdf', 'needle');
        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(2);
    });
});
