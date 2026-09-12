import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { TRegisteredHandler } from '@tests/unit/electron/helpers/ipcRegistryHarness';
import type * as FsPromisesModule from 'fs/promises';
import { IMAGE_EXPORT_PLATFORM_FEATURE } from '@contracts/imageExportPlatformFeature';
import { registerPlatformFeatureHandlers } from '@electron/platform-ipc/validatedIpcRegistrar';
import {
    createDeferred,
    createTestEventSender,
    type ITestEventSender,
} from '@tests/helpers/electronEventEmitterHarness';

const mocks = vi.hoisted(() => ({
    backingState: 'eager' as 'eager' | 'lazy-original',
    captureWorkingCopyAdmissionSnapshot: vi.fn(async (_path: string) => ({
        mtimeNs: 2n,
        size: 1024n,
    })),
    ensureWorkingCopyDirectory: vi.fn(async () => true),
    existsSync: vi.fn(() => true),
    exportPdfAsMultiPageTiff: vi.fn(),
    exportPdfPagesAsImages: vi.fn(),
    exportDjvuPagesAsImages: vi.fn(),
    exportDjvuAsMultiPageTiff: vi.fn(),
    fromWebContents: vi.fn(() => null),
    getPdfPageCount: vi.fn(async () => 10),
    normalizeImageExportPath: vi.fn((path: string) => ({ normalizedPath: path })),
    rm: vi.fn(async () => undefined),
    resolveAllowedWritePath: vi.fn(async (path: string) => path),
    transitionWorkingCopyBackingState: vi.fn(),
    showSaveDialog: vi.fn(async (..._args: unknown[]) => ({
        canceled: false,
        filePath: '/tmp/export.jpg',
    })),
}));

vi.mock('electron', () => ({
    app: {isPackaged: false},
    BrowserWindow: { fromWebContents: mocks.fromWebContents },
    dialog: { showSaveDialog: mocks.showSaveDialog },
}));

vi.mock('fs', () => ({ existsSync: mocks.existsSync }));

vi.mock('fs/promises', async (importOriginal) => ({
    ...(await importOriginal<typeof FsPromisesModule>()),
    rm: mocks.rm,
}));

vi.mock('@electron/file-access/workingCopyCreation', () => ({ ensureWorkingCopyDirectory: mocks.ensureWorkingCopyDirectory }));

vi.mock('@electron/utils/pathValidator', () => ({ resolveAllowedWritePath: mocks.resolveAllowedWritePath }));
vi.mock('@electron/file-access/workingCopyStore', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule>()),
    captureWorkingCopyAdmissionSnapshot: (path: string) =>
        mocks.captureWorkingCopyAdmissionSnapshot(path),
    getWorkingCopyBackingEntry: (path: string, senderId?: number) => ({
        admissionSnapshot: {
            mtimeNs: 2n,
            size: 1024n,
        },
        backingState: mocks.backingState,
        originalPath: '/original/source.pdf',
        ownerWebContentsId: senderId,
        registeredAtMs: 1,
        registrationId: 9,
        role: 'current',
    }),
    runWithWorkingCopyRegistrationFence: async (
        _path: string,
        _registrationId: number,
        operation: (entry: Record<string, unknown>) => Promise<unknown>,
    ) => ({
        matched: true,
        value: await operation({
            admissionSnapshot: {
                mtimeNs: 2n,
                size: 1024n,
            },
            backingState: mocks.backingState,
            originalPath: '/original/source.pdf',
            registeredAtMs: 1,
            registrationId: 9,
            role: 'current',
        }),
    }),
    transitionWorkingCopyBackingState: (...args: unknown[]) =>
        mocks.transitionWorkingCopyBackingState(...args),
    workingCopyAdmissionSnapshotsMatch: (
        left: {
            mtimeNs: bigint;
            size: bigint
        },
        right: {
            mtimeNs: bigint;
            size: bigint
        },
    ) => left.mtimeNs === right.mtimeNs && left.size === right.size,
}));
vi.mock('@electron/file-access/workingCopyMaterialization', () => ({WorkingCopyMaterializationError: class WorkingCopyMaterializationError extends Error {
    public readonly code: string;

    public constructor(code: string, message: string) {
        super(message);
        this.code = code;
    }
}}));

