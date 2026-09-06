import type {IPdfRenderTask} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

const loggerError = vi.fn();
const loggerDebug = vi.fn();
const rangeReadFailureReceipt = {
    eventId: '0123456789abcdef0123456789abcdef',
    code: 'RENDERER_PDF_RANGE_READ_FAILED',
    occurredAt: 1,
    severity: 'error',
};
const createObjectURLMock = vi.fn(() => 'blob:pdf-load');
const revokeObjectURLMock = vi.fn();

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    error: loggerError,
    warn: vi.fn(),
    warnThrottled: vi.fn(),
    debug: loggerDebug,
}}));

interface IPdfjsDataRangeTransport {
    onDataRange: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    requestDataRange: ((begin: number, end: number) => void) | null;
}

class MockPdfDataRangeTransport implements IPdfjsDataRangeTransport {
    public onDataRange = vi.fn();
    public abort = vi.fn();
    public requestDataRange: ((begin: number, end: number) => void) | null = null;

    constructor(length: number, initialData: Uint8Array) {
        void length;
        void initialData;
    }
}

const pdfjsState: {
    version: string;
    GlobalWorkerOptions: { workerSrc: string };
    VerbosityLevel: { ERRORS: number };
    getDocument: ReturnType<typeof vi.fn>;
    PDFDataRangeTransport?: typeof MockPdfDataRangeTransport;
} = {
    version: '5.7.284',
    GlobalWorkerOptions: { workerSrc: '' },
    VerbosityLevel: { ERRORS: 0 },
    getDocument: vi.fn(),
    PDFDataRangeTransport: MockPdfDataRangeTransport,
};

vi.mock('pdfjs-dist', () => pdfjsState);

const electronApi = createElectronPlatformApiFixture({documentFiles: {readFileRange: vi.fn()}});

vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => electronApi}));

const {leasePdfDocumentPage} = await import('@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource');
const {createPdfDocumentSession} = await import('@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession');
const {createDocumentViewerChassisAuthority} = await import('@app/utils/document-viewer/chassis/documentViewerChassisAuthority');
const {maxCachedPdfPages} = await import('@app/modules/pdf-viewer/engine/maxCachedPdfPages');
const {runCoordinatedPdfPageOperation} = await import('@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender');

// This test copies two 1 MiB ranges and runs alongside the complete six-project
// unit matrix. Keep the behavioral assertions strict without making host load
// part of the oracle.
const rangePreloadTestTimeoutMs = 30_000;

