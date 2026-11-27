import {describe, expect, it, vi} from 'vitest';

import {
    assertBrowserDjvuSource,
    getBrowserDjvuInfo,
    runBrowserDjvuConversion,
    resolveBrowserDjvuPdfRenderConcurrency,
    resolveBrowserDjvuPdfRenderSettings,
    withBrowserDjvuWorker,
    cancelBrowserDjvuConversion,
    onBrowserDjvuConversionProgress,
} from '@app/platform/browser-api/browserDjvuConversionPipeline';
import {runJob} from '@app/utils/jobs/runJob';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {requireDocumentRef} from '@contracts/documentRef';
import {createRequestId, requireJobId} from '@contracts/shared';
import {requireEpochMs} from '@contracts/timestamps';
import {createElectronPlatformApiFixture} from '@tests/helpers/createElectronPlatformApiFixture';
import {SerializableError} from '@contracts/serializableError';

const mocks = vi.hoisted(() => ({
    createWorker: vi.fn(),
    getPageSizes: vi.fn(),
    loggerError: vi.fn(),
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    buildCompactPage: vi.fn(),
    combineWorker: vi.fn(),
    pageOps: vi.fn(),
    renderDjvuPage: vi.fn(),
    /** The page-ops request boundary a test lowers; null keeps the real one. */
    pageOpsMaxRequestBytes: null as number | null,
}));

vi.mock('@contracts/browserPageOpsLimits', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@contracts/browserPageOpsLimits')>();
    return {
        ...actual,
        get BROWSER_PAGE_OPS_MAX_REQUEST_BYTES() {
            return mocks.pageOpsMaxRequestBytes ?? actual.BROWSER_PAGE_OPS_MAX_REQUEST_BYTES;
        },
    };
});

vi.mock('@app/platform/browser-api/createDjvuWorkerFromPath', () => ({
    createDjvuWorkerFromPath: mocks.createWorker,
    getDjvuWorkerPageSizes: mocks.getPageSizes,
}));
vi.mock('@app/utils/browserLogger', () => ({
    BrowserLogger: {
        error: mocks.loggerError,
        info: mocks.loggerInfo,
        warn: mocks.loggerWarn,
    },
}));
vi.mock('@app/platform/browser-api/browserPdfCombineWorkerClient', () => ({runBrowserPdfCombineWorkerRequest: mocks.combineWorker}));
vi.mock('@app/platform/browser-api/browserPageOpsWorkerClient', () => ({runBrowserPageOpsWorkerRequest: mocks.pageOps}));
vi.mock('@app/platform/browser-api/buildBrowserDjvuCompactPage', () => ({buildBrowserDjvuCompactPage: mocks.buildCompactPage}));
vi.mock('@app/platform/browser-api/browserDjvuRasterizer', () => ({
    DjvuCanceledError: class DjvuCanceledError extends Error {
        public constructor() {
            super('DjVu conversion canceled');
            this.name = 'DjvuCanceledError';
        }
    },
    renderDjvuPage: mocks.renderDjvuPage,
    throwIfDjvuCanceled: (signal?: AbortSignal) => {
        if (signal?.aborted) {
            throw new Error('DjVu conversion canceled');
        }
    },
}));

const browserFailure: FailureReceipt = {
    eventId: '0123456789abcdef0123456789abcdef' as FailureReceipt['eventId'],
    code: 'UNCLASSIFIED_RENDERER_ERROR',
    occurredAt: requireEpochMs(1),
    severity: 'error',
};