vi.mock('@electron/features/image-export/main/export', () => ({
    exportPdfAsMultiPageTiff: mocks.exportPdfAsMultiPageTiff,
    exportPdfPagesAsImages: mocks.exportPdfPagesAsImages,
    getPdfPageCount: mocks.getPdfPageCount,
    normalizeImageExportPath: mocks.normalizeImageExportPath,
}));
vi.mock('@electron/features/image-export/main/djvuImageExport', () => ({
    exportDjvuPagesAsImages: mocks.exportDjvuPagesAsImages,
    exportDjvuAsMultiPageTiff: mocks.exportDjvuAsMultiPageTiff,
}));

vi.mock('@electron/te', () => ({ te: (key: string) => key }));

const {
    handlePdfExportImages,
    handlePdfExportMultiPageTiff,
    imageExportMainBindings,
} = await import('@electron/features/image-export/main/ipc');
const IMAGE_EXPORT_CHANNELS = IMAGE_EXPORT_PLATFORM_FEATURE.invokeChannels;

function registerImageExportHandlers(registrar: {handle: (channel: string, handler: TRegisteredHandler) => void;}) {
    registerPlatformFeatureHandlers(
        registrar as never,
        IMAGE_EXPORT_PLATFORM_FEATURE,
        imageExportMainBindings,
    );
}

interface ITestProgressPayload {
    phase: 'rendering' | 'combining';
    processed: number;
    total: number;
    percent: number;
}

interface ITestProgressOptions { onProgress?: (progress: ITestProgressPayload) => void; }

let nextSenderId = 7;

function createSender() {
    return createTestEventSender(nextSenderId++);
}

function createContext(sender: ITestEventSender) {
    return {
        sender: sender as never,
        senderId: sender.id,
        parentWindow: null,
    };
}

function createIpcEvent(sender: ITestEventSender) {
    return {sender: sender as never};
}

function triggerRenderProcessGone(sender: ITestEventSender) {
    sender.emit('render-process-gone');
}

function triggerMainFrameNavigation(sender: ITestEventSender) {
    sender.emit('did-start-navigation', {}, 'app://reload', false, true);
}

