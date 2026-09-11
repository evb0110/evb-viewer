import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import {
    assertBrowserDjvuSource,
    runBrowserDjvuConversion,
    resolveBrowserDjvuCompactExportPlan,
    resolveBrowserDjvuConversionPreflight,
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

const mocks = vi.hoisted(() => ({
    createWorker: vi.fn(),
    getPageSizes: vi.fn(),
    loggerError: vi.fn(),
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    renderPageAsPpm: vi.fn(),
    tryCombine: vi.fn(),
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
vi.mock('@app/platform/browser-api/tryCombineImageInputsWithWasm', () => ({tryCombineImageInputsWithWasm: mocks.tryCombine}));
vi.mock('@app/platform/browser-api/browserDjvuRasterizer', () => ({
    DJVU_COMPACT_PHOTO_PPI_CAP: 300,
    DjvuCanceledError: class DjvuCanceledError extends Error {
        public constructor() {
            super('DjVu conversion canceled');
            this.name = 'DjvuCanceledError';
        }
    },
    positiveInteger: (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null,
    renderDjvuPage: vi.fn(),
    renderDjvuPageAsPpm: mocks.renderPageAsPpm,
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
        vi.stubGlobal('window', {electronAPI: {documentFiles: {
            statFile: vi.fn(),
            readFile: vi.fn(),
            readFileRange: vi.fn(),
        }}});

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
        vi.stubGlobal('window', {electronAPI: {documentFiles: {
            readFile,
            readFileRange,
            statFile,
        }}});
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

    it('uses a bounded compact raster fallback for compact DjVu-aware web exports', () => {
        expect(resolveBrowserDjvuPdfRenderSettings({
            pdfStrategy: 'compact-djvu-aware',
            subsample: 1,
        })).toEqual({
            strategy: 'compact-djvu-aware',
            subsample: 1,
            jpegQuality: 85,
        });

        expect(resolveBrowserDjvuPdfRenderSettings({
            pdfStrategy: 'compact-djvu-aware',
            subsample: 4,
        })).toEqual({
            strategy: 'compact-djvu-aware',
            subsample: 4,
            jpegQuality: 85,
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
            0,
            tier,
        )).toBe(expectedConcurrency);
    });

    it('falls compact web export back to streaming direct export when page specs exceed the memory budget', () => {
        expect(resolveBrowserDjvuCompactExportPlan([{
            width: 100,
            height: 100,
            dpi: 300,
        }], 40_000)).toEqual({
            strategy: 'compact-djvu-aware',
            estimatedPageSpecBytes: 30_256,
            maxPageSpecBytes: 40_000,
        });

        expect(resolveBrowserDjvuCompactExportPlan([{
            width: 1_000,
            height: 1_000,
            dpi: 300,
        }], 1_000_000)).toEqual({
            strategy: 'direct-fallback',
            estimatedPageSpecBytes: 3_000_256,
            maxPageSpecBytes: 1_000_000,
            fallbackReason: 'memory-budget',
        });
    });

    it('uses the bookmark-capable streaming path when compact export must preserve bookmarks', () => {
        expect(resolveBrowserDjvuCompactExportPlan([{
            width: 100,
            height: 100,
            dpi: 300,
        }], 40_000, true)).toEqual({
            strategy: 'direct-fallback',
            estimatedPageSpecBytes: 30_256,
            maxPageSpecBytes: 40_000,
            fallbackReason: 'bookmarks',
        });
    });

    it('reports browser conversion boundaries before raster rendering starts', () => {
        expect(resolveBrowserDjvuConversionPreflight(Array.from({length: 500}, () => ({
            width: 8_000,
            height: 10_000,
        })))).toMatchObject({
            allowed: true,
            maxPagePixels: 80_000_000,
            maxPages: 500,
        });
        expect(resolveBrowserDjvuConversionPreflight(Array.from({length: 501}, () => ({
            width: 100,
            height: 100,
        })))).toMatchObject({
            allowed: false,
            reason: 'page-count',
        });
        expect(resolveBrowserDjvuConversionPreflight([{
            width: 10_000,
            height: 8_001,
        }])).toMatchObject({
            allowed: false,
            reason: 'page-pixels',
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
        const admission = Promise.withResolvers<{
            status: 'success';
            data: Uint8Array;
        }>();
        mocks.createWorker.mockResolvedValueOnce(worker);
        mocks.getPageSizes.mockResolvedValueOnce([{
            width: 100,
            height: 100,
            dpi: 300,
        }]);
        mocks.renderPageAsPpm.mockResolvedValueOnce({
            input: {
                fileName: 'page.ppm',
                data: new Uint8Array([
                    0x50,
                    0x36,
                ]),
            },
            pageSize: {
                widthPoints: 72,
                heightPoints: 72,
            },
        });
        mocks.tryCombine.mockImplementationOnce((_inputs, _options, signal?: AbortSignal) => {
            signal?.addEventListener('abort', () => admission.resolve({
                status: 'success',
                data: new Uint8Array([
                    0x25,
                    0x50,
                    0x44,
                    0x46,
                ]),
            }), {once: true});
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
            await vi.waitFor(() => expect(mocks.tryCombine).toHaveBeenCalledOnce());

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

});
