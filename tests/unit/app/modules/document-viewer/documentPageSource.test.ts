// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IPagePreviewSource } from '@app/modules/document-viewer/pagePreviewSource';
import { createDjvuPageSource } from '@app/modules/document-viewer/source/createDjvuPageSource';
import {
    createDocumentSession,
    ensurePdfProjection,
} from '@app/modules/document-viewer/session/documentSession';
import { createWorkspaceSurfaceBudgetController } from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';
import {requireDocumentRef} from '@contracts/documentRef';

describe('document page sources', () => {
    it('exposes one cancellable full-document DjVu search provider with the known page count', async () => {
        const searchText = vi.fn().mockResolvedValue({
            results: [{
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
            }],
            truncated: false,
        });
        const previewSource = {
            getPageSizes: vi.fn().mockResolvedValue(Array.from({length: 4}, () => ({
                width: 600,
                height: 800,
                dpi: 300,
            }))),
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
        expect(searchText).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'source-search',
            pageCount: 4,
            signal: controller.signal,
        }));
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

    it('exposes leased raster, thumbnail, text, outline, and annotation providers', async () => {
        const previewSource = {
            getPageSizes: vi.fn().mockResolvedValue([{
                width: 1_200,
                height: 1_800,
                dpi: 300,
            }]),
            getPageText: vi.fn().mockResolvedValue('DjVu page text'),
            getOutline: vi.fn().mockResolvedValue([{
                title: 'Chapter',
                pageNumber: 1,
                children: [],
            }]),
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
        expect(await source.outlineProvider?.getOutline(controller.signal)).toEqual([{
            title: 'Chapter',
            pageNumber: 1,
            children: [],
        }]);
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
            getPageSizes: vi.fn().mockResolvedValue([{
                width: 1_200,
                height: 1_800,
                dpi: 300,
            }]),
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

        await expect(source.renderPage({
            pageNumber: 1,
            widthPx: 200,
            priority: 'prefetch',
            signal: new AbortController().signal,
        })).rejects.toThrow('DjVu preview exceeds the available raster surface budget');
        expect(previewSource.renderPageObjectUrl).not.toHaveBeenCalled();
        expect(previewSource.revokeObjectURL).not.toHaveBeenCalled();
        source.dispose();
    });

    it('revokes a decoded DjVu surface when its retained reservation is refused', async () => {
        const previewSource = {
            getPageSizes: vi.fn().mockResolvedValue([{
                width: 1_200,
                height: 1_800,
                dpi: 300,
            }]),
            renderPageObjectUrl: vi.fn().mockResolvedValue({
                objectUrl: 'blob:retained-budget-refused',
                renderedPx: 200,
            }),
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        } satisfies IPagePreviewSource;
        const transientRelease = vi.fn();
        const tryReserve = vi.fn()
            .mockReturnValueOnce({release: transientRelease})
            .mockReturnValueOnce(null);
        const source = await createDjvuPageSource(requireDocumentRef('/book.djvu'), previewSource, {
            reserve: vi.fn(),
            tryReserve,
            releaseScope: vi.fn(),
        });

        await expect(source.renderPage({
            pageNumber: 1,
            widthPx: 200,
            priority: 'prefetch',
            signal: new AbortController().signal,
        })).rejects.toThrow('DjVu preview exceeds the available raster surface budget');
        expect(transientRelease).toHaveBeenCalledOnce();
        expect(previewSource.renderPageObjectUrl).toHaveBeenCalledOnce();
        expect(previewSource.revokeObjectURL).toHaveBeenCalledWith('blob:retained-budget-refused');
        source.dispose();
    });

    it('cancels the native preview when its page render leaves the mount window', async () => {
        let rejectRender!: (error: Error) => void;
        const previewSource = {
            cancelPagePreview: vi.fn(() => rejectRender(new Error('canceled'))),
            getPageSizes: vi.fn().mockResolvedValue([{
                width: 1_200,
                height: 1_800,
                dpi: 300,
            }]),
            renderPageObjectUrl: vi.fn(() => new Promise<never>((_resolve, reject) => {
                rejectRender = reject;
            })),
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

    it('releases the transient DjVu reservation before canceled native work settles', async () => {
        let resolveRender!: (value: {
            objectUrl: string;
            renderedPx: number;
        }) => void;
        const previewSource = {
            cancelPagePreview: vi.fn(),
            getPageSizes: vi.fn().mockResolvedValue([{
                width: 1_200,
                height: 1_800,
                dpi: 300,
            }]),
            renderPageObjectUrl: vi.fn(() => new Promise<{
                objectUrl: string;
                renderedPx: number;
            }>((resolve) => {
                resolveRender = resolve;
            })),
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
        expect(budget.getSnapshot().reservedBytesByCategory['djvu-preview']).toBeGreaterThan(0);

        controller.abort();

        expect(previewSource.cancelPagePreview).toHaveBeenCalledWith(
            1,
            expect.stringMatching(/^djvu-page-source:\d+:1:1$/u),
        );
        expect(budget.getSnapshot().reservedBytesByCategory['djvu-preview']).toBe(0);

        resolveRender({
            objectUrl: 'blob:late-canceled-page',
            renderedPx: 200,
        });
        await expect(render).rejects.toThrow();
        expect(previewSource.revokeObjectURL).toHaveBeenCalledWith('blob:late-canceled-page');
        source.dispose();
    });

    it('revokes a late DjVu.js URL after abort without committing a retained lease', async () => {
        let resolveRender!: (value: {
            objectUrl: string;
            renderedPx: number;
        }) => void;
        const previewSource = {
            getPageSizes: vi.fn().mockResolvedValue([{
                width: 1_200,
                height: 1_800,
                dpi: 300,
            }]),
            renderPageObjectUrl: vi.fn(() => new Promise<{
                objectUrl: string;
                renderedPx: number;
            }>((resolve) => {
                resolveRender = resolve;
            })),
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
            getPageSizes: vi.fn().mockResolvedValue([{
                width: 1_200,
                height: 1_800,
                dpi: 300,
            }]),
            renderPageObjectUrl: vi.fn().mockResolvedValue({
                objectUrl: 'blob:pressure-page',
                renderedPx: 200,
            }),
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        } satisfies IPagePreviewSource;
        const budget = createWorkspaceSurfaceBudgetController(800_000);
        const source = await createDjvuPageSource(requireDocumentRef('/book.djvu'), previewSource, budget);
        const surface = await source.renderPage({
            pageNumber: 1,
            widthPx: 200,
            priority: 'nearby',
            signal: new AbortController().signal,
        });
        const onInvalidated = vi.fn();
        surface.onInvalidated?.(onInvalidated);

        budget.setPressureLevel('emergency');

        expect(onInvalidated).toHaveBeenCalledOnce();
        expect(previewSource.revokeObjectURL).toHaveBeenCalledWith('blob:pressure-page');
        source.dispose();
    });

    it('protects a visible DjVu surface from pressure eviction', async () => {
        const previewSource = {
            getPageSizes: vi.fn().mockResolvedValue([{
                width: 1_200,
                height: 1_800,
                dpi: 300,
            }]),
            renderPageObjectUrl: vi.fn().mockResolvedValue({
                objectUrl: 'blob:visible-page',
                renderedPx: 200,
            }),
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        } satisfies IPagePreviewSource;
        const budget = createWorkspaceSurfaceBudgetController(800_000);
        const source = await createDjvuPageSource(requireDocumentRef('/book.djvu'), previewSource, budget);
        const surface = await source.renderPage({
            pageNumber: 1,
            widthPx: 200,
            priority: 'visible',
            signal: new AbortController().signal,
        });
        const onInvalidated = vi.fn();
        surface.onInvalidated?.(onInvalidated);

        budget.setPressureLevel('emergency');

        expect(onInvalidated).not.toHaveBeenCalled();
        expect(previewSource.revokeObjectURL).not.toHaveBeenCalled();
        surface.release();
        source.dispose();
    });

    it('admits independent required surfaces for two visible DjVu panes under pressure', async () => {
        const budget = createWorkspaceSurfaceBudgetController(600);
        let nextObjectUrl = 0;
        const createPreviewSource = () => ({
            getPageSizes: vi.fn().mockResolvedValue([{
                width: 10,
                height: 10,
                dpi: 300,
            }]),
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

        budget.setPressureLevel('emergency');
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
            effectiveMaxBytes: 150,
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
            getPageSizes: vi.fn().mockResolvedValue([{
                width: 1_200,
                height: 1_800,
                dpi: 300,
            }]),
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
        const reserve = vi.fn((options: {canEvict?: (() => boolean) | undefined;}) => {
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
        const session = createDocumentSession({
            id: 'session',
            originalRef: requireDocumentRef('/book.djvu'),
            source: oldSource,
            capabilities,
        });

        await ensurePdfProjection(session, {build: vi.fn().mockResolvedValue({
            documentRef: requireDocumentRef('/book.pdf'),
            source: pdfSource,
            capabilities: {
                ...capabilities,
                pageEdits: true,
            },
        })}, 'edit', new AbortController().signal);

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
        const session = createDocumentSession({
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