describe('PdfDocumentSession range loading', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        loggerError.mockReturnValue(rangeReadFailureReceipt);
        electronApi.documentFiles.readFileRange.mockReset();
        vi.stubGlobal('URL', {
            ...URL,
            createObjectURL: createObjectURLMock,
            revokeObjectURL: revokeObjectURLMock,
        });
        pdfjsState.PDFDataRangeTransport = MockPdfDataRangeTransport;
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage: vi.fn(async () => ({
                    cleanup: vi.fn(),
                    getViewport: vi.fn(() => ({
                        width: 100,
                        height: 200,
                    })),
                })),
                destroy: vi.fn(),
            }),
            destroy: vi.fn(),
        });
    });

    it('distinguishes an exact trusted target-page seed from normalized fallback pages', () => {
        const documentState = createPdfDocumentSession();

        expect(documentState.hasExactPageGeometry(7)).toBe(false);
        expect(documentState.seedTrustedPageGeometry({
            pageNumber: 7,
            pageCount: 431,
            width: 478.8,
            height: 765.3,
        })).toBe(true);
        expect(documentState.hasExactPageGeometry(7)).toBe(true);
        expect(documentState.hasExactPageGeometry(1)).toBe(false);

        documentState.cleanup();
        expect(documentState.hasExactPageGeometry(7)).toBe(false);
    });

    it('replaces a provisional trusted baseline with authoritative PDF.js geometry', async () => {
        const documentState = createPdfDocumentSession();
        expect(documentState.seedTrustedPageGeometry({
            pageNumber: 1,
            pageCount: 1,
            width: 640,
            height: 900,
        })).toBe(true);

        const result = await documentState.loadPdf(new Blob(['pdf'], {type: 'application/pdf'}));

        expect(result).not.toBeNull();
        expect(documentState.pageMetrics.value).toEqual([{
            width: 100,
            height: 200,
        }]);
        expect(documentState.basePageWidth.value).toBe(100);
        expect(documentState.basePageHeight.value).toBe(200);
        expect(documentState.hasExactPageGeometry(1)).toBe(true);
    });

    it('loads a PDF through range transport and populates document state', async () => {
        const size = (1024 * 1024 * 2) + 13;
        electronApi.documentFiles.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = createPdfDocumentSession();
        const source = {
            kind: 'path',
            path: '/tmp/success.pdf',
            size,
        } as const;
        const result = await documentState.loadPdf(source);

        expect(result).not.toBeNull();
        expect(documentState.loadError.value).toBeNull();
        expect(documentState.pdfDocument.value).not.toBeNull();
        expect(documentState.pdfDocument.value).toBe(result?.document ?? null);
        expect(documentState.acceptedSource.value).toBe(source);
        expect(documentState.numPages.value).toBe(1);
        expect(documentState.basePageWidth.value).toBe(100);
        expect(documentState.basePageHeight.value).toBe(200);
        expect(documentState.pageMetrics.value).toEqual([{
            width: 100,
            height: 200,
        }]);
        expect(documentState.isLoading.value).toBe(false);

        const { getPdfjsAssetDir } = await import('@app/utils/viewerAssets');
        expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        expect(pdfjsState.getDocument).toHaveBeenCalledWith(expect.objectContaining({
            range: expect.any(MockPdfDataRangeTransport),
            length: size,
            rangeChunkSize: 1024 * 1024,
            disableAutoFetch: true,
            disableStream: true,
            verbosity: pdfjsState.VerbosityLevel.ERRORS,
            standardFontDataUrl: getPdfjsAssetDir('standard_fonts'),
            cMapUrl: getPdfjsAssetDir('cmaps'),
            cMapPacked: true,
            wasmUrl: getPdfjsAssetDir('wasm'),
            iccUrl: getPdfjsAssetDir('iccs'),
            useSystemFonts: false,
        }));
    });

    it('does not impose a total-page product cap on path-backed PDFs', async () => {
        const pageCount = 100_001;
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: pageCount,
                getPage: vi.fn(async () => ({
                    cleanup: vi.fn(),
                    getViewport: vi.fn(() => ({
                        width: 100,
                        height: 200,
                    })),
                })),
                destroy: vi.fn(),
            }),
            destroy: vi.fn(),
        });
        electronApi.documentFiles.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = createPdfDocumentSession();
        const result = await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/many-pages.pdf',
            size: 2048,
        });

        expect(result).not.toBeNull();
        expect(documentState.numPages.value).toBe(pageCount);
        expect(documentState.loadError.value).toBeNull();
    });

    it('keeps million-page metric hydration sparse and cancels a far scroll', async () => {
        const pageCount = 1_000_000;
        const farPage = {
            cleanup: vi.fn(),
            getViewport: vi.fn(() => ({
                width: 320,
                height: 520,
            })),
        };
        const farPageReady = Promise.withResolvers<typeof farPage>();
        const getPage = vi.fn(async (pageNumber: number) => {
            if (pageNumber === 1) {
                return {
                    cleanup: vi.fn(),
                    getViewport: vi.fn(() => ({
                        width: 300,
                        height: 500,
                    })),
                };
            }
            return farPageReady.promise;
        });
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: pageCount,
                getPage,
                destroy: vi.fn(),
            }),
            destroy: vi.fn(),
        });
        electronApi.documentFiles.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = createPdfDocumentSession();
        const result = await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/million-pages.pdf',
            size: 2048,
        });

        expect(result).not.toBeNull();
        expect(documentState.numPages.value).toBe(pageCount);
        expect(documentState.pageMetrics.value.length).toBe(1);
        expect(Object.keys(documentState.pageMetrics.value)).toEqual(['0']);

        const farScroll = documentState.ensurePageMetricsInRange(pageCount - 1, pageCount);
        await vi.waitFor(() => {
            expect(getPage).toHaveBeenCalledTimes(3);
        });

        documentState.cleanup();
        farPageReady.resolve(farPage);

        await expect(farScroll).rejects.toThrow('Rendering cancelled: PDF page request became stale');
        expect(documentState.pageMetrics.value).toEqual([]);
        expect(documentState.numPages.value).toBe(0);
    });

    it('keeps the preloaded tail cached until PDF.js requests it', async () => {
        const getDocumentCalled = Promise.withResolvers<MockPdfDataRangeTransport>();
        const deferred = Promise.withResolvers<{
            numPages: number;
            getPage: ReturnType<typeof vi.fn>;
            destroy: ReturnType<typeof vi.fn>;
        }>();
        const destroy = vi.fn(() => Promise.resolve());
        const chunkLength = 1024 * 1024;
        const size = chunkLength * 3;
        const tailStart = size - chunkLength;
        const initialData = new Uint8Array(chunkLength);
        const tailData = new Uint8Array(chunkLength);
        initialData[0] = 1;
        tailData[0] = 9;
        tailData[chunkLength - 1] = 7;

        pdfjsState.getDocument.mockImplementation((options: { range?: MockPdfDataRangeTransport }) => {
            expect(options.range?.onDataRange).not.toHaveBeenCalled();
            if (options.range) {
                getDocumentCalled.resolve(options.range);
            } else {
                getDocumentCalled.reject(new Error('Expected PDF range transport'));
            }
            return {
                promise: deferred.promise,
                destroy,
            };
        });

        electronApi.documentFiles.readFileRange.mockImplementation(async (
            _path: string,
            offset: number,
            length: number,
        ) => {
            if (offset === 0) {
                expect(length).toBe(chunkLength);
                return initialData;
            }
            if (offset === tailStart) {
                expect(length).toBe(chunkLength);
                return tailData;
            }
            throw new Error(`Unexpected PDF range read ${offset}..${offset + length}`);
        });

        const documentState = createPdfDocumentSession();
        const loadPromise = documentState.loadPdf({
            kind: 'path',
            path: '/tmp/preloaded-tail.pdf',
            size,
        });

        const range = await getDocumentCalled.promise;

        expect(range.onDataRange).not.toHaveBeenCalled();

        const dataRangeDelivered = Promise.withResolvers<{
            begin: number;
            chunk: unknown;
        }>();
        range.onDataRange.mockImplementation((begin: number, chunk: unknown) => {
            dataRangeDelivered.resolve({
                begin,
                chunk,
            });
        });
        if (!range.requestDataRange) {
            throw new Error('Expected PDF range request handler');
        }

        range.requestDataRange(tailStart, size);
        const deliveredRange = await dataRangeDelivered.promise;

        expect(electronApi.documentFiles.readFileRange).toHaveBeenCalledTimes(2);
        expect(range.onDataRange).toHaveBeenCalledTimes(1);
        const rangeChunk = deliveredRange.chunk as Uint8Array | undefined;
        expect(deliveredRange.begin).toBe(tailStart);
        expect(rangeChunk).toBeInstanceOf(Uint8Array);
        expect(rangeChunk).not.toBe(tailData);
        expect(rangeChunk).toHaveLength(chunkLength);
        expect(rangeChunk?.[0]).toBe(9);
        expect(rangeChunk?.[chunkLength - 1]).toBe(7);

        documentState.cleanup();
        deferred.reject(new Error('range cache test cancelled load'));

        await expect(loadPromise).resolves.toBeNull();
        expect(documentState.loadError.value).toBeNull();
    }, rangePreloadTestTimeoutMs);

    it('uses the largest measured page as the fit baseline when page sizes differ', async () => {
        const getPage = vi.fn(async (pageNumber: number) => {
            const metrics = [
                {
                    width: 180,
                    height: 240,
                },
                {
                    width: 612,
                    height: 792,
                },
                {
                    width: 320,
                    height: 640,
                },
            ];
            const metric = metrics[pageNumber - 1]!;
            return { getViewport: vi.fn(() => metric) };
        });
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 3,
                getPage,
                destroy: vi.fn(),
            }),
            destroy: vi.fn(),
        });
        electronApi.documentFiles.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = createPdfDocumentSession();
        const result = await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/mixed-sizes.pdf',
            size: 1024,
        });

        expect(result).not.toBeNull();
        expect(documentState.basePageWidth.value).toBe(180);
        expect(documentState.basePageHeight.value).toBe(240);
        expect(documentState.pageMetrics.value).toEqual([{
            width: 180,
            height: 240,
        }]);
        expect(getPage).toHaveBeenCalledTimes(1);

        await expect(documentState.ensurePageMetricsInRange(2, 3)).resolves.toBe(true);

        expect(documentState.basePageWidth.value).toBe(612);
        expect(documentState.basePageHeight.value).toBe(792);
        expect(documentState.pageMetrics.value).toEqual([
            {
                width: 180,
                height: 240,
            },
            {
                width: 612,
                height: 792,
            },
            {
                width: 320,
                height: 640,
            },
        ]);
        expect(getPage).toHaveBeenCalledTimes(3);
    });

    it('hydrates only the requested metric range after the initial page', async () => {
        const getPage = vi.fn(async (pageNumber: number) => ({ getViewport: vi.fn(() => ({
            width: 200 + pageNumber,
            height: 400 + pageNumber,
        })) }));
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 5,
                getPage,
                destroy: vi.fn(),
            }),
            destroy: vi.fn(),
        });
        electronApi.documentFiles.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = createPdfDocumentSession();
        await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/lazy-metrics.pdf',
            size: 2048,
        });

        expect(getPage).toHaveBeenCalledTimes(1);
        expect(documentState.pageMetrics.value[0]).toEqual({
            width: 201,
            height: 401,
        });
        expect(documentState.pageMetrics.value[3]).toBeUndefined();

        await expect(documentState.ensurePageMetricsInRange(4, 5)).resolves.toBe(true);

        expect(getPage).toHaveBeenCalledTimes(3);
        expect(documentState.pageMetrics.value[3]).toEqual({
            width: 204,
            height: 404,
        });
        expect(documentState.pageMetrics.value[4]).toEqual({
            width: 205,
            height: 405,
        });
        expect(documentState.pageMetrics.value[1]).toBeUndefined();
    });

    it('keeps metric-loaded page proxies cached for the later render path', async () => {
        const pageCleanup = vi.fn();
        const page2 = {
            cleanup: pageCleanup,
            getViewport: vi.fn(() => ({
                width: 202,
                height: 402,
            })),
        };
        const pages = new Map<number, unknown>([
            [
                1,
                {
                    cleanup: vi.fn(),
                    getViewport: vi.fn(() => ({
                        width: 201,
                        height: 401,
                    })),
                },
            ],
            [
                2,
                page2,
            ],
        ]);
        const getPage = vi.fn(async (pageNumber: number) => pages.get(pageNumber));
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 2,
                getPage,
                destroy: vi.fn(),
            }),
            destroy: vi.fn(),
        });
        electronApi.documentFiles.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = createPdfDocumentSession();
        await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/cache-metrics-for-render.pdf',
            size: 2048,
        });

        await expect(documentState.ensurePageMetricsInRange(2, 2)).resolves.toBe(true);
        await expect(documentState.getPage(2)).resolves.toBe(page2);

        expect(pageCleanup).not.toHaveBeenCalled();
        expect(getPage).toHaveBeenCalledTimes(2);
    });

    it('routes page-source metric hydration through the bounded PDF page cache', async () => {
        const loadedPages: Array<{
            cleanup: ReturnType<typeof vi.fn>;
            pageNumber: number;
        }> = [];
        const getPage = vi.fn(async (pageNumber: number) => {
            const page = {
                cleanup: vi.fn(),
                getViewport: vi.fn(() => ({
                    width: 200,
                    height: 400,
                })),
                pageNumber,
            };
            loadedPages.push(page);
            return page;
        });
        const pageCount = maxCachedPdfPages + 1;
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: pageCount,
                getPage,
                destroy: vi.fn(),
            }),
            destroy: vi.fn(),
        });
        electronApi.documentFiles.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const authority = createDocumentViewerChassisAuthority(ref('pdf'));
        const documentState = createPdfDocumentSession({chassisAuthority: authority});
        try {
            await documentState.loadPdf({
                kind: 'path',
                path: '/tmp/page-source-metric-cache.pdf',
                size: 2048,
            });
            await nextTick();

            const pageSource = authority.source.value;
            expect(pageSource).not.toBeNull();
            if (!pageSource) {
                throw new Error('PDF page source was not bound');
            }
            for (let pageNumber = 2; pageNumber <= pageCount; pageNumber += 1) {
                await pageSource.getPageMetrics(pageNumber);
            }

            expect(loadedPages[0]?.cleanup).toHaveBeenCalledTimes(1);
        } finally {
            documentState.cleanup();
        }
    });

    it('surfaces a load error when PDF.js range transport API is unavailable', async () => {
        delete pdfjsState.PDFDataRangeTransport;
        electronApi.documentFiles.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));

        const documentState = createPdfDocumentSession();
        const result = await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/a.pdf',
            size: 3,
        });

        expect(result).toBeNull();
        expect(documentState.isLoading.value).toBe(false);
        expect(documentState.loadError.value).toBeInstanceOf(Error);
        expect((documentState.loadError.value as Error).message).toContain('PDFDataRangeTransport export is not a constructor');
        expect(loggerError).toHaveBeenCalledWith(
            'pdf-document',
            'Failed to load PDF',
            expect.any(Error),
            {
                code: 'RENDERER_PDF_DOCUMENT_LOAD_FAILED',
                context: {},
            },
        );
    });

    it('returns null and clears loading when initial range read fails', async () => {
        electronApi.documentFiles.readFileRange.mockRejectedValue(new Error('read failed'));

        const documentState = createPdfDocumentSession();
        const result = await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/b.pdf',
            size: 7,
        });

        expect(result).toBeNull();
        expect(documentState.acceptedSource.value).toBeNull();
        expect(documentState.isLoading.value).toBe(false);
        expect(documentState.loadError.value).toBeInstanceOf(Error);
        expect((documentState.loadError.value as Error).message).toBe('read failed');
        expect(loggerError).toHaveBeenCalledWith(
            'pdf-document',
            'Failed to load PDF',
            expect.any(Error),
            {
                code: 'RENDERER_PDF_DOCUMENT_LOAD_FAILED',
                context: {},
            },
        );
    });

    it('fails the load instead of hanging when a later range read rejects', async () => {
        const deferred = Promise.withResolvers<{
            numPages: number;
            getPage: ReturnType<typeof vi.fn>;
            destroy: ReturnType<typeof vi.fn>;
        }>();
        const destroy = vi.fn(() => {
            deferred.reject(new Error('range load aborted'));
            return Promise.resolve();
        });

        pdfjsState.getDocument.mockReturnValue({
            promise: deferred.promise,
            destroy,
        });

        electronApi.documentFiles.readFileRange
            .mockResolvedValueOnce(new Uint8Array([
                1,
                2,
                3,
                4,
            ]))
            .mockRejectedValueOnce(new Error('late range read failed'));

        const documentState = createPdfDocumentSession();
        const loadPromise = documentState.loadPdf({
            kind: 'path',
            path: '/tmp/late-failure.pdf',
            size: (1024 * 1024) + 512,
        });

        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });

        const getDocumentArg = pdfjsState.getDocument.mock.calls[0]?.[0] as { range?: MockPdfDataRangeTransport } | undefined;
        expect(getDocumentArg?.range).toBeInstanceOf(MockPdfDataRangeTransport);

        getDocumentArg?.range?.requestDataRange?.(1024 * 1024, (1024 * 1024) + 512);

        await expect(loadPromise).resolves.toBeNull();
        expect(documentState.isLoading.value).toBe(false);
        expect(documentState.pdfDocument.value).toBeNull();
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(getDocumentArg?.range?.abort).toHaveBeenCalledTimes(1);
        expect(loggerError).toHaveBeenNthCalledWith(
            1,
            'pdf-document',
            'Failed to read PDF range chunk',
            expect.any(Error),
            {
                code: 'RENDERER_PDF_RANGE_READ_FAILED',
                context: {},
            },
        );
        expect(loggerError).toHaveBeenNthCalledWith(
            2,
            'pdf-document',
            'Failed to load PDF',
            expect.any(Error),
            rangeReadFailureReceipt,
        );
    });

    it('queues a range request burst wider than the serialized read chain instead of failing the load', async () => {
        const deferred = Promise.withResolvers<{
            numPages: number;
            getPage: ReturnType<typeof vi.fn>;
            destroy: ReturnType<typeof vi.fn>;
        }>();
        const destroy = vi.fn(() => {
            deferred.reject(new Error('range load aborted'));
            return Promise.resolve();
        });

        pdfjsState.getDocument.mockReturnValue({
            promise: deferred.promise,
            destroy,
        });
        electronApi.documentFiles.readFileRange.mockImplementation(async (
            _path: string,
            _offset: number,
            length: number,
        ) => new Uint8Array(length));

        const documentState = createPdfDocumentSession();
        const loadPromise = documentState.loadPdf({
            kind: 'path',
            path: '/tmp/range-burst.pdf',
            size: 80 * 1024 * 1024,
        });

        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });

        const getDocumentArg = pdfjsState.getDocument.mock.calls[0]?.[0] as { range?: MockPdfDataRangeTransport } | undefined;
        const range = getDocumentArg?.range;
        expect(range).toBeInstanceOf(MockPdfDataRangeTransport);
        range?.onDataRange.mockClear();

        const burstSize = 64;
        for (let index = 0; index < burstSize; index += 1) {
            const begin = (2 + index) * 1024 * 1024;
            range?.requestDataRange?.(begin, begin + (1024 * 1024));
        }

        await vi.waitFor(() => {
            expect(range?.onDataRange).toHaveBeenCalledTimes(burstSize);
        });
        expect(loggerError).not.toHaveBeenCalled();
        expect(range?.abort).not.toHaveBeenCalled();

        deferred.resolve({
            numPages: 1,
            getPage: vi.fn(async () => ({
                cleanup: vi.fn(),
                getViewport: vi.fn(() => ({
                    width: 100,
                    height: 200,
                })),
            })),
            destroy,
        });

        await expect(loadPromise).resolves.not.toBeNull();
    });

    it('stops reading queued ranges once the load has already failed', async () => {
        const deferred = Promise.withResolvers<{
            numPages: number;
            getPage: ReturnType<typeof vi.fn>;
            destroy: ReturnType<typeof vi.fn>;
        }>();
        const destroy = vi.fn(() => {
            deferred.reject(new Error('range load aborted'));
            return Promise.resolve();
        });

        pdfjsState.getDocument.mockReturnValue({
            promise: deferred.promise,
            destroy,
        });

        const failingBegin = 2 * 1024 * 1024;
        electronApi.documentFiles.readFileRange.mockImplementation(async (
            _path: string,
            offset: number,
            length: number,
        ) => {
            if (offset === failingBegin) {
                throw new Error('range read failed');
            }
            return new Uint8Array(length);
        });

        const documentState = createPdfDocumentSession();
        const loadPromise = documentState.loadPdf({
            kind: 'path',
            path: '/tmp/range-burst-failure.pdf',
            size: 80 * 1024 * 1024,
        });

        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });

        const getDocumentArg = pdfjsState.getDocument.mock.calls[0]?.[0] as { range?: MockPdfDataRangeTransport } | undefined;
        const range = getDocumentArg?.range;
        expect(range).toBeInstanceOf(MockPdfDataRangeTransport);
        electronApi.documentFiles.readFileRange.mockClear();
        range?.onDataRange.mockClear();

        for (let index = 0; index < 8; index += 1) {
            const begin = failingBegin + (index * 1024 * 1024);
            range?.requestDataRange?.(begin, begin + (1024 * 1024));
        }

        await expect(loadPromise).resolves.toBeNull();

        expect(electronApi.documentFiles.readFileRange).toHaveBeenCalledTimes(1);
        expect(electronApi.documentFiles.readFileRange).toHaveBeenCalledWith(
            '/tmp/range-burst-failure.pdf',
            failingBegin,
            1024 * 1024,
        );
        expect(range?.onDataRange).not.toHaveBeenCalled();
    });

    it.each([
        { staleReadOutcome: 'resolves' },
        { staleReadOutcome: 'rejects' },
    ] as const)(
        'lets load B finish before stale load A $staleReadOutcome its pending range read',
        async ({staleReadOutcome}) => {
            const chunkLength = 1024 * 1024;
            const requestedStart = chunkLength;
            const requestedEnd = requestedStart + chunkLength;
            const fileSize = 4 * chunkLength;
            const staleRead = Promise.withResolvers<Uint8Array>();
            const stalePlatformReadSettled = Promise.withResolvers<undefined>();
            const createDocument = (id: string) => ({
                id,
                numPages: 1,
                getPage: vi.fn(async () => ({
                    cleanup: vi.fn(),
                    getViewport: vi.fn(() => ({
                        width: 100,
                        height: 200,
                    })),
                })),
                destroy: vi.fn(() => Promise.resolve()),
            });
            const documentA = createDocument('a');
            const documentB = createDocument('b');
            const loadBResult = Promise.withResolvers<typeof documentB>();

            pdfjsState.getDocument
                .mockReturnValueOnce({
                    promise: Promise.resolve(documentA),
                    destroy: vi.fn(() => Promise.resolve()),
                })
                .mockReturnValueOnce({
                    promise: loadBResult.promise,
                    destroy: vi.fn(() => Promise.resolve()),
                });
            electronApi.documentFiles.readFileRange.mockImplementation(async (
                path: string,
                offset: number,
                length: number,
            ) => {
                if (path === '/tmp/range-session-a.pdf' && offset === requestedStart) {
                    return staleRead.promise.then(
                        (data) => {
                            stalePlatformReadSettled.resolve(undefined);
                            return data;
                        },
                        (error: unknown) => {
                            stalePlatformReadSettled.resolve(undefined);
                            throw error;
                        },
                    );
                }
                return new Uint8Array(length);
            });

            const documentState = createPdfDocumentSession();
            const sourceA = {
                kind: 'path',
                path: '/tmp/range-session-a.pdf',
                size: fileSize,
            } as const;
            const sourceB = {
                kind: 'path',
                path: '/tmp/range-session-b.pdf',
                size: fileSize,
            } as const;

            await expect(documentState.loadPdf(sourceA)).resolves.toEqual(expect.objectContaining({ document: documentA }));
            const rangeA = (pdfjsState.getDocument.mock.calls[0]?.[0] as { range?: MockPdfDataRangeTransport } | undefined)?.range;
            expect(rangeA).toBeInstanceOf(MockPdfDataRangeTransport);
            rangeA?.onDataRange.mockClear();
            rangeA?.requestDataRange?.(requestedStart, requestedEnd);
            await vi.waitFor(() => {
                expect(electronApi.documentFiles.readFileRange).toHaveBeenCalledWith(
                    sourceA.path,
                    requestedStart,
                    chunkLength,
                );
            });

            const loadB = documentState.loadPdf(sourceB);
            await vi.waitFor(() => {
                expect(pdfjsState.getDocument).toHaveBeenCalledTimes(2);
            });
            const rangeB = (pdfjsState.getDocument.mock.calls[1]?.[0] as { range?: MockPdfDataRangeTransport } | undefined)?.range;
            expect(rangeB).toBeInstanceOf(MockPdfDataRangeTransport);
            rangeB?.onDataRange.mockClear();
            rangeB?.requestDataRange?.(requestedStart, requestedEnd);

            await vi.waitFor(() => {
                expect(rangeB?.onDataRange).toHaveBeenCalledOnce();
            });
            loadBResult.resolve(documentB);
            await expect(loadB).resolves.toEqual(expect.objectContaining({ document: documentB }));
            expect(documentState.pdfDocument.value).toBe(documentB);
            expect(documentState.acceptedSource.value).toBe(sourceB);

            if (staleReadOutcome === 'resolves') {
                staleRead.resolve(new Uint8Array(chunkLength));
            } else {
                staleRead.reject(new Error('stale range A failed'));
            }
            await stalePlatformReadSettled.promise;
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });

            expect(rangeA?.onDataRange).not.toHaveBeenCalled();
            expect(rangeB?.onDataRange).toHaveBeenCalledOnce();
            expect(rangeB?.abort).not.toHaveBeenCalled();
            expect(documentB.destroy).not.toHaveBeenCalled();
            expect(documentState.pdfDocument.value).toBe(documentB);
            expect(documentState.acceptedSource.value).toBe(sourceB);
            expect(documentState.loadError.value).toBeNull();
            expect(loggerError).not.toHaveBeenCalledWith(
                'pdf-document',
                'Failed to read PDF range chunk',
                expect.anything(),
            );
        },
    );

    it('fulfills a PDF.js range request with multiple platform reads when a read is short', async () => {
        const deferred = Promise.withResolvers<{
            numPages: number;
            getPage: ReturnType<typeof vi.fn>;
            destroy: ReturnType<typeof vi.fn>;
        }>();
        const destroy = vi.fn(() => Promise.resolve());

        pdfjsState.getDocument.mockReturnValue({
            promise: deferred.promise,
            destroy,
        });

        const requestedStart = 5 * 1024 * 1024;
        const requestedEnd = requestedStart + 12;
        electronApi.documentFiles.readFileRange.mockImplementation(async (
            _path: string,
            offset: number,
            length: number,
        ) => {
            if (offset === requestedStart) {
                expect(length).toBe(12);
                return new Uint8Array(8);
            }
            if (offset === requestedStart + 8) {
                expect(length).toBe(4);
                return new Uint8Array(4);
            }
            return new Uint8Array(Math.min(length, 4));
        });

        const documentState = createPdfDocumentSession();
        const loadPromise = documentState.loadPdf({
            kind: 'path',
            path: '/tmp/short-range-read.pdf',
            size: 20 * 1024 * 1024,
        });

        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });

        const getDocumentArg = pdfjsState.getDocument.mock.calls[0]?.[0] as { range?: MockPdfDataRangeTransport } | undefined;
        const range = getDocumentArg?.range;
        expect(range).toBeInstanceOf(MockPdfDataRangeTransport);
        range?.onDataRange.mockClear();

        range?.requestDataRange?.(requestedStart, requestedEnd);
        await vi.waitFor(() => {
            expect(range?.onDataRange).toHaveBeenCalledTimes(1);
        });

        expect(electronApi.documentFiles.readFileRange).toHaveBeenCalledWith(
            '/tmp/short-range-read.pdf',
            requestedStart,
            12,
        );
        expect(electronApi.documentFiles.readFileRange).toHaveBeenCalledWith(
            '/tmp/short-range-read.pdf',
            requestedStart + 8,
            4,
        );
        expect(range?.onDataRange.mock.calls[0]?.[0]).toBe(requestedStart);
        expect(range?.onDataRange.mock.calls[0]?.[1]).toHaveLength(12);

        deferred.resolve({
            numPages: 1,
            getPage: vi.fn(async () => ({
                cleanup: vi.fn(),
                getViewport: vi.fn(() => ({
                    width: 100,
                    height: 200,
                })),
            })),
            destroy,
        });

        await expect(loadPromise).resolves.not.toBeNull();
    });

    it('fulfills a large PDF.js range request with bounded platform reads', async () => {
        const deferred = Promise.withResolvers<{
            numPages: number;
            getPage: ReturnType<typeof vi.fn>;
            destroy: ReturnType<typeof vi.fn>;
        }>();
        const destroy = vi.fn(() => Promise.resolve());

        pdfjsState.getDocument.mockReturnValue({
            promise: deferred.promise,
            destroy,
        });
        electronApi.documentFiles.readFileRange.mockImplementation(async (
            _path: string,
            _offset: number,
            length: number,
        ) => new Uint8Array(length));

        const documentState = createPdfDocumentSession();
        const loadPromise = documentState.loadPdf({
            kind: 'path',
            path: '/tmp/large-range.pdf',
            size: 80 * 1024 * 1024,
        });

        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });

        const range = (pdfjsState.getDocument.mock.calls[0]?.[0] as { range?: MockPdfDataRangeTransport } | undefined)?.range;
        expect(range).toBeInstanceOf(MockPdfDataRangeTransport);

        electronApi.documentFiles.readFileRange.mockClear();
        range?.onDataRange.mockClear();
        range?.requestDataRange?.(2 * 1024 * 1024, 12 * 1024 * 1024);

        await vi.waitFor(() => {
            expect(range?.onDataRange).toHaveBeenCalledTimes(10);
        });
        expect(electronApi.documentFiles.readFileRange).toHaveBeenNthCalledWith(
            1,
            '/tmp/large-range.pdf',
            2 * 1024 * 1024,
            8 * 1024 * 1024,
        );
        expect(electronApi.documentFiles.readFileRange).toHaveBeenNthCalledWith(
            2,
            '/tmp/large-range.pdf',
            10 * 1024 * 1024,
            2 * 1024 * 1024,
        );
        expect(range?.onDataRange.mock.calls.every(call => call[0] === 2 * 1024 * 1024)).toBe(true);
        expect(range?.onDataRange.mock.calls.every(call => call[1]?.byteLength === 1024 * 1024)).toBe(true);
        expect(range?.onDataRange.mock.calls.slice(0, -1).every(call => call[2] === false)).toBe(true);
        expect(range?.onDataRange.mock.calls.at(-1)?.[2]).toBeUndefined();

        deferred.resolve({
            numPages: 1,
            getPage: vi.fn(async () => ({
                cleanup: vi.fn(),
                getViewport: vi.fn(() => ({
                    width: 100,
                    height: 200,
                })),
            })),
            destroy,
        });

        await expect(loadPromise).resolves.not.toBeNull();
    });

    it('loads oversized path-backed files through the bounded PDF.js range transport', async () => {
        const size = 2 * 1024 * 1024 * 1024;
        electronApi.documentFiles.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = createPdfDocumentSession();
        const result = await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/native-opening-preview.pdf',
            size,
        });

        expect(result).not.toBeNull();
        expect(pdfjsState.getDocument).toHaveBeenCalledWith(expect.objectContaining({
            disableAutoFetch: true,
            disableStream: true,
            length: size,
            range: expect.any(MockPdfDataRangeTransport),
            rangeChunkSize: 1024 * 1024,
        }));
        expect(electronApi.documentFiles.readFileRange).toHaveBeenCalledTimes(2);
        expect(electronApi.documentFiles.readFileRange).toHaveBeenCalledWith(
            '/tmp/native-opening-preview.pdf',
            0,
            1024 * 1024,
        );
        expect(electronApi.documentFiles.readFileRange).toHaveBeenCalledWith(
            '/tmp/native-opening-preview.pdf',
            size - (1024 * 1024),
            1024 * 1024,
        );
        expect(loggerError).not.toHaveBeenCalled();
    });

    it('streams pathological-size PDF.js range requests without an aggregate allocation', async () => {
        const deferred = Promise.withResolvers<{
            numPages: number;
            getPage: ReturnType<typeof vi.fn>;
            destroy: ReturnType<typeof vi.fn>;
        }>();
        const destroy = vi.fn(() => {
            deferred.reject(new Error('pathological range load aborted'));
            return Promise.resolve();
        });

        pdfjsState.getDocument.mockReturnValue({
            promise: deferred.promise,
            destroy,
        });
        electronApi.documentFiles.readFileRange.mockImplementation(async (
            _path: string,
            _offset: number,
            length: number,
        ) => new Uint8Array(length));

        const documentState = createPdfDocumentSession();
        const loadPromise = documentState.loadPdf({
            kind: 'path',
            path: '/tmp/pathological-range.pdf',
            size: 128 * 1024 * 1024,
        });

        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });

        const range = (pdfjsState.getDocument.mock.calls[0]?.[0] as { range?: MockPdfDataRangeTransport } | undefined)?.range;
        expect(range).toBeInstanceOf(MockPdfDataRangeTransport);

        electronApi.documentFiles.readFileRange.mockClear();
        range?.requestDataRange?.(0, 64 * 1024 * 1024 + 1);

        await vi.waitFor(() => {
            expect(range?.onDataRange).toHaveBeenCalledTimes(65);
        });
        expect(electronApi.documentFiles.readFileRange).toHaveBeenCalledTimes(9);
        expect(range?.onDataRange.mock.calls.every(call => call[1]?.byteLength <= 1024 * 1024)).toBe(true);
        expect(range?.onDataRange.mock.calls.slice(0, -1).every(call => call[2] === false)).toBe(true);
        expect(range?.onDataRange.mock.calls.at(-1)?.[2]).toBeUndefined();

        documentState.cleanup();
        await expect(loadPromise).resolves.toBeNull();
        expect(destroy).toHaveBeenCalledTimes(1);
    });

    it('invalidates an accepted document when a later range read rejects', async () => {
        const documentDestroy = vi.fn();
        const taskDestroy = vi.fn(() => Promise.resolve());
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage: vi.fn(async () => ({
                    cleanup: vi.fn(),
                    getViewport: vi.fn(() => ({
                        width: 100,
                        height: 200,
                    })),
                })),
                destroy: documentDestroy,
            }),
            destroy: taskDestroy,
        });
        electronApi.documentFiles.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = createPdfDocumentSession();
        await expect(documentState.loadPdf({
            kind: 'path',
            path: '/tmp/post-load-range-failure.pdf',
            size: (1024 * 1024 * 2) + 512,
        })).resolves.not.toBeNull();

        const range = (pdfjsState.getDocument.mock.calls[0]?.[0] as { range?: MockPdfDataRangeTransport } | undefined)?.range;
        expect(documentState.pdfDocument.value).not.toBeNull();

        const postLoadReadError = new Error('post-load read failed');
        electronApi.documentFiles.readFileRange.mockRejectedValue(postLoadReadError);
        range?.requestDataRange?.(1024 * 1024, (1024 * 1024) + 512);

        await vi.waitFor(() => {
            expect(documentState.pdfDocument.value).toBeNull();
            expect(documentState.loadState.value.status).toBe('failed');
        });

        expect(documentState.loadError.value).toBe(postLoadReadError);
        expect(documentState.acceptedSource.value).toBeNull();
        expect(documentState.isLoading.value).toBe(false);
        expect(documentState.numPages.value).toBe(0);
        expect(taskDestroy).not.toHaveBeenCalled();
        expect(documentDestroy).toHaveBeenCalledTimes(1);
        expect(range?.abort).toHaveBeenCalledTimes(1);
    });

    it('unpublishes an accepted document when initial metric priming fails', async () => {
        const documentDestroy = vi.fn();
        const taskDestroy = vi.fn(() => Promise.resolve());
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 2,
                getPage: vi.fn(async () => {
                    throw new Error('page 1 unavailable');
                }),
                destroy: documentDestroy,
            }),
            destroy: taskDestroy,
        });
        electronApi.documentFiles.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = createPdfDocumentSession();
        const result = await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/metric-prime-failure.pdf',
            size: 2048,
        });

        expect(result).toBeNull();
        expect(documentState.acceptedSource.value).toBeNull();
        expect(documentState.pdfDocument.value).toBeNull();
        expect(documentState.numPages.value).toBe(0);
        expect(documentState.pageMetrics.value).toEqual([]);
        expect(taskDestroy).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(documentDestroy).toHaveBeenCalledOnce());
    });

    it('keeps the accepted source bound to load B when stale load A resolves afterward', async () => {
        const staleDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({getViewport: vi.fn(() => ({
                width: 100,
                height: 200,
            }))})),
            destroy: vi.fn(() => Promise.resolve()),
        };
        const currentDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({getViewport: vi.fn(() => ({
                width: 300,
                height: 400,
            }))})),
            destroy: vi.fn(() => Promise.resolve()),
        };
        const staleLoad = Promise.withResolvers<typeof staleDocument>();
        pdfjsState.getDocument
            .mockReturnValueOnce({
                promise: staleLoad.promise,
                destroy: vi.fn(() => Promise.resolve()),
            })
            .mockReturnValueOnce({
                promise: Promise.resolve(currentDocument),
                destroy: vi.fn(() => Promise.resolve()),
            });

        const documentState = createPdfDocumentSession();
        const sourceA = new Blob([Uint8Array.of(1)]);
        const sourceB = new Blob([Uint8Array.of(2)]);
        const loadA = documentState.loadPdf(sourceA);
        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });

        const loadB = documentState.loadPdf(sourceB);
        await expect(loadB).resolves.toEqual(expect.objectContaining({ document: currentDocument }));
        expect(documentState.pdfDocument.value).toBe(currentDocument);
        expect(documentState.acceptedSource.value).toBe(sourceB);

        staleLoad.resolve(staleDocument);
        await expect(loadA).resolves.toBeNull();

        expect(documentState.pdfDocument.value).toBe(currentDocument);
        expect(documentState.acceptedSource.value).toBe(sourceB);
        expect(staleDocument.destroy).toHaveBeenCalledOnce();
    });

    it('clears the accepted source on explicit cleanup', async () => {
        electronApi.documentFiles.readFileRange.mockResolvedValue(Uint8Array.of(1, 2, 3, 4));
        const documentState = createPdfDocumentSession();
        const source = {
            kind: 'path',
            path: '/tmp/cleanup-source.pdf',
            size: 2048,
        } as const;

        await expect(documentState.loadPdf(source)).resolves.not.toBeNull();
        expect(documentState.acceptedSource.value).toBe(source);

        documentState.cleanup();

        expect(documentState.acceptedSource.value).toBeNull();
        expect(documentState.pdfDocument.value).toBeNull();
    });

    it('destroys the PDF.js loading task and aborts range transport when document parsing fails', async () => {
        const destroy = vi.fn(() => Promise.resolve());
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.reject(new Error('parse failed')),
            destroy,
        });
        electronApi.documentFiles.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = createPdfDocumentSession();
        const result = await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/parse-failure.pdf',
            size: (1024 * 1024) + 512,
        });

        const getDocumentArg = pdfjsState.getDocument.mock.calls[0]?.[0] as { range?: MockPdfDataRangeTransport } | undefined;
        expect(result).toBeNull();
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(getDocumentArg?.range?.abort).toHaveBeenCalledTimes(1);

        documentState.cleanup();

        expect(destroy).toHaveBeenCalledTimes(1);
        expect(getDocumentArg?.range?.abort).toHaveBeenCalledTimes(1);
    });

    it('destroys the PDF.js loading task and revokes blob URLs when blob loading fails', async () => {
        const destroy = vi.fn(() => Promise.resolve());
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.reject(new Error('blob parse failed')),
            destroy,
        });

        const documentState = createPdfDocumentSession();
        const result = await documentState.loadPdf(new Blob([Uint8Array.of(1, 2, 3)]));

        expect(result).toBeNull();
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(createObjectURLMock).toHaveBeenCalledTimes(1);
        expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:pdf-load');

        documentState.cleanup();

        expect(destroy).toHaveBeenCalledTimes(1);
        expect(revokeObjectURLMock).toHaveBeenCalledTimes(1);
    });

    it('finishes accepted document teardown before submitting the next PDF.js load', async () => {
        const firstDestroy = Promise.withResolvers<undefined>();
        const firstTaskDestroy = vi.fn(() => Promise.resolve());
        const firstDocumentDestroy = vi.fn(() => firstDestroy.promise);
        const secondDocumentDestroy = vi.fn(() => Promise.resolve());
        const createDocument = (destroy: ReturnType<typeof vi.fn>) => ({
            numPages: 1,
            getPage: vi.fn(async () => ({
                cleanup: vi.fn(),
                getViewport: vi.fn(() => ({
                    width: 100,
                    height: 200,
                })),
            })),
            destroy,
        });

        pdfjsState.getDocument
            .mockReturnValueOnce({
                promise: Promise.resolve(createDocument(firstDocumentDestroy)),
                destroy: firstTaskDestroy,
            })
            .mockReturnValueOnce({
                promise: Promise.resolve(createDocument(secondDocumentDestroy)),
                destroy: vi.fn(() => Promise.resolve()),
            });
        electronApi.documentFiles.readFileRange.mockResolvedValue(Uint8Array.of(1, 2, 3, 4));

        const documentState = createPdfDocumentSession();
        await expect(documentState.loadPdf({
            kind: 'path',
            path: '/tmp/first.pdf',
            size: 2048,
        })).resolves.not.toBeNull();

        documentState.cleanup();
        await vi.waitFor(() => {
            expect(firstDocumentDestroy).toHaveBeenCalledOnce();
        });

        electronApi.documentFiles.readFileRange.mockClear();
        const secondLoad = documentState.loadPdf({
            kind: 'path',
            path: '/tmp/second.pdf',
            size: 2048,
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(firstTaskDestroy).not.toHaveBeenCalled();
        expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        expect(electronApi.documentFiles.readFileRange).not.toHaveBeenCalled();

        firstDestroy.resolve(undefined);

        await expect(secondLoad).resolves.not.toBeNull();
        expect(pdfjsState.getDocument).toHaveBeenCalledTimes(2);
        expect(electronApi.documentFiles.readFileRange).toHaveBeenCalled();
    });

    it('settles invalidation cancellation and its page lease before destroying the PDF.js document', async () => {
        const events: string[] = [];
        const render = Promise.withResolvers<undefined>();
        const page = {
            cleanup: vi.fn(() => events.push('page-cleanup')),
            getViewport: vi.fn(() => ({
                width: 100,
                height: 200,
            })),
            pageNumber: 1,
        };
        const documentDestroy = vi.fn(async () => {
            events.push('document-destroy');
        });
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage: vi.fn(async () => page),
                destroy: documentDestroy,
            }),
            destroy: vi.fn(() => Promise.resolve()),
        });
        electronApi.documentFiles.readFileRange.mockResolvedValue(Uint8Array.of(1, 2, 3, 4));
        const source = shallowRef<Blob | null>(new Blob([Uint8Array.of(1)]));
        const documentState = createPdfDocumentSession({src: computed(() => source.value)});
        await documentState.loadPdf(source.value!);
        const scheduler = documentState.rasterScheduler!;
        const demand = {
            consumerGeneration: 1,
            documentFence: scheduler.documentFence,
            estimatedPixels: 100,
            lane: 'viewport-visible',
            ordinal: 1,
            pageNumber: 1,
            renderKey: 'initial',
            retention: 'render-cache',
        } as const;
        const cancel = vi.fn(() => {
            events.push('render-cancel');
        });
        const renderTask: IPdfRenderTask = {
            _internalRenderTask: null,
            cancel,
            imageCoordinates: null,
            onContinue: vi.fn(),
            onError: vi.fn(),
            promise: render.promise,
            separateAnnots: false,
        };
        scheduler.setDemand({
            sourceId: 'viewport',
            input: [demand],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: {
                id: 'viewport',
                prepare: async () => ({}),
                start: () => renderTask,
                commit: () => true,
                discard: vi.fn(),
                release: vi.fn(),
            },
        });
        await vi.waitFor(() => expect(scheduler.snapshot().inFlightPages).toHaveLength(1));
        documentState.subscribe(async (transition) => {
            if (transition.phase !== 'invalidated') {
                return;
            }
            await scheduler.cancelSource('viewport');
            events.push('invalidation-settled');
        });

        source.value = null;
        await nextTick();
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());

        expect(documentDestroy).not.toHaveBeenCalled();
        expect(page.cleanup).not.toHaveBeenCalled();

        render.resolve(undefined);
        await vi.waitFor(() => expect(documentDestroy).toHaveBeenCalledOnce());

        expect(events).toEqual([
            'render-cancel',
            'invalidation-settled',
            'page-cleanup',
            'document-destroy',
        ]);
    });

    it('does not destroy PDF.js while cancelled page preparation is still running', async () => {
        const events: string[] = [];
        const operatorList = Promise.withResolvers<{
            fnArray: number[];
            argsArray: unknown[][];
        }>();
        const prepareStarted = vi.fn();
        const startCalled = vi.fn();
        const page = {
            cleanup: vi.fn(() => events.push('page-cleanup')),
            getOperatorList: vi.fn(() => operatorList.promise),
            getViewport: vi.fn(() => ({
                width: 100,
                height: 200,
            })),
            pageNumber: 1,
        };
        const documentDestroy = vi.fn(async () => {
            events.push('document-destroy');
        });
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage: vi.fn(async () => page),
                destroy: documentDestroy,
            }),
            destroy: vi.fn(() => Promise.resolve()),
        });
        electronApi.documentFiles.readFileRange.mockResolvedValue(Uint8Array.of(1, 2, 3, 4));
        const source = new Blob([Uint8Array.of(1)]);
        const documentState = createPdfDocumentSession({src: computed(() => source)});
        await documentState.loadPdf(source);
        const scheduler = documentState.rasterScheduler!;
        scheduler.setDemand({
            sourceId: 'viewport',
            input: [{
                consumerGeneration: 1,
                documentFence: scheduler.documentFence,
                estimatedPixels: 100,
                lane: 'viewport-visible',
                ordinal: 1,
                pageNumber: 1,
                renderKey: 'preparing',
                retention: 'render-cache',
            } as const],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: {
                id: 'viewport',
                prepare: async (_demand, leasedPage, signal, captureSettlement) => runCoordinatedPdfPageOperation({
                    owner: 'viewport',
                    pageNumber: leasedPage.pageNumber,
                    pdfPage: leasedPage,
                    priority: 100,
                    signal,
                    captureSettlement,
                    operation: async () => {
                        prepareStarted();
                        events.push('preparation-start');
                        const result = await leasedPage.getOperatorList();
                        events.push('preparation-settled');
                        return result;
                    },
                }).then(() => signal.aborted ? null : {}, () => null),
                start: () => {
                    startCalled();
                    throw new Error('Cancelled preparation must not start a render');
                },
                commit: () => true,
                discard: vi.fn(),
                release: vi.fn(),
            },
        });
        await vi.waitFor(() => expect(prepareStarted).toHaveBeenCalledOnce());

        documentState.cleanup();
        await vi.waitFor(() => expect(scheduler.snapshot().accepting).toBe(false));

        expect(documentDestroy).not.toHaveBeenCalled();
        expect(page.cleanup).not.toHaveBeenCalled();
        expect(startCalled).not.toHaveBeenCalled();

        operatorList.resolve({
            fnArray: [],
            argsArray: [],
        });
        await vi.waitFor(() => expect(documentDestroy).toHaveBeenCalledOnce());

        expect(startCalled).not.toHaveBeenCalled();
        expect(events).toEqual([
            'preparation-start',
            'preparation-settled',
            'page-cleanup',
            'document-destroy',
        ]);
    });

    it('bounds the cached PDF pages with an LRU policy', async () => {
        const loadedPages = new Map<number, Array<{
            cleanup: ReturnType<typeof vi.fn>;
            pageNumber: number;
        }>>();
        const getPage = vi.fn(async (pageNumber: number) => ({
            getViewport: vi.fn(() => ({
                width: 200,
                height: 400,
            })),
            cleanup: vi.fn(),
            pageNumber,
        })).mockImplementation(async (pageNumber: number) => {
            const page = {
                getViewport: vi.fn(() => ({
                    width: 200,
                    height: 400,
                })),
                cleanup: vi.fn(),
                pageNumber,
            };
            loadedPages.set(pageNumber, [
                ...(loadedPages.get(pageNumber) ?? []),
                page,
            ]);
            return page;
        });
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: maxCachedPdfPages + 5,
                getPage,
                destroy: vi.fn(),
            }),
            destroy: vi.fn(),
        });
        electronApi.documentFiles.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = createPdfDocumentSession();
        await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/cache-lru.pdf',
            size: 2048,
        });

        expect(getPage).toHaveBeenCalledTimes(1);

        for (let pageNumber = 2; pageNumber <= maxCachedPdfPages + 1; pageNumber += 1) {
            await documentState.getPage(pageNumber);
        }

        expect(getPage).toHaveBeenCalledTimes(maxCachedPdfPages + 1);

        await documentState.getPage(1);

        expect(getPage).toHaveBeenCalledTimes(maxCachedPdfPages + 2);

        await documentState.getPage(maxCachedPdfPages + 1);

        expect(getPage).toHaveBeenCalledTimes(maxCachedPdfPages + 2);
        expect(loadedPages.get(2)?.[0]?.cleanup).toHaveBeenCalledTimes(1);
    });

    it('defers cache cleanup for active page leases until release', async () => {
        const loadedPages = new Map<number, Array<{
            cleanup: ReturnType<typeof vi.fn>;
            getViewport: ReturnType<typeof vi.fn>;
            pageNumber: number;
        }>>();
        const getPage = vi.fn(async (pageNumber: number) => {
            const page = {
                cleanup: vi.fn(),
                getViewport: vi.fn(() => ({
                    width: 200,
                    height: 400,
                })),
                pageNumber,
            };
            loadedPages.set(pageNumber, [
                ...(loadedPages.get(pageNumber) ?? []),
                page,
            ]);
            return page;
        });
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 2,
                getPage,
                destroy: vi.fn(),
            }),
            destroy: vi.fn(),
        });
        electronApi.documentFiles.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = createPdfDocumentSession();
        await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/deferred-lease-cleanup.pdf',
            size: 2048,
        });
        const pageLease = await documentState.leasePage(1);
        documentState.cleanupPageCache();

        expect(loadedPages.get(1)?.[0]?.cleanup).not.toHaveBeenCalled();

        pageLease.release();

        expect(loadedPages.get(1)?.[0]?.cleanup).toHaveBeenCalledTimes(1);

        await documentState.getPage(1);

        expect(getPage).toHaveBeenCalledTimes(2);
        expect(loadedPages.get(1)?.[1]?.cleanup).not.toHaveBeenCalled();
    });

    it('keeps background inventory pages out of the visible render LRU', async () => {
        const pages = new Map<number, Array<{
            cleanup: ReturnType<typeof vi.fn>;
            getViewport: ReturnType<typeof vi.fn>;
            pageNumber: number;
        }>>();
        const getPage = vi.fn(async (pageNumber: number) => {
            const page = {
                cleanup: vi.fn(),
                getViewport: vi.fn(() => ({
                    width: 200,
                    height: 400,
                })),
                pageNumber,
            };
            pages.set(pageNumber, [
                ...(pages.get(pageNumber) ?? []),
                page,
            ]);
            return page;
        });
        const pdfDocument = {
            numPages: 2,
            getPage,
            destroy: vi.fn(),
        };
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(pdfDocument),
            destroy: vi.fn(),
        });
        electronApi.documentFiles.readFileRange.mockResolvedValue(Uint8Array.of(1, 2, 3, 4));

        const documentState = createPdfDocumentSession();
        await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/background-page-inventory.pdf',
            size: 2048,
        });

        const backgroundLease = await leasePdfDocumentPage(
            pdfDocument as never,
            2,
            'transient-background',
        );
        backgroundLease.release();

        expect(pages.get(2)?.[0]?.cleanup).not.toHaveBeenCalled();
        await documentState.getPage(2);
        expect(getPage).toHaveBeenCalledTimes(3);
        expect(pages.get(1)?.[0]?.cleanup).not.toHaveBeenCalled();
    });

    it('keeps stable cached page proxies attached to one exact lease entry across eviction', async () => {
        const stablePage = {
            cleanup: vi.fn(),
            getViewport: vi.fn(() => ({
                width: 200,
                height: 400,
            })),
            pageNumber: 1,
        };
        const getPage = vi.fn(async () => stablePage);
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage,
                destroy: vi.fn(),
            }),
            destroy: vi.fn(),
        });
        electronApi.documentFiles.readFileRange.mockResolvedValue(Uint8Array.of(1, 2, 3, 4));

        const documentState = createPdfDocumentSession();
        await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/stable-proxy-leases.pdf',
            size: 2048,
        });

        const firstLease = await documentState.leasePage(1);
        documentState.evictPage(1);
        const secondLease = await documentState.leasePage(1);
        documentState.evictPage(1);

        secondLease.release();
        expect(stablePage.cleanup).not.toHaveBeenCalled();

        firstLease.release();
        expect(stablePage.cleanup).toHaveBeenCalledOnce();

        firstLease.release();
        secondLease.release();
        expect(stablePage.cleanup).toHaveBeenCalledOnce();

        const thirdLease = await documentState.leasePage(1);
        const fourthLease = await documentState.leasePage(1);
        documentState.evictPage(1);

        thirdLease.release();
        expect(stablePage.cleanup).toHaveBeenCalledOnce();
        fourthLease.release();
        expect(stablePage.cleanup).toHaveBeenCalledTimes(2);
        expect(getPage).toHaveBeenCalledTimes(3);
    });
});
