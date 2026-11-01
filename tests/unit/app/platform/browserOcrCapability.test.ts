import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireRequestId} from '@contracts/shared';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {IScanCleanupPreviewRequest} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {
    IBrowserScanCleanupPreviewBase,
    IBrowserScanCleanupPreviewRendering,
    IRenderBrowserScanCleanupPreviewInput,
} from '@app/platform/browser-api/browserScanCleanupJob';
import {cast} from '@tests/helpers/cast';

const browserPlatformWiringTimeoutMs = 8_000;

describe('browser OCR capability', {timeout: 20_000}, () => {
    beforeAll(async () => {
        // The first import transforms the whole browser platform, which takes
        // seconds on a loaded machine. Pay that once here so the wiring budget
        // below measures the wiring, not the transform.
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            await import('@app/platform/browserPlatformApi');
        } finally {
            consoleError.mockRestore();
        }
    });

    it('refuses OCR with its reason when the browser cannot run the engine', async () => {
        vi.stubGlobal('Worker', undefined);
        try {
            const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

            await expect(browserOcrCapability.getLanguages()).resolves.toEqual([]);
            await expect(browserOcrCapability.createSearchablePdf(requireDocumentRef('browser://documents/a/in.pdf'), [{
                pageNumber: requirePageNumber(1),
                languages: ['eng'],
            }], requireRequestId('request-2'))).resolves.toMatchObject({
                started: false,
                errorEnvelope: {
                    code: 'OCR_BROWSER_UNSUPPORTED',
                    message: 'OCR_BROWSER_UNSUPPORTED',
                },
            });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    describe('in a browser that can run the engine', () => {
        beforeEach(() => {
            vi.stubGlobal('Worker', function Worker() {});
            vi.stubGlobal('caches', {open: () => Promise.resolve({match: () => Promise.resolve(undefined)})});
        });
        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('offers every desktop language, each still to download', async () => {
            const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');
            const { AVAILABLE_OCR_LANGUAGES } = await import('@contracts/ocrLanguages');

            const languages = await browserOcrCapability.getLanguages();
            expect(languages.map(language => language.code))
                .toEqual(AVAILABLE_OCR_LANGUAGES.map(language => language.code));
            expect(new Set(languages.map(language => language.modelState))).toEqual(new Set(['missing']));
        });

        it('refuses a language outside the registry', async () => {
            const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

            await expect(browserOcrCapability.createSearchablePdf(requireDocumentRef('browser://documents/a/in.pdf'), [{
                pageNumber: requirePageNumber(1),
                languages: ['xyz'],
            }], requireRequestId('request-3'))).resolves.toMatchObject({
                started: false,
                error: 'Unsupported OCR language: xyz',
                errorEnvelope: {code: 'OCR_INVALID_PAYLOAD'},
            });
        });
    });

    it('reports unknown jobs and results without touching documents', async () => {
        const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

        await expect(browserOcrCapability.cancel(requireRequestId('request-5'))).resolves.toEqual({
            canceled: false,
            reason: 'not-found',
        });
        await expect(browserOcrCapability.acknowledgeResultFile(
            requireRequestId('request-5'),
            requireDocumentRef('browser://documents/b/result.pdf'),
        )).resolves.toEqual({cleaned: false});
    });

    it('wires the browser platform to the browser OCR capability', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { browserPlatformApi } = await import('@app/platform/browserPlatformApi');
        const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

        expect(browserPlatformApi.ocr).toBe(browserOcrCapability);
    }, browserPlatformWiringTimeoutMs);
});

interface IPendingRender {
    input: IRenderBrowserScanCleanupPreviewInput;
    resolve: (rendering: IBrowserScanCleanupPreviewRendering) => void;
}

const renders = {pending: [] as IPendingRender[]};
const destroyed = {count: 0};

/** The source boundary and the job's renders, settled by each test. */
function mockScanCleanupPreviewSource() {
    vi.doMock('@app/platform/browser-api/browserScanCleanupJob', () => ({renderBrowserScanCleanupWorkspacePreview: (input: IRenderBrowserScanCleanupPreviewInput) => new Promise<IBrowserScanCleanupPreviewRendering>((resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true});
        renders.pending.push({
            input,
            resolve,
        });
    })}));
    vi.doMock('@app/platform/browserDocumentStore', () => ({browserDocumentStore: {
        assertDocumentRevisionCurrent: vi.fn(async () => undefined),
        read: vi.fn(async () => new Uint8Array([
            1,
            2,
            3,
        ])),
    }}));
    vi.doMock('@app/platform/browser-api/browserPageOpsWorkerClient', () => ({runBrowserPageOpsWorkerRequest: vi.fn(async () => ({
        pageCount: 2,
        pages: [
            1,
            2,
        ].map(pageNumber => ({
            pageNumber,
            xPoints: 0,
            yPoints: 0,
            widthPoints: 612,
            heightPoints: 792,
            rotation: 0,
        })),
    }))}));
    vi.doMock('@app/platform/browser-api/loadBrowserPdfjsDocument', () => ({loadBrowserPdfjsDocument: vi.fn(async () => ({
        numPages: 2,
        loadingTask: {destroy: vi.fn(async () => {
            destroyed.count += 1;
        })},
    }))}));
}

const scanCleanupPreviewOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'auto',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'ink',
    marginsMm: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    readingOrder: 'ltr',
    skipBlankPages: false,
    pageOverrides: {},
} satisfies IScanCleanupPreviewRequest['options'];

let nextRequest = 0;
function request(overrides: Partial<IScanCleanupPreviewRequest> = {}): IScanCleanupPreviewRequest {
    nextRequest += 1;
    return {
        requestId: requireRequestId(`preview-${String(nextRequest)}`),
        sourcePdfPath: requireDocumentRef('/docs/scan.pdf'),
        ownerId: 'owner-1',
        documentRevision: 'revision-1',
        pageNumber: requirePageNumber(1),
        options: scanCleanupPreviewOptions,
        visible: true,
        ...overrides,
    };
}

function rendering(pageNumber: number, base: IBrowserScanCleanupPreviewBase | null = null): IBrowserScanCleanupPreviewRendering {
    return {
        result: {
            pageNumber: requirePageNumber(pageNumber),
            totalPages: 2,
            rawWidthPx: 100,
            rawHeightPx: 100,
            pageMetadata: {} as never,
            outputs: [],
        },
        base,
    };
}

const retainedBase = cast<IBrowserScanCleanupPreviewBase>({pageSize: {pageNumber: 1}});