describe('browserDjvuConversionPipeline', () => {
    it('refuses absolute paths without a native DjVu bridge before worker creation', () => {
        const electronApi = createElectronPlatformApiFixture();
        Reflect.deleteProperty(electronApi.djvu, 'getInfo');
        vi.stubGlobal('window', {electronAPI: electronApi});

        expect(() => assertBrowserDjvuSource(requireDocumentRef('/tmp/native.djvu'), 'info')).toThrowError(
            expect.objectContaining({
                code: 'native-unavailable',
                name: 'PdfCombineCapabilityError',
                operation: 'djvu-info',
            }),
        );
    });

    it('does not read or create a worker for an absolute path without a native bridge', async () => {
        const readFile = vi.fn();
        const readFileRange = vi.fn();
        const statFile = vi.fn();
        const electronApi = createElectronPlatformApiFixture({
            documentFiles: {
                readFile,
                readFileRange,
                statFile,
            },
        });
        Reflect.deleteProperty(electronApi.djvu, 'getInfo');
        vi.stubGlobal('window', {electronAPI: electronApi});
        mocks.createWorker.mockRejectedValue(new Error('browser DjVu worker must not be created'));

        await expect(withBrowserDjvuWorker(requireDocumentRef('/tmp/native.djvu'), async () => undefined, 'info')).rejects.toMatchObject({
            code: 'native-unavailable',
            operation: 'djvu-info',
        });

        expect(mocks.createWorker).not.toHaveBeenCalled();
        expect(statFile).not.toHaveBeenCalled();
        expect(readFile).not.toHaveBeenCalled();
        expect(readFileRange).not.toHaveBeenCalled();
    });

    it('preserves browser document references for the browser worker route', () => {
        expect(() => assertBrowserDjvuSource(requireDocumentRef('browser://documents/book.djvu'), 'info')).not.toThrow();
    });

    it('keeps direct raster exports at the requested source detail', () => {
        expect(
            resolveBrowserDjvuPdfRenderSettings({
                pdfStrategy: 'direct',
                subsample: 1,
            }),
        ).toEqual({
            strategy: 'direct',
            subsample: 1,
            jpegQuality: 0.92,
        });

        expect(
            resolveBrowserDjvuPdfRenderSettings({
                pdfStrategy: 'auto',
                subsample: 4,
            }),
        ).toEqual({
            strategy: 'direct',
            subsample: 4,
            jpegQuality: 0.92,
        });
    });

    it('uses the photo quality of the compact preset each subsample selects', () => {
        expect(
            resolveBrowserDjvuPdfRenderSettings({
                pdfStrategy: 'compact-djvu-aware',
                subsample: 1,
            }),
        ).toEqual({
            strategy: 'compact-djvu-aware',
            subsample: 1,
            jpegQuality: 95,
        });

        expect(
            resolveBrowserDjvuPdfRenderSettings({
                pdfStrategy: 'compact-djvu-aware',
                subsample: 4,
            }),
        ).toEqual({
            strategy: 'compact-djvu-aware',
            subsample: 4,
            jpegQuality: 75,
        });
    });

    it('caps browser DjVu page rendering concurrency by cores and page size', () => {
        const ordinaryPages = Array.from({length: 10}, () => ({
            width: 2_400,
            height: 3_200,
        }));

        expect(resolveBrowserDjvuPdfRenderConcurrency(ordinaryPages, 8)).toBe(3);
        expect(resolveBrowserDjvuPdfRenderConcurrency(ordinaryPages, 2)).toBe(1);
        expect(resolveBrowserDjvuPdfRenderConcurrency([ordinaryPages[0]!], 8)).toBe(1);
        expect(
            resolveBrowserDjvuPdfRenderConcurrency(
                [
                    {
                        width: 4_500,
                        height: 4_000,
                    },
                    {
                        width: 4_500,
                        height: 4_000,
                    },
                ],
                8,
            ),
        ).toBe(2);
        expect(
            resolveBrowserDjvuPdfRenderConcurrency(
                [
                    {
                        width: 6_000,
                        height: 6_000,
                    },
                    {
                        width: 6_000,
                        height: 6_000,
                    },
                ],
                8,
            ),
        ).toBe(1);
    });

    it.each([
        ['low', 1],
        ['medium', 3],
        ['high', 3],
    ] as const)('clamps %s-tier browser DjVu conversion concurrency to %i', (tier, expectedConcurrency) => {
        const ordinaryPages = Array.from({length: 10}, () => ({
            width: 2_400,
            height: 3_200,
        }));

        expect(resolveBrowserDjvuPdfRenderConcurrency(ordinaryPages, 8, tier)).toBe(expectedConcurrency);
    });

    it('falls back to direct JPEG combine when the compact request exceeds the WASM boundary', async () => {
        const stat = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: 1,
            modifiedAt: 1,
        });
        const getSaveTarget = vi
            .spyOn(browserDocumentStore, 'getSaveTarget')
            .mockRejectedValue(new Error('direct export output requested'));
        mocks.createWorker.mockResolvedValueOnce({terminate: vi.fn()});
        mocks.getPageSizes.mockResolvedValueOnce([
            {
                width: 100,
                height: 100,
                dpi: 300,
            },
        ]);
        mocks.buildCompactPage.mockResolvedValueOnce({
            route: 'photo',
            spec: {
                kind: 'image',
                pageSize: {
                    widthPoints: 72,
                    heightPoints: 72,
                },
                image: {
                    fileName: 'page.ppm',
                    data: new Uint8Array([0x50, 0x36]),
                },
            },
        });
        mocks.renderDjvuPage.mockResolvedValueOnce({
            bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
            width: 100,
            height: 100,
            dpi: 300,
        });
        mocks.combineWorker
            .mockRejectedValueOnce(
                new SerializableError({
                    code: 'too-large',
                    message: 'Image combine WASM request exceeds the admission ceiling',
                }),
            )
            .mockResolvedValueOnce({data: new Uint8Array([0x25, 0x50, 0x44, 0x46])});

        try {
            await expect(
                runBrowserDjvuConversion(
                    requireDocumentRef('browser://documents/book.djvu'),
                    requireDocumentRef('browser://documents/output.pdf'),
                    {
                        jobId: requireJobId('djvu-compact-boundary'),
                        pdfStrategy: 'compact-djvu-aware',
                        preserveBookmarks: false,
                    },
                ),
            ).resolves.toMatchObject({
                success: false,
                error: 'direct export output requested',
            });
            expect(mocks.renderDjvuPage).toHaveBeenCalledOnce();
            expect(mocks.combineWorker).toHaveBeenCalledTimes(2);
            expect(mocks.combineWorker.mock.calls[1]?.[1]).toMatchObject({
                inputs: [],
                wasmImagePreprocessing: {
                    pageSpecs: [
                        {
                            kind: 'image',
                            pageSize: {
                                widthPoints: 24,
                                heightPoints: 24,
                            },
                            image: {fileName: 'page-00001.jpg'},
                        },
                    ],
                },
            });
            expect(getSaveTarget).toHaveBeenCalledOnce();
        } finally {
            mocks.renderDjvuPage.mockReset();
            mocks.combineWorker.mockReset();
            stat.mockRestore();
            getSaveTarget.mockRestore();
        }
    });

    it('falls back to direct JPEG combine when one page of many exceeds the WASM boundary while another is still building', async () => {
        const stat = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: 1,
            modifiedAt: 1,
        });
        const getSaveTarget = vi
            .spyOn(browserDocumentStore, 'getSaveTarget')
            .mockRejectedValue(new Error('direct export output requested'));
        vi.stubGlobal('navigator', {hardwareConcurrency: 8});
        const page = {
            width: 100,
            height: 100,
            dpi: 300,
        };
        mocks.createWorker.mockResolvedValue({terminate: vi.fn()});
        mocks.getPageSizes.mockResolvedValueOnce([page, page]);
        // Page 1 is still decoding when page 2 is refused; it stops as a
        // canceled DjVu page does, with an error of its own.
        mocks.buildCompactPage.mockImplementation(
            (_worker: unknown, pageNumber: number, _metrics: unknown, _preset: unknown, signal: AbortSignal) =>
                pageNumber === 1
                    ? new Promise((_resolve, reject) => {
                          signal.addEventListener('abort', () => reject(new Error('DjVu conversion canceled')), {once: true});
                      })
                    : Promise.resolve({
                          route: 'photo',
                          spec: {
                              kind: 'image',
                              pageSize: {
                                  widthPoints: 72,
                                  heightPoints: 72,
                              },
                              image: {
                                  fileName: 'page.ppm',
                                  data: new Uint8Array([2]),
                              },
                          },
                      }),
        );
        mocks.renderDjvuPage.mockResolvedValue({
            bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
            width: 100,
            height: 100,
            dpi: 300,
        });
        mocks.combineWorker
            .mockRejectedValueOnce(
                new SerializableError({
                    code: 'too-large',
                    message: 'Image dimensions are too large to combine safely: 10000x8001',
                }),
            )
            .mockResolvedValue({data: new Uint8Array([0x25, 0x50, 0x44, 0x46])});
        mocks.pageOps.mockResolvedValueOnce({
            status: 'written',
            data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        });

        try {
            await expect(
                runBrowserDjvuConversion(
                    requireDocumentRef('browser://documents/book.djvu'),
                    requireDocumentRef('browser://documents/output.pdf'),
                    {
                        jobId: requireJobId('djvu-compact-page-boundary'),
                        pdfStrategy: 'compact-djvu-aware',
                        preserveBookmarks: false,
                    },
                ),
            ).resolves.toMatchObject({
                success: false,
                error: 'direct export output requested',
            });
            expect(mocks.renderDjvuPage).toHaveBeenCalledTimes(2);
            expect(getSaveTarget).toHaveBeenCalledOnce();
        } finally {
            vi.unstubAllGlobals();
            mocks.buildCompactPage.mockReset();
            mocks.renderDjvuPage.mockReset();
            mocks.combineWorker.mockReset();
            mocks.createWorker.mockReset();
            mocks.pageOps.mockReset();
            stat.mockRestore();
            getSaveTarget.mockRestore();
        }
    });

    it('falls back to direct JPEG combine when the encoded compact pages together exceed what one merge request holds', async () => {
        const stat = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: 1,
            modifiedAt: 1,
        });
        const getSaveTarget = vi
            .spyOn(browserDocumentStore, 'getSaveTarget')
            .mockRejectedValue(new Error('direct export output requested'));
        const page = {
            width: 100,
            height: 100,
            dpi: 300,
        };
        mocks.createWorker.mockResolvedValue({terminate: vi.fn()});
        mocks.getPageSizes.mockResolvedValueOnce([page, page]);
        mocks.buildCompactPage.mockResolvedValue({
            route: 'photo',
            spec: {
                kind: 'image',
                pageSize: {
                    widthPoints: 72,
                    heightPoints: 72,
                },
                image: {
                    fileName: 'page.ppm',
                    data: new Uint8Array([1]),
                },
            },
        });
        mocks.renderDjvuPage.mockResolvedValue({
            bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
            width: 100,
            height: 100,
            dpi: 300,
        });
        // Compact pages encode to 4 bytes each (8 > 6); direct JPEG pages encode to 2 bytes each (4 <= 6).
        mocks.combineWorker.mockImplementation(
            async (_type: string, payload: {wasmImagePreprocessing: {pageSpecs: Array<{image: {fileName: string}}>}}) => ({
                data: payload.wasmImagePreprocessing.pageSpecs[0]!.image.fileName.endsWith('.jpg') ? new Uint8Array(2) : new Uint8Array(4),
            }),
        );
        mocks.pageOps.mockResolvedValueOnce({
            status: 'written',
            data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        });
        mocks.pageOpsMaxRequestBytes = 6;

        try {
            await expect(
                runBrowserDjvuConversion(
                    requireDocumentRef('browser://documents/book.djvu'),
                    requireDocumentRef('browser://documents/output.pdf'),
                    {
                        jobId: requireJobId('djvu-compact-joined-boundary'),
                        pdfStrategy: 'compact-djvu-aware',
                        preserveBookmarks: false,
                    },
                ),
            ).resolves.toMatchObject({
                success: false,
                error: 'direct export output requested',
            });
            expect(getSaveTarget).toHaveBeenCalledOnce();
            expect(mocks.pageOps).toHaveBeenCalledOnce();
        } finally {
            mocks.pageOpsMaxRequestBytes = null;
            mocks.buildCompactPage.mockReset();
            mocks.renderDjvuPage.mockReset();
            mocks.combineWorker.mockReset();
            mocks.createWorker.mockReset();
            mocks.pageOps.mockReset();
            stat.mockRestore();
            getSaveTarget.mockRestore();
        }
    });

    it('falls back to direct JPEG combine when the compact merge engine has no room to join the pages', async () => {
        const stat = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: 1,
            modifiedAt: 1,
        });
        const getSaveTarget = vi
            .spyOn(browserDocumentStore, 'getSaveTarget')
            .mockRejectedValue(new Error('direct export output requested'));
        const page = {
            width: 100,
            height: 100,
            dpi: 300,
        };
        mocks.createWorker.mockResolvedValue({terminate: vi.fn()});
        mocks.getPageSizes.mockResolvedValueOnce([page, page]);
        mocks.buildCompactPage.mockResolvedValue({
            route: 'photo',
            spec: {
                kind: 'image',
                pageSize: {
                    widthPoints: 72,
                    heightPoints: 72,
                },
                image: {
                    fileName: 'page.ppm',
                    data: new Uint8Array([1]),
                },
            },
        });
        mocks.renderDjvuPage.mockResolvedValue({
            bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
            width: 100,
            height: 100,
            dpi: 300,
        });
        mocks.combineWorker.mockResolvedValue({data: new Uint8Array(4)});
        mocks.pageOps
            .mockResolvedValueOnce({
                status: 'failed',
                error: {
                    code: 'too-large',
                    message: 'The PDF page engine ran out of memory',
                },
            })
            .mockResolvedValueOnce({
                status: 'written',
                data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
            });

        try {
            await expect(
                runBrowserDjvuConversion(
                    requireDocumentRef('browser://documents/book.djvu'),
                    requireDocumentRef('browser://documents/output.pdf'),
                    {
                        jobId: requireJobId('djvu-compact-merge-refused'),
                        pdfStrategy: 'compact-djvu-aware',
                        preserveBookmarks: false,
                    },
                ),
            ).resolves.toMatchObject({
                success: false,
                error: 'direct export output requested',
            });
            expect(getSaveTarget).toHaveBeenCalledOnce();
            expect(mocks.pageOps).toHaveBeenCalledTimes(2);
        } finally {
            mocks.buildCompactPage.mockReset();
            mocks.renderDjvuPage.mockReset();
            mocks.combineWorker.mockReset();
            mocks.createWorker.mockReset();
            mocks.pageOps.mockReset();
            stat.mockRestore();
            getSaveTarget.mockRestore();
        }
    });

    it('fails a conversion that keeps bookmarks when the outline cannot be read', async () => {
        const stat = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: 1,
            modifiedAt: 1,
        });
        mocks.createWorker.mockResolvedValueOnce({
            getOutline: async () => {
                throw new Error('NAVM chunk could not be decoded');
            },
            terminate: vi.fn(),
        });
        mocks.getPageSizes.mockResolvedValueOnce([
            {
                width: 100,
                height: 100,
                dpi: 300,
            },
        ]);
        mocks.buildCompactPage.mockResolvedValueOnce({
            route: 'photo',
            spec: {
                kind: 'image',
                pageSize: {
                    widthPoints: 72,
                    heightPoints: 72,
                },
                image: {
                    fileName: 'page.ppm',
                    data: new Uint8Array([0x50, 0x36]),
                },
            },
        });
        mocks.combineWorker.mockResolvedValueOnce({data: new Uint8Array([0x25, 0x50, 0x44, 0x46])});

        try {
            await expect(
                runBrowserDjvuConversion(
                    requireDocumentRef('browser://documents/book.djvu'),
                    requireDocumentRef('browser://documents/output.pdf'),
                    {
                        jobId: requireJobId('djvu-outline-unreadable'),
                        pdfStrategy: 'compact-djvu-aware',
                        preserveBookmarks: true,
                    },
                ),
            ).resolves.toMatchObject({
                success: false,
                error: expect.stringContaining('NAVM'),
            });
        } finally {
            stat.mockRestore();
        }
    });

    it('reports text that only an unsampled middle page carries', async () => {
        // First, middle and last pages of five are 1, 3 and 5; only page 2 has text.
        const pageTexts = ['', 'Only page two has a text layer', '', '', ''];
        vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: 1,
            modifiedAt: 7,
        });
        mocks.getPageSizes.mockResolvedValue(
            pageTexts.map(() => ({
                width: 100,
                height: 100,
                dpi: 300,
            })),
        );
        mocks.createWorker.mockResolvedValue({
            getOutline: async () => [],
            getMetadata: async () => ({}),
            pageHasText: async (pageNumber: number) => (pageTexts[pageNumber - 1] ?? '').trim().length > 0,
            getPageText: async (pageNumber: number) => ({
                text: pageTexts[pageNumber - 1] ?? '',
                pageWidth: 100,
                pageHeight: 100,
                zones: [],
            }),
            terminate: vi.fn(),
        });

        await expect(getBrowserDjvuInfo(requireDocumentRef('browser://documents/text-on-page-two.djvu'))).resolves.toMatchObject({
            pageCount: 5,
            hasText: true,
        });
    });

    it('classifies invalid browser output as an expected outcome without capturing', async () => {
        mocks.loggerError.mockClear();

        await expect(
            runBrowserDjvuConversion(requireDocumentRef('browser://documents/book.djvu'), requireDocumentRef('/tmp/output.pdf'), {
                jobId: requireJobId('djvu-convert-invalid-output'),
            }),
        ).resolves.toMatchObject({
            success: false,
            expected: {
                kind: 'expected',
                code: 'validation-rejected',
            },
        });
        expect(mocks.loggerError).not.toHaveBeenCalled();
    });

    it('reuses a browser worker receipt instead of capturing in the conversion parent', async () => {
        const stat = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: 1,
            modifiedAt: 1,
        });
        const workerError = Object.assign(new Error('DjVu decoder failed'), {failure: browserFailure});
        mocks.createWorker.mockRejectedValueOnce(workerError);
        mocks.loggerError.mockClear();

        try {
            await expect(
                runBrowserDjvuConversion(
                    requireDocumentRef('browser://documents/book.djvu'),
                    requireDocumentRef('browser://documents/output.pdf'),
                    {jobId: requireJobId('djvu-convert-worker-failure')},
                ),
            ).resolves.toMatchObject({
                success: false,
                error: 'DjVu decoder failed',
                failure: browserFailure,
            });
            expect(mocks.loggerError).not.toHaveBeenCalled();
        } finally {
            stat.mockRestore();
        }
    });

    it('captures abort-related conversion faults instead of treating them as cancellation', async () => {
        const stat = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: 1,
            modifiedAt: 1,
        });
        mocks.createWorker.mockRejectedValueOnce(new Error('Failed to abort PDF output cleanup'));
        mocks.loggerError.mockReturnValue(browserFailure);
        mocks.loggerError.mockClear();

        try {
            await expect(
                runBrowserDjvuConversion(
                    requireDocumentRef('browser://documents/book.djvu'),
                    requireDocumentRef('browser://documents/output.pdf'),
                    {jobId: requireJobId('djvu-convert-abort-wording-failure')},
                ),
            ).resolves.toMatchObject({
                success: false,
                error: 'Failed to abort PDF output cleanup',
                failure: browserFailure,
            });
            expect(mocks.loggerError).toHaveBeenCalledOnce();
        } finally {
            stat.mockRestore();
        }
    });

    it('does not create the compact output sink when WASM admission is canceled', async () => {
        const stat = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: 1,
            modifiedAt: 1,
        });
        const getSaveTarget = vi.spyOn(browserDocumentStore, 'getSaveTarget');
        const worker = {
            doc: {
                getPagesSizes: () => ({
                    run: async () => [
                        {
                            width: 100,
                            height: 100,
                            dpi: 300,
                        },
                    ],
                }),
            },
            terminate: vi.fn(),
        };
        const admission = Promise.withResolvers<{data: Uint8Array}>();
        mocks.createWorker.mockResolvedValueOnce(worker);
        mocks.getPageSizes.mockResolvedValueOnce([
            {
                width: 100,
                height: 100,
                dpi: 300,
            },
        ]);
        mocks.buildCompactPage.mockResolvedValueOnce({
            route: 'photo',
            spec: {
                kind: 'image',
                pageSize: {
                    widthPoints: 72,
                    heightPoints: 72,
                },
                image: {
                    fileName: 'page.ppm',
                    data: new Uint8Array([0x50, 0x36]),
                },
            },
        });
        mocks.combineWorker.mockImplementationOnce((_inputs, _options, signal?: AbortSignal) => {
            signal?.addEventListener('abort', () => admission.resolve({data: new Uint8Array([0x25, 0x50, 0x44, 0x46])}), {once: true});
            return admission.promise;
        });

        try {
            const jobId = requireJobId('djvu-compact-admission-cancel');
            const conversion = runBrowserDjvuConversion(
                requireDocumentRef('browser://documents/book.djvu'),
                requireDocumentRef('browser://documents/output.pdf'),
                {
                    jobId,
                    pdfStrategy: 'compact-djvu-aware',
                    preserveBookmarks: false,
                },
            );
            await vi.waitFor(() => expect(mocks.combineWorker).toHaveBeenCalledOnce());

            expect(cancelBrowserDjvuConversion(jobId)).toEqual({canceled: true});
            await expect(conversion).resolves.toMatchObject({
                success: false,
                expected: {
                    kind: 'expected',
                    code: 'canceled',
                },
            });
            expect(getSaveTarget).not.toHaveBeenCalled();
        } finally {
            stat.mockRestore();
            getSaveTarget.mockRestore();
        }
    });

    it.each([
        {
            error: new Error('ERR_BROWSER_PDF_COMBINE_WASM_UNAVAILABLE'),
            code: 'temporarily-unavailable',
            message: 'Browser compact DjVu export is temporarily unavailable',
        },
        {
            error: new Error('ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_INPUT'),
            code: 'unsupported-input',
            message: 'Browser compact DjVu export does not support this page data',
        },
    ])('preserves the compact $code refusal without writing a fallback PDF', async ({error, code, message}) => {
        const stat = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: 1,
            modifiedAt: 1,
        });
        const getSaveTarget = vi.spyOn(browserDocumentStore, 'getSaveTarget');
        mocks.createWorker.mockResolvedValueOnce({terminate: vi.fn()});
        mocks.getPageSizes.mockResolvedValueOnce([
            {
                width: 100,
                height: 100,
                dpi: 300,
            },
        ]);
        mocks.buildCompactPage.mockResolvedValueOnce({
            route: 'photo',
            spec: {
                kind: 'image',
                pageSize: {
                    widthPoints: 72,
                    heightPoints: 72,
                },
                image: {
                    fileName: 'page.ppm',
                    data: new Uint8Array([0x50, 0x36]),
                },
            },
        });
        mocks.combineWorker.mockRejectedValueOnce(error);
        mocks.loggerError.mockClear();

        try {
            await expect(
                runBrowserDjvuConversion(
                    requireDocumentRef('browser://documents/book.djvu'),
                    requireDocumentRef('browser://documents/output.pdf'),
                    {
                        jobId: requireJobId('djvu-compact-worker-refusal'),
                        pdfStrategy: 'compact-djvu-aware',
                        preserveBookmarks: false,
                    },
                ),
            ).resolves.toMatchObject({
                success: false,
                error: message,
                expected: {
                    kind: 'expected',
                    code,
                },
            });
            expect(getSaveTarget).not.toHaveBeenCalled();
            expect(mocks.loggerError).not.toHaveBeenCalled();
        } finally {
            stat.mockRestore();
            getSaveTarget.mockRestore();
        }
    });

    it('writes compact pages in document order when a later page finishes first, reporting each in order', async () => {
        const stat = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: 1,
            modifiedAt: 1,
        });
        const written: Uint8Array[] = [];
        const getSaveTarget = vi.spyOn(browserDocumentStore, 'getSaveTarget').mockResolvedValue({
            saveName: 'output.pdf',
            saveKind: 'pdf',
            saveHandle: {
                createWritable: async () => ({
                    write: async (chunk: ArrayBuffer) => {
                        written.push(new Uint8Array(chunk));
                    },
                    close: async () => {},
                    abort: async () => {},
                }),
            } as unknown as FileSystemFileHandle,
        });
        const replace = vi.spyOn(browserDocumentStore, 'replaceWithHandleBackedDocument').mockResolvedValue(undefined as never);
        const setRetention = vi.spyOn(browserDocumentStore, 'setRetention').mockResolvedValue(undefined as never);
        const unload = vi.spyOn(browserDocumentStore, 'unload').mockReturnValue(undefined as never);
        const page = {
            width: 100,
            height: 100,
            dpi: 300,
        };
        mocks.createWorker.mockResolvedValue({terminate: vi.fn()});
        mocks.getPageSizes.mockResolvedValueOnce([page, page]);
        mocks.buildCompactPage.mockImplementation(async (_worker: unknown, pageNumber: number) => ({
            route: 'photo',
            spec: {
                kind: 'image',
                pageSize: {
                    widthPoints: 72,
                    heightPoints: 72,
                },
                image: {
                    fileName: `page-${pageNumber}.ppm`,
                    data: new Uint8Array([pageNumber]),
                },
            },
        }));
        // Page 1 encodes only after page 2 has finished, on a device with lanes for both.
        vi.stubGlobal('navigator', {hardwareConcurrency: 8});
        const pageTwoEncoded = Promise.withResolvers<void>();
        mocks.combineWorker.mockImplementation(
            async (_type: string, payload: {wasmImagePreprocessing: {pageSpecs: Array<{image: {fileName: string}}>}}) => {
                const fileName = payload.wasmImagePreprocessing.pageSpecs[0]!.image.fileName;
                if (fileName === 'page-1.ppm') {
                    await pageTwoEncoded.promise;
                } else {
                    pageTwoEncoded.resolve();
                }
                return {data: new TextEncoder().encode(`[${fileName}]`)};
            },
        );
        mocks.pageOps.mockImplementation(async (_type: string, payload: {sources: Blob[]}) => ({
            status: 'written',
            data: new TextEncoder().encode((await Promise.all(payload.sources.map((source) => source.text()))).join('')),
        }));
        const requestId = createRequestId('djvu-convert');
        const shown: string[] = [];
        const conversion = Promise.withResolvers<unknown>();
        const run = runJob(
            {
                onProgress: onBrowserDjvuConversionProgress,
                onComplete: () => () => {},
                cancel: async () => null,
            },
            {
                requestId,
                onProgress: (progress) => shown.push(`${progress.phase} ${progress.percent}%`),
                start: async () => {
                    void runBrowserDjvuConversion(
                        requireDocumentRef('browser://documents/book.djvu'),
                        requireDocumentRef('browser://documents/output.pdf'),
                        {
                            jobId: requireJobId('djvu-progress'),
                            requestId,
                            pdfStrategy: 'compact-djvu-aware',
                            preserveBookmarks: false,
                        },
                    ).then(conversion.resolve, conversion.reject);
                },
            },
        );

        try {
            await expect(conversion.promise).resolves.toMatchObject({success: true});
            expect(new TextDecoder().decode(Uint8Array.from(written.flatMap((chunk) => [...chunk])))).toBe('[page-1.ppm][page-2.ppm]');
            expect(shown).toEqual(['loading 0%', 'converting 0%', 'converting 45%', 'converting 90%', 'assembling 90%', 'bookmarks 100%']);
        } finally {
            void run.cancel();
            vi.unstubAllGlobals();
            mocks.buildCompactPage.mockReset();
            mocks.combineWorker.mockReset();
            mocks.createWorker.mockReset();
            mocks.pageOps.mockReset();
            stat.mockRestore();
            getSaveTarget.mockRestore();
            replace.mockRestore();
            setRetention.mockRestore();
            unload.mockRestore();
        }
    });

    it('maps nested DjVu bookmarks to output indices, preserves null destinations for omitted pages, and scales to 2,000 bookmarks x 5,000 pages', async () => {
        const stat = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: 1,
            modifiedAt: 1,
        });
        const getSaveTarget = vi.spyOn(browserDocumentStore, 'getSaveTarget').mockResolvedValue({
            saveName: 'output.pdf',
            saveKind: 'pdf',
            saveHandle: {
                createWritable: async () => ({
                    write: async () => {},
                    close: async () => {},
                    abort: async () => {},
                }),
            } as unknown as FileSystemFileHandle,
        });
        const replace = vi.spyOn(browserDocumentStore, 'replaceWithHandleBackedDocument').mockResolvedValue(undefined as never);
        const setRetention = vi.spyOn(browserDocumentStore, 'setRetention').mockResolvedValue(undefined as never);
        const unload = vi.spyOn(browserDocumentStore, 'unload').mockReturnValue(undefined as never);

        const totalPages = 5_000;
        const bookmarkCount = 2_000;
        const outline = [
            {
                title: 'Omitted Front Matter',
                url: '#1',
                children: [
                    {
                        title: 'First Included',
                        url: '#10',
                        children: [],
                    },
                ],
            },
            ...Array.from({length: bookmarkCount - 1}, (_, index) => ({
                title: `Chapter ${index + 1}`,
                url: `#${10 + ((index * 2) % 4_990)}`,
                children: [],
            })),
        ];

        mocks.createWorker.mockResolvedValue({
            getOutline: async () => outline,
            getPageNumberByUrl: async (url: string) => Number(url.slice(1)),
            terminate: vi.fn(),
        });
        mocks.getPageSizes.mockResolvedValueOnce(
            Array.from({length: totalPages}, () => ({
                width: 100,
                height: 100,
                dpi: 300,
            })),
        );
        mocks.buildCompactPage.mockImplementation(async (_worker: unknown, pageNumber: number) => ({
            route: 'photo',
            spec: {
                kind: 'image',
                pageSize: {
                    widthPoints: 72,
                    heightPoints: 72,
                },
                image: {
                    fileName: `page-${pageNumber}.ppm`,
                    data: new Uint8Array([1]),
                },
            },
        }));
        mocks.combineWorker.mockResolvedValue({data: new Uint8Array([1])});
        mocks.pageOps.mockResolvedValue({
            status: 'written',
            data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        });
        let capturedBookmarks: ReadonlyArray<{
            readonly title: string;
            readonly pageIndex: number | null;
            readonly items: ReadonlyArray<{
                readonly title: string;
                readonly pageIndex: number | null;
            }>;
        }> = [];
        const pdfPageEngine = await import('@app/platform/browser/pdfPageEngine');
        const appendMutations = vi.spyOn(pdfPageEngine, 'appendPdfMutationsToBytes').mockImplementation(async (data, request) => {
            if (request.mutations.bookmarks?.items) {
                capturedBookmarks = request.mutations.bookmarks.items;
            }
            return {
                pageCount: totalPages - 9,
                length: data.byteLength,
                identityBindings: [],
                sha256: '0'.repeat(64),
                data: new Uint8Array(data),
            };
        });

        try {
            const includedPages = Array.from({length: totalPages - 9}, (_, index) => index + 10);
            const startedAt = performance.now();
            const result = await runBrowserDjvuConversion(
                requireDocumentRef('browser://documents/book.djvu'),
                requireDocumentRef('browser://documents/output.pdf'),
                {
                    jobId: requireJobId('djvu-bookmarks-scale'),
                    pdfStrategy: 'compact-djvu-aware',
                    preserveBookmarks: true,
                },
                includedPages,
            );
            const elapsedMs = performance.now() - startedAt;

            expect(result).toMatchObject({success: true});
            expect(capturedBookmarks).toHaveLength(bookmarkCount);
            expect(capturedBookmarks[0]?.title).toBe('Omitted Front Matter');
            expect(capturedBookmarks[0]?.pageIndex).toBeNull();
            expect(capturedBookmarks[0]?.items[0]?.title).toBe('First Included');
            expect(capturedBookmarks[0]?.items[0]?.pageIndex).toBe(0);
            expect(capturedBookmarks[1]?.pageIndex).toBe(0);
            expect(capturedBookmarks[2]?.pageIndex).toBe(2);
            expect(elapsedMs).toBeLessThan(5_000);
        } finally {
            appendMutations.mockRestore();
            mocks.buildCompactPage.mockReset();
            mocks.combineWorker.mockReset();
            mocks.createWorker.mockReset();
            mocks.pageOps.mockReset();
            stat.mockRestore();
            getSaveTarget.mockRestore();
            replace.mockRestore();
            setRetention.mockRestore();
            unload.mockRestore();
        }
    });
});
