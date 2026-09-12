import type * as TViMockOriginalModule from '@app/platform/browser-api/browserYield';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { readFileSync } from 'fs';
import { buildPdfSearchExcerpt } from '@pdf-core';
import {FakeIndexedDbFactory} from '@tests/unit/app/platform/browserPlatformTestDoubles';
import {requireRequestId} from '@contracts/shared';

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

interface ISearchConformanceCorpus {cases: ISearchConformanceCase[];}

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

const searchConformanceCorpus = JSON.parse(readFileSync(
    new URL('../../../../packages/contracts/searchConformanceCorpus.json', import.meta.url),
    'utf8',
)) as ISearchConformanceCorpus;

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
    getDocumentRevision: vi.fn(),
    read: vi.fn(),
    readRange: vi.fn(),
}));
const browserSearchWorkerClientMock = vi.hoisted(() => ({
    canUseBrowserSearchWorker: vi.fn(() => false),
    createBrowserSearchWorkerRequest: vi.fn(),
    createBrowserSearchWorkerPageStreamRequest: vi.fn(),
    cancelBrowserSearchWorkerRequest: vi.fn(async () => {}),
    BrowserSearchWorkerUnavailableError: class BrowserSearchWorkerUnavailableError extends Error {},
    BrowserSearchWorkerTimeoutError: class BrowserSearchWorkerTimeoutError extends Error {},
}));
const pdfjsModule = vi.hoisted(() => ({
    version: '6.3.311',
    GlobalWorkerOptions: { workerSrc: undefined as string | undefined },
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
    createBrowserSearchWorkerPageStreamRequest: (payload: unknown) =>
        (
            browserSearchWorkerClientMock.createBrowserSearchWorkerPageStreamRequest as (
                nextPayload: unknown,
            ) => unknown
        )(payload),
    cancelBrowserSearchWorkerRequest: (requestId: unknown) =>
        (
            browserSearchWorkerClientMock.cancelBrowserSearchWorkerRequest as (
                nextRequestId: unknown,
            ) => unknown
        )(requestId),
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
        vi.doUnmock('@app/platform/browser-api/browserSearchLimits');
        vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
        yieldToBrowserMock.mockClear();
        browserDocumentStoreMock.stat.mockReset();
        browserDocumentStoreMock.getContentSignature.mockReset();
        browserDocumentStoreMock.getContentSignature.mockResolvedValue('content-token-1');
        browserDocumentStoreMock.getDocumentRevision.mockReset();
        browserDocumentStoreMock.getDocumentRevision.mockImplementation(async (documentRef: string) =>
            makeBrowserRevision(documentRef, 'drt1:browser:content-token-1'));
        browserDocumentStoreMock.read.mockReset();
        browserDocumentStoreMock.readRange.mockReset();
        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReset();
        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReturnValue(false);
        browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mockReset();
        browserSearchWorkerClientMock.createBrowserSearchWorkerPageStreamRequest.mockReset();
        browserSearchWorkerClientMock.cancelBrowserSearchWorkerRequest.mockReset();
        browserSearchWorkerClientMock.cancelBrowserSearchWorkerRequest.mockResolvedValue(undefined);
        pdfjsModule.getDocument.mockReset();
    });

    it('returns an observable cache-clear rejection and allows the caller to retry', async () => {
        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { clearSearchCaches } = createBrowserSearchCapability();
        await clearSearchCaches();
        const database = requireFakeIndexedDbFactory()
            .getDatabase('evb-browser-search-cache');
        database?.rejectNextTransaction(new Error('clear transaction failed'));

        await expect(clearSearchCaches()).rejects.toThrow('clear transaction failed');
        await expect(clearSearchCaches()).resolves.toBeUndefined();
    });

    it('does not reuse persisted browser page text for geometry-required search runs', async () => {
        const pageTexts = Array.from(
            { length: 30 },
            (_value, index) => `page ${index + 1} foo`,
        );
        const cleanup = vi.fn(async () => {});
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: vi.fn(async () => ({items: [{str: pageTexts[pageNumber - 1] ?? ''}]})),
            cleanup,
        }));
        const destroy = vi.fn(async () => {});
        const fakePdfDocument = {
            numPages: pageTexts.length,
            getPage,
            destroy,
        };

        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        pdfjsModule.getDocument.mockReturnValue({promise: Promise.resolve(fakePdfDocument)});

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const firstCapability = createBrowserSearchCapability().capability;
        const firstRun = await firstCapability.run('/tmp/test.pdf', 'foo');
        const secondCapability = createBrowserSearchCapability().capability;
        const secondRun = await secondCapability.run('/tmp/test.pdf', 'foo');

        expect(firstRun.results).toHaveLength(30);
        expect(secondRun.results).toHaveLength(30);
        expect(browserDocumentStoreMock.stat).toHaveBeenCalledTimes(6);
        expect(browserDocumentStoreMock.readRange).toHaveBeenCalledTimes(2);
        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(2);
        expect(yieldToBrowserMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(getPage).toHaveBeenCalledTimes(60);
        expect(destroy).toHaveBeenCalledTimes(2);
        expect(cleanup).toHaveBeenCalledTimes(60);
    });

    it('extracts browser search text from the current PDF bytes without OCR sidecars', async () => {
        const pdfPath = 'browser://documents/test/search.pdf';
        const getPage = vi.fn(async () => ({
            getTextContent: vi.fn(async () => ({items: [{str: 'pdf fallback needle'}]})),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: 1,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
        const result = await capability.run(pdfPath, 'fallback');

        expect(result.results).toEqual([expect.objectContaining({ pageNumber: 1 })]);
        expect(pdfjsModule.getDocument).toHaveBeenCalledOnce();
        expect(getPage).toHaveBeenCalledOnce();
    });

    it('executes regex page matching in the browser search worker and keeps UTF-16 offsets', async () => {
        const pageText = '😀 needle';
        const getPage = vi.fn(async () => ({
            getTextContent: vi.fn(async () => ({items: [{str: pageText}]})),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: 1,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReturnValue(true);
        browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mockReturnValue({
            requestId: 41,
            promise: Promise.resolve({
                matches: [{
                    startOffset: 3,
                    endOffset: 9,
                }],
                truncated: false,
            }),
        });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
        const result = await capability.run('/tmp/regex.pdf', 'n.edle', {
            matchCase: true,
            useRegex: true,
            requestId: requireRequestId('regex-worker'),
        });

        expect(result.results).toEqual([expect.objectContaining({
            startOffset: 3,
            endOffset: 9,
            excerpt: expect.objectContaining({match: 'needle'}),
        })]);
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
                deadlineAtMs: expect.any(Number),
            },
            expect.objectContaining({
                timeoutMs: 1_250,
                resetWorkerOnTimeout: true,
            }),
        );
    });

    it('turns a stalled regex worker into a typed bounded failure', async () => {
        const getPage = vi.fn(async () => ({
            getTextContent: vi.fn(async () => ({items: [{str: 'aaaaaaaa'}]})),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: 2,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
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
                        matches: [{
                            startOffset: 0,
                            endOffset: 4,
                        }],
                        truncated: false,
                    }),
                }
                : {
                    requestId: 42,
                    promise: stalledWorkerPromise,
                };
        });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
        const progress: unknown[] = [];
        const stopProgress = capability.onProgress(value => progress.push(value));

        await expect(capability.run('/tmp/regex-timeout.pdf', 'a+b', {
            matchCase: true,
            useRegex: true,
            requestId: requireRequestId('regex-timeout'),
        })).rejects.toMatchObject({
            name: 'SearchRegexLimitError',
            code: 'SEARCH_REGEX_LIMIT',
        });
        stopProgress();
        expect(progress).toEqual(expect.arrayContaining([expect.objectContaining({processed: 1})]));
        expect(progress.every(value => (
            typeof value === 'object'
            && value !== null
            && !('results' in value)
        ))).toBe(true);
    });

    it('does not run regex matching on the renderer when the worker is unavailable', async () => {
        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReturnValue(false);

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();

        await expect(capability.run('/tmp/regex-unavailable.pdf', 'a+', {useRegex: true}))
            .rejects.toThrow('Browser search worker is required for regular expression search');
        expect(browserDocumentStoreMock.stat).not.toHaveBeenCalled();
        expect(browserSearchWorkerClientMock.createBrowserSearchWorkerRequest).not.toHaveBeenCalled();
    });

    it.each(searchConformanceCorpus.cases)('matches the shared conformance corpus case $id in the browser capability', async (fixture) => {
        const pdfPath = `browser://documents/test/${fixture.id}.pdf`;
        const getPage = vi.fn(async () => ({
            getTextContent: vi.fn(async () => ({items: [{str: fixture.text}]})),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: 1,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockImplementation(async (_path: string, _offset: number, length: number) => new Uint8Array(length));
        browserDocumentStoreMock.getContentSignature.mockResolvedValue(`content-token-${fixture.id}`);

        const { SEARCH_EXCERPT_CONTEXT_CHARS } = await import('@app/platform/browser-api/browserSearchLimits');
        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
        const result = await capability.run(pdfPath, fixture.query, fixture.options);

        expect(result.results.map(match => ({
            startOffset: match.startOffset,
            endOffset: match.endOffset,
            excerpt: match.excerpt,
        }))).toEqual(fixture.expectedMatches.map(match => ({
            startOffset: match.startOffset,
            endOffset: match.endOffset,
            excerpt: buildPdfSearchExcerpt(
                fixture.text,
                match.startOffset,
                match.endOffset,
                SEARCH_EXCERPT_CONTEXT_CHARS,
            ),
        })));
    });

    it('attaches pdfjs operator-list geometry to browser search results', async () => {
        const glyphs = Array.from('«История»').map((unicode) => ({
            unicode,
            width: unicode === '«' || unicode === '»' ? 200 : 600,
        }));
        const getTextContent = vi.fn(async () => ({items: [{str: 'fallback'}]}));
        const getPage = vi.fn(async () => ({
            view: [
                0,
                0,
                200,
                200,
            ],
            getOperatorList: vi.fn(async () => ({
                fnArray: [
                    pdfjsModule.OPS.beginText,
                    pdfjsModule.OPS.setFont,
                    pdfjsModule.OPS.setTextMatrix,
                    pdfjsModule.OPS.showText,
                    pdfjsModule.OPS.endText,
                ],
                argsArray: [
                    [],
                    [
                        'f1',
                        10,
                    ],
                    [new Float32Array([
                        1,
                        0,
                        0,
                        1,
                        10,
                        50,
                    ])],
                    [glyphs],
                    [],
                ],
            })),
            getTextContent,
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: 1,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
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
        expect(getTextContent).not.toHaveBeenCalled();
    });

    it('invalidates browser page text caches when same-size document content changes', async () => {
        const firstDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({
                getTextContent: vi.fn(async () => ({items: [{str: 'alpha foo'}]})),
                cleanup: vi.fn(async () => {}),
            })),
            destroy: vi.fn(async () => {}),
        };
        const secondDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({
                getTextContent: vi.fn(async () => ({items: [{str: 'beta bar'}]})),
                cleanup: vi.fn(async () => {}),
            })),
            destroy: vi.fn(async () => {}),
        };
        const firstDocumentGetPage = firstDocument.getPage;
        const secondDocumentGetPage = secondDocument.getPage;

        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        browserDocumentStoreMock.getContentSignature.mockResolvedValue('content-token-1');
        pdfjsModule.getDocument
            .mockReturnValueOnce({promise: Promise.resolve(firstDocument)})
            .mockReturnValueOnce({promise: Promise.resolve(secondDocument)});

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();

        await expect(capability.run('/tmp/test.pdf', 'foo')).resolves.toEqual({
            results: [expect.objectContaining({ pageNumber: 1 })],
            truncated: false,
        });
        browserDocumentStoreMock.getContentSignature.mockResolvedValue('content-token-2');
        browserDocumentStoreMock.getDocumentRevision.mockImplementation(async (documentRef: string) =>
            makeBrowserRevision(documentRef, 'drt1:browser:content-token-2', 2));
        await expect(capability.run('/tmp/test.pdf', 'bar')).resolves.toEqual({
            results: [expect.objectContaining({ pageNumber: 1 })],
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
                getTextContent: vi.fn(async () => ({items: [{str: 'alpha foo'}]})),
                cleanup: vi.fn(async () => {}),
            })),
            destroy: vi.fn(async () => {}),
        };
        const secondDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({
                getTextContent: vi.fn(async () => ({items: [{str: 'beta bar'}]})),
                cleanup: vi.fn(async () => {}),
            })),
            destroy: vi.fn(async () => {}),
        };
        const firstDocumentGetPage = firstDocument.getPage;
        const secondDocumentGetPage = secondDocument.getPage;

        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        browserDocumentStoreMock.getContentSignature.mockResolvedValue('same-content-signature');
        browserDocumentStoreMock.getDocumentRevision.mockImplementation(async (documentRef: string) =>
            makeBrowserRevision(documentRef, 'drt1:browser:revision-1'));
        pdfjsModule.getDocument
            .mockReturnValueOnce({promise: Promise.resolve(firstDocument)})
            .mockReturnValueOnce({promise: Promise.resolve(secondDocument)});

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();

        await expect(capability.run('/tmp/test.pdf', 'foo')).resolves.toEqual({
            results: [expect.objectContaining({ pageNumber: 1 })],
            truncated: false,
        });
        browserDocumentStoreMock.getDocumentRevision.mockImplementation(async (documentRef: string) =>
            makeBrowserRevision(documentRef, 'drt1:browser:revision-2', 2));
        await expect(capability.run('/tmp/test.pdf', 'bar')).resolves.toEqual({
            results: [expect.objectContaining({ pageNumber: 1 })],
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
                getTextContent: vi.fn(async () => ({items: [{str: 'alpha foo'}]})),
                cleanup: vi.fn(async () => {}),
            })),
            destroy: vi.fn(async () => {}),
        };
        const secondDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({
                getTextContent: vi.fn(async () => ({items: [{str: 'beta bar'}]})),
                cleanup: vi.fn(async () => {}),
            })),
            destroy: vi.fn(async () => {}),
        };
        const secondDocumentGetPage = secondDocument.getPage;

        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        pdfjsModule.getDocument
            .mockReturnValueOnce({promise: Promise.resolve(firstDocument)})
            .mockReturnValueOnce({promise: Promise.resolve(secondDocument)});

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const firstCapability = createBrowserSearchCapability().capability;
        await firstCapability.run('/tmp/test.pdf', 'foo', { pageCount: 1 });

        const indexedDbFactory = requireFakeIndexedDbFactory();
        const record = indexedDbFactory
            .getDatabase('evb-browser-search-cache')
            ?.getStoreRecords('document-text')
            .get('/tmp/test.pdf');
        mutateRecord(requirePersistedRecord(record));

        const secondCapability = createBrowserSearchCapability().capability;
        await expect(secondCapability.run('/tmp/test.pdf', 'bar', { pageCount: 1 })).resolves.toEqual({
            results: [expect.objectContaining({ pageNumber: 1 })],
            truncated: false,
        });

        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(2);
        expect(secondDocumentGetPage).toHaveBeenCalledTimes(1);
    });

    it('clears persisted browser page text indexes on resetCache', async () => {
        const pageTexts = [
            'alpha foo',
            'beta foo',
        ];
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: vi.fn(async () => ({items: [{str: pageTexts[pageNumber - 1] ?? ''}]})),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: pageTexts.length,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
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
            return { promise: Promise.resolve({
                numPages: 1,
                getPage: vi.fn(async () => ({
                    getTextContent: vi.fn(async () => ({items: [{str: pageText}]})),
                    cleanup: vi.fn(async () => {}),
                })),
                destroy: vi.fn(async () => {}),
            }) };
        });
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();

        for (let index = 1; index <= 17; index += 1) {
            await capability.warmIndex(`/tmp/lru-${index}.pdf`);
        }

        const indexedDbFactory = requireFakeIndexedDbFactory();
        const database = indexedDbFactory.getDatabase('evb-browser-search-cache');
        expect(database?.getStoreRecords('document-text').size).toBe(16);
        expect(database?.getStoreRecords('document-text').has('/tmp/lru-1.pdf')).toBe(false);
        expect(database?.getStoreRecords('document-text').has('/tmp/lru-17.pdf')).toBe(true);
    });

    it('searches documents above 64 MiB with metadata-only admission and range reads', async () => {
        const getPage = vi.fn(async () => ({
            getTextContent: vi.fn(async () => ({items: [{str: 'foo'}]})),
            cleanup: vi.fn(async () => {}),
        }));
        browserDocumentStoreMock.stat.mockResolvedValue({ size: (64 * 1024 * 1024) + 1 });
        browserDocumentStoreMock.readRange.mockImplementation(async (_path: string, _offset: number, length: number) => new Uint8Array(length));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: 1,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();

        await expect(capability.run('/tmp/huge.pdf', 'foo')).resolves.toMatchObject({
            results: [expect.objectContaining({pageNumber: 1})],
            truncated: false,
        });
        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.readRange).toHaveBeenCalled();
        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(1);
    });

    it('persists sparse page records without page-count blank slots', async () => {
        const pageTexts = [
            '',
            'needle',
            '',
        ];
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: vi.fn(async () => ({items: [{str: pageTexts[pageNumber - 1] ?? ''}]})),
            cleanup: vi.fn(async () => {}),
        }));
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: pageTexts.length,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
        await expect(capability.warmIndex('/tmp/sparse.pdf')).resolves.toBe(true);

        const database = requireFakeIndexedDbFactory()
            .getDatabase('evb-browser-search-cache');
        const record = requirePersistedRecord(
            database?.getStoreRecords('document-text').get('/tmp/sparse.pdf'),
        );
        expect(record.version).toBe(8);
        expect(record.pageCount).toBe(3);
        expect(record.pages).toEqual([{
            pageNumber: 2,
            text: 'needle',
        }]);
        expect('pageTexts' in record).toBe(false);
    });

    it('migrates a legacy page-text array without padding a million-page record', async () => {
        const path = '/tmp/legacy-million.pdf';
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
        await capability.resetCache();
        const database = requireFakeIndexedDbFactory()
            .getDatabase('evb-browser-search-cache');
        database?.getStoreRecords('document-text').set(path, {
            version: 7,
            pdfPath: path,
            fileSize: 3,
            contentSignature: 'content-token-1',
            documentRevision: 'drt1:browser:content-token-1',
            pageCount: 1_000_000,
            pageTexts: ['needle'],
            textBytes: 12,
        });

        const arrayFrom = vi.spyOn(Array, 'from');
        capability.onProgress(progress => {
            if (progress.processed === 1) {
                void capability.cancel(requireRequestId('legacy-million'));
            }
        });
        await expect(capability.warmIndex(path, {requestId: requireRequestId('legacy-million')})).resolves.toBe(false);
        await vi.waitFor(() => {
            const migrated = requirePersistedRecord(
                database?.getStoreRecords('document-text').get(path),
            );
            expect(migrated.version).toBe(8);
            expect(migrated.pages).toEqual([{
                pageNumber: 1,
                text: 'needle',
            }]);
            expect('pageTexts' in migrated).toBe(false);
        });
        expect(arrayFrom.mock.calls.some(([value]) => (
            typeof value === 'object'
            && value !== null
            && 'length' in value
            && Number(value.length) >= 1_000_000
        ))).toBe(false);
        arrayFrom.mockRestore();
    });

    it('cancels a million-page direct scan after one delivered page', async () => {
        const arrayFrom = vi.spyOn(Array, 'from');
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: vi.fn(async () => ({items: [{str: pageNumber === 1 ? 'needle' : ''}]})),
            cleanup: vi.fn(async () => {}),
        }));
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: 1_000_000,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
        capability.onProgress(progress => {
            if (progress.processed === 1) {
                void capability.cancel(requireRequestId('million-direct'));
            }
        });
        await expect(capability.run('/tmp/million-direct.pdf', 'needle', {requestId: requireRequestId('million-direct')})).resolves.toEqual({
            results: [],
            truncated: false,
        });
        expect(getPage).toHaveBeenCalledTimes(1);
        expect(arrayFrom.mock.calls.some(([value]) => (
            typeof value === 'object'
            && value !== null
            && 'length' in value
            && Number(value.length) >= 1_000_000
        ))).toBe(false);
        arrayFrom.mockRestore();
    });

    it('returns no browser search results for empty queries before loading PDF.js', async () => {
        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();

        await expect(capability.run('/tmp/test.pdf', '')).resolves.toEqual({
            results: [],
            truncated: false,
        });
        expect(browserDocumentStoreMock.stat).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.readRange).not.toHaveBeenCalled();
        expect(pdfjsModule.getDocument).not.toHaveBeenCalled();
    });

    it('streams uncached browser search results as direct extraction scans pages', async () => {
        const pageTexts = [
            'alpha sign',
            'beta sign',
        ];
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: vi.fn(async () => ({items: [{str: pageTexts[pageNumber - 1] ?? ''}]})),
            cleanup: vi.fn(async () => {}),
        }));

        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: pageTexts.length,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
        const progressUpdates: Array<{
            processed: number;
            resultCount: number;
            resultsStartIndex?: number;
        }> = [];
        capability.onProgress((progress) => {
            progressUpdates.push({
                processed: progress.processed,
                resultCount: progress.results?.length ?? 0,
                ...(progress.resultsStartIndex === undefined
                    ? {}
                    : {resultsStartIndex: progress.resultsStartIndex}),
            });
        });
        const result = await capability.run('/tmp/test.pdf', 'sign', {requestId: requireRequestId('stream-search')});

        expect(result.results).toEqual([
            expect.objectContaining({ pageNumber: 1 }),
            expect.objectContaining({ pageNumber: 2 }),
        ]);
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
        expect(browserSearchWorkerClientMock.createBrowserSearchWorkerRequest).not.toHaveBeenCalled();
        expect(pdfjsModule.getDocument).toHaveBeenCalledOnce();
        expect(getPage).toHaveBeenCalledTimes(2);
    });

    it('stops direct extraction after truncated streaming search without persisting a full index', async () => {
        vi.doMock('@app/platform/browser-api/browserSearchLimits', () => ({
            SEARCH_EXCERPT_CONTEXT_CHARS: 10,
            SEARCH_RESULT_LIMIT: 2,
            BROWSER_SEARCH_MAX_PAGE_COUNT: 1_000_000,
            validateBrowserSearchPageCount: () => undefined,
            validateBrowserSearchQueryCost: () => undefined,
        }));
        const pageTexts = [
            'alpha foo',
            'beta foo',
            'gamma foo',
            'delta foo',
        ];
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: vi.fn(async () => ({items: [{str: pageTexts[pageNumber - 1] ?? ''}]})),
            cleanup: vi.fn(async () => {}),
        }));

        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: pageTexts.length,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const firstCapability = createBrowserSearchCapability().capability;
        const firstRun = await firstCapability.run('/tmp/test.pdf', 'foo');
        const secondCapability = createBrowserSearchCapability().capability;
        const secondRun = await secondCapability.run('/tmp/test.pdf', 'foo');

        expect(firstRun).toEqual({
            results: expect.arrayContaining([
                expect.objectContaining({ pageNumber: 1 }),
                expect.objectContaining({ pageNumber: 2 }),
            ]),
            truncated: true,
        });
        expect(secondRun.truncated).toBe(true);
        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(2);
        expect(getPage).toHaveBeenCalledTimes(6);

        const indexedDbFactory = requireFakeIndexedDbFactory();
        const database = indexedDbFactory.getDatabase('evb-browser-search-cache');
        expect(database?.getStoreRecords('document-text').size ?? 0).toBe(0);
    });

    it('keeps an exact-limit result set complete and scans every remaining page', async () => {
        vi.doMock('@app/platform/browser-api/browserSearchLimits', () => ({
            SEARCH_EXCERPT_CONTEXT_CHARS: 10,
            SEARCH_RESULT_LIMIT: 2,
            BROWSER_SEARCH_MAX_PAGE_COUNT: 1_000_000,
            validateBrowserSearchPageCount: () => undefined,
            validateBrowserSearchQueryCost: () => undefined,
        }));
        const pageTexts = [
            'alpha foo',
            'beta foo',
            'gamma without a match',
        ];
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: vi.fn(async () => ({items: [{str: pageTexts[pageNumber - 1] ?? ''}]})),
            cleanup: vi.fn(async () => {}),
        }));

        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: pageTexts.length,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
        const truncatedProgress: boolean[] = [];
        capability.onProgress(progress => truncatedProgress.push(Boolean(progress.truncated)));
        const result = await capability.run('/tmp/test.pdf', 'foo', {requestId: requireRequestId('exact-limit')});

        expect(result.truncated).toBe(false);
        expect(result.results.map(match => Number(match.pageNumber))).toEqual([
            1,
            2,
        ]);
        expect(getPage).toHaveBeenCalledTimes(3);
        expect(truncatedProgress).not.toContain(true);
    });

    it('truncates only after discovering the first match beyond the limit', async () => {
        vi.doMock('@app/platform/browser-api/browserSearchLimits', () => ({
            SEARCH_EXCERPT_CONTEXT_CHARS: 10,
            SEARCH_RESULT_LIMIT: 2,
            BROWSER_SEARCH_MAX_PAGE_COUNT: 1_000_000,
            validateBrowserSearchPageCount: () => undefined,
            validateBrowserSearchQueryCost: () => undefined,
        }));
        const pageTexts = [
            'alpha foo',
            'beta foo',
            'gamma foo',
            'delta foo',
        ];
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: vi.fn(async () => ({items: [{str: pageTexts[pageNumber - 1] ?? ''}]})),
            cleanup: vi.fn(async () => {}),
        }));

        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: pageTexts.length,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
        const progressUpdates: Array<{
            processed: number;
            truncated: boolean;
            pageNumbers: number[];
        }> = [];
        capability.onProgress(progress => progressUpdates.push({
            processed: progress.processed,
            truncated: Boolean(progress.truncated),
            pageNumbers: (progress.results ?? []).map(match => Number(match.pageNumber)),
        }));
        const result = await capability.run('/tmp/test.pdf', 'foo', {requestId: requireRequestId('over-limit')});

        expect(result.truncated).toBe(true);
        expect(result.results.map(match => Number(match.pageNumber))).toEqual([
            1,
            2,
        ]);
        expect(result.results.map(match => match.matchIndex)).toEqual([
            0,
            1,
        ]);
        expect(getPage).toHaveBeenCalledTimes(3);
        expect(progressUpdates.filter(update => update.truncated)).toEqual([{
            processed: 3,
            truncated: true,
            pageNumbers: [],
        }]);
        expect(progressUpdates.flatMap(update => update.pageNumbers)).toEqual([
            1,
            2,
        ]);
    });

    it('assigns page match indexes without scanning prior results', async () => {
        const getPage = vi.fn(async () => ({
            getTextContent: vi.fn(async () => ({items: [{str: 'foo foo foo'}]})),
            cleanup: vi.fn(async () => {}),
        }));

        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: 1,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
        const result = await capability.run('/tmp/test.pdf', 'foo');

        expect(result.results.map((match) => match.pageMatchIndex)).toEqual([
            0,
            1,
            2,
        ]);
    });

    it('warms the text index through the backpressured worker page stream', async () => {
        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReturnValue(true);
        browserSearchWorkerClientMock.createBrowserSearchWorkerPageStreamRequest.mockReturnValue({
            requestId: 41,
            pages: (async function* () {
                yield {
                    pageNumber: 1,
                    pageCount: 2_646,
                    text: 'alpha',
                };
                yield {
                    pageNumber: 2,
                    pageCount: 2_646,
                    text: '',
                };
            })(),
            promise: Promise.resolve({pageCount: 2_646}),
        });
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();

        await expect(capability.warmIndex('/tmp/worker-stream.pdf')).resolves.toBe(true);

        expect(browserSearchWorkerClientMock.createBrowserSearchWorkerPageStreamRequest)
            .toHaveBeenCalledWith({pdfPath: '/tmp/worker-stream.pdf'});
        expect(pdfjsModule.getDocument).not.toHaveBeenCalled();
        const database = requireFakeIndexedDbFactory()
            .getDatabase('evb-browser-search-cache');
        const record = requirePersistedRecord(
            database?.getStoreRecords('document-text').get('/tmp/worker-stream.pdf'),
        );
        expect(record.pageCount).toBe(2_646);
        expect(record.pages).toEqual([{
            pageNumber: 1,
            text: 'alpha',
        }]);
    });

    it('falls back to direct warm-index extraction when the browser search worker is unavailable', async () => {
        const getPage = vi.fn(async () => ({
            getTextContent: vi.fn(async () => ({items: [{str: 'foo'}]})),
            cleanup: vi.fn(async () => {}),
        }));
        const WorkerUnavailableError = browserSearchWorkerClientMock.BrowserSearchWorkerUnavailableError;

        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReturnValue(true);
        browserSearchWorkerClientMock.createBrowserSearchWorkerPageStreamRequest.mockImplementation(() => {
            throw new WorkerUnavailableError('worker unavailable');
        });
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: 1,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();

        await expect(capability.warmIndex('/tmp/test.pdf')).resolves.toBe(true);
        expect(browserSearchWorkerClientMock.createBrowserSearchWorkerPageStreamRequest).toHaveBeenCalledTimes(1);
        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(1);
    });

    it('surfaces browser search worker request failures without direct extraction fallback', async () => {
        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReturnValue(true);
        browserSearchWorkerClientMock.createBrowserSearchWorkerPageStreamRequest.mockImplementation(() => ({
            pages: (async function* () {})(),
            requestId: 17,
            promise: new Promise((_resolve, reject) => {
                queueMicrotask(() => reject(new Error('worker crashed after request start')));
            }),
        }));
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();

        await expect(capability.warmIndex('/tmp/test.pdf')).rejects.toThrow('worker crashed after request start');
        expect(browserSearchWorkerClientMock.createBrowserSearchWorkerPageStreamRequest).toHaveBeenCalledTimes(1);
        expect(browserDocumentStoreMock.readRange).not.toHaveBeenCalled();
        expect(pdfjsModule.getDocument).not.toHaveBeenCalled();
    });

    it('cancels active direct browser extraction when search is canceled', async () => {
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        let firstPageRead = false;
        let releaseFirstPageRead: () => void = () => {};
        const firstPageReadGate = new Promise<void>((resolve) => {
            releaseFirstPageRead = resolve;
        });
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: vi.fn(async () => {
                if (pageNumber === 1) {
                    firstPageRead = true;
                    await firstPageReadGate;
                }
                return {items: [{str: `page ${pageNumber} foo`}]};
            }),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: 3,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
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
        expect(getPage.mock.calls.length).toBeLessThan(3);

        const nextRun = await capability.run('/tmp/test.pdf', 'foo', {requestId: requireRequestId('cancel-me')});

        expect(nextRun.results.length).toBeGreaterThan(0);
    });
});
