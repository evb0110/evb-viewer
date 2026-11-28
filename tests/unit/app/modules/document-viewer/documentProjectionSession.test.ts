import {readFileSync} from 'node:fs';
// @vitest-environment happy-dom

import {describe, expect, it, vi} from 'vitest';
import {createElectronPlatformApiFixture} from '@tests/helpers/createElectronPlatformApiFixture';
import type {IPagePreviewSource} from '@app/modules/document-viewer/pagePreviewSource';
import {createDjvuPagePreviewSourceFromPath} from '@app/platform/browser-api/createDjvuWorkerFromPath';
import {requireDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import {createDjvuPageSource} from '@app/modules/document-viewer/source/createDjvuPageSource';
import {createDocumentProjectionSession, ensurePdfProjection} from '@app/modules/document-viewer/session/documentProjectionSession';
import {createWorkspaceSurfaceBudgetController} from '@app/modules/document-viewer/runtime/workspaceSurfaceBudgetController';

const djvuRouteMocks = vi.hoisted(() => ({createBrowserDjvuWorker: vi.fn()}));

vi.mock(import('@app/platform/browser-api/browserDjvuWorkerClient'), async (importOriginal) => ({
    ...(await importOriginal()),
    createBrowserDjvuWorker: djvuRouteMocks.createBrowserDjvuWorker,
}));

describe('document page sources', () => {
    it('exposes one cancellable full-document DjVu search provider with the known page count', async () => {
        const searchText = vi.fn().mockResolvedValue({
            results: [
                {
                    pageNumber: 3,
                    pageMatchIndex: 0,
                    matchIndex: 0,
                    startOffset: 0,
                    endOffset: 6,
                    excerpt: {
                        before: '',
                        match: 'needle',
                        after: '',
                    },
                },
            ],
            truncated: false,
        });
        const previewSource = {
            getPageSizes: vi.fn().mockResolvedValue(
                Array.from({length: 4}, () => ({
                    width: 600,
                    height: 800,
                    dpi: 300,
                })),
            ),
            searchText,
            renderPageObjectUrl: vi.fn(),
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        } satisfies IPagePreviewSource;
        const source = await createDjvuPageSource(
            requireDocumentRef('/book.djvu'),
            previewSource,
            createWorkspaceSurfaceBudgetController(),
        );
        const controller = new AbortController();

        const response = await source.searchProvider?.search({
            requestId: 'source-search',
            query: 'needle',
            matchOptions: {
                matchCase: false,
                wholeWord: false,
                useRegex: false,
            },
            signal: controller.signal,
        });

        expect(response?.results[0]?.pageNumber).toBe(3);
        expect(searchText).toHaveBeenCalledWith(
            expect.objectContaining({
                requestId: 'source-search',
                pageCount: 4,
                signal: controller.signal,
            }),
        );
        source.dispose();
    });

    it('normalizes DjVu pixel geometry to points using each page DPI', async () => {
        const previewSource = {
            getPageSizes: vi.fn().mockResolvedValue([
                {
                    width: 1_200,
                    height: 1_800,
                    dpi: 300,
                },
                {
                    width: 600,
                    height: 900,
                    dpi: 150,
                },
            ]),
            renderPageObjectUrl: vi.fn(),
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        } satisfies IPagePreviewSource;
        const source = await createDjvuPageSource(
            requireDocumentRef('/book.djvu'),
            previewSource,
            createWorkspaceSurfaceBudgetController(),
        );

        expect(await source.getPageMetrics(1)).toEqual({
            widthPoints: 288,
            heightPoints: 432,
            rotation: 0,
        });
        expect(await source.getPageMetrics(2)).toEqual({
            widthPoints: 288,
            heightPoints: 432,
            rotation: 0,
        });
        source.dispose();
    });

    it('constructs a DjVu source from one prioritized page size and hydrates other metrics lazily', async () => {
        const getPageSizes = vi.fn(() => new Promise<never>(() => undefined));
        const getPageSize = vi.fn(async (pageNumber: number) => ({
            width: pageNumber === 3 ? 900 : 600,
            height: pageNumber === 3 ? 1_200 : 800,
            dpi: 300,
        }));
        const previewSource = {
            getPageSizes,
            getPageSize,
            getPageSourceInfo: vi.fn().mockResolvedValue({
                pageCount: 4,
                pageNumber: 2,
                pageSize: {
                    width: 600,
                    height: 800,
                    dpi: 300,
                },
            }),
            renderPageObjectUrl: vi.fn(),
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        } satisfies IPagePreviewSource;

        const source = await createDjvuPageSource(
            requireDocumentRef('/book.djvu'),
            previewSource,
            createWorkspaceSurfaceBudgetController(),
            {initialPageNumber: 2},
        );

        expect(source.pageCount).toBe(4);
        expect(previewSource.getPageSourceInfo).toHaveBeenCalledWith(2);
        expect(getPageSizes).not.toHaveBeenCalled();
        expect(await source.getPageMetrics(2)).toEqual({
            widthPoints: 144,
            heightPoints: 192,
            rotation: 0,
        });
        expect(getPageSize).not.toHaveBeenCalled();

        expect(await source.getPageMetrics(3)).toEqual({
            widthPoints: 216,
            heightPoints: 288,
            rotation: 0,
        });
        expect(getPageSize).toHaveBeenCalledOnce();
        expect(getPageSize).toHaveBeenCalledWith(3);
        expect(getPageSizes).not.toHaveBeenCalled();
        source.dispose();
    });

    it('keeps small DjVu documents native above the browser page limit', async () => {
        let pageCount = 10_000;
        const nativeGetInfo = vi.fn(async () => ({
            pageCount,
            sourceDpi: 300,
            hasBookmarks: false,
            hasText: false,
            metadata: {},
        }));
        const nativeGetPageSourceInfo = vi.fn(async (_path: string, pageNumber: number) => ({
            pageCount,
            pageNumber: requirePageNumber(pageNumber),
            pageSize: {
                width: 600,
                height: 800,
                dpi: 300,
            },
        }));
        const nativeGetPageSizes = vi.fn(async () => []);
        // A small bundled file: the routing reads the native page count, and
        // the DjVu.js route then reads this file's own 501-page table.
        const sourceBytes = new Uint8Array(readFileSync('tests/fixtures/djvu/sources/browser-boundary-501-pages.djvu'));
        const browserGetComponentDirectory = vi.fn(async () => ({
            names: Array.from({length: 501}, (_, index) => `page-${index}.djvu`),
            flags: Array.from({length: 501}, () => 1),
        }));
        const worker = {
            open: vi.fn(async () => undefined),
            getComponentDirectory: browserGetComponentDirectory,
            getDocInfo: vi.fn(),
            getPageInfo: vi.fn(),
            getOutline: vi.fn(async () => []),
            getMetadata: vi.fn(async () => ({})),
            hasText: vi.fn(async () => false),
            getPageText: vi.fn(),
            renderPageRgba: vi.fn(),
            renderPagePpm: vi.fn(),
            renderPageCompactLayer: vi.fn(),
            terminate: vi.fn(),
        };
        djvuRouteMocks.createBrowserDjvuWorker.mockReturnValue(worker);
        const electronApi = createElectronPlatformApiFixture({
            documentFiles: {
                readFile: vi.fn(async () => sourceBytes),
                readFileRange: vi.fn(async (_path: string, offset: number, length: number) => sourceBytes.slice(offset, offset + length)),
                statFile: vi.fn(async () => ({size: sourceBytes.byteLength})),
            },
            djvu: {
                getInfo: nativeGetInfo,
                getPageSourceInfo: nativeGetPageSourceInfo,
                getPageSizes: nativeGetPageSizes,
            },
        });
        vi.stubGlobal('window', {electronAPI: electronApi});

        try {
            const browserPreview = await createDjvuPagePreviewSourceFromPath(requireDocumentRef('/tmp/small-many-pages.djvu'));
            await expect(browserPreview.getPageSizes()).resolves.toHaveLength(501);
            expect(nativeGetInfo).toHaveBeenCalledOnce();
            expect(browserGetComponentDirectory).toHaveBeenCalledOnce();
            browserPreview.terminate();

            pageCount = 10_001;
            const nativePreview = await createDjvuPagePreviewSourceFromPath(requireDocumentRef('/tmp/small-many-pages.djvu'));
            const source = await createDjvuPageSource(
                requireDocumentRef('/tmp/small-many-pages.djvu'),
                nativePreview,
                createWorkspaceSurfaceBudgetController(),
            );

            expect(source.pageCount).toBe(10_001);
            expect(nativeGetInfo).toHaveBeenCalledTimes(2);
            expect(nativeGetPageSourceInfo).toHaveBeenCalledWith('/tmp/small-many-pages.djvu', 1);
            expect(nativeGetPageSizes).not.toHaveBeenCalled();
            expect(djvuRouteMocks.createBrowserDjvuWorker).toHaveBeenCalledOnce();
            source.dispose();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('exposes leased raster, thumbnail, text, outline, and annotation providers', async () => {
        const previewSource = {
            getPageSizes: vi.fn().mockResolvedValue([
                {
                    width: 1_200,
                    height: 1_800,
                    dpi: 300,
                },
            ]),
            getPageText: vi.fn().mockResolvedValue('DjVu page text'),
            getOutline: vi.fn().mockResolvedValue([
                {
                    title: 'Chapter',
                    pageNumber: 1,
                    children: [],
                },
            ]),
            renderPageObjectUrl: vi.fn().mockResolvedValue({
                objectUrl: 'blob:page-1',
                renderedPx: 200,
            }),
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        } satisfies IPagePreviewSource;
        const source = await createDjvuPageSource(
            requireDocumentRef('/book.djvu'),
            previewSource,
            createWorkspaceSurfaceBudgetController(),
        );
        const controller = new AbortController();

        expect(await source.textProvider?.getPageText(1, controller.signal)).toBe('DjVu page text');
        expect(await source.outlineProvider?.getOutline(controller.signal)).toEqual([
            {
                title: 'Chapter',
                pageNumber: 1,
                children: [],
            },
        ]);
        const thumbnail = await source.thumbnailProvider!.renderThumbnail({
            pageNumber: 1,
            widthPx: 200,
            priority: 'navigation',
            signal: controller.signal,
        });
        expect(thumbnail).toMatchObject({
            surface: 'blob:page-1',
            widthPx: 200,
            heightPx: 300,
        });
        thumbnail.release();
        expect(previewSource.revokeObjectURL).toHaveBeenCalledWith('blob:page-1');
        source.dispose();
        expect(previewSource.terminate).toHaveBeenCalledOnce();
    });

    it('does not start a full-resolution browser DjVu decode without a transient reservation', async () => {
        const previewSource = {
            fullResolutionDecodeBeforeScale: true,
            getPageSizes: vi.fn().mockResolvedValue([
                {
                    width: 1_200,
                    height: 1_800,
                    dpi: 300,
                },
            ]),
            renderPageObjectUrl: vi.fn().mockResolvedValue({
                objectUrl: 'blob:oversized-page',
                renderedPx: 200,
            }),
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        } satisfies IPagePreviewSource;
        const source = await createDjvuPageSource(
            requireDocumentRef('/book.djvu'),
            previewSource,
            createWorkspaceSurfaceBudgetController(100),
        );

        await expect(
            source.renderPage({
                pageNumber: 1,
                widthPx: 200,
                priority: 'prefetch',
                signal: new AbortController().signal,
            }),
        ).rejects.toThrow('DjVu preview exceeds the available raster surface budget');
        expect(previewSource.renderPageObjectUrl).not.toHaveBeenCalled();
        expect(previewSource.revokeObjectURL).not.toHaveBeenCalled();
        source.dispose();
    });

    it('revokes a decoded DjVu surface when its retained reservation is refused', async () => {
        const previewSource = {
            getPageSizes: vi.fn().mockResolvedValue([
                {
                    width: 1_200,
                    height: 1_800,
                    dpi: 300,
                },
            ]),
            renderPageObjectUrl: vi.fn().mockResolvedValue({
                objectUrl: 'blob:retained-budget-refused',
                renderedPx: 200,
            }),
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        } satisfies IPagePreviewSource;
        const transientRelease = vi.fn();
        const tryReserve = vi.fn().mockReturnValueOnce({release: transientRelease}).mockReturnValueOnce(null);
        const source = await createDjvuPageSource(requireDocumentRef('/book.djvu'), previewSource, {
            reserve: vi.fn(),
            tryReserve,
            releaseScope: vi.fn(),
        });

        await expect(
            source.renderPage({
                pageNumber: 1,
                widthPx: 200,
                priority: 'prefetch',
                signal: new AbortController().signal,
            }),
        ).rejects.toThrow('DjVu preview exceeds the available raster surface budget');
        expect(transientRelease).toHaveBeenCalledOnce();
        expect(previewSource.renderPageObjectUrl).toHaveBeenCalledOnce();
        expect(previewSource.revokeObjectURL).toHaveBeenCalledWith('blob:retained-budget-refused');
        source.dispose();
    });

    it('cancels the native preview when its page render leaves the mount window', async () => {
        let rejectRender!: (error: Error) => void;
        const previewSource = {
            cancelPagePreview: vi.fn(() => rejectRender(new Error('canceled'))),
            getPageSizes: vi.fn().mockResolvedValue([
                {
                    width: 1_200,
                    height: 1_800,
                    dpi: 300,
                },
            ]),
            renderPageObjectUrl: vi.fn(
                () =>
                    new Promise<never>((_resolve, reject) => {
                        rejectRender = reject;
                    }),
            ),
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        } satisfies IPagePreviewSource;
        const source = await createDjvuPageSource(
            requireDocumentRef('/book.djvu'),
            previewSource,
            createWorkspaceSurfaceBudgetController(),
        );
        const controller = new AbortController();
        const render = source.renderPage({
            pageNumber: 1,
            widthPx: 200,
            priority: 'nearby',
            signal: controller.signal,
        });

        await vi.waitFor(() => expect(previewSource.renderPageObjectUrl).toHaveBeenCalledOnce());
        controller.abort();

        await expect(render).rejects.toThrow('canceled');
        expect(previewSource.cancelPagePreview).toHaveBeenCalledWith(1, expect.stringMatching(/^djvu-page-source:\d+:1:1$/u));
        source.dispose();
    });

    it('holds the transient DjVu reservation across abort until canceled native work settles', async () => {
        let resolveRender!: (value: {objectUrl: string; renderedPx: number}) => void;
        const previewSource = {
            cancelPagePreview: vi.fn(),
            getPageSizes: vi.fn().mockResolvedValue([
                {
                    width: 1_200,
                    height: 1_800,
                    dpi: 300,
                },
            ]),
            renderPageObjectUrl: vi.fn(
                () =>
                    new Promise<{
                        objectUrl: string;
                        renderedPx: number;
                    }>((resolve) => {
                        resolveRender = resolve;
                    }),
            ),
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        } satisfies IPagePreviewSource;
        const budget = createWorkspaceSurfaceBudgetController();
        const source = await createDjvuPageSource(requireDocumentRef('/book.djvu'), previewSource, budget);
        const controller = new AbortController();
        const render = source.renderPage({
            pageNumber: 1,
            widthPx: 200,
            priority: 'visible',
            signal: controller.signal,
        });

        await vi.waitFor(() => expect(previewSource.renderPageObjectUrl).toHaveBeenCalledOnce());
        const reservedDuringDecode = budget.getSnapshot().reservedBytesByCategory['djvu-preview'];
        expect(reservedDuringDecode).toBeGreaterThan(0);

        controller.abort();

        expect(previewSource.cancelPagePreview).toHaveBeenCalledWith(1, expect.stringMatching(/^djvu-page-source:\d+:1:1$/u));
        // Transient reservation MUST stay charged while the canceled decode is still in flight.
        expect(budget.getSnapshot().reservedBytesByCategory['djvu-preview']).toBe(reservedDuringDecode);

        resolveRender({
            objectUrl: 'blob:late-canceled-page',
            renderedPx: 200,
        });
        await expect(render).rejects.toThrow();
        expect(budget.getSnapshot().reservedBytesByCategory['djvu-preview']).toBe(0);
        expect(previewSource.revokeObjectURL).toHaveBeenCalledWith('blob:late-canceled-page');
        source.dispose();
    });

    it('holds transient DjVu reservation across dispose and worker errors until decode settles', async () => {
        let rejectRender!: (error: Error) => void;
        const previewSource = {
            cancelPagePreview: vi.fn(),
            getPageSizes: vi.fn().mockResolvedValue([
                {
                    width: 1_200,
                    height: 1_800,
                    dpi: 300,
                },
            ]),
            renderPageObjectUrl: vi.fn(
                () =>
                    new Promise<never>((_resolve, reject) => {
                        rejectRender = reject;
                    }),
            ),
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        } satisfies IPagePreviewSource;
        const budget = createWorkspaceSurfaceBudgetController();
        const source = await createDjvuPageSource(requireDocumentRef('/book.djvu'), previewSource, budget);
        const render = source.renderPage({
            pageNumber: 1,
            widthPx: 200,
            priority: 'visible',
            signal: new AbortController().signal,
        });

        await vi.waitFor(() => expect(previewSource.renderPageObjectUrl).toHaveBeenCalledOnce());
        const reservedDuringDecode = budget.getSnapshot().reservedBytesByCategory['djvu-preview'];
        expect(reservedDuringDecode).toBeGreaterThan(0);

        // Disposing the source while decode is still active must NOT drop the transient reservation early.
        source.dispose();
        expect(previewSource.terminate).toHaveBeenCalledOnce();
        expect(budget.getSnapshot().reservedBytesByCategory['djvu-preview']).toBe(reservedDuringDecode);

        rejectRender(new Error('worker failed'));
        await expect(render).rejects.toThrow('worker failed');
        expect(budget.getSnapshot().reservedBytesByCategory['djvu-preview']).toBe(0);
    });

    it('keeps a shared browser DjVu worker alive when one pane disposes, skips RGBA copy on abort, and holds transient budget until settlement', async () => {
        const {browserDocumentStore} = await import('@app/platform/browserDocumentStore');
        const sourceBytes = new Uint8Array(readFileSync('tests/fixtures/djvu/sources/photo-art.djvu'));
        const docRef = requireDocumentRef('browser://documents/shared-djvu-panes/photo-art.djvu');
        const statSpy = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: sourceBytes.byteLength,
            modifiedAt: 1234,
        });
        const readRangeSpy = vi
            .spyOn(browserDocumentStore, 'readRange')
            .mockImplementation(async (_ref, offset, length) => sourceBytes.slice(offset, offset + length));

        const pane1Decode = Promise.withResolvers<{width: number; height: number; bytes: Uint8Array}>();
        let renderCalls = 0;
        const sharedWorker = {
            open: vi.fn(async () => undefined),
            getComponentDirectory: vi.fn(async () => null),
            getDocInfo: vi.fn(),
            getPageInfo: vi.fn(),
            getPageLayerSummary: vi.fn(),
            getOutline: vi.fn(async () => []),
            getMetadata: vi.fn(async () => ({})),
            pageHasText: vi.fn(async () => false),
            getPageText: vi.fn(),
            renderMaskPbm: vi.fn(),
            renderBackgroundRgb: vi.fn(),
            renderPagePpm: vi.fn(),
            getPageNumberByUrl: vi.fn(),
            clearCache: vi.fn(),
            renderPage: vi.fn(async () => {
                renderCalls += 1;
                if (renderCalls === 1) {
                    return pane1Decode.promise;
                }
                return {
                    width: 4,
                    height: 4,
                    bytes: new Uint8Array(4 * 4 * 4),
                };
            }),
            terminate: vi.fn(),
        };
        djvuRouteMocks.createBrowserDjvuWorker.mockReset();
        djvuRouteMocks.createBrowserDjvuWorker.mockReturnValue(sharedWorker);

        const imageDataConstructs = vi.fn();
        class SpyImageData {
            public constructor(
                public data: Uint8ClampedArray,
                public width: number,
                public height: number,
            ) {
                imageDataConstructs(width, height);
            }
        }
        vi.stubGlobal('ImageData', SpyImageData);
        vi.stubGlobal(
            'OffscreenCanvas',
            class {
                public constructor(
                    public width: number,
                    public height: number,
                ) {}
                public getContext() {
                    return {putImageData: vi.fn()};
                }
                public convertToBlob() {
                    return Promise.resolve(new Blob([new Uint8Array([137, 80, 78, 71])], {type: 'image/png'}));
                }
            },
        );
        const createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pane-2-ok');
        const revokeObjectUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

        try {
            const preview1 = await createDjvuPagePreviewSourceFromPath(docRef);
            const preview2 = await createDjvuPagePreviewSourceFromPath(docRef);
            const budget = createWorkspaceSurfaceBudgetController();
            const source1 = await createDjvuPageSource(docRef, preview1, budget);
            const source2 = await createDjvuPageSource(docRef, preview2, budget);

            const pane1Render = source1.renderPage({
                pageNumber: 1,
                widthPx: 200,
                priority: 'visible',
                signal: new AbortController().signal,
            });
            await vi.waitFor(() => expect(sharedWorker.renderPage).toHaveBeenCalledOnce());
            const reservedDuringPane1 = budget.getSnapshot().reservedBytesByCategory['djvu-preview'];
            expect(reservedDuringPane1).toBeGreaterThan(0);

            // Disposing pane 1 while pane 2 shares the worker must NOT kill the worker or drop transient bytes early.
            source1.dispose();
            expect(sharedWorker.terminate).not.toHaveBeenCalled();
            expect(budget.getSnapshot().reservedBytesByCategory['djvu-preview']).toBe(reservedDuringPane1);

            // When pane 1's decode returns from the shared worker, abort signal must stop before ImageData RGBA copy.
            pane1Decode.resolve({
                width: 200,
                height: 150,
                bytes: new Uint8Array(200 * 150 * 4),
            });
            await expect(pane1Render).rejects.toThrow();
            expect(imageDataConstructs).not.toHaveBeenCalled();
            expect(budget.getSnapshot().reservedBytesByCategory['djvu-preview']).toBe(0);

            // Pane 2 still renders cleanly on the same shared worker.
            const pane2Lease = await source2.renderPage({
                pageNumber: 1,
                widthPx: 4,
                priority: 'visible',
                signal: new AbortController().signal,
            });
            expect(pane2Lease.surface).toBe('blob:pane-2-ok');
            expect(imageDataConstructs).toHaveBeenCalledOnce();
            pane2Lease.release();
            source2.dispose();
            await vi.waitFor(() => expect(sharedWorker.terminate).toHaveBeenCalledOnce());
        } finally {
            statSpy.mockRestore();
            readRangeSpy.mockRestore();
            createObjectUrlSpy.mockRestore();
            revokeObjectUrlSpy.mockRestore();
            vi.unstubAllGlobals();
        }
    });

    it('retries a speculative nearby DjVu render cleanly once fast-scroll transient budget drains instead of failing permanently', async () => {
        const page1Render = Promise.withResolvers<{objectUrl: string; renderedPx: number}>();
        const previewSource = {
            cancelPagePreview: vi.fn(),
            getPageSizes: vi.fn().mockResolvedValue([
                {width: 100, height: 100, dpi: 300},
                {width: 100, height: 100, dpi: 300},
            ]),
            renderPageObjectUrl: vi.fn(async (pageNumber: number) => {
                if (pageNumber === 1) {
                    return page1Render.promise;
                }
                return {objectUrl: 'blob:page-2-ok', renderedPx: 100};
            }),
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        } satisfies IPagePreviewSource;
        // Budget fits one 100x100 RGBA page (40,000 bytes), not two concurrently.
        const budget = createWorkspaceSurfaceBudgetController(40_000);
        const source = await createDjvuPageSource(requireDocumentRef('/fast-scroll.djvu'), previewSource, budget);

        const page1Controller = new AbortController();
        const render1 = source.renderPage({
            pageNumber: 1,
            widthPx: 100,
            priority: 'visible',
            signal: page1Controller.signal,
        });
        await vi.waitFor(() => expect(previewSource.renderPageObjectUrl).toHaveBeenCalledWith(1, expect.anything()));

        // User fast-scrolls away: page 1 is aborted, still holding its transient reservation while worker decodes.
        page1Controller.abort();
        expect(budget.getSnapshot().reservedBytesByCategory['djvu-preview']).toBe(40_000);

        // Speculative nearby page 2 requests render while page 1's transient reservation fills the budget.
        const render2 = source.renderPage({
            pageNumber: 2,
            widthPx: 100,
            priority: 'nearby',
            signal: new AbortController().signal,
        });
        // Give microtasks a turn to ensure page 2 does NOT fail prematurely with a terminal RangeError.
        await Promise.resolve();
        await Promise.resolve();

        // Once page 1's canceled decode settles and releases its transient reservation, page 2 must succeed.
        page1Render.resolve({objectUrl: 'blob:page-1-stale', renderedPx: 100});
        await expect(render1).rejects.toThrow();
        const lease2 = await render2;
        expect(lease2.surface).toBe('blob:page-2-ok');
        lease2.release();

        // Two simultaneous speculative nearby renders against the same 1-page budget must queue the second
        // behind the first synchronously (without rejecting before the first settles).
        const simultaneousPage1 = Promise.withResolvers<{objectUrl: string; renderedPx: number}>();
        previewSource.renderPageObjectUrl.mockImplementation(async (pageNumber: number) => {
            if (pageNumber === 1) {
                return simultaneousPage1.promise;
            }
            return {objectUrl: 'blob:simultaneous-page-2', renderedPx: 100};
        });
        const simController1 = new AbortController();
        const simRender1 = source.renderPage({
            pageNumber: 1,
            widthPx: 100,
            priority: 'nearby',
            signal: simController1.signal,
        });
        const simRender2 = source.renderPage({
            pageNumber: 2,
            widthPx: 100,
            priority: 'nearby',
            signal: new AbortController().signal,
        });
        await vi.waitFor(() => expect(previewSource.renderPageObjectUrl).toHaveBeenCalledWith(1, expect.anything()));
        simController1.abort();
        simultaneousPage1.resolve({objectUrl: 'blob:simultaneous-page-1-aborted', renderedPx: 100});
        await expect(simRender1).rejects.toThrow();
        const simLease2 = await simRender2;
        expect(simLease2.surface).toBe('blob:simultaneous-page-2');
        simLease2.release();
        source.dispose();
    });

    it('revokes a late DjVu.js URL after abort without committing a retained lease', async () => {
        let resolveRender!: (value: {objectUrl: string; renderedPx: number}) => void;
        const previewSource = {
            getPageSizes: vi.fn().mockResolvedValue([
                {
                    width: 1_200,
                    height: 1_800,
                    dpi: 300,
                },
            ]),
            renderPageObjectUrl: vi.fn(
                () =>
                    new Promise<{
                        objectUrl: string;
                        renderedPx: number;
                    }>((resolve) => {
                        resolveRender = resolve;
                    }),
            ),
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        } satisfies IPagePreviewSource;
        const budget = createWorkspaceSurfaceBudgetController();
        const source = await createDjvuPageSource(requireDocumentRef('/book.djvu'), previewSource, budget);
        const controller = new AbortController();
        const render = source.renderPage({
            pageNumber: 1,
            widthPx: 200,
            priority: 'visible',
            signal: controller.signal,
        });
        await vi.waitFor(() => expect(previewSource.renderPageObjectUrl).toHaveBeenCalledOnce());

        controller.abort();
        resolveRender({
            objectUrl: 'blob:late-aborted-page',
            renderedPx: 200,
        });

        await expect(render).rejects.toThrow();
        expect(previewSource.revokeObjectURL).toHaveBeenCalledWith('blob:late-aborted-page');
        expect(budget.getSnapshot().leaseCount).toBe(0);
        source.dispose();
    });

    it('notifies a mounted DjVu surface when later memory pressure invalidates it', async () => {
        const previewSource = {
            getPageSizes: vi.fn().mockResolvedValue([
                {
                    width: 1_200,
                    height: 1_800,
                    dpi: 300,
                },
            ]),
            renderPageObjectUrl: vi.fn().mockResolvedValue({
                objectUrl: 'blob:pressure-page',
                renderedPx: 200,
            }),
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        } satisfies IPagePreviewSource;
        const budget = createWorkspaceSurfaceBudgetController(400_000);
        const source = await createDjvuPageSource(requireDocumentRef('/book.djvu'), previewSource, budget);
        const surface = await source.renderPage({
            pageNumber: 1,
            widthPx: 200,
            priority: 'nearby',
            signal: new AbortController().signal,
        });
        const onInvalidated = vi.fn();
        surface.onInvalidated?.(onInvalidated);

        budget.setPressureLevel('critical');

        expect(onInvalidated).toHaveBeenCalledOnce();
        expect(previewSource.revokeObjectURL).toHaveBeenCalledWith('blob:pressure-page');
        source.dispose();
    });

    it('protects a visible DjVu surface from pressure eviction', async () => {
        const previewSource = {
            getPageSizes: vi.fn().mockResolvedValue([
                {
                    width: 1_200,
                    height: 1_800,
                    dpi: 300,
                },
            ]),
            renderPageObjectUrl: vi.fn().mockResolvedValue({
                objectUrl: 'blob:visible-page',
                renderedPx: 200,
            }),
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        } satisfies IPagePreviewSource;
        const budget = createWorkspaceSurfaceBudgetController(400_000);
        const source = await createDjvuPageSource(requireDocumentRef('/book.djvu'), previewSource, budget);
        const surface = await source.renderPage({
            pageNumber: 1,
            widthPx: 200,
            priority: 'visible',
            signal: new AbortController().signal,
        });
        const onInvalidated = vi.fn();
        surface.onInvalidated?.(onInvalidated);

        budget.setPressureLevel('critical');

        expect(onInvalidated).not.toHaveBeenCalled();
        expect(previewSource.revokeObjectURL).not.toHaveBeenCalled();
        surface.release();
        source.dispose();
    });

    it('admits independent required surfaces for two visible DjVu panes under pressure', async () => {
        const budget = createWorkspaceSurfaceBudgetController(600);
        let nextObjectUrl = 0;
        const createPreviewSource = () =>
            ({
                getPageSizes: vi.fn().mockResolvedValue([
                    {
                        width: 10,
                        height: 10,
                        dpi: 300,
                    },
                ]),
                renderPageObjectUrl: vi.fn().mockImplementation(async () => ({
                    objectUrl: `blob:visible-pane-${String(++nextObjectUrl)}`,
                    renderedPx: 10,
                })),
                revokeObjectURL: vi.fn(),
                terminate: vi.fn(),
            }) satisfies IPagePreviewSource;
        const firstPreviewSource = createPreviewSource();
        const secondPreviewSource = createPreviewSource();
        const firstSource = await createDjvuPageSource(requireDocumentRef('/first.djvu'), firstPreviewSource, budget);
        const secondSource = await createDjvuPageSource(requireDocumentRef('/second.djvu'), secondPreviewSource, budget);
        const firstSurface = await firstSource.renderPage({
            pageNumber: 1,
            widthPx: 10,
            priority: 'navigation',
            signal: new AbortController().signal,
        });

        budget.setPressureLevel('critical');
        const secondSurface = await secondSource.renderPage({
            pageNumber: 1,
            widthPx: 10,
            priority: 'navigation',
            signal: new AbortController().signal,
        });

        expect(firstSurface.surface).toBe('blob:visible-pane-1');
        expect(secondSurface.surface).toBe('blob:visible-pane-2');
        expect(firstPreviewSource.revokeObjectURL).not.toHaveBeenCalled();
        expect(secondPreviewSource.revokeObjectURL).not.toHaveBeenCalled();
        expect(budget.getSnapshot()).toMatchObject({
            effectiveMaxBytes: 300,
            leaseCount: 2,
            reservedBytes: 800,
        });
        firstSurface.release();
        secondSurface.release();
        firstSource.dispose();
        secondSource.dispose();
    });

    it('promotes a completed DjVu surface lease without rerendering the page', async () => {
        const previewSource = {
            getPageSizes: vi.fn().mockResolvedValue([
                {
                    width: 1_200,
                    height: 1_800,
                    dpi: 300,
                },
            ]),
            renderPageObjectUrl: vi.fn().mockResolvedValue({
                objectUrl: 'blob:promoted-page',
                renderedPx: 200,
            }),
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        } satisfies IPagePreviewSource;
        const promotePriority = vi.fn();
        const setPriority = vi.fn();
        let canEvict: (() => boolean) | undefined;
        const reserve = vi.fn((options: {canEvict?: (() => boolean) | undefined}) => {
            canEvict = options.canEvict;
            return {
                promotePriority,
                setPriority,
                release: vi.fn(),
            };
        });
        const source = await createDjvuPageSource(requireDocumentRef('/book.djvu'), previewSource, {
            reserve,
            releaseScope: vi.fn(),
        });
        const surface = await source.renderPage({
            pageNumber: 1,
            widthPx: 200,
            priority: 'nearby',
            signal: new AbortController().signal,
        });

        expect(canEvict?.()).toBe(true);
        surface.promotePriority?.('navigation');
        expect(canEvict?.()).toBe(false);
        surface.promotePriority?.('visible');

        expect(previewSource.renderPageObjectUrl).toHaveBeenCalledOnce();
        expect(promotePriority).toHaveBeenCalledOnce();
        expect(promotePriority).toHaveBeenCalledWith(100);
        surface.setPriority?.('prefetch');
        expect(canEvict?.()).toBe(true);
        expect(setPriority).toHaveBeenCalledWith(10);
        surface.release();
        source.dispose();
    });

    it('atomically swaps a session source after a projection is ready', async () => {
        const oldSource = {
            kind: 'djvu' as const,
            documentRef: requireDocumentRef('/book.djvu'),
            pageCount: 1,
            getPageMetrics: vi.fn(),
            renderPage: vi.fn(),
            dispose: vi.fn(),
        };
        const pdfSource = {
            ...oldSource,
            kind: 'pdf' as const,
            documentRef: requireDocumentRef('/book.pdf'),
        };
        const capabilities = {
            annotations: false,
            directImageExport: true,
            outline: false,
            pageEdits: false,
            search: false,
            text: false,
        };
        const session = createDocumentProjectionSession({
            id: 'session',
            originalRef: requireDocumentRef('/book.djvu'),
            source: oldSource,
            capabilities,
        });

        await ensurePdfProjection(
            session,
            {
                build: vi.fn().mockResolvedValue({
                    documentRef: requireDocumentRef('/book.pdf'),
                    source: pdfSource,
                    capabilities: {
                        ...capabilities,
                        pageEdits: true,
                    },
                }),
            },
            'edit',
            new AbortController().signal,
        );

        expect(session.source).toBe(pdfSource);
        expect(session.capabilities.pageEdits).toBe(true);
        expect(session.projection.status).toBe('ready');
        expect(oldSource.dispose).toHaveBeenCalledOnce();
    });

    it('passes the print projection reason through the builder before swapping sources', async () => {
        const oldSource = {
            kind: 'djvu' as const,
            documentRef: requireDocumentRef('/book.djvu'),
            pageCount: 1,
            getPageMetrics: vi.fn(),
            renderPage: vi.fn(),
            dispose: vi.fn(),
        };
        const pdfSource = {
            ...oldSource,
            kind: 'pdf' as const,
            documentRef: requireDocumentRef('/print.pdf'),
        };
        const capabilities = {
            annotations: false,
            directImageExport: true,
            outline: false,
            pageEdits: false,
            search: false,
            text: false,
        };
        const session = createDocumentProjectionSession({
            id: 'print-session',
            originalRef: requireDocumentRef('/book.djvu'),
            source: oldSource,
            capabilities,
        });
        const build = vi.fn().mockResolvedValue({
            documentRef: requireDocumentRef('/print.pdf'),
            source: pdfSource,
            capabilities: {
                ...capabilities,
                pageEdits: true,
            },
        });
        const signal = new AbortController().signal;

        await ensurePdfProjection(session, {build}, 'print', signal);

        expect(build).toHaveBeenCalledWith({
            session,
            reason: 'print',
            signal,
        });
        expect(session.projection).toEqual({
            status: 'ready',
            reason: 'print',
            documentRef: requireDocumentRef('/print.pdf'),
        });
        expect(session.source).toBe(pdfSource);
    });
});
