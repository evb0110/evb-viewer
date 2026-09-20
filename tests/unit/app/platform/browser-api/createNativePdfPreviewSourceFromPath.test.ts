import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IPdfNativePagePreview } from '@contracts/electronApiDocuments';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireRequestId} from '@contracts/shared';
import { createNativePdfPreviewSourceFromPath } from '@app/platform/browser-api/createNativePdfPreviewSourceFromPath';
import { workspaceSurfaceBudgetController } from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';

describe('createNativePdfPreviewSourceFromPath', () => {
    afterEach(() => {
        workspaceSurfaceBudgetController.setPressureLevel('healthy');
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('cancels active native preview renders when the source terminates', async () => {
        const rejectByRequestId = new Map<string, (error: Error) => void>();
        const documentFiles: Parameters<typeof createNativePdfPreviewSourceFromPath>[1] = {
            cancelPdfNativePagePreview: vi.fn(async (requestId: string) => {
                rejectByRequestId.get(requestId)?.(new Error('Native PDF preview canceled'));
                return {canceled: true};
            }),
            getPdfNativePageSizes: vi.fn(async () => []),
            renderPdfNativePagePreview: vi.fn(async (
                _path: string,
                _pageNumber: number,
                options?: {previewRequestId?: string},
            ) => new Promise<IPdfNativePagePreview>((_resolve, reject: (error: Error) => void) => {
                const requestId = options?.previewRequestId;
                if (!requestId) {
                    throw new Error('Expected previewRequestId');
                }
                rejectByRequestId.set(requestId, reject);
            })),
        };

        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => 'blob:preview'),
            revokeObjectURL: vi.fn(),
        });

        const source = createNativePdfPreviewSourceFromPath(requireDocumentRef('/tmp/native-preview.pdf'), documentFiles);
        const renderPromise = source.renderPageObjectUrl(1);
        await Promise.resolve();

        source.terminate();

        await expect(renderPromise).rejects.toThrow('Native PDF preview canceled');
        expect(documentFiles.cancelPdfNativePagePreview)
            .toHaveBeenCalledWith(expect.stringMatching(/^pdf-native-preview-\d+-\d+-\d+-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u));
    });

    it('cancels the active request for a page when that page is reset', async () => {
        const rejectByRequestId = new Map<string, (error: Error) => void>();
        const documentFiles: Parameters<typeof createNativePdfPreviewSourceFromPath>[1] = {
            cancelPdfNativePagePreview: vi.fn(async (requestId: string) => {
                rejectByRequestId.get(requestId)?.(new Error('Native PDF preview canceled'));
                return {canceled: true};
            }),
            getPdfNativePageSizes: vi.fn(async () => []),
            renderPdfNativePagePreview: vi.fn(async (
                _path: string,
                _pageNumber: number,
                options?: {previewRequestId?: string},
            ) => new Promise<IPdfNativePagePreview>((_resolve, reject: (error: Error) => void) => {
                const requestId = options?.previewRequestId;
                if (!requestId) {
                    throw new Error('Expected previewRequestId');
                }
                rejectByRequestId.set(requestId, reject);
            })),
        };

        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => 'blob:preview'),
            revokeObjectURL: vi.fn(),
        });

        const source = createNativePdfPreviewSourceFromPath(requireDocumentRef('/tmp/native-preview.pdf'), documentFiles);
        const renderPromise = source.renderPageObjectUrl(2);
        await Promise.resolve();

        source.cancelPagePreview?.(2);

        await expect(renderPromise).rejects.toThrow('Native PDF preview canceled');
        expect(documentFiles.cancelPdfNativePagePreview)
            .toHaveBeenCalledWith(expect.stringMatching(/^pdf-native-preview-\d+-\d+-\d+-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u));
    });

    it('never reuses request IDs across two sources for the same path and page', async () => {
        const seenRequestIds: string[] = [];
        const documentFiles: Parameters<typeof createNativePdfPreviewSourceFromPath>[1] = {
            cancelPdfNativePagePreview: vi.fn(async () => ({canceled: false})),
            getPdfNativePageSizes: vi.fn(async () => []),
            renderPdfNativePagePreview: vi.fn(async (
                _path: string,
                _pageNumber: number,
                options?: {previewRequestId?: string},
            ) => {
                seenRequestIds.push(options?.previewRequestId ?? '');
                return {
                    bytes: new Uint8Array([1]),
                    width: 40,
                    height: 25,
                };
            }),
        };
        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => 'blob:pane-preview'),
            revokeObjectURL: vi.fn(),
        });
        const paneA = createNativePdfPreviewSourceFromPath(requireDocumentRef('/tmp/shared-pane.pdf'), documentFiles);
        const paneB = createNativePdfPreviewSourceFromPath(requireDocumentRef('/tmp/shared-pane.pdf'), documentFiles);

        await paneA.renderPageObjectUrl(1);
        await paneB.renderPageObjectUrl(1);

        expect(seenRequestIds).toHaveLength(2);
        expect(new Set(seenRequestIds).size).toBe(2);
        paneA.terminate();
        paneB.terminate();
    });

    it('keeps a same-path source budgeted when the other source terminates', async () => {
        const documentFiles: Parameters<typeof createNativePdfPreviewSourceFromPath>[1] = {
            cancelPdfNativePagePreview: vi.fn(async () => ({canceled: false})),
            getPdfNativePageSizes: vi.fn(async () => []),
            renderPdfNativePagePreview: vi.fn(async () => ({
                bytes: new Uint8Array([1]),
                width: 40,
                height: 25,
            })),
        };
        vi.stubGlobal('URL', {
            createObjectURL: vi.fn()
                .mockReturnValueOnce('blob:pane-a')
                .mockReturnValueOnce('blob:pane-b'),
            revokeObjectURL: vi.fn(),
        });
        const before = workspaceSurfaceBudgetController.getSnapshot();
        const paneA = createNativePdfPreviewSourceFromPath(requireDocumentRef('/tmp/shared-budget.pdf'), documentFiles);
        const paneB = createNativePdfPreviewSourceFromPath(requireDocumentRef('/tmp/shared-budget.pdf'), documentFiles);
        const pageBytes = 40 * 25 * 4;

        await paneA.renderPageObjectUrl(1);
        await paneB.renderPageObjectUrl(1);
        expect(workspaceSurfaceBudgetController.getSnapshot().reservedBytesByCategory['native-preview'])
            .toBe(before.reservedBytesByCategory['native-preview'] + pageBytes * 2);

        paneA.terminate();

        expect(workspaceSurfaceBudgetController.getSnapshot().reservedBytesByCategory['native-preview'])
            .toBe(before.reservedBytesByCategory['native-preview'] + pageBytes);
        paneB.terminate();
        expect(workspaceSurfaceBudgetController.getSnapshot().reservedBytesByCategory['native-preview'])
            .toBe(before.reservedBytesByCategory['native-preview']);
    });

    it('cancels one page consumer without canceling a concurrent consumer', async () => {
        const pending = new Map<string, PromiseWithResolvers<IPdfNativePagePreview>>();
        const documentFiles: Parameters<typeof createNativePdfPreviewSourceFromPath>[1] = {
            cancelPdfNativePagePreview: vi.fn(async (requestId: string) => {
                pending.get(requestId)?.reject(new Error('Native PDF preview canceled'));
                return {canceled: true};
            }),
            getPdfNativePageSizes: vi.fn(async () => []),
            renderPdfNativePagePreview: vi.fn(async (
                _path: string,
                _pageNumber: number,
                options?: {previewRequestId?: string},
            ) => {
                const requestId = options?.previewRequestId;
                if (!requestId) throw new Error('Expected previewRequestId');
                const deferred = Promise.withResolvers<IPdfNativePagePreview>();
                pending.set(requestId, deferred);
                return deferred.promise;
            }),
        };
        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => 'blob:preview'),
            revokeObjectURL: vi.fn(),
        });
        const source = createNativePdfPreviewSourceFromPath(requireDocumentRef('/tmp/native-preview.pdf'), documentFiles);
        const viewport = source.renderPageObjectUrl(2, {previewRequestId: requireRequestId('viewport')});
        const thumbnail = source.renderPageObjectUrl(2, {previewRequestId: requireRequestId('thumbnail')});
        await vi.waitFor(() => expect(pending.size).toBe(2));

        source.cancelPagePreview?.(2, 'thumbnail');
        pending.get('viewport')?.resolve({
            bytes: new Uint8Array([1]),
            width: 40,
            height: 25,
        });

        await expect(thumbnail).rejects.toThrow('Native PDF preview canceled');
        await expect(viewport).resolves.toMatchObject({
            objectUrl: 'blob:preview',
            renderedPx: 40,
        });
        expect(documentFiles.cancelPdfNativePagePreview).toHaveBeenCalledOnce();
        expect(documentFiles.cancelPdfNativePagePreview).toHaveBeenCalledWith('thumbnail');
        source.terminate();
    });

    it('leases decoded native preview surfaces until their object URLs are released', async () => {
        const documentFiles: Parameters<typeof createNativePdfPreviewSourceFromPath>[1] = {
            cancelPdfNativePagePreview: vi.fn(async () => ({canceled: false})),
            getPdfNativePageSizes: vi.fn(async () => []),
            renderPdfNativePagePreview: vi.fn(async () => ({
                bytes: new Uint8Array([
                    1,
                    2,
                    3,
                ]),
                width: 40,
                height: 25,
            })),
        };
        const createObjectURL = vi.fn(() => 'blob:leased-preview');
        vi.stubGlobal('URL', {
            createObjectURL,
            revokeObjectURL: vi.fn(),
        });
        const before = workspaceSurfaceBudgetController.getSnapshot();
        const source = createNativePdfPreviewSourceFromPath(requireDocumentRef('/tmp/leased-preview.pdf'), documentFiles);

        const rendered = await source.renderPageObjectUrl(1);

        const leased = workspaceSurfaceBudgetController.getSnapshot();
        expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({type: 'image/jpeg'}));
        expect(leased.reservedBytesByCategory['native-preview'])
            .toBe(before.reservedBytesByCategory['native-preview'] + 40 * 25 * 4);
        source.revokeObjectURL(rendered.objectUrl);
        expect(workspaceSurfaceBudgetController.getSnapshot().reservedBytesByCategory['native-preview'])
            .toBe(before.reservedBytesByCategory['native-preview']);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:leased-preview');
    });

    it('forwards a learned raster width ceiling with the rendered object URL', async () => {
        const documentFiles: Parameters<typeof createNativePdfPreviewSourceFromPath>[1] = {
            cancelPdfNativePagePreview: vi.fn(async () => ({canceled: false})),
            getPdfNativePageSizes: vi.fn(async () => []),
            renderPdfNativePagePreview: vi.fn(async () => ({
                bytes: new Uint8Array([1]),
                width: 2_008,
                height: 3_189,
                rasterWidthCeilingPx: 2_008,
            })),
        };
        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => 'blob:raster-preview'),
            revokeObjectURL: vi.fn(),
        });
        const source = createNativePdfPreviewSourceFromPath(requireDocumentRef('/tmp/raster-preview.pdf'), documentFiles);

        await expect(source.renderPageObjectUrl(1)).resolves.toMatchObject({
            objectUrl: 'blob:raster-preview',
            renderedPx: 2_008,
            rasterWidthCeilingPx: 2_008,
        });
        source.terminate();
    });

    it('notifies the viewer when later pressure revokes a native preview URL', async () => {
        const documentFiles: Parameters<typeof createNativePdfPreviewSourceFromPath>[1] = {
            cancelPdfNativePagePreview: vi.fn(async () => ({canceled: false})),
            getPdfNativePageSizes: vi.fn(async () => []),
            renderPdfNativePagePreview: vi.fn(async () => ({
                bytes: new Uint8Array([1]),
                width: 100_000_000,
                height: 1,
            })),
        };
        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => 'blob:pressure-preview'),
            revokeObjectURL: vi.fn(),
        });
        workspaceSurfaceBudgetController.setPressureLevel('healthy');
        const source = createNativePdfPreviewSourceFromPath(requireDocumentRef('/tmp/pressure-preview.pdf'), documentFiles);
        const rendered = await source.renderPageObjectUrl(1);
        const onInvalidated = vi.fn();
        rendered.onInvalidated?.(onInvalidated);

        workspaceSurfaceBudgetController.setPressureLevel('emergency');

        expect(onInvalidated).toHaveBeenCalledOnce();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:pressure-preview');
        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
        workspaceSurfaceBudgetController.setPressureLevel('healthy');
        source.terminate();
    });
});
