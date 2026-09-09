import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
} from 'vue';
import { createRangePageSelection } from '@contracts/pageNumbers';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import { useWorkspaceExport } from '@app/modules/workspace-shell/composables/useWorkspaceExport';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';

const trackMock = vi.hoisted(() => vi.fn());
const exportImagesMock = vi.hoisted(() => vi.fn());
const exportTiffMock = vi.hoisted(() => vi.fn());
const cleanupFileMock = vi.hoisted(() => vi.fn(async () => {}));
const toastAddMock = vi.hoisted(() => vi.fn());
const progressListeners = vi.hoisted(() => new Set<(progress: {
    requestId: string;
    format: 'images' | 'multipage-tiff';
    phase: 'rendering' | 'combining';
    processed: number;
    total: number;
    percent: number;
}) => void>());
const onProgressMock = vi.hoisted(() => vi.fn((callback: (progress: {
    requestId: string;
    format: 'images' | 'multipage-tiff';
    phase: 'rendering' | 'combining';
    processed: number;
    total: number;
    percent: number;
}) => void) => {
    progressListeners.add(callback);
    return () => {
        progressListeners.delete(callback);
    };
}));
const mockDocumentWorkingCopyCapability = {cleanupFile: cleanupFileMock};
const mockImageExportCapability = {
    exportPdfToImages: exportImagesMock,
    exportPdfToMultiPageTiff: exportTiffMock,
    onProgress: onProgressMock,
};

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentWorkingCopyCapability: () => mockDocumentWorkingCopyCapability,
    getImageExportCapability: () => mockImageExportCapability,
}));
vi.mock('@app/composables/useAnalytics', () => ({useAnalytics: () => ({track: trackMock})}));

function createComposable(options: {
    ensureWorkingCopyFreshForRead?: () => Promise<boolean>;
    sourceKind?: 'pdf' | 'djvu';
    sourcePath?: string;
    multiPageTiffSourceKind?: 'pdf' | 'djvu';
    multiPageTiffSourcePath?: string;
    totalPages?: number;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
} = {}) {
    const scope = effectScope();
    const workingCopyPath = ref<TDocumentRef>(requireDocumentRef('/tmp/work.pdf'));
    const sourceKind = ref<'pdf' | 'djvu'>(options.sourceKind ?? 'pdf');
    const sourcePath = ref<TDocumentRef>(requireDocumentRef(options.sourcePath ?? '/tmp/work.pdf'));
    const imageTarget = computed(() => ({
        sourceKind: sourceKind.value,
        sourcePath: sourcePath.value,
        requiresFreshWorkingCopy: sourceKind.value === 'pdf',
    }));
    const multiPageTiffTarget = computed(() => ({
        sourceKind: options.multiPageTiffSourceKind ?? sourceKind.value,
        sourcePath: requireDocumentRef(options.multiPageTiffSourcePath ?? options.sourcePath ?? '/tmp/work.pdf'),
        requiresFreshWorkingCopy: (options.multiPageTiffSourceKind ?? sourceKind.value) === 'pdf',
    }));
    const state = scope.run(() => useWorkspaceExport({
        workingCopyPath,
        exportTargets: {
            imageTarget,
            multiPageTiffTarget,
        },
        totalPages: ref(options.totalPages ?? 5),
        ...(options.ensureWorkingCopyFreshForRead ? { ensureWorkingCopyFreshForRead: options.ensureWorkingCopyFreshForRead } : {}),
        ...(options.runWithDocumentOperationLease
            ? {runWithDocumentOperationLease: options.runWithDocumentOperationLease}
            : {}),
    }));

    if (!state) {
        throw new Error('Failed to create workspace export scope');
    }

    return {
        scope,
        sourceKind,
        sourcePath,
        state,
        workingCopyPath,
    };
}