async function settleTurns() {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe('browser scan cleanup preview admission', () => {
    beforeEach(() => {
        vi.resetModules();
        renders.pending = [];
        destroyed.count = 0;
        mockScanCleanupPreviewSource();
    });

    afterEach(() => {
        for (const path of [
            '@app/platform/browser-api/browserScanCleanupJob',
            '@app/platform/browserDocumentStore',
            '@app/platform/browser-api/browserPageOpsWorkerClient',
            '@app/platform/browser-api/loadBrowserPdfjsDocument',
        ]) vi.doUnmock(path);
    });

    async function loadCapability() {
        return (await import('@app/platform/browser-api/browserScanCleanupCapability')).browserScanCleanupCapability;
    }

    it('declines a speculative neighbour without retiring the visible page', async () => {
        const capability = await loadCapability();
        const visible = capability.preview(request());
        await vi.waitFor(() => expect(renders.pending).toHaveLength(1));

        await expect(capability.preview(request({
            visible: false,
            pageNumber: requirePageNumber(2),
        }))).resolves.toEqual({canceled: true});

        renders.pending[0]!.resolve(rendering(1));
        await expect(visible).resolves.toMatchObject({pageNumber: 1});
        expect(renders.pending).toHaveLength(1);
    });

    it('refines a base that is still rendering once it lands, without canceling the detail', async () => {
        const capability = await loadCapability();
        const base = request();
        const basePreview = capability.preview(base);
        await vi.waitFor(() => expect(renders.pending).toHaveLength(1));
        const detail = capability.preview(request({
            visible: false,
            detail: {
                viewports: {full: {
                    xNormalized: 0,
                    yNormalized: 0,
                    widthNormalized: 0.5,
                    heightNormalized: 0.5,
                    rotationDegrees: 0,
                }},
                outputMode: 'bw',
            },
        }));
        await settleTurns();
        // The detail waits for its base instead of starting or retiring it.
        expect(renders.pending).toHaveLength(1);

        renders.pending[0]!.resolve(rendering(1, retainedBase));
        await expect(basePreview).resolves.toMatchObject({pageNumber: 1});
        await vi.waitFor(() => expect(renders.pending).toHaveLength(2));
        expect(renders.pending[1]!.input.base).toBe(retainedBase);
        renders.pending[1]!.resolve(rendering(1));
        await expect(detail).resolves.toMatchObject({
            pageNumber: 1,
            requestId: expect.stringContaining('preview-'),
        });
    });

    it('shares one render between two requests for the same picture', async () => {
        const capability = await loadCapability();
        const first = capability.preview(request());
        await vi.waitFor(() => expect(renders.pending).toHaveLength(1));
        const second = capability.preview(request());
        await settleTurns();
        expect(renders.pending).toHaveLength(1);
        renders.pending[0]!.resolve(rendering(1));
        const [
            firstResult,
            secondResult,
        ] = await Promise.all([
            first,
            second,
        ]);
        expect(firstResult).toMatchObject({pageNumber: 1});
        expect(secondResult).toMatchObject({pageNumber: 1});
        expect('requestId' in firstResult && 'requestId' in secondResult && firstResult.requestId !== secondResult.requestId).toBe(true);
    });

    it('retires a base for another page and answers it canceled', async () => {
        const capability = await loadCapability();
        const first = capability.preview(request());
        await vi.waitFor(() => expect(renders.pending).toHaveLength(1));
        const second = capability.preview(request({pageNumber: requirePageNumber(2)}));
        await expect(first).resolves.toEqual({canceled: true});
        await vi.waitFor(() => expect(renders.pending).toHaveLength(2));
        renders.pending[1]!.resolve(rendering(2));
        await expect(second).resolves.toMatchObject({pageNumber: 2});
    });

    it('refuses a detail with no base of the same picture', async () => {
        const capability = await loadCapability();
        await expect(capability.preview(request({
            visible: false,
            detail: {
                viewports: {full: {
                    xNormalized: 0,
                    yNormalized: 0,
                    widthNormalized: 1,
                    heightNormalized: 1,
                    rotationDegrees: 0,
                }},
                outputMode: 'bw',
            },
        }))).rejects.toThrow('rebuild the base preview');
    });

    it('cancels its own owner\'s work and releases the source when the raw cache is invalidated', async () => {
        const capability = await loadCapability();
        const visible = capability.preview(request());
        await vi.waitFor(() => expect(renders.pending).toHaveLength(1));
        await expect(capability.cancelPreview({
            sourcePdfPath: requireDocumentRef('/docs/scan.pdf'),
            ownerId: 'someone-else',
            documentRevision: 'revision-1',
        })).resolves.toBe(false);
        await expect(capability.cancelPreview({
            sourcePdfPath: requireDocumentRef('/docs/scan.pdf'),
            ownerId: 'owner-1',
            documentRevision: 'revision-1',
            invalidateRawCache: true,
        })).resolves.toBe(true);
        await expect(visible).resolves.toEqual({canceled: true});
        await vi.waitFor(() => expect(destroyed.count).toBe(1));
    });
});