describe('image export IPC lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.backingState = 'eager';
        mocks.captureWorkingCopyAdmissionSnapshot.mockResolvedValue({
            mtimeNs: 2n,
            size: 1024n,
        });
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        mocks.existsSync.mockReturnValue(true);
        mocks.resolveAllowedWritePath.mockImplementation(async (path: string) => path);
        mocks.getPdfPageCount.mockResolvedValue(10);
        mocks.showSaveDialog.mockResolvedValue({
            canceled: false,
            filePath: '/tmp/export.jpg',
        });
        mocks.normalizeImageExportPath.mockImplementation((
            path: string,
            fallbackFormat = 'png',
        ) => {
            const normalizedPath = path.includes('.') ? path : `${path}.${fallbackFormat === 'jpeg' ? 'jpg' : fallbackFormat}`;
            const extension = normalizedPath.split('.').pop()?.toLowerCase();
            return {
                normalizedPath,
                format: extension === 'jpg' || extension === 'jpeg'
                    ? 'jpeg'
                    : extension === 'tif' || extension === 'tiff' ? 'tiff' : 'png',
            };
        });
        mocks.exportPdfPagesAsImages.mockResolvedValue(['/tmp/export.jpg']);
        mocks.exportPdfAsMultiPageTiff.mockResolvedValue(['/tmp/export.tiff']);
        mocks.exportDjvuPagesAsImages.mockResolvedValue(['/tmp/export.jpg']);
        mocks.exportDjvuAsMultiPageTiff.mockResolvedValue(['/tmp/export.tiff']);
    });

    it('defaults page image export to JPEG while offering PNG and TIFF choices', async () => {
        const sender = createSender();

        await expect(handlePdfExportImages(
            createContext(sender),
            '/tmp/working.pdf',
            [7],
        )).resolves.toEqual({
            success: true,
            outputPaths: ['/tmp/export.jpg'],
        });

        const dialogOptions = mocks.showSaveDialog.mock.calls[0]?.[0];
        expect(dialogOptions).toEqual(expect.objectContaining({
            title: 'dialogs.exportImages',
            defaultPath: 'document-page-007.jpg',
            filters: [
                {
                    name: 'dialogs.jpegImages',
                    extensions: [
                        'jpg',
                        'jpeg',
                    ],
                },
                {
                    name: 'dialogs.pngImages',
                    extensions: ['png'],
                },
                {
                    name: 'dialogs.tiffImages',
                    extensions: [
                        'tif',
                        'tiff',
                    ],
                },
            ],
        }));
        expect(mocks.normalizeImageExportPath).toHaveBeenCalledWith('/tmp/export.jpg', 'jpeg');
    });

    it('uses a JPEG fallback when the image export target has no extension', async () => {
        const sender = createSender();
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/export',
        });
        mocks.exportPdfPagesAsImages.mockResolvedValueOnce(['/tmp/export.jpg']);

        await expect(handlePdfExportImages(
            createContext(sender),
            '/tmp/working.pdf',
        )).resolves.toEqual({
            success: true,
            outputPaths: ['/tmp/export.jpg'],
        });

        expect(mocks.normalizeImageExportPath).toHaveBeenCalledWith('/tmp/export', 'jpeg');
        expect(mocks.exportPdfPagesAsImages).toHaveBeenCalledWith(
            '/tmp/working.pdf',
            '/tmp/export.jpg',
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(mocks.captureWorkingCopyAdmissionSnapshot).not.toHaveBeenCalled();
    });

    it('pins lazy-original image export to witnessed source bytes', async () => {
        const sender = createSender();
        mocks.backingState = 'lazy-original';

        await expect(handlePdfExportImages(
            createContext(sender),
            '/tmp/working.pdf',
            [2],
        )).resolves.toEqual({
            success: true,
            outputPaths: ['/tmp/export.jpg'],
        });

        expect(mocks.getPdfPageCount).toHaveBeenCalledWith(
            '/original/source.pdf',
            expect.objectContaining({signal: expect.any(AbortSignal)}),
        );
        expect(mocks.exportPdfPagesAsImages).toHaveBeenCalledWith(
            '/original/source.pdf',
            '/tmp/export.jpg',
            expect.objectContaining({
                beforePublish: expect.any(Function),
                signal: expect.any(AbortSignal),
            }),
        );
        expect(mocks.captureWorkingCopyAdmissionSnapshot).toHaveBeenCalledTimes(4);
    });

    it('routes DjVu image export through the source raster provider', async () => {
        const sender = createSender();
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/export',
        });

        await expect(handlePdfExportImages(
            createContext(sender),
            '/tmp/working.djvu',
            [2],
            'djvu-export-request',
            'djvu',
        )).resolves.toEqual({
            success: true,
            outputPaths: ['/tmp/export.jpg'],
        });

        expect(mocks.exportDjvuPagesAsImages).toHaveBeenCalledWith(
            '/tmp/working.djvu',
            '/tmp/export.jpg',
            expect.objectContaining({
                pageNumbers: [2],
                format: 'jpeg',
                signal: expect.any(AbortSignal),
            }),
        );
        expect(mocks.exportPdfPagesAsImages).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: 'malformed page numbers',
            pageCount: 10,
            pages: [
                1,
                '2' as never,
            ],
            error: 'Invalid page number at index 1',
        },
        {
            name: 'duplicate page numbers',
            pageCount: 10,
            pages: [
                2,
                2,
            ],
            error: 'Duplicate page number: 2',
        },
        {
            name: 'page numbers beyond the document',
            pageCount: 3,
            pages: [4],
            error: 'Page number 4 exceeds PDF page count (3)',
        },
    ])('rejects $name before opening an image export dialog', async ({
        error,
        pageCount,
        pages,
    }) => {
        const sender = createSender();
        mocks.getPdfPageCount.mockReset().mockResolvedValue(pageCount);

        await expect(handlePdfExportImages(
            createContext(sender),
            '/tmp/working.pdf',
            pages,
        )).rejects.toThrow(error);

        expect(mocks.showSaveDialog).not.toHaveBeenCalled();
        expect(mocks.exportPdfPagesAsImages).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: 'crashes',
            endLifecycle: triggerRenderProcessGone,
        },
        {
            name: 'navigates its main frame',
            endLifecycle: triggerMainFrameNavigation,
        },
    ])('aborts page image export when the owning renderer $name', async ({endLifecycle}) => {
        const sender = createSender();
        const exportState: {signal: AbortSignal | undefined} = { signal: undefined };
        mocks.exportPdfPagesAsImages.mockImplementation(async (
            _sourcePath: string,
            _outputPath: string,
            options: { signal?: AbortSignal },
        ) => {
            exportState.signal = options.signal;
            return new Promise<string[]>((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => {
                    reject(new Error('Renderer lifecycle ended'));
                }, { once: true });
            });
        });

        const resultPromise = handlePdfExportImages(
            createContext(sender),
            '/tmp/working.pdf',
            [1],
        );

        await vi.waitFor(() => {
            expect(mocks.exportPdfPagesAsImages).toHaveBeenCalledOnce();
        });
        endLifecycle(sender);

        await expect(resultPromise).resolves.toEqual({
            success: false,
            canceled: true,
        });
        expect(exportState.signal?.aborted).toBe(true);
    });

    it('returns every split multi-page TIFF output path', async () => {
        const sender = createSender();
        mocks.backingState = 'lazy-original';
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/export.tiff',
        });
        mocks.exportPdfAsMultiPageTiff.mockResolvedValueOnce([
            '/tmp/export-part-001.tiff',
            '/tmp/export-part-002.tiff',
        ]);

        await expect(handlePdfExportMultiPageTiff(
            createContext(sender),
            '/tmp/working.pdf',
        )).resolves.toEqual({
            success: true,
            outputPath: '/tmp/export-part-001.tiff',
            outputPaths: [
                '/tmp/export-part-001.tiff',
                '/tmp/export-part-002.tiff',
            ],
        });
        expect(mocks.exportPdfAsMultiPageTiff).toHaveBeenCalledWith(
            '/original/source.pdf',
            '/tmp/export.tiff',
            expect.objectContaining({beforePublish: expect.any(Function)}),
        );
    });

    it('does not delete image outputs when the source changes after export', async () => {
        const sender = createSender();
        mocks.backingState = 'lazy-original';
        mocks.captureWorkingCopyAdmissionSnapshot
            .mockReset()
            .mockResolvedValueOnce({
                mtimeNs: 2n,
                size: 1024n,
            })
            .mockResolvedValueOnce({
                mtimeNs: 2n,
                size: 1024n,
            })
            .mockResolvedValueOnce({
                mtimeNs: 2n,
                size: 1024n,
            })
            .mockResolvedValueOnce({
                mtimeNs: 3n,
                size: 1024n,
            });

        await expect(handlePdfExportImages(
            createContext(sender),
            '/tmp/working.pdf',
            [1],
        )).rejects.toThrow('The original document changed while it was being read');

        expect(mocks.rm).not.toHaveBeenCalled();
    });

    it('replays active image-export progress when the renderer subscribes after progress starts', async () => {
        const handlers = new Map<string, TRegisteredHandler>();
        registerImageExportHandlers({handle: (channel, handler) => handlers.set(channel, handler)});
        const sender = createSender();
        const exportDeferred = createDeferred<string[]>();
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/export.tiff',
        });
        mocks.exportPdfAsMultiPageTiff.mockImplementationOnce(async (
            _sourcePath: string,
            outputPath: string,
            options: ITestProgressOptions,
        ) => {
            options.onProgress?.({
                phase: 'rendering',
                processed: 3,
                total: 10,
                percent: 30,
            });
            return exportDeferred.promise.then(() => [outputPath]);
        });

        const exportPromise = handlers.get(IMAGE_EXPORT_CHANNELS.exportPdfToMultiPageTiff)!(
            createIpcEvent(sender),
            '/tmp/working.pdf',
            undefined,
            'export-subscribe-active',
        );
        await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith('pdfExport:progress', {
            requestId: 'export-subscribe-active',
            format: 'multipage-tiff',
            phase: 'rendering',
            processed: 3,
            total: 10,
            percent: 30,
            status: 'running',
        }));

        sender.send.mockClear();
        handlers.get(IMAGE_EXPORT_CHANNELS.subscribeProgress)!(createIpcEvent(sender));

        expect(sender.send).toHaveBeenCalledWith('pdfExport:progress', {
            requestId: 'export-subscribe-active',
            format: 'multipage-tiff',
            phase: 'rendering',
            processed: 3,
            total: 10,
            percent: 30,
            status: 'running',
        });
        exportDeferred.resolve(['/tmp/export.tiff']);
        await exportPromise;
    });

    it('replays terminal image-export progress when the renderer subscribes shortly after completion', async () => {
        const handlers = new Map<string, TRegisteredHandler>();
        registerImageExportHandlers({handle: (channel, handler) => handlers.set(channel, handler)});
        const sender = createSender();
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/export.tiff',
        });
        mocks.exportPdfAsMultiPageTiff.mockImplementationOnce(async (
            _sourcePath: string,
            outputPath: string,
            options: ITestProgressOptions,
        ) => {
            options.onProgress?.({
                phase: 'combining',
                processed: 10,
                total: 10,
                percent: 100,
            });
            return [outputPath];
        });

        await handlers.get(IMAGE_EXPORT_CHANNELS.exportPdfToMultiPageTiff)!(
            createIpcEvent(sender),
            '/tmp/working.pdf',
            undefined,
            'export-subscribe-terminal',
        );
        sender.send.mockClear();
        handlers.get(IMAGE_EXPORT_CHANNELS.subscribeProgress)!(createIpcEvent(sender));

        expect(sender.send).toHaveBeenCalledWith('pdfExport:progress', {
            requestId: 'export-subscribe-terminal',
            format: 'multipage-tiff',
            phase: 'combining',
            processed: 10,
            total: 10,
            percent: 100,
            status: 'success',
        });
    });

    it('delivers one failed terminal when export throws before progress', async () => {
        const sender = createSender();
        mocks.exportPdfPagesAsImages.mockRejectedValueOnce(new Error('render failed'));

        await expect(handlePdfExportImages(
            createContext(sender),
            '/tmp/working.pdf',
            undefined,
            'export-failed',
        )).rejects.toThrow('render failed');

        expect(sender.send.mock.calls.filter(([
            , progress,
        ]) => (
            progress as {status?: string}
        ).status === 'failed')).toEqual([[
            'pdfExport:progress',
            expect.objectContaining({
                requestId: 'export-failed',
                status: 'failed',
                error: 'render failed',
            }),
        ]]);
    });

    it('never deletes page images the exporter already wrote to the chosen folder', async () => {
        const sender = createSender();
        const oversizedOutputPaths = Array.from(
            {length: 100_001},
            (_unused, index) => `/tmp/export-${index}.jpg`,
        );
        mocks.exportPdfPagesAsImages.mockResolvedValueOnce(oversizedOutputPaths);

        await expect(handlePdfExportImages(
            createContext(sender),
            '/tmp/working.pdf',
            [1],
        )).resolves.toEqual({
            success: true,
            outputPaths: oversizedOutputPaths,
        });
        expect(mocks.rm).not.toHaveBeenCalled();
    });

    it('never deletes multi-page TIFF parts the exporter already wrote', async () => {
        const sender = createSender();
        const oversizedParts = Array.from({length: 100_001}, (_unused, index) => `/tmp/export-part-${String(index + 1).padStart(3, '0')}.tiff`);
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/export.tiff',
        });
        mocks.exportPdfAsMultiPageTiff.mockResolvedValueOnce(oversizedParts);

        await expect(handlePdfExportMultiPageTiff(
            createContext(sender),
            '/tmp/working.pdf',
        )).resolves.toMatchObject({success: true});
        expect(mocks.rm).not.toHaveBeenCalled();
    });

    it('still returns output paths for a page image export at the output-path budget boundary', async () => {
        const sender = createSender();
        const boundaryOutputPaths = Array.from({length: 100_000}, (_unused, index) => `/tmp/export-${index}.jpg`);
        mocks.exportPdfPagesAsImages.mockResolvedValueOnce(boundaryOutputPaths);

        await expect(handlePdfExportImages(
            createContext(sender),
            '/tmp/working.pdf',
            [1],
        )).resolves.toEqual({
            success: true,
            outputPaths: boundaryOutputPaths,
        });
        expect(mocks.rm).not.toHaveBeenCalled();
    });

    it('rejects oversized image export progress request ids before opening a save dialog', async () => {
        const sender = createSender();
        const oversizedRequestId = 'x'.repeat(129);

        await expect(handlePdfExportMultiPageTiff(
            createContext(sender),
            '/tmp/working.pdf',
            undefined,
            oversizedRequestId,
        )).rejects.toThrow('requestId exceeds maximum length (128)');

        expect(mocks.showSaveDialog).not.toHaveBeenCalled();
        expect(mocks.ensureWorkingCopyDirectory).not.toHaveBeenCalled();
        expect(mocks.exportPdfAsMultiPageTiff).not.toHaveBeenCalled();
    });
});
