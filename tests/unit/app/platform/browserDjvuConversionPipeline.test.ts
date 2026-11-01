import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import {
    assertBrowserDjvuSource,
    getBrowserDjvuInfo,
    runBrowserDjvuConversion,
    resolveBrowserDjvuPdfRenderConcurrency,
    resolveBrowserDjvuPdfRenderSettings,
    withBrowserDjvuWorker,
    cancelBrowserDjvuConversion,
} from '@app/platform/browser-api/browserDjvuConversionPipeline';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireJobId} from '@contracts/shared';
import {requireEpochMs} from '@contracts/timestamps';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import {SerializableError} from '@contracts/serializableError';

const mocks = vi.hoisted(() => ({
    createWorker: vi.fn(),
    getPageSizes: vi.fn(),
    loggerError: vi.fn(),
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    buildCompactPage: vi.fn(),
    combineWorker: vi.fn(),
}));

vi.mock('@app/platform/browser-api/createDjvuWorkerFromPath', () => ({
    createDjvuWorkerFromPath: mocks.createWorker,
    getDjvuWorkerPageSizes: mocks.getPageSizes,
}));
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    error: mocks.loggerError,
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
}}));
vi.mock('@app/platform/browser-api/browserPdfCombineWorkerClient', () => ({runBrowserPdfCombineWorkerRequest: mocks.combineWorker}));
vi.mock('@app/platform/browser-api/buildBrowserDjvuCompactPage', () => ({buildBrowserDjvuCompactPage: mocks.buildCompactPage}));
vi.mock('@app/platform/browser-api/browserDjvuRasterizer', () => ({
    DjvuCanceledError: class DjvuCanceledError extends Error {
        public constructor() {
            super('DjVu conversion canceled');
            this.name = 'DjvuCanceledError';
        }
    },
    renderDjvuPage: vi.fn(),
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
        const electronApi = createElectronPlatformApiFixture({documentFiles: {
            readFile,
            readFileRange,
            statFile,
        }});
        Reflect.deleteProperty(electronApi.djvu, 'getInfo');
        vi.stubGlobal('window', {electronAPI: electronApi});
        mocks.createWorker.mockRejectedValue(new Error('browser DjVu worker must not be created'));

        await expect(withBrowserDjvuWorker(
            requireDocumentRef('/tmp/native.djvu'),
            async () => undefined,
            'info',
        )).rejects.toMatchObject({
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
        expect(resolveBrowserDjvuPdfRenderSettings({
            pdfStrategy: 'direct',
            subsample: 1,
        })).toEqual({
            strategy: 'direct',
            subsample: 1,
            jpegQuality: 0.92,
        });

        expect(resolveBrowserDjvuPdfRenderSettings({
            pdfStrategy: 'auto',
            subsample: 4,
        })).toEqual({
            strategy: 'direct',
            subsample: 4,
            jpegQuality: 0.92,
        });
    });

    it('uses the photo quality of the compact preset each subsample selects', () => {
        expect(resolveBrowserDjvuPdfRenderSettings({
            pdfStrategy: 'compact-djvu-aware',
            subsample: 1,
        })).toEqual({
            strategy: 'compact-djvu-aware',
            subsample: 1,
            jpegQuality: 95,
        });

        expect(resolveBrowserDjvuPdfRenderSettings({
            pdfStrategy: 'compact-djvu-aware',
            subsample: 4,
        })).toEqual({
            strategy: 'compact-djvu-aware',
            subsample: 4,
            jpegQuality: 75,
        });
    });

    it('caps browser DjVu page rendering concurrency by cores and page size', () => {
        const ordinaryPages = Array.from({ length: 10 }, () => ({
            width: 2_400,
            height: 3_200,
        }));

        expect(resolveBrowserDjvuPdfRenderConcurrency(ordinaryPages, 8)).toBe(3);
        expect(resolveBrowserDjvuPdfRenderConcurrency(ordinaryPages, 2)).toBe(1);
        expect(resolveBrowserDjvuPdfRenderConcurrency([ordinaryPages[0]!], 8)).toBe(1);
        expect(resolveBrowserDjvuPdfRenderConcurrency([
            {
                width: 4_500,
                height: 4_000,
            },
            {
                width: 4_500,
                height: 4_000,
            },
        ], 8)).toBe(2);
        expect(resolveBrowserDjvuPdfRenderConcurrency([
            {
                width: 6_000,
                height: 6_000,
            },
            {
                width: 6_000,
                height: 6_000,
            },
        ], 8)).toBe(1);
    });

    it.each([
        [
            'low',
            1,
        ],
        [
            'medium',
            3,
        ],
        [
            'high',
            3,
        ],
    ] as const)('clamps %s-tier browser DjVu conversion concurrency to %i', (tier, expectedConcurrency) => {
        const ordinaryPages = Array.from({length: 10}, () => ({
            width: 2_400,
            height: 3_200,
        }));

        expect(resolveBrowserDjvuPdfRenderConcurrency(
            ordinaryPages,
            8,
            tier,
        )).toBe(expectedConcurrency);
    });

    it('streams the direct PDF when the compact request exceeds the WASM boundary', async () => {
        const stat = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: 1,
            modifiedAt: 1,
        });
        // The direct export's output sink is the first step past the fallback.
        const getSaveTarget = vi.spyOn(browserDocumentStore, 'getSaveTarget').mockRejectedValue(new Error('direct export output requested'));
        mocks.createWorker.mockResolvedValueOnce({terminate: vi.fn()});
        mocks.getPageSizes.mockResolvedValueOnce([{
            width: 100,
            height: 100,
            dpi: 300,
        }]);
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
                    data: new Uint8Array([
                        0x50,
                        0x36,
                    ]),
                },
            },
        });
        mocks.combineWorker.mockRejectedValueOnce(new SerializableError({
            code: 'too-large',
            message: 'Image combine WASM request exceeds the admission ceiling',
        }));

        try {
            await expect(runBrowserDjvuConversion(
                requireDocumentRef('browser://documents/book.djvu'),
                requireDocumentRef('browser://documents/output.pdf'),
                {
                    jobId: requireJobId('djvu-compact-boundary'),
                    pdfStrategy: 'compact-djvu-aware',
                    preserveBookmarks: false,
                },
            )).resolves.toMatchObject({
                success: false,
                error: 'direct export output requested',
            });
            expect(getSaveTarget).toHaveBeenCalledOnce();
        } finally {
            stat.mockRestore();
            getSaveTarget.mockRestore();
        }
    });

    it('reports text that only an unsampled middle page carries', async () => {
        // First, middle and last pages of five are 1, 3 and 5; only page 2 has text.
        const pageTexts = [
            '',
            'Only page two has a text layer',
            '',
            '',
            '',
        ];
        vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: 1,
            modifiedAt: 7,
        });
        mocks.getPageSizes.mockResolvedValue(pageTexts.map(() => ({
            width: 100,
            height: 100,
            dpi: 300,
        })));
        mocks.createWorker.mockResolvedValue({
            doc: {
                getContents: () => ({run: async () => null}),
                getPage: (pageNumber: number) => ({getText: () => ({run: async () => pageTexts[pageNumber - 1] ?? ''})}),
            },
            terminate: vi.fn(),
        });

        await expect(getBrowserDjvuInfo(requireDocumentRef('browser://documents/text-on-page-two.djvu'))).resolves.toMatchObject({
            pageCount: 5,
            hasText: true,
        });
    });

    it('classifies invalid browser output as an expected outcome without capturing', async () => {
        mocks.loggerError.mockClear();

        await expect(runBrowserDjvuConversion(
            requireDocumentRef('browser://documents/book.djvu'),
            requireDocumentRef('/tmp/output.pdf'),
            {jobId: requireJobId('djvu-convert-invalid-output')},
        )).resolves.toMatchObject({
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
            await expect(runBrowserDjvuConversion(
                requireDocumentRef('browser://documents/book.djvu'),
                requireDocumentRef('browser://documents/output.pdf'),
                {jobId: requireJobId('djvu-convert-worker-failure')},
            )).resolves.toMatchObject({
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
            await expect(runBrowserDjvuConversion(
                requireDocumentRef('browser://documents/book.djvu'),
                requireDocumentRef('browser://documents/output.pdf'),
                {jobId: requireJobId('djvu-convert-abort-wording-failure')},
            )).resolves.toMatchObject({
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
            doc: {getPagesSizes: () => ({run: async () => [{
                width: 100,
                height: 100,
                dpi: 300,
            }]})},
            terminate: vi.fn(),
        };
        const admission = Promise.withResolvers<{data: Uint8Array}>();
        mocks.createWorker.mockResolvedValueOnce(worker);
        mocks.getPageSizes.mockResolvedValueOnce([{
            width: 100,
            height: 100,
            dpi: 300,
        }]);
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
                    data: new Uint8Array([
                        0x50,
                        0x36,
                    ]),
                },
            },
        });
        mocks.combineWorker.mockImplementationOnce((_inputs, _options, signal?: AbortSignal) => {
            signal?.addEventListener('abort', () => admission.resolve({data: new Uint8Array([
                0x25,
                0x50,
                0x44,
                0x46,
            ])}), {once: true});
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
    ])('preserves the compact $code refusal without writing a fallback PDF', async ({
        error, code, message,
    }) => {
        const stat = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: 1,
            modifiedAt: 1,
        });
        const getSaveTarget = vi.spyOn(browserDocumentStore, 'getSaveTarget');
        mocks.createWorker.mockResolvedValueOnce({terminate: vi.fn()});
        mocks.getPageSizes.mockResolvedValueOnce([{
            width: 100,
            height: 100,
            dpi: 300,
        }]);
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
                    data: new Uint8Array([
                        0x50,
                        0x36,
                    ]),
                },
            },
        });
        mocks.combineWorker.mockRejectedValueOnce(error);
        mocks.loggerError.mockClear();

        try {
            await expect(runBrowserDjvuConversion(
                requireDocumentRef('browser://documents/book.djvu'),
                requireDocumentRef('browser://documents/output.pdf'),
                {
                    jobId: requireJobId('djvu-compact-worker-refusal'),
                    pdfStrategy: 'compact-djvu-aware',
                    preserveBookmarks: false,
                },
            )).resolves.toMatchObject({
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

});
