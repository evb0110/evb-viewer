import type * as TViMockOriginalModule from '@electron/config/constants';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    const postedMessages: Array<Record<string, unknown>> = [];
    const messageHandlers = new Map<string, (message: unknown) => void>();

    return {
        postedMessages,
        messageHandlers,
        parentPort: {
            postMessage: vi.fn((message: Record<string, unknown>) => {
                postedMessages.push(message);
            }),
            on: vi.fn((event: string, handler: (message: unknown) => void) => {
                messageHandlers.set(event, handler);
            }),
        },
        stat: vi.fn(),
        loadSearchIndex: vi.fn(),
        buildSearchIndex: vi.fn(),
        buildXlargeSearchIndex: vi.fn(),
        tryRunNativeSearch: vi.fn(),
        workerData: undefined as unknown,
    };
});

vi.mock('worker_threads', () => ({
    parentPort: mocks.parentPort,
    get workerData() {
        return mocks.workerData;
    },
}));
vi.mock('fs/promises', () => ({stat: mocks.stat}));
vi.mock('@electron/features/search/indexBuilder', () => ({
    SEARCH_INDEX_SCHEMA_VERSION: 7,
    loadSearchIndex: mocks.loadSearchIndex,
    buildSearchIndex: mocks.buildSearchIndex,
}));
vi.mock('@electron/features/search/nativeSearch', () => {
    class XlargeNativeSearchCapabilityError extends Error {
        constructor(readonly kind: string, message: string) {
            super(message);
        }
    }
    return {
        tryRunNativeSearch: mocks.tryRunNativeSearch,
        XlargeNativeSearchCapabilityError,
        isXlargeNativeSearchCapabilityError: (error: unknown) => (
            error instanceof XlargeNativeSearchCapabilityError
        ),
    };
});
vi.mock('@electron/features/search/xlargeIndexBuilder', () => ({buildXlargeSearchIndex: mocks.buildXlargeSearchIndex}));
vi.mock('@electron/config/constants', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    EXCERPT_CONTEXT_CHARS: 32,
    SEARCH_RESULT_LIMIT: 100,
}));
vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
}) }));

const TEST_PDF_PATH = '/tmp/test-search.pdf';
const DOCUMENT_REVISION = 'revision-token';
const PAGE_TEXT = 'XxUniquePageTextxX';

interface IIndexedSearchPageForTest {
    pageNumber: number;
    text: string;
    pageWidth?: number;
    pageHeight?: number;
    rotation?: 0 | 90 | 180 | 270;
    words?: Array<{
        text: string;
        x: number;
        y: number;
        width: number;
        height: number;
    }>;
}

interface IBuildSearchIndexOptionsForTest {onPageIndexed?: (page: IIndexedSearchPageForTest) => void;}

