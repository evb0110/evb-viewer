import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

const mocks = vi.hoisted(() => ({
    rm: vi.fn(),
    stat: vi.fn(),
    buildSearchIndex: vi.fn(),
    loadSearchIndex: vi.fn(),
}));

vi.mock('fs/promises', () => ({
    rm: mocks.rm,
    stat: mocks.stat,
}));

vi.mock('@electron/features/search/indexBuilder', () => ({
    SEARCH_INDEX_SCHEMA_VERSION: 7,
    buildSearchIndex: mocks.buildSearchIndex,
    loadSearchIndex: mocks.loadSearchIndex,
}));

const PDF_PATH = '/tmp/poisoned.pdf';
const DOCUMENT_REVISION = requireDocumentRevisionToken('revision-token');

function createAbortError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

interface IIndexPageForTest {
    pageNumber: number;
    text: string;
}

interface IIndexForTest { pages: IIndexPageForTest[]; }

interface IBuildSearchIndexOptionsForTest {
    pageCount?: number;
    signal?: AbortSignal;
    onPageIndexed?: (page: IIndexPageForTest) => void;
    validateBeforePersist?: (index: IIndexForTest) => void;
}

describe('ensureSearchIndex', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        delete process.env.EVB_PDF_SEARCH_ENABLE;

        mocks.rm.mockResolvedValue(undefined);
        mocks.stat.mockImplementation(async (path: string) => {
            if (path === PDF_PATH) {
                return { mtimeMs: 1 };
            }
            if (path === `${PDF_PATH}.index.json`) {
                return { mtimeMs: 10 };
            }
            throw new Error(`Unexpected stat path: ${path}`);
        });
        mocks.loadSearchIndex.mockResolvedValue({
            schemaVersion: 7,
            documentRevision: {token: DOCUMENT_REVISION},
            pdfPath: PDF_PATH,
            createdAt: 1,
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: 'x'.repeat(128),
            }],
        });
        mocks.buildSearchIndex.mockResolvedValue({
            schemaVersion: 7,
            documentRevision: {token: DOCUMENT_REVISION},
            pdfPath: PDF_PATH,
            createdAt: 2,
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: 'healed',
            }],
        });
    });

    it('deletes an over-budget cached JSON index and rebuilds it once', async () => {
        const { ensureSearchIndex } = await import('@electron/features/search/worker/ensureSearchIndex');

        const entry = await ensureSearchIndex(new Map(), PDF_PATH, {
            maxEntries: 4,
            ttlMs: 60_000,
            maxPageTextBytes: 64,
            maxTotalTextBytes: 1024,
        }, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
            throwIfCancelled: () => undefined,
        });

        expect(mocks.rm).toHaveBeenCalledWith(`${PDF_PATH}.index.json`, { force: true });
        expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(1);
        expect(mocks.buildSearchIndex).toHaveBeenCalledWith(PDF_PATH, [], expect.objectContaining({ pageCount: 1 }));
        expect(entry.index.pages).toEqual([{
            pageNumber: 1,
            text: 'healed',
        }]);
    });

    it('accepts a complete index that holds no extractable text without rebuilding it', async () => {
        const { ensureSearchIndex } = await import('@electron/features/search/worker/ensureSearchIndex');
        mocks.loadSearchIndex.mockResolvedValue({
            schemaVersion: 7,
            documentRevision: {token: DOCUMENT_REVISION},
            pdfPath: PDF_PATH,
            createdAt: 1,
            pageCount: 2,
            pages: [
                {
                    pageNumber: 1,
                    text: '',
                },
                {
                    pageNumber: 2,
                    text: '',
                },
            ],
        });

        const entry = await ensureSearchIndex(new Map(), PDF_PATH, {
            maxEntries: 4,
            ttlMs: 60_000,
            maxPageTextBytes: 1024,
            maxTotalTextBytes: 4096,
        }, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2,
            throwIfCancelled: () => undefined,
        });

        expect(mocks.buildSearchIndex).not.toHaveBeenCalled();
        expect(entry.index.pages).toHaveLength(2);
    });

    it('stops rebuilding when a build cannot satisfy the expected page count', async () => {
        const { ensureSearchIndex } = await import('@electron/features/search/worker/ensureSearchIndex');
        const shortIndex = {
            schemaVersion: 7,
            documentRevision: {token: DOCUMENT_REVISION},
            pdfPath: PDF_PATH,
            createdAt: 2,
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                text: 'only page',
            }],
        };
        mocks.loadSearchIndex.mockResolvedValue(shortIndex);
        mocks.buildSearchIndex.mockResolvedValue(shortIndex);

        const entry = await ensureSearchIndex(new Map(), PDF_PATH, {
            maxEntries: 4,
            ttlMs: 60_000,
            maxPageTextBytes: 1024,
            maxTotalTextBytes: 4096,
        }, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 3,
            throwIfCancelled: () => undefined,
        });

        expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(2);
        expect(entry.index.pages).toHaveLength(1);
    });

    it('passes the text budget validator into index builds before persistence', async () => {
        const { ensureSearchIndex } = await import('@electron/features/search/worker/ensureSearchIndex');
        mocks.stat.mockImplementation(async (path: string) => {
            if (path === PDF_PATH) {
                return { mtimeMs: 1 };
            }
            throw new Error(`Missing ${path}`);
        });
        mocks.loadSearchIndex.mockResolvedValue(null);
        mocks.buildSearchIndex.mockImplementation(async (
            _pdfPath: string,
            _pageData: unknown[],
            options: IBuildSearchIndexOptionsForTest,
        ) => {
            const overBudgetIndex: IIndexForTest = { pages: [] };
            overBudgetIndex.pages.push({
                pageNumber: 1,
                text: 'x'.repeat(128),
            });
            options.validateBeforePersist?.(overBudgetIndex);
            throw new Error('validator should have rejected');
        });

        await expect(ensureSearchIndex(new Map(), PDF_PATH, {
            maxEntries: 4,
            ttlMs: 60_000,
            maxPageTextBytes: 64,
            maxTotalTextBytes: 1024,
        }, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
            throwIfCancelled: () => undefined,
        })).rejects.toThrow('Search index page 1 is too large');
    });

    it('keeps a shared index build alive when one waiter stream callback aborts', async () => {
        const { ensureSearchIndex } = await import('@electron/features/search/worker/ensureSearchIndex');
        mocks.stat.mockImplementation(async (path: string) => {
            if (path === PDF_PATH) {
                return { mtimeMs: 1 };
            }
            throw new Error(`Missing ${path}`);
        });
        mocks.loadSearchIndex.mockResolvedValue(null);

        let emitIndexedPage: () => void = () => {
            throw new Error('Build has not started');
        };
        let resolveBuild: () => void = () => {
            throw new Error('Build has not started');
        };
        mocks.buildSearchIndex.mockImplementation(async (
            _pdfPath: string,
            _pageData: unknown[],
            options: IBuildSearchIndexOptionsForTest,
        ) => new Promise((resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(createAbortError()), { once: true });
            emitIndexedPage = () => {
                options.onPageIndexed?.({
                    pageNumber: 1,
                    text: 'needle',
                });
            };
            resolveBuild = () => resolve({
                schemaVersion: 7,
                documentRevision: {token: DOCUMENT_REVISION},
                pdfPath: PDF_PATH,
                createdAt: 2,
                pageCount: 1,
                pages: [{
                    pageNumber: 1,
                    text: 'needle',
                }],
            });
        }));

        const firstController = new AbortController();
        const firstStream = vi.fn(() => {
            throw createAbortError();
        });
        const secondStream = vi.fn();

        const firstWaiter = ensureSearchIndex(new Map(), PDF_PATH, {
            maxEntries: 4,
            ttlMs: 60_000,
            maxPageTextBytes: 1024,
            maxTotalTextBytes: 1024,
        }, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
            signal: firstController.signal,
            throwIfCancelled: signal => {
                if (signal?.aborted) {
                    throw createAbortError();
                }
            },
            onPageIndexed: firstStream,
        });
        const secondWaiter = ensureSearchIndex(new Map(), PDF_PATH, {
            maxEntries: 4,
            ttlMs: 60_000,
            maxPageTextBytes: 1024,
            maxTotalTextBytes: 1024,
        }, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
            throwIfCancelled: () => undefined,
            onPageIndexed: secondStream,
        });

        await vi.waitFor(() => {
            expect(mocks.buildSearchIndex).toHaveBeenCalledOnce();
        });

        emitIndexedPage();
        firstController.abort(createAbortError());
        resolveBuild();

        await expect(firstWaiter).rejects.toMatchObject({ name: 'AbortError' });
        const secondEntry = await secondWaiter;
        expect(secondEntry.index.pages).toEqual([expect.objectContaining({
            pageNumber: 1,
            text: 'needle',
        })]);
        expect(firstStream).toHaveBeenCalledOnce();
        expect(secondStream).toHaveBeenCalledWith(expect.objectContaining({
            pageNumber: 1,
            text: 'needle',
        }));
        expect(mocks.buildSearchIndex).toHaveBeenCalledOnce();
    });

    it('replaces an unknown-count in-flight build with a counted build', async () => {
        const { ensureSearchIndex } = await import('@electron/features/search/worker/ensureSearchIndex');
        mocks.stat.mockImplementation(async (path: string) => {
            if (path === PDF_PATH) {
                return { mtimeMs: 1 };
            }
            throw new Error(`Missing ${path}`);
        });
        mocks.loadSearchIndex.mockResolvedValue(null);

        let firstSignal: AbortSignal | undefined;
        let resolveFirst!: () => void;
        let resolveSecond!: () => void;
        mocks.buildSearchIndex.mockImplementation(async (
            _pdfPath: string,
            _pageData: unknown[],
            options: IBuildSearchIndexOptionsForTest,
        ) => new Promise((resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(createAbortError()), { once: true });
            if (mocks.buildSearchIndex.mock.calls.length === 1) {
                firstSignal = options.signal;
                resolveFirst = () => resolve({
                    schemaVersion: 7,
                    documentRevision: {token: DOCUMENT_REVISION},
                    pdfPath: PDF_PATH,
                    createdAt: 2,
                    pages: [{
                        pageNumber: 1,
                        text: 'unknown-count',
                    }],
                });
                return;
            }
            resolveSecond = () => resolve({
                schemaVersion: 7,
                documentRevision: {token: DOCUMENT_REVISION},
                pdfPath: PDF_PATH,
                createdAt: 3,
                pageCount: 2136,
                pages: Array.from({ length: 2136 }, (_value, index) => ({
                    pageNumber: index + 1,
                    text: index === 0 ? 'counted' : '',
                })),
            });
        }));

        const cache = new Map();
        const unknownBuild = ensureSearchIndex(cache, PDF_PATH, {
            maxEntries: 4,
            ttlMs: 60_000,
            maxPageTextBytes: 1024,
            maxTotalTextBytes: 4096,
        }, {
            documentRevision: DOCUMENT_REVISION,
            throwIfCancelled: signal => {
                if (signal?.aborted) {
                    throw createAbortError();
                }
            },
        });
        const unknownOutcome = unknownBuild.catch(error => error);

        await vi.waitFor(() => {
            expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(1);
        });

        const countedBuild = ensureSearchIndex(cache, PDF_PATH, {
            maxEntries: 4,
            ttlMs: 60_000,
            maxPageTextBytes: 1024,
            maxTotalTextBytes: 4096,
        }, {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2136,
            throwIfCancelled: () => undefined,
        });

        await vi.waitFor(() => {
            expect(mocks.buildSearchIndex).toHaveBeenCalledTimes(2);
        });
        expect(firstSignal?.aborted).toBe(true);
        expect(mocks.buildSearchIndex.mock.calls[1]?.[2]).toEqual(expect.objectContaining({ pageCount: 2136 }));

        resolveSecond();
        const countedEntry = await countedBuild;

        expect(countedEntry.index.pageCount).toBe(2136);
        expect(countedEntry.index.pages[0]).toEqual(expect.objectContaining({ text: 'counted' }));
        await expect(unknownOutcome).resolves.toMatchObject({ name: 'AbortError' });

        resolveFirst();
    });
});