describe('useWorkspaceExport', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        progressListeners.clear();
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
        vi.stubGlobal('useToast', () => ({ add: toastAddMock }));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('refuses an oversized partial compact image selection instead of opening an all-pages dialog', async () => {
        const {
            scope,
            state,
        } = createComposable({totalPages: 200_000});
        const selection = createRangePageSelection(200_000, 2, 100_002);
        const exportPromise = state.handleExportImages(selection);

        try {
            expect(state.exportScopeDialogOpen.value).toBe(false);
            expect(exportImagesMock).not.toHaveBeenCalled();
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'warning',
                title: 'export.selectionTooLarge',
            }));
        } finally {
            scope.stop();
            await exportPromise;
        }
    });

    it('uses the driver target declared for TIFF instead of the image target', async () => {
        const {
            state,
            scope,
        } = createComposable({
            sourceKind: 'djvu',
            sourcePath: '/tmp/source.djvu',
            multiPageTiffSourceKind: 'pdf',
            multiPageTiffSourcePath: '/tmp/tiff-source.pdf',
        });
        exportTiffMock.mockResolvedValue({
            success: true,
            outputPaths: ['/tmp/output.tiff'],
        });

        const exportPromise = state.handleExportMultiPageTiff([1]);
        state.handleExportScopeDialogSubmit({pageNumbers: [1]});
        await exportPromise;

        expect(exportTiffMock).toHaveBeenCalledWith(
            requireDocumentRef('/tmp/tiff-source.pdf'),
            [1],
            expect.any(String),
            'pdf',
        );
        expect(exportTiffMock).not.toHaveBeenCalledWith(
            requireDocumentRef('/tmp/source.djvu'),
            expect.anything(),
            expect.anything(),
            'djvu',
        );
        scope.stop();
    });

    it('refuses an oversized partial compact TIFF selection instead of opening an all-pages dialog', async () => {
        const {
            scope,
            state,
        } = createComposable({totalPages: 200_000});
        const selection = createRangePageSelection(200_000, 2, 100_002);
        const exportPromise = state.handleExportMultiPageTiff(selection);

        try {
            expect(state.exportScopeDialogOpen.value).toBe(false);
            expect(exportTiffMock).not.toHaveBeenCalled();
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'warning',
                title: 'export.selectionTooLarge',
            }));
        } finally {
            scope.stop();
            await exportPromise;
        }
    });

    it('keeps an accepted compact selection intact through dialog setup', async () => {
        const {
            scope,
            state,
        } = createComposable({totalPages: 200_000});
        const selection = createRangePageSelection(200_000, 2, 100_001);
        const exportPromise = state.handleExportImages(selection);

        try {
            expect(state.exportScopeDialogOpen.value).toBe(true);
            expect(state.exportScopeDialogPageSelection.value).toBe(selection);

            state.handleExportScopeDialogOpenChange(false);
            await exportPromise;

            expect(exportImagesMock).not.toHaveBeenCalled();
        } finally {
            scope.stop();
        }
    });

    it('shows a running export card and a temporary success state for image export', async () => {
        vi.useFakeTimers();
        const exportDeferred: { resolve?: (value: {
            success: boolean;
            outputPaths: string[];
        }) => void; } = {};
        exportImagesMock.mockImplementationOnce(() => new Promise((resolve) => {
            exportDeferred.resolve = resolve;
        }));

        const {
            scope,
            state,
        } = createComposable();

        try {
            const exportPromise = state.handleExportImages([
                1,
                2,
                3,
            ]);

            expect(state.exportScopeDialogOpen.value).toBe(true);
            state.handleExportScopeDialogSubmit({pageNumbers: [
                1,
                2,
                3,
            ]});
            await Promise.resolve();

            expect(state.exportOverlay.value).toEqual({
                kind: 'images',
                pageCount: 3,
                state: 'running',
            });

            const resolveExport = exportDeferred.resolve;
            if (!resolveExport) {
                throw new Error('Export promise resolver was not set');
            }

            resolveExport({
                success: true,
                outputPaths: [
                    '/Users/test/Desktop/document-page-001.png',
                    '/Users/test/Desktop/document-page-002.png',
                    '/Users/test/Desktop/document-page-003.png',
                ],
            });
            await exportPromise;

            expect(cleanupFileMock).not.toHaveBeenCalled();
            expect(state.exportOverlay.value).toEqual({
                kind: 'images',
                pageCount: 3,
                state: 'success',
            });

            await vi.advanceTimersByTimeAsync(2200);
            expect(state.exportOverlay.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('cleans up browser output refs after image export', async () => {
        exportImagesMock.mockResolvedValueOnce({
            success: true,
            outputPaths: [
                'browser://documents/output/page-1.png',
                'browser://documents/output/page-2.png',
            ],
        });

        const {
            scope,
            state,
        } = createComposable();

        try {
            const exportPromise = state.handleExportImages([
                1,
                2,
            ]);
            state.handleExportScopeDialogSubmit({pageNumbers: [
                1,
                2,
            ]});
            await exportPromise;

            expect(cleanupFileMock).toHaveBeenCalledTimes(2);
            expect(cleanupFileMock).toHaveBeenCalledWith('browser://documents/output/page-1.png');
            expect(cleanupFileMock).toHaveBeenCalledWith('browser://documents/output/page-2.png');
        } finally {
            scope.stop();
        }
    });

    it('clears the export card when TIFF export is canceled', async () => {
        exportTiffMock.mockResolvedValueOnce({
            success: false,
            canceled: true,
        });

        const {
            scope,
            state,
        } = createComposable();

        try {
            const exportPromise = state.handleExportMultiPageTiff([
                4,
                5,
            ]);

            expect(state.exportScopeDialogOpen.value).toBe(true);
            state.handleExportScopeDialogSubmit({pageNumbers: [
                4,
                5,
            ]});
            await exportPromise;

            expect(state.exportOverlay.value).toBeNull();
            expect(cleanupFileMock).not.toHaveBeenCalled();
        } finally {
            scope.stop();
        }
    });

    it('updates TIFF export progress from matching progress events', async () => {
        const exportDeferred: { resolve?: (value: {
            success: boolean;
            outputPath: string;
        }) => void; } = {};
        exportTiffMock.mockImplementationOnce(() => new Promise((resolve) => {
            exportDeferred.resolve = resolve;
        }));

        const {
            scope,
            state,
        } = createComposable();

        try {
            const exportPromise = state.handleExportMultiPageTiff([
                1,
                2,
            ]);
            state.handleExportScopeDialogSubmit({pageNumbers: [
                1,
                2,
            ]});
            await Promise.resolve();

            const requestId = exportTiffMock.mock.calls[0]?.[2];
            if (typeof requestId !== 'string') {
                throw new Error('Expected export request id');
            }

            progressListeners.forEach((listener) => listener({
                requestId,
                format: 'multipage-tiff',
                phase: 'rendering',
                processed: 1,
                total: 2,
                percent: 45,
            }));

            expect(state.exportOverlay.value).toEqual({
                kind: 'multipage-tiff',
                pageCount: 2,
                progressPercent: 45,
                state: 'running',
            });

            progressListeners.forEach((listener) => listener({
                requestId: 'other-export',
                format: 'multipage-tiff',
                phase: 'rendering',
                processed: 2,
                total: 2,
                percent: 90,
            }));
            expect(state.exportOverlay.value?.progressPercent).toBe(45);

            const resolveExport = exportDeferred.resolve;
            if (!resolveExport) {
                throw new Error('Export promise resolver was not set');
            }
            resolveExport({
                success: true,
                outputPath: '/Users/test/Desktop/document-pages.tiff',
            });
            await exportPromise;

            expect(progressListeners.size).toBe(0);
            expect(state.exportOverlay.value).toEqual({
                kind: 'multipage-tiff',
                pageCount: 2,
                state: 'success',
            });
        } finally {
            scope.stop();
        }
    });

    it('does not cleanup filesystem TIFF export outputs', async () => {
        exportTiffMock.mockResolvedValueOnce({
            success: true,
            outputPath: '/Users/test/Desktop/document-pages.tiff',
        });

        const {
            scope,
            state,
        } = createComposable();

        try {
            const exportPromise = state.handleExportMultiPageTiff([1]);
            state.handleExportScopeDialogSubmit({pageNumbers: [1]});
            await exportPromise;

            expect(cleanupFileMock).not.toHaveBeenCalled();
            expect(state.exportOverlay.value).toEqual({
                kind: 'multipage-tiff',
                pageCount: 1,
                state: 'success',
            });
        } finally {
            scope.stop();
        }
    });

    it('accepts split filesystem TIFF outputs', async () => {
        exportTiffMock.mockResolvedValueOnce({
            success: true,
            outputPaths: [
                '/Users/test/Desktop/document-pages-part-001.tiff',
                '/Users/test/Desktop/document-pages-part-002.tiff',
            ],
        });

        const {
            scope,
            state,
        } = createComposable();

        try {
            const exportPromise = state.handleExportMultiPageTiff([
                1,
                2,
                3,
            ]);
            state.handleExportScopeDialogSubmit({pageNumbers: [
                1,
                2,
                3,
            ]});
            await exportPromise;

            expect(cleanupFileMock).not.toHaveBeenCalled();
            expect(state.exportOverlay.value).toEqual({
                kind: 'multipage-tiff',
                pageCount: 3,
                state: 'success',
            });
        } finally {
            scope.stop();
        }
    });

    it('cleans up browser TIFF output refs', async () => {
        exportTiffMock.mockResolvedValueOnce({
            success: true,
            outputPaths: [
                'browser://documents/output/document-pages-part-001.tiff',
                'browser://documents/output/document-pages-part-002.tiff',
            ],
        });

        const {
            scope,
            state,
        } = createComposable();

        try {
            const exportPromise = state.handleExportMultiPageTiff([1]);
            state.handleExportScopeDialogSubmit({pageNumbers: [1]});
            await exportPromise;

            expect(cleanupFileMock).toHaveBeenCalledTimes(2);
            expect(cleanupFileMock).toHaveBeenCalledWith('browser://documents/output/document-pages-part-001.tiff');
            expect(cleanupFileMock).toHaveBeenCalledWith('browser://documents/output/document-pages-part-002.tiff');
        } finally {
            scope.stop();
        }
    });

    it('shows a toast when TIFF export fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        exportTiffMock.mockRejectedValueOnce(new Error('Multi-page TIFF export exceeds the Classic TIFF 4GB limit'));

        const {
            scope,
            state,
        } = createComposable();

        try {
            const exportPromise = state.handleExportMultiPageTiff([1]);
            state.handleExportScopeDialogSubmit({pageNumbers: [1]});
            await exportPromise;

            expect(state.exportOverlay.value).toBeNull();
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'error',
                title: 'errors.export.multiPageTiff',
                description: expect.stringContaining('Multi-page TIFF export exceeds the Classic TIFF 4GB limit'),
            }));
        } finally {
            scope.stop();
        }
    });

    it('persists pending changes before image export reads the working copy', async () => {
        const ensureWorkingCopyFreshForRead = vi.fn(async () => true);
        exportImagesMock.mockResolvedValueOnce({
            success: true,
            outputPaths: ['/tmp/page-1.png'],
        });

        const {
            scope,
            state,
        } = createComposable({ ensureWorkingCopyFreshForRead });

        try {
            const exportPromise = state.handleExportImages([1]);
            state.handleExportScopeDialogSubmit({pageNumbers: [1]});
            await exportPromise;

            expect(ensureWorkingCopyFreshForRead).toHaveBeenCalledOnce();
            expect(exportImagesMock).toHaveBeenCalledWith('/tmp/work.pdf', [1], expect.any(String), 'pdf');
        } finally {
            scope.stop();
        }
    });

    it('exports DjVu pages directly without trying to persist a PDF working copy', async () => {
        const ensureWorkingCopyFreshForRead = vi.fn(async () => true);
        exportImagesMock.mockResolvedValueOnce({
            success: true,
            outputPaths: ['/tmp/page-1.png'],
        });
        const {
            scope,
            state,
        } = createComposable({
            ensureWorkingCopyFreshForRead,
            sourceKind: 'djvu',
            sourcePath: '/tmp/source.djvu',
        });

        try {
            const exportPromise = state.handleExportImages([1]);
            state.handleExportScopeDialogSubmit({pageNumbers: [1]});
            await exportPromise;

            expect(ensureWorkingCopyFreshForRead).not.toHaveBeenCalled();
            expect(exportImagesMock).toHaveBeenCalledWith('/tmp/source.djvu', [1], expect.any(String), 'djvu');
        } finally {
            scope.stop();
        }
    });

    it('exports a multi-page TIFF directly from the DjVu source', async () => {
        exportTiffMock.mockResolvedValueOnce({
            success: true,
            outputPath: '/tmp/pages.tiff',
        });
        const {
            scope,
            state,
        } = createComposable({
            sourceKind: 'djvu',
            sourcePath: '/tmp/source.djvu',
        });

        try {
            const exportPromise = state.handleExportMultiPageTiff([
                1,
                3,
            ]);
            state.handleExportScopeDialogSubmit({pageNumbers: [
                1,
                3,
            ]});
            await exportPromise;

            expect(exportTiffMock).toHaveBeenCalledWith(
                '/tmp/source.djvu',
                [
                    1,
                    3,
                ],
                expect.any(String),
                'djvu',
            );
        } finally {
            scope.stop();
        }
    });

    it('holds the document-operation lease for the complete image export', async () => {
        const exportResult = Promise.withResolvers<{
            success: boolean;
            outputPaths: string[];
        }>();
        exportImagesMock.mockReturnValue(exportResult.promise);
        let leaseActive = false;
        const leaseCall = vi.fn();
        const runWithDocumentOperationLease = async <T>(
            kind: TDocumentOperationKind,
            operation: () => Promise<T>,
        ) => {
            leaseCall(kind);
            expect(kind).toBe('raster-export');
            leaseActive = true;
            try {
                return await operation();
            } finally {
                leaseActive = false;
            }
        };
        const {
            scope,
            state,
        } = createComposable({runWithDocumentOperationLease});

        try {
            const exportPromise = state.handleExportImages([1]);
            state.handleExportScopeDialogSubmit({pageNumbers: [1]});
            await Promise.resolve();
            await Promise.resolve();

            expect(leaseActive).toBe(true);
            expect(exportImagesMock).toHaveBeenCalledOnce();
            exportResult.resolve({
                success: true,
                outputPaths: ['/tmp/page-1.png'],
            });
            await exportPromise;

            expect(leaseActive).toBe(false);
            expect(leaseCall).toHaveBeenCalledOnce();
        } finally {
            scope.stop();
        }
    });

    it('fences a deferred image export result after document identity changes', async () => {
        const exportResult = Promise.withResolvers<{
            success: boolean;
            outputPaths: string[];
        }>();
        exportImagesMock.mockReturnValue(exportResult.promise);
        const {
            scope,
            sourcePath,
            state,
        } = createComposable();

        try {
            const exportPromise = state.handleExportImages([1]);
            state.handleExportScopeDialogSubmit({pageNumbers: [1]});
            await Promise.resolve();
            await Promise.resolve();
            expect(state.exportOverlay.value?.state).toBe('running');

            sourcePath.value = requireDocumentRef('/tmp/replacement.pdf');
            exportResult.resolve({
                success: true,
                outputPaths: ['browser://documents/output/stale.png'],
            });
            await exportPromise;

            expect(cleanupFileMock).toHaveBeenCalledWith('browser://documents/output/stale.png');
            expect(state.exportOverlay.value).toBeNull();
            expect(trackMock).not.toHaveBeenCalledWith('export_completed', expect.anything());
        } finally {
            scope.stop();
        }
    });

    it('does not mix a source kind changed while freshness is deferred', async () => {
        const freshness = Promise.withResolvers<boolean>();
        const {
            scope,
            sourceKind,
            sourcePath,
            state,
        } = createComposable({ensureWorkingCopyFreshForRead: () => freshness.promise});

        try {
            const exportPromise = state.handleExportImages([1]);
            state.handleExportScopeDialogSubmit({pageNumbers: [1]});
            await Promise.resolve();
            await Promise.resolve();

            sourceKind.value = 'djvu';
            sourcePath.value = requireDocumentRef('/tmp/replacement.djvu');
            freshness.resolve(true);
            await exportPromise;

            expect(exportImagesMock).not.toHaveBeenCalled();
            expect(state.exportOverlay.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('cancels image export when pending changes cannot be persisted', async () => {
        const ensureWorkingCopyFreshForRead = vi.fn(async () => false);

        const {
            scope,
            state,
        } = createComposable({ ensureWorkingCopyFreshForRead });

        try {
            const exportPromise = state.handleExportImages([1]);
            state.handleExportScopeDialogSubmit({pageNumbers: [1]});
            await exportPromise;

            expect(ensureWorkingCopyFreshForRead).toHaveBeenCalledOnce();
            expect(exportImagesMock).not.toHaveBeenCalled();
            expect(state.exportOverlay.value).toBeNull();
            expect(toastAddMock).not.toHaveBeenCalledWith(expect.objectContaining({color: 'error'}));
        } finally {
            scope.stop();
        }
    });

    it('does not add a second red export error when pending changes cannot be persisted', async () => {
        const ensureWorkingCopyFreshForRead = vi.fn(async () => false);

        const {
            scope,
            state,
        } = createComposable({ ensureWorkingCopyFreshForRead });

        try {
            const exportPromise = state.handleExportMultiPageTiff([1]);
            state.handleExportScopeDialogSubmit({pageNumbers: [1]});
            await exportPromise;

            expect(ensureWorkingCopyFreshForRead).toHaveBeenCalledOnce();
            expect(exportTiffMock).not.toHaveBeenCalled();
            expect(state.exportOverlay.value).toBeNull();
            expect(toastAddMock).not.toHaveBeenCalledWith(expect.objectContaining({color: 'error'}));
        } finally {
            scope.stop();
        }
    });
});