describe('search worker warmup and cache behavior', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.postedMessages.length = 0;
        mocks.messageHandlers.clear();
        mocks.workerData = undefined;
        delete process.env.EVB_PDF_SEARCH_ENABLE;
        delete process.env.EVB_PDF_SEARCH_DISABLE;

        mocks.stat.mockImplementation(async (path: string) => {
            if (path.endsWith('.pdf')) {
                return { mtimeMs: 10 };
            }
            if (path.endsWith('.index.json')) {
                return { mtimeMs: 1 };
            }
            throw new Error(`Unexpected stat path: ${path}`);
        });

        mocks.loadSearchIndex.mockResolvedValue(null);
        mocks.tryRunNativeSearch.mockResolvedValue(null);
        mocks.buildXlargeSearchIndex.mockResolvedValue({
            indexPath: `${TEST_PDF_PATH}.index.evb-search-v2.bin`,
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
            pagesScanned: 1,
            pagesWritten: 1,
            textBytes: PAGE_TEXT.length,
            truncated: false,
            complete: true,
        });
        mocks.buildSearchIndex.mockResolvedValue({
            schemaVersion: 7,
            documentRevision: {token: DOCUMENT_REVISION},
            pdfPath: TEST_PDF_PATH,
            createdAt: Date.now(),
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: PAGE_TEXT,
            }],
        });
    });

    it('uses native sidecar search before loading the JS search index when available', async () => {
        process.env.EVB_PDF_SEARCH_ENABLE = '1';
        const nativeResponse = {
            results: [{
                pageNumber: 1,
                pageMatchIndex: 0,
                matchIndex: 0,
                startOffset: 2,
                endOffset: 8,
                excerpt: {
                    prefix: false,
                    suffix: false,
                    before: 'xx',
                    match: 'needle',
                    after: 'yy',
                },
            }],
            truncated: false,
        };
        mocks.tryRunNativeSearch.mockResolvedValue({
            response: nativeResponse,
            totalPages: 3,
        });

        await import('@electron/features/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        expect(handleMessage).toBeTypeOf('function');

        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'native-1',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: ' needle ',
                pageCount: 3,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual({
                type: 'complete',
                requestId: 'native-1',
                response: nativeResponse,
            });
        });
        expect(mocks.tryRunNativeSearch).toHaveBeenCalledWith(expect.objectContaining({
            matchCase: false,
            pageCount: 3,
            pdfPath: TEST_PDF_PATH,
            documentRevision: DOCUMENT_REVISION,
            query: ' needle ',
            useRegex: false,
            wholeWord: false,
            nativeServiceIdleTimeoutMs: 5 * 60_000,
        }));
        expect(mocks.loadSearchIndex).not.toHaveBeenCalled();
        expect(mocks.buildSearchIndex).not.toHaveBeenCalled();
    });

    it('releases the resident JS index after a search the native sidecar answered', async () => {
        process.env.EVB_PDF_SEARCH_ENABLE = '1';
        mocks.stat.mockImplementation(async (path: string) => {
            if (path.endsWith('.pdf')) {
                return { mtimeMs: 10 };
            }
            if (path.endsWith('.index.json')) {
                return { mtimeMs: 20 };
            }
            throw new Error(`Unexpected stat path: ${path}`);
        });

        await import('@electron/features/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        expect(handleMessage).toBeTypeOf('function');

        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'evict-warm',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: '',
                pageCount: 1,
                warmup: true,
            },
        });
        await vi.waitFor(() => {
            expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(1);
        });

        mocks.tryRunNativeSearch.mockResolvedValue({
            response: {
                results: [],
                truncated: false,
            },
            totalPages: 1,
        });
        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'evict-native',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: 'needle',
                pageCount: 1,
            },
        });
        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                type: 'complete',
                requestId: 'evict-native',
            }));
        });

        mocks.loadSearchIndex.mockClear();
        mocks.tryRunNativeSearch.mockResolvedValue(null);
        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'evict-js',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: PAGE_TEXT,
                pageCount: 1,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.loadSearchIndex).toHaveBeenCalled();
        });
    });

    it('builds and warms index on explicit warmup requests', async () => {
        await import('@electron/features/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        expect(handleMessage).toBeTypeOf('function');

        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'warm-1',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: '',
                pageCount: 1,
                warmup: true,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(1);
        });
        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual({
                type: 'complete',
                requestId: 'warm-1',
                response: {
                    results: [],
                    truncated: false,
                },
            });
        });
    });

    it('singleflights concurrent warmup index builds for the same document revision', async () => {
        let resolveBuild!: () => void;
        mocks.buildSearchIndex.mockImplementation(async () => new Promise((resolve) => {
            resolveBuild = () => resolve({
                schemaVersion: 7,
                documentRevision: {token: DOCUMENT_REVISION},
                pdfPath: TEST_PDF_PATH,
                createdAt: Date.now(),
                pageCount: 1,
                pages: [{
                    pageNumber: 1,
                    text: PAGE_TEXT,
                }],
            });
        }));

        await import('@electron/features/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        expect(handleMessage).toBeTypeOf('function');

        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'warm-singleflight-1',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: '',
                pageCount: 1,
                warmup: true,
            },
        });
        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'warm-singleflight-2',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: '',
                pageCount: 1,
                warmup: true,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(1);
        });

        resolveBuild();

        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual({
                type: 'complete',
                requestId: 'warm-singleflight-1',
                response: {
                    results: [],
                    truncated: false,
                },
            });
            expect(mocks.postedMessages).toContainEqual({
                type: 'complete',
                requestId: 'warm-singleflight-2',
                response: {
                    results: [],
                    truncated: false,
                },
            });
        });
        expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(1);
    });

    it('streams newly discovered search results as deltas while carrying page rotation', async () => {
        const firstPage: IIndexedSearchPageForTest = {
            pageNumber: 1,
            text: 'needle \n',
            pageWidth: 200,
            pageHeight: 100,
            rotation: 90,
            words: [{
                text: 'needle',
                x: 10,
                y: 20,
                width: 30,
                height: 40,
            }],
        };
        const secondPage: IIndexedSearchPageForTest = {
            pageNumber: 2,
            text: 'needle \n',
        };
        mocks.buildSearchIndex.mockImplementation(async (
            _pdfPath: string,
            _pageData: unknown[],
            options: IBuildSearchIndexOptionsForTest,
        ) => {
            options.onPageIndexed?.(firstPage);
            options.onPageIndexed?.(secondPage);
            return {
                schemaVersion: 7,
                documentRevision: {token: DOCUMENT_REVISION},
                pdfPath: TEST_PDF_PATH,
                createdAt: Date.now(),
                pageCount: 2,
                pages: [
                    firstPage,
                    secondPage,
                ],
            };
        });

        await import('@electron/features/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        expect(handleMessage).toBeTypeOf('function');

        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'stream-delta-1',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: 'needle',
                pageCount: 2,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                type: 'complete',
                requestId: 'stream-delta-1',
            }));
        });

        const resultProgressMessages = mocks.postedMessages.filter(message => (
            message.type === 'progress'
            && message.requestId === 'stream-delta-1'
            && Array.isArray(message.results)
        ));

        expect(resultProgressMessages).toEqual([
            expect.objectContaining({
                resultsStartIndex: 0,
                results: [expect.objectContaining({
                    pageNumber: 1,
                    matchIndex: 0,
                    pageWidth: 200,
                    pageHeight: 100,
                    rotation: 90,
                    words: [expect.objectContaining({ text: 'needle' })],
                })],
                truncated: false,
            }),
            expect.objectContaining({
                resultsStartIndex: 1,
                results: [expect.objectContaining({
                    pageNumber: 2,
                    matchIndex: 1,
                })],
                truncated: false,
            }),
        ]);
        expect(resultProgressMessages[1]?.results).toHaveLength(1);
    });

    it('keeps an exact-limit stream untruncated while later pages have no matches', async () => {
        const limitPage: IIndexedSearchPageForTest = {
            pageNumber: 1,
            text: `${'needle '.repeat(100)}\n`,
        };
        const emptyPage: IIndexedSearchPageForTest = {
            pageNumber: 2,
            text: 'no match here',
        };
        const anotherEmptyPage: IIndexedSearchPageForTest = {
            pageNumber: 3,
            text: 'still no match',
        };
        mocks.buildSearchIndex.mockImplementation(async (
            _pdfPath: string,
            _pageData: unknown[],
            options: IBuildSearchIndexOptionsForTest,
        ) => {
            options.onPageIndexed?.(limitPage);
            options.onPageIndexed?.(emptyPage);
            options.onPageIndexed?.(anotherEmptyPage);
            return {
                schemaVersion: 7,
                documentRevision: {token: DOCUMENT_REVISION},
                pdfPath: TEST_PDF_PATH,
                createdAt: Date.now(),
                pages: [
                    limitPage,
                    emptyPage,
                    anotherEmptyPage,
                ],
            };
        });

        await import('@electron/features/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'stream-limit-1',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: 'needle',
                pageCount: 3,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                type: 'complete',
                requestId: 'stream-limit-1',
                response: expect.objectContaining({
                    results: expect.any(Array),
                    truncated: false,
                }),
            }));
        });

        expect(mocks.postedMessages).not.toContainEqual(expect.objectContaining({
            type: 'progress',
            requestId: 'stream-limit-1',
            truncated: true,
        }));
    });

    it('marks an exact-limit stream as truncated when a later page adds one match', async () => {
        const limitPage: IIndexedSearchPageForTest = {
            pageNumber: 1,
            text: `${'needle '.repeat(100)}\n`,
        };
        const laterPage: IIndexedSearchPageForTest = {
            pageNumber: 2,
            text: 'needle on a later page',
        };
        mocks.buildSearchIndex.mockImplementation(async (
            _pdfPath: string,
            _pageData: unknown[],
            options: IBuildSearchIndexOptionsForTest,
        ) => {
            options.onPageIndexed?.(limitPage);
            options.onPageIndexed?.(laterPage);
            return {
                schemaVersion: 7,
                documentRevision: {token: DOCUMENT_REVISION},
                pdfPath: TEST_PDF_PATH,
                createdAt: Date.now(),
                pages: [
                    limitPage,
                    laterPage,
                ],
            };
        });

        await import('@electron/features/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'stream-limit-extra-1',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: 'needle',
            },
        });

        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                type: 'complete',
                requestId: 'stream-limit-extra-1',
                response: expect.objectContaining({
                    results: expect.any(Array),
                    truncated: true,
                }),
            }));
        });

        expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
            type: 'progress',
            requestId: 'stream-limit-extra-1',
            results: [],
            resultsStartIndex: 100,
            truncated: true,
        }));
    });

    it('evicts the oldest cached index once the default cache budget is exceeded', async () => {
        await import('@electron/features/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        expect(handleMessage).toBeTypeOf('function');

        const pdfPaths = [
            '/tmp/search-a.pdf',
            '/tmp/search-b.pdf',
            '/tmp/search-c.pdf',
            '/tmp/search-a.pdf',
        ];

        for (let index = 0; index < pdfPaths.length; index += 1) {
            const pdfPath = pdfPaths[index];
            handleMessage?.({
                type: 'search',
                payload: {
                    requestId: `warm-${index}`,
                    pdfPath,
                    documentRevision: DOCUMENT_REVISION,
                    query: '',
                    pageCount: 1,
                    warmup: true,
                },
            });
            await vi.waitFor(() => {
                expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                    type: 'complete',
                    requestId: `warm-${index}`,
                }));
            });
        }

        expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(4);
    });

    it('validates workerData and evicts retained text above the low-tier 48 MiB budget', async () => {
        const MIB = 1024 * 1024;
        mocks.workerData = {
            nativeServiceIdleTimeoutMs: 60_000,
            resourcePolicy: {
                indexCacheMaxEntries: 2,
                indexCacheTtlMs: 120_000,
                maxPageTextBytes: 2 * MIB,
                maxTotalTextBytes: 48 * MIB,
            },
        };
        const pageText = 'x'.repeat(MIB);
        mocks.buildSearchIndex.mockImplementation(async (pdfPath: string) => ({
            schemaVersion: 7,
            documentRevision: {token: DOCUMENT_REVISION},
            pdfPath,
            createdAt: Date.now(),
            pageCount: 25,
            pages: Array.from({length: 25}, (_, index) => ({
                pageNumber: index + 1,
                text: pageText,
            })),
        }));

        await import('@electron/features/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        for (const [
            index,
            pdfPath,
        ] of [
                '/tmp/search-budget-a.pdf',
                '/tmp/search-budget-b.pdf',
                '/tmp/search-budget-a.pdf',
            ].entries()) {
            handleMessage?.({
                type: 'search',
                payload: {
                    requestId: `budget-${index}`,
                    pdfPath,
                    documentRevision: DOCUMENT_REVISION,
                    query: '',
                    pageCount: 25,
                    warmup: true,
                },
            });
            await vi.waitFor(() => {
                expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                    type: 'complete',
                    requestId: `budget-${index}`,
                }));
            });
        }

        expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(3);
    });

    it('rejects malformed workerData instead of applying in-process defaults', async () => {
        mocks.workerData = {
            nativeServiceIdleTimeoutMs: 60_000,
            resourcePolicy: {
                indexCacheMaxEntries: 1,
                indexCacheTtlMs: 120_000,
                maxPageTextBytes: 2 * 1024 * 1024,
                maxTotalTextBytes: 0,
            },
        };

        await expect(import('@electron/features/search/worker'))
            .rejects.toThrow('Invalid search workerData');
        expect(mocks.parentPort.on).not.toHaveBeenCalled();
    });

    it('does not materialize lowercase page copies across repeated searches', async () => {
        const originalToLowerCase = String.prototype.toLowerCase;
        let pageTextLowerCalls = 0;
        const toLowerSpy = vi
            .spyOn(String.prototype, 'toLowerCase')
            .mockImplementation(function toLowerCasePatched(this: string) {
                if (String(this) === PAGE_TEXT) {
                    pageTextLowerCalls += 1;
                }
                return originalToLowerCase.call(String(this));
            });

        try {
            await import('@electron/features/search/worker');
            const handleMessage = mocks.messageHandlers.get('message');
            expect(handleMessage).toBeTypeOf('function');

            handleMessage?.({
                type: 'search',
                payload: {
                    requestId: 'search-1',
                    pdfPath: TEST_PDF_PATH,
                    documentRevision: DOCUMENT_REVISION,
                    query: 'unique',
                    pageCount: 1,
                },
            });
            await vi.waitFor(() => {
                expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                    type: 'complete',
                    requestId: 'search-1',
                }));
            });

            handleMessage?.({
                type: 'search',
                payload: {
                    requestId: 'search-2',
                    pdfPath: TEST_PDF_PATH,
                    documentRevision: DOCUMENT_REVISION,
                    query: 'text',
                    pageCount: 1,
                },
            });
            await vi.waitFor(() => {
                expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                    type: 'complete',
                    requestId: 'search-2',
                }));
            });

            expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(1);
            expect(pageTextLowerCalls).toBe(0);
        } finally {
            toLowerSpy.mockRestore();
        }
    });

    it('rebuilds stale on-disk indexes from the previous schema', async () => {
        mocks.loadSearchIndex.mockResolvedValue({
            pdfPath: TEST_PDF_PATH,
            createdAt: Date.now(),
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: PAGE_TEXT,
            }],
        });

        await import('@electron/features/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        expect(handleMessage).toBeTypeOf('function');

        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'warm-stale',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: '',
                pageCount: 1,
                warmup: true,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(1);
        });
    });

    it('rebuilds current-schema on-disk indexes when the PDF is newer', async () => {
        mocks.loadSearchIndex.mockResolvedValue({
            schemaVersion: 7,
            documentRevision: {token: DOCUMENT_REVISION},
            pdfPath: TEST_PDF_PATH,
            createdAt: Date.now(),
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: PAGE_TEXT,
            }],
        });

        await import('@electron/features/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        expect(handleMessage).toBeTypeOf('function');

        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'warm-source-newer',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: '',
                pageCount: 1,
                warmup: true,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(1);
        });
        expect(mocks.loadSearchIndex).not.toHaveBeenCalled();
    });

    it('streams matches while a stale index is being rebuilt', async () => {
        mocks.buildSearchIndex.mockImplementation(async (
            _pdfPath: string,
            _pageData: unknown[],
            options: IBuildSearchIndexOptionsForTest,
        ) => {
            options.onPageIndexed?.({
                pageNumber: 1,
                text: 'needle on the first page',
            });
            return {
                schemaVersion: 7,
                documentRevision: {token: DOCUMENT_REVISION},
                pdfPath: TEST_PDF_PATH,
                createdAt: Date.now(),
                pageCount: 2,
                pages: [
                    {
                        pageNumber: 1,
                        text: 'needle on the first page',
                    },
                    {
                        pageNumber: 2,
                        text: 'second page',
                    },
                ],
            };
        });

        await import('@electron/features/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        expect(handleMessage).toBeTypeOf('function');

        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'search-stream',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: 'needle',
                pageCount: 2,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                type: 'progress',
                requestId: 'search-stream',
                results: [expect.objectContaining({
                    pageNumber: 1,
                    startOffset: 0,
                    endOffset: 6,
                })],
                truncated: false,
            }));
        });
        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                type: 'complete',
                requestId: 'search-stream',
            }));
        });
    });

    it('routes xlarge warmup through the streaming builder without the legacy index', async () => {
        const pageCount = 1_000_001;
        mocks.stat.mockResolvedValue({
            mtimeMs: 10,
            size: 17 * 1024 * 1024,
        });
        mocks.buildXlargeSearchIndex.mockImplementation(async (options: {
            pageCount: number;
            onProgress?: (progress: {
                complete: boolean;
                pageCount: number;
                pagesScanned: number;
                pagesWritten: number;
                textBytes: number;
                truncated: boolean;
                documentRevision: string;
            }) => void;
        }) => {
            options.onProgress?.({
                complete: false,
                documentRevision: DOCUMENT_REVISION,
                pageCount: options.pageCount,
                pagesScanned: options.pageCount,
                pagesWritten: 1,
                textBytes: PAGE_TEXT.length,
                truncated: false,
            });
            options.onProgress?.({
                complete: true,
                documentRevision: DOCUMENT_REVISION,
                pageCount: options.pageCount,
                pagesScanned: options.pageCount,
                pagesWritten: 1,
                textBytes: PAGE_TEXT.length,
                truncated: false,
            });
            return {
                indexPath: `${TEST_PDF_PATH}.index.evb-search-v2.bin`,
                documentRevision: DOCUMENT_REVISION,
                pageCount: options.pageCount,
                pagesScanned: options.pageCount,
                pagesWritten: 1,
                textBytes: PAGE_TEXT.length,
                truncated: false,
                complete: true,
            };
        });

        await import('@electron/features/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'xlarge-warmup',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: '',
                pageCount,
                warmup: true,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual({
                type: 'complete',
                requestId: 'xlarge-warmup',
                response: {
                    results: [],
                    truncated: false,
                },
            });
        });
        expect(mocks.buildXlargeSearchIndex).toHaveBeenCalledOnce();
        expect(mocks.buildXlargeSearchIndex.mock.calls[0]?.[0]).not.toHaveProperty('maxPageTextBytes');
        expect(mocks.buildXlargeSearchIndex.mock.calls[0]?.[0]).not.toHaveProperty('maxTotalTextBytes');
        expect(mocks.buildSearchIndex).not.toHaveBeenCalled();
        expect(mocks.loadSearchIndex).not.toHaveBeenCalled();
        expect(mocks.tryRunNativeSearch).not.toHaveBeenCalled();

        const progress = mocks.postedMessages.filter(message => (
            message.type === 'progress' && message.requestId === 'xlarge-warmup'
        ));
        expect(progress[0]).toEqual(expect.objectContaining({
            processed: pageCount - 1,
            total: pageCount,
        }));
        expect(progress.at(-1)).toEqual(expect.objectContaining({
            processed: pageCount,
            total: pageCount,
        }));
    });

    it('coalesces xlarge warmups for the same revision', async () => {
        const pageCount = 1_000_001;
        let resolveBuild!: () => void;
        mocks.stat.mockResolvedValue({
            mtimeMs: 10,
            size: 17 * 1024 * 1024,
        });
        mocks.buildXlargeSearchIndex.mockImplementation(async () => new Promise((resolve) => {
            resolveBuild = () => resolve({
                indexPath: `${TEST_PDF_PATH}.index.evb-search-v2.bin`,
                documentRevision: DOCUMENT_REVISION,
                pageCount,
                pagesScanned: pageCount,
                pagesWritten: 1,
                textBytes: PAGE_TEXT.length,
                truncated: false,
                complete: true,
            });
        }));

        await import('@electron/features/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        for (const requestId of [
            'xlarge-warmup-1',
            'xlarge-warmup-2',
        ]) {
            handleMessage?.({
                type: 'search',
                payload: {
                    requestId,
                    pdfPath: TEST_PDF_PATH,
                    documentRevision: DOCUMENT_REVISION,
                    query: '',
                    pageCount,
                    warmup: true,
                },
            });
        }

        await vi.waitFor(() => expect(mocks.buildXlargeSearchIndex).toHaveBeenCalledOnce());
        resolveBuild();
        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                type: 'complete',
                requestId: 'xlarge-warmup-1',
            }));
            expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                type: 'complete',
                requestId: 'xlarge-warmup-2',
            }));
        });
        expect(mocks.buildSearchIndex).not.toHaveBeenCalled();
        expect(mocks.loadSearchIndex).not.toHaveBeenCalled();
    });

    it('rebuilds a missing xlarge sidecar once, then searches natively', async () => {
        const pageCount = 1_000_001;
        mocks.stat.mockResolvedValue({
            mtimeMs: 10,
            size: 17 * 1024 * 1024,
        });
        mocks.tryRunNativeSearch
            .mockRejectedValueOnce({
                kind: 'index-missing-or-stale',
                message: 'missing sidecar',
            })
            .mockResolvedValueOnce({
                response: {
                    results: [],
                    truncated: false,
                },
                totalPages: pageCount,
            });
        mocks.buildXlargeSearchIndex.mockResolvedValue({
            indexPath: `${TEST_PDF_PATH}.index.evb-search-v2.bin`,
            documentRevision: DOCUMENT_REVISION,
            pageCount,
            pagesScanned: pageCount,
            pagesWritten: 1,
            textBytes: PAGE_TEXT.length,
            truncated: false,
            complete: true,
        });

        await import('@electron/features/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'xlarge-rebuild',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: 'needle',
                pageCount,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                type: 'complete',
                requestId: 'xlarge-rebuild',
            }));
        });
        expect(mocks.tryRunNativeSearch).toHaveBeenCalledTimes(2);
        expect(mocks.tryRunNativeSearch.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            strictXlarge: true,
            skipLegacyGeometry: true,
            pageCount,
        }));
        expect(mocks.buildXlargeSearchIndex).toHaveBeenCalledOnce();
        expect(mocks.buildSearchIndex).not.toHaveBeenCalled();
        expect(mocks.loadSearchIndex).not.toHaveBeenCalled();
    });

    it('fails closed on xlarge native failure without a JS fallback', async () => {
        const pageCount = 1_000_001;
        mocks.stat.mockResolvedValue({
            mtimeMs: 10,
            size: 17 * 1024 * 1024,
        });
        mocks.tryRunNativeSearch.mockRejectedValue({
            kind: 'native-failure',
            message: 'native unavailable',
        });

        await import('@electron/features/search/worker');
        const handleMessage = mocks.messageHandlers.get('message');
        handleMessage?.({
            type: 'search',
            payload: {
                requestId: 'xlarge-native-failure',
                pdfPath: TEST_PDF_PATH,
                documentRevision: DOCUMENT_REVISION,
                query: 'needle',
                pageCount,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.postedMessages).toContainEqual(expect.objectContaining({
                type: 'error',
                requestId: 'xlarge-native-failure',
            }));
        });
        expect(mocks.buildXlargeSearchIndex).not.toHaveBeenCalled();
        expect(mocks.buildSearchIndex).not.toHaveBeenCalled();
        expect(mocks.loadSearchIndex).not.toHaveBeenCalled();
    });
});
