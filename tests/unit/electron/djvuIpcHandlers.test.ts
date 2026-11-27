import type * as TDdjvuConversionModule from '@electron/features/djvu/main/ddjvuConversion';
import type * as TEmbedBookmarksModule from '@electron/features/djvu/main/embedBookmarksIntoPdfFile';
import type * as TPagePreviewModule from '@electron/features/djvu/main/pagePreview';
import type * as TPdfExportModule from '@electron/features/djvu/main/pdfExport';
import type * as TViewingModule from '@electron/features/djvu/main/viewing';

import type {TRegisteredHandler} from '@tests/unit/electron/helpers/ipcRegistryHarness';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {resolve} from 'node:path';
import {DJVU_PLATFORM_FEATURE} from '@contracts/djvuPlatformFeature';
import {createAbortError} from '@electron/utils/abort';
import {getUnprovenNativeTerminationDetail, markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';
import {requireJobId, requireRequestId} from '@contracts/shared';
import * as v from 'valibot';
import {registerPlatformFeatureHandlers} from '@electron/platform-ipc/validatedIpcRegistrar';
import {createDeferred, createTestEventSender} from '@tests/helpers/electronEventEmitterHarness';

const mocks = vi.hoisted(() => ({
    handlers: new Map<string, TRegisteredHandler>(),
    ipcHandle: vi.fn<(channel: string, handler: TRegisteredHandler) => void>(),
    estimateSizes: vi.fn(),
    getDjvuPageCount: vi.fn(),
    getDjvuResolution: vi.fn(),
    getDjvuOutlineBookmarks: vi.fn(),
    getDjvuPageComponentMap: vi.fn(),
    getDjvuHasText: vi.fn(),
    getDjvuMetadata: vi.fn(),
    handleDjvuConvertToPdf: vi.fn(),
    handleDjvuCancel: vi.fn(),
    handleDjvuOpenForViewing: vi.fn(),
    getDjvuOutputJobState: vi.fn(),
    subscribeDjvuProgress: vi.fn(),
    cancelConversion: vi.fn(),
    convertDjvuToPdfFile: vi.fn(),
    withDjvuNativeResourceLease: vi.fn(),
    buildCompactDjvuAwarePdfFromDjvu: vi.fn(),
    detectDjvuHasText: vi.fn(),
    isAllowedDjvuViewingPath: vi.fn(),
    getDjvuPageSizesForViewing: vi.fn(),
    getDjvuPageSourceInfoForViewing: vi.fn(),
    renderDjvuPagePreview: vi.fn(),
    releaseDjvuViewingPath: vi.fn(),
    cleanupDjvuTempPdfPath: vi.fn(),
    pruneStaleDjvuArtifactJobs: vi.fn(),
    getRecentFiles: vi.fn(),
    readDjvuPageText: vi.fn(),
    safeSendToWindow: vi.fn(),
    senderSend: vi.fn(),
    hostResourceTier: 'high' as 'low' | 'medium' | 'high',
    embedBookmarksIntoPdfFile: null as
        | ((
              ...args: Parameters<typeof TEmbedBookmarksModule.embedBookmarksIntoPdfFile>
          ) => ReturnType<typeof TEmbedBookmarksModule.embedBookmarksIntoPdfFile>)
        | null,
}));

vi.mock('electron', () => ({
    app: {
        isPackaged: false,
        getPath: vi.fn(() => '/tmp'),
    },
    BrowserWindow: {fromWebContents: vi.fn(() => null)},
    ipcMain: {
        handle: (channel: string, handler: TRegisteredHandler) => {
            mocks.ipcHandle(channel, handler);
            mocks.handlers.set(channel, handler);
        },
    },
}));

vi.mock('@electron/features/djvu/main/estimateSizes', () => ({estimateSizes: mocks.estimateSizes}));
vi.mock('@electron/features/djvu/main/metadata', () => ({
    getDjvuPageCount: mocks.getDjvuPageCount,
    getDjvuResolution: mocks.getDjvuResolution,
    getDjvuOutlineBookmarks: mocks.getDjvuOutlineBookmarks,
    getDjvuPageComponentMap: mocks.getDjvuPageComponentMap,
    getDjvuHasText: mocks.getDjvuHasText,
    getDjvuMetadata: mocks.getDjvuMetadata,
}));
vi.mock('@electron/features/djvu/main/pdfExport', () => ({
    handleDjvuConvertToPdf: mocks.handleDjvuConvertToPdf,
    handleDjvuCancel: mocks.handleDjvuCancel,
    getDjvuOutputJobState: mocks.getDjvuOutputJobState,
    subscribeDjvuProgress: mocks.subscribeDjvuProgress,
}));
vi.mock('@electron/features/djvu/main/viewing', async (importOriginal) => ({
    ...(await importOriginal<typeof TViewingModule>()),
    handleDjvuOpenForViewing: mocks.handleDjvuOpenForViewing,
    isAllowedDjvuViewingPath: mocks.isAllowedDjvuViewingPath,
    releaseDjvuViewingPath: mocks.releaseDjvuViewingPath,
    cleanupDjvuTempPdfPath: mocks.cleanupDjvuTempPdfPath,
}));
vi.mock('@electron/features/djvu/main/djvuArtifactManifest', () => ({pruneStaleDjvuArtifactJobs: mocks.pruneStaleDjvuArtifactJobs}));
vi.mock('@electron/recentFiles', () => ({getRecentFiles: mocks.getRecentFiles}));
vi.mock('@electron/features/djvu/main/pagePreview', () => ({
    DJVU_PAGE_SIZE_ARRAY_MAX_PAGES: 10_000,
    getDjvuPageSourceInfoForViewing: mocks.getDjvuPageSourceInfoForViewing,
    getDjvuPageSizesForViewing: mocks.getDjvuPageSizesForViewing,
    renderDjvuPagePreview: mocks.renderDjvuPagePreview,
}));
vi.mock('@electron/features/djvu/main/ddjvuConversion', () => ({
    cancelConversion: mocks.cancelConversion,
    convertDjvuToPdfFile: mocks.convertDjvuToPdfFile,
    withDjvuNativeResourceLease: mocks.withDjvuNativeResourceLease,
}));
vi.mock('@electron/features/djvu/main/buildCompactDjvuAwarePdfFromDjvu', () => ({
    buildCompactDjvuAwarePdfFromDjvu: mocks.buildCompactDjvuAwarePdfFromDjvu,
}));
vi.mock('@electron/features/djvu/main/textSearch', () => ({
    detectDjvuHasText: mocks.detectDjvuHasText,
    readDjvuPageText: mocks.readDjvuPageText,
}));
vi.mock('@electron/features/djvu/main/safeSendToWindow', () => ({safeSendToWindow: mocks.safeSendToWindow}));
vi.mock('@electron/resources/hostResourceProfile', () => ({
    getHostResourceProfileSnapshot: () => ({
        logicalCpus: 8,
        totalRamBytes: 16 * 1024 * 1024 * 1024,
        safeMode: false,
        detectedTier: mocks.hostResourceTier,
        performanceMode: 'auto',
        tier: mocks.hostResourceTier,
    }),
}));
vi.mock('@electron/features/djvu/main/embedBookmarksIntoPdfFile', async (importOriginal) => {
    const actual = await importOriginal<typeof TEmbedBookmarksModule>();
    return {
        ...actual,
        embedBookmarksIntoPdfFile: (...args: Parameters<typeof TEmbedBookmarksModule.embedBookmarksIntoPdfFile>) =>
            (mocks.embedBookmarksIntoPdfFile ?? actual.embedBookmarksIntoPdfFile)(...args),
    };
});

vi.mock('@electron/utils/createLogger', () => ({
    createLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }),
}));
const {handleDjvuGetPageSourceInfo, handleDjvuRenderPagePreview, resolveDjvuPreviewBrokerPriority} =
    await import('@electron/features/djvu/main/djvuOperations');
const {default: prepareDjvuMainBindings} = await import('@electron/features/djvu/mainBindings');
const {configureMainJobBroker, mainJobBroker} = await import('@electron/resources/jobBroker');

function registerDjvuIpcAdapter() {
    registerPlatformFeatureHandlers(
        {
            handle: (channel: string, handler: TRegisteredHandler) => {
                mocks.ipcHandle(channel, handler);
                mocks.handlers.set(channel, handler);
            },
        } as never,
        DJVU_PLATFORM_FEATURE,
        prepareDjvuMainBindings(),
    );
}

configureMainJobBroker({
    logicalCpus: 8,
    totalRamBytes: 16 * 1024 * 1024 * 1024,
    safeMode: false,
    detectedTier: 'high',
    performanceMode: 'auto',
    tier: 'high',
});

function createIpcEvent(senderId: number) {
    return {sender: createTestEventSender(senderId, mocks.senderSend)};
}

function getHandler(channel: string) {
    const handler = mocks.handlers.get(channel);
    if (!handler) {
        throw new Error(`IPC handler is not registered for channel "${channel}"`);
    }
    return handler;
}

interface IPreviewResult {
    bytes: Uint8Array;
    width: number;
    height: number;
}

function createPendingPreviews(count: number) {
    const previews = Array.from({length: count}, () => createDeferred<IPreviewResult>());
    previews.forEach((preview) => mocks.renderDjvuPagePreview.mockReturnValueOnce(preview.promise));
    return previews;
}

function resolvePreview(preview: ReturnType<typeof createDeferred<IPreviewResult>>, byte: number) {
    preview.resolve({
        bytes: new Uint8Array([byte]),
        width: 100,
        height: 200,
    });
}

describe('registerDjvuIpcAdapter', () => {
    it('prioritizes visible page previews ahead of nearby and background work', () => {
        expect(resolveDjvuPreviewBrokerPriority(100)).toBe('visible');
        expect(resolveDjvuPreviewBrokerPriority(90)).toBe('visible');
        expect(resolveDjvuPreviewBrokerPriority(50)).toBe('foreground');
        expect(resolveDjvuPreviewBrokerPriority(20)).toBe('user');
        expect(resolveDjvuPreviewBrokerPriority(10)).toBe('background');
    });

    beforeEach(() => {
        mocks.handlers.clear();
        vi.clearAllMocks();
        mocks.hostResourceTier = 'high';
        mocks.embedBookmarksIntoPdfFile = null;

        mocks.getDjvuPageCount.mockResolvedValue(1);
        mocks.getDjvuResolution.mockResolvedValue(300);
        mocks.getDjvuOutlineBookmarks.mockResolvedValue([]);
        mocks.getDjvuPageComponentMap.mockResolvedValue(new Map());
        mocks.getDjvuHasText.mockResolvedValue(true);
        mocks.getDjvuMetadata.mockResolvedValue({});
        mocks.readDjvuPageText.mockResolvedValue('');
        mocks.estimateSizes.mockReturnValue([]);
        mocks.handleDjvuConvertToPdf.mockResolvedValue({success: true});
        mocks.handleDjvuCancel.mockResolvedValue({canceled: true});
        mocks.handleDjvuOpenForViewing.mockResolvedValue({success: true});
        mocks.cancelConversion.mockResolvedValue(true);
        mocks.convertDjvuToPdfFile.mockReset();
        mocks.withDjvuNativeResourceLease.mockImplementation(async (options: {task: () => Promise<unknown>}) => options.task());
        mocks.isAllowedDjvuViewingPath.mockReturnValue(true);
        mocks.getDjvuPageSizesForViewing.mockResolvedValue([
            {
                width: 100,
                height: 200,
                dpi: 300,
            },
        ]);
        mocks.getDjvuPageSourceInfoForViewing.mockResolvedValue({
            pageCount: 1,
            pageNumber: 1,
            pageSize: {
                width: 100,
                height: 200,
                dpi: 300,
            },
            sourceSize: 1,
            sourceModifiedAt: 1,
        });
        mocks.renderDjvuPagePreview.mockResolvedValue({
            bytes: new Uint8Array([1]),
            width: 100,
            height: 200,
        });
        mocks.releaseDjvuViewingPath.mockReturnValue(undefined);
        mocks.cleanupDjvuTempPdfPath.mockResolvedValue(undefined);
        mocks.pruneStaleDjvuArtifactJobs.mockResolvedValue(0);
        mocks.getRecentFiles.mockResolvedValue([]);
    });

    it('prunes only manifest-owned stale artifact jobs during registration', () => {
        registerDjvuIpcAdapter();

        expect(mocks.pruneStaleDjvuArtifactJobs).toHaveBeenCalledOnce();
    });

    it('releases viewing paths without requiring the source file to still exist', () => {
        registerDjvuIpcAdapter();
        const handler = getHandler('djvu:releaseViewingPath');
        const event = createIpcEvent(1);

        handler(event, '/tmp/missing.djvu');

        expect(mocks.releaseDjvuViewingPath).toHaveBeenCalledWith(
            expect.objectContaining({
                sender: event.sender,
                senderId: 1,
            }),
            resolve('/tmp/missing.djvu'),
        );
    });

    it('releases symlinked viewing paths using the opened spelling while the source still exists', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-release-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            const symlinkPath = join(tempRoot, 'link.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            symlinkSync(realPath, symlinkPath);

            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(1);
            allowOpenPath(symlinkPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:releaseViewingPath');

            handler(event, symlinkPath);

            expect(mocks.releaseDjvuViewingPath).toHaveBeenCalledWith(
                expect.objectContaining({
                    sender: event.sender,
                    senderId: 1,
                }),
                symlinkPath,
            );
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('requires an active viewing grant before probing page sizes', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-size-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));

            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(1);
            allowOpenPath(realPath, event.sender as never);
            mocks.isAllowedDjvuViewingPath.mockReturnValue(false);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:getPageSizes');

            await expect(handler(event, realPath)).rejects.toThrow('DjVu viewing path is not active');

            expect(mocks.getDjvuPageSizesForViewing).not.toHaveBeenCalled();
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it.each([
        createAbortError('outline read canceled'),
        markUnprovenNativeTermination(new Error('outline termination unproven'), 'child remains alive'),
    ])('propagates cancellation and liveness evidence from optional outline reads: $message', async (failure) => {
        const directory = mkdtempSync(join(tmpdir(), 'djvu-optional-outline-'));
        try {
            const path = join(directory, 'book.djvu');
            writeFileSync(path, 'AT&TFORM');
            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(1);
            allowOpenPath(path, event.sender as never);
            mocks.getDjvuOutlineBookmarks.mockRejectedValue(failure);
            registerDjvuIpcAdapter();
            await expect(getHandler('djvu:getInfo')(event, path)).rejects.toThrow(failure.message);
            await expect(getHandler('djvu:getOutline')(event, path)).rejects.toThrow(failure.message);
        } finally {
            rmSync(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('keeps browsing available when an optional outline cannot be read', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'djvu-optional-outline-'));
        try {
            const path = join(directory, 'book.djvu');
            writeFileSync(path, 'AT&TFORM');
            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(1);
            allowOpenPath(path, event.sender as never);
            mocks.getDjvuOutlineBookmarks.mockRejectedValue(new Error('DjVu outline metadata exceeded 262144 bytes'));
            registerDjvuIpcAdapter();
            await expect(getHandler('djvu:getInfo')(event, path)).resolves.toMatchObject({
                pageCount: 1,
                hasBookmarks: false,
            });
            await expect(getHandler('djvu:getOutline')(event, path)).resolves.toEqual([]);
        } finally {
            rmSync(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('returns native page text and maps a nested outline to interactive provider shape', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-provider-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(1);
            allowOpenPath(realPath, event.sender as never);
            mocks.readDjvuPageText.mockResolvedValue('Native page text');
            mocks.getDjvuOutlineBookmarks.mockResolvedValue([
                {
                    title: 'Chapter',
                    pageIndex: 0,
                    namedDest: null,
                    bold: false,
                    italic: false,
                    color: null,
                    items: [
                        {
                            title: 'Section',
                            pageIndex: 2,
                            namedDest: null,
                            bold: false,
                            italic: false,
                            color: null,
                            items: [],
                        },
                    ],
                },
            ]);
            registerDjvuIpcAdapter();

            await expect(getHandler('djvu:getPageText')(event, realPath, 3)).resolves.toBe('Native page text');
            await expect(getHandler('djvu:getOutline')(event, realPath)).resolves.toEqual([
                {
                    title: 'Chapter',
                    pageNumber: 1,
                    children: [
                        {
                            title: 'Section',
                            pageNumber: 3,
                            children: [],
                        },
                    ],
                },
            ]);
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('resolves component-ID outline destinations through the viewing IPC endpoint', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'djvu-component-outline-'));
        try {
            const path = join(directory, 'index.djvu');
            writeFileSync(path, 'AT&TFORM');
            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(1);
            allowOpenPath(path, event.sender as never);
            mocks.getDjvuOutlineBookmarks.mockResolvedValue([
                {
                    title: 'Second',
                    pageIndex: 1,
                    namedDest: null,
                    bold: false,
                    italic: false,
                    color: null,
                    items: [],
                },
            ]);
            registerDjvuIpcAdapter();

            await expect(getHandler('djvu:getOutline')(event, path)).resolves.toEqual([
                {
                    title: 'Second',
                    pageNumber: 2,
                    children: [],
                },
            ]);
        } finally {
            rmSync(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('probes only the prioritized page size when creating a viewing source', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-source-info-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(1);
            allowOpenPath(realPath, event.sender as never);
            mocks.getDjvuPageCount.mockResolvedValue(431);
            mocks.getDjvuPageSourceInfoForViewing.mockResolvedValue({
                pageCount: 431,
                pageNumber: 7,
                pageSize: {
                    width: 100,
                    height: 200,
                    dpi: 300,
                },
                sourceSize: 1,
                sourceModifiedAt: 1,
            });
            registerDjvuIpcAdapter();

            await expect(getHandler('djvu:getPageSourceInfo')(event, realPath, 7)).resolves.toEqual({
                pageCount: 431,
                pageNumber: 7,
                pageSize: {
                    width: 100,
                    height: 200,
                    dpi: 300,
                },
                sourceSize: 1,
                sourceModifiedAt: expect.any(Number),
            });

            expect(mocks.getDjvuPageSourceInfoForViewing).toHaveBeenCalledWith(realPath, 7);
            expect(mocks.getDjvuPageSizesForViewing).not.toHaveBeenCalled();
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('allows read-only opening geometry prewarm for a persisted Recent DjVu without granting file access', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-recent-source-info-test-'));
        try {
            const realPath = join(tempRoot, 'recent.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            mocks.getRecentFiles.mockResolvedValue([
                {
                    originalPath: realPath,
                    fileName: 'recent.djvu',
                    timestamp: 1,
                },
            ]);
            registerDjvuIpcAdapter();

            await expect(getHandler('djvu:getPageSourceInfo')(createIpcEvent(1), realPath, 1)).resolves.toMatchObject({
                pageCount: 1,
                pageNumber: 1,
            });

            expect(mocks.getDjvuPageSourceInfoForViewing).toHaveBeenCalledWith(realPath, 1);
            expect(mocks.isAllowedDjvuViewingPath).not.toHaveBeenCalled();
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('prewarms only the exact persisted Recent filename without granting access', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-djvu-recent-identity-'));
        const sibling = join(directory, 'edge.djvu');
        const requested = `${sibling}\u00a0`;
        writeFileSync(sibling, 'one page');
        writeFileSync(requested, 'two pages');
        const {requireOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const event = createIpcEvent(101);
        registerDjvuIpcAdapter();
        mocks.getDjvuPageSourceInfoForViewing.mockImplementation(async (path: string) => ({
            pageCount: readFileSync(path, 'utf8') === 'two pages' ? 2 : 1,
            pageNumber: 1,
            pageSize: {
                width: 100,
                height: 200,
                dpi: 300,
            },
            sourceSize: statSync(path).size,
            sourceModifiedAt: Math.trunc(statSync(path).mtimeMs),
        }));
        try {
            mocks.getRecentFiles.mockResolvedValue([
                {
                    originalPath: sibling,
                    fileName: 'edge.djvu',
                    timestamp: 1,
                },
            ]);
            await expect(getHandler('djvu:getPageSourceInfo')(event, requested, 1)).rejects.toThrow('Path not allowed');
            mocks.getRecentFiles.mockResolvedValue([
                {
                    originalPath: requested,
                    fileName: 'edge.djvu\u00a0',
                    timestamp: 1,
                },
            ]);
            await expect(getHandler('djvu:getPageSourceInfo')(event, requested, 1)).resolves.toMatchObject({pageCount: 2});
            expect(() => requireOpenPath(requested, event.sender as never)).toThrow('Path not allowed');
        } finally {
            mocks.getDjvuPageSourceInfoForViewing.mockReset();
            rmSync(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('reads the exact bytes and size of a DjVu filename with trailing no-break space', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-djvu-read-identity-'));
        const sibling = join(directory, 'edge.djvu');
        const requested = `${sibling}\u00a0`;
        const {allowOpenPaths} = await import('@electron/file-access/openPathCapabilities');
        const {handleFileRead, handleFileStat} = await import('@electron/features/documents/main/documentFileReadHandlers');
        try {
            writeFileSync(sibling, 'one page');
            writeFileSync(requested, 'two pages from the exact file');
            allowOpenPaths([sibling, requested], 103);
            await expect(handleFileStat({senderId: 103}, requested)).resolves.toMatchObject({size: 29});
            expect(Buffer.from(await handleFileRead({senderId: 103}, requested)).toString()).toBe('two pages from the exact file');
            expect(Buffer.from(await handleFileRead({senderId: 103}, sibling)).toString()).toBe('one page');
        } finally {
            rmSync(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('releases the exact viewing lease while retaining its sibling, including after removal', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-djvu-release-identity-'));
        const sibling = join(directory, 'edge.djvu');
        const requested = `${sibling}\u00a0`;
        const viewing = await vi.importActual<typeof TViewingModule>('@electron/features/djvu/main/viewing');
        const {allowOpenPaths} = await import('@electron/file-access/openPathCapabilities');
        const event = createIpcEvent(102);
        const context = {
            ...event,
            senderId: 102,
        };
        registerDjvuIpcAdapter();
        mocks.releaseDjvuViewingPath.mockImplementation(viewing.releaseDjvuViewingPath);
        try {
            writeFileSync(sibling, 'one page');
            writeFileSync(requested, 'two pages');
            allowOpenPaths([sibling, requested], event.sender as never);
            for (const removed of [false, true]) {
                viewing.adoptDjvuViewingPath(context as never, sibling, null);
                viewing.adoptDjvuViewingPath(context as never, requested, null);
                if (removed) {
                    rmSync(requested);
                }
                await getHandler('djvu:releaseViewingPath')(event, requested);
                expect(viewing.isAllowedDjvuViewingPath(requested, 102)).toBe(false);
                expect(viewing.isAllowedDjvuViewingPath(sibling, 102)).toBe(true);
                viewing.releaseDjvuViewingPath(context as never, sibling);
            }
        } finally {
            viewing.releaseDjvuViewingPath(context as never, requested);
            viewing.releaseDjvuViewingPath(context as never, sibling);
            mocks.releaseDjvuViewingPath.mockReset();
            rmSync(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('rejects opening geometry prewarm for an ungranted DjVu outside the persisted Recent list', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-untrusted-source-info-test-'));
        try {
            const realPath = join(tempRoot, 'untrusted.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            registerDjvuIpcAdapter();

            await expect(getHandler('djvu:getPageSourceInfo')(createIpcEvent(1), realPath, 1)).rejects.toThrow('Path not allowed');

            expect(mocks.getDjvuPageSourceInfoForViewing).not.toHaveBeenCalled();
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('renders a page preview only for an active viewing path', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));

            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(1);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:renderPagePreview');

            await expect(handler(event, realPath, 1, {subsample: 3})).resolves.toEqual({
                bytes: new Uint8Array([1]),
                width: 100,
                height: 200,
            });

            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledWith(
                realPath,
                1,
                expect.objectContaining({
                    previewRequestId: expect.stringMatching(/^djvu-preview-/u),
                    subsample: 3,
                }),
                expect.objectContaining({
                    cancelGroup: expect.stringMatching(/^djvu-preview:1:djvu-preview-/u),
                    signal: expect.any(AbortSignal),
                }),
            );
            expect(mocks.getDjvuPageCount).not.toHaveBeenCalled();
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it.each([
        ['low', 1],
        ['medium', 2],
        ['high', 2],
    ] as const)('caps %s-tier native previews at %i per sender', async (tier, maxInFlight) => {
        const tempRoot = mkdtempSync(join(tmpdir(), `evb-djvu-${tier}-preview-cap-test-`));
        try {
            mocks.hostResourceTier = tier;
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const previews = createPendingPreviews(maxInFlight + 1);
            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(30);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:renderPagePreview');
            const runs = previews.map((_preview, index) =>
                handler(event, realPath, index + 1, {previewRequestId: `${tier}-preview-${index}`}),
            );

            await vi.waitFor(() => {
                expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(maxInFlight);
            });
            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(maxInFlight);

            resolvePreview(previews[0]!, 1);
            await vi.waitFor(() => {
                expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(maxInFlight + 1);
            });
            previews.slice(1).forEach((preview, index) => {
                resolvePreview(preview, index + 2);
            });
            await Promise.all(runs);
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('isolates identical preview request ids and cancellation across senders', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-sender-key-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const [firstPreview, secondPreview] = createPendingPreviews(2);

            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const firstEvent = createIpcEvent(21);
            const secondEvent = createIpcEvent(22);
            allowOpenPath(realPath, firstEvent.sender as never);
            allowOpenPath(realPath, secondEvent.sender as never);
            registerDjvuIpcAdapter();
            const renderHandler = getHandler('djvu:renderPagePreview');
            const cancelHandler = getHandler('djvu:cancelPagePreview');

            const firstRun = renderHandler(firstEvent, realPath, 1, {
                previewRequestId: 'shared-preview-id',
                subsample: 3,
            });
            const secondRun = renderHandler(secondEvent, realPath, 1, {
                previewRequestId: 'shared-preview-id',
                subsample: 3,
            });

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2));
            const firstOperation = mocks.renderDjvuPagePreview.mock.calls[0]?.[3];
            const secondOperation = mocks.renderDjvuPagePreview.mock.calls[1]?.[3];
            expect(firstOperation).toMatchObject({
                cancelGroup: 'djvu-preview:21:shared-preview-id',
                signal: expect.any(AbortSignal),
            });
            expect(secondOperation).toMatchObject({
                cancelGroup: 'djvu-preview:22:shared-preview-id',
                signal: expect.any(AbortSignal),
            });

            await expect(cancelHandler(firstEvent, 'shared-preview-id')).resolves.toEqual({canceled: true});

            expect(firstOperation?.signal.aborted).toBe(true);
            expect(secondOperation?.signal.aborted).toBe(false);
            expect(mocks.cancelConversion).toHaveBeenCalledWith('djvu-preview:21:shared-preview-id');
            expect(mocks.cancelConversion).not.toHaveBeenCalledWith('djvu-preview:22:shared-preview-id');

            resolvePreview(firstPreview!, 1);
            resolvePreview(secondPreview!, 2);
            await expect(firstRun).resolves.toMatchObject({width: 100});
            await expect(secondRun).resolves.toMatchObject({width: 100});
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('keeps a newer matching preview operation registered when the older operation completes', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-operation-identity-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const [firstPreview, secondPreview] = createPendingPreviews(2);

            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(24);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const renderHandler = getHandler('djvu:renderPagePreview');
            const cancelHandler = getHandler('djvu:cancelPagePreview');

            const firstRun = renderHandler(event, realPath, 1, {
                previewRequestId: 'reused-preview-id',
                subsample: 3,
            });
            const secondRun = renderHandler(event, realPath, 2, {
                previewRequestId: 'reused-preview-id',
                subsample: 3,
            });
            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2));
            const secondSignal = mocks.renderDjvuPagePreview.mock.calls[1]?.[3]?.signal as AbortSignal | undefined;

            resolvePreview(firstPreview!, 1);
            await expect(firstRun).resolves.toMatchObject({width: 100});

            await expect(cancelHandler(event, 'reused-preview-id')).resolves.toEqual({canceled: true});
            expect(secondSignal?.aborted).toBe(true);

            resolvePreview(secondPreview!, 2);
            await expect(secondRun).resolves.toMatchObject({width: 100});
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects oversized preview request ids at the boundary before starting native work', () => {
        const codec = DJVU_PLATFORM_FEATURE.ipcCodecs[DJVU_PLATFORM_FEATURE.invokeChannels.renderPagePreview]!;
        expect(() => codec.decodeArgs(['/tmp/book.djvu', 1, {previewRequestId: 'x'.repeat(129)}])).toThrow(
            'renderPagePreview.options.previewRequestId exceeds maximum length (128)',
        );
        expect(mocks.renderDjvuPagePreview).not.toHaveBeenCalled();
    });

    it('drops superseded queued native preview requests per sender before spawning conversion', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-coalesce-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const [firstPreview, secondPreview, fourthPreview] = createPendingPreviews(3);

            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(9);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:renderPagePreview');

            const firstRun = handler(event, realPath, 1, {
                previewRequestId: 'preview-1',
                subsample: 3,
            });
            const secondRun = handler(event, realPath, 1, {
                previewRequestId: 'preview-2',
                subsample: 3,
            });
            const thirdRun = handler(event, realPath, 1, {
                previewRequestId: 'preview-3',
                subsample: 3,
            });
            const thirdRejection = expect(thirdRun).rejects.toThrow('DjVu preview request superseded');
            const fourthRun = handler(event, realPath, 1, {
                previewRequestId: 'preview-4',
                subsample: 3,
            });

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2));

            resolvePreview(firstPreview!, 1);

            await thirdRejection;
            await Promise.resolve();

            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(3);
            expect(mocks.renderDjvuPagePreview).toHaveBeenNthCalledWith(
                3,
                realPath,
                1,
                {
                    previewRequestId: 'preview-4',
                    subsample: 3,
                },
                expect.objectContaining({
                    cancelGroup: 'djvu-preview:9:preview-4',
                    signal: expect.any(AbortSignal),
                }),
            );

            resolvePreview(secondPreview!, 2);
            resolvePreview(fourthPreview!, 4);

            await expect(firstRun).resolves.toMatchObject({width: 100});
            await expect(secondRun).resolves.toMatchObject({width: 100});
            await expect(fourthRun).resolves.toMatchObject({width: 100});
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects queued native preview requests when their sender is destroyed', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-destroy-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const [firstPreview, secondPreview] = createPendingPreviews(2);

            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(12);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:renderPagePreview');

            const firstRun = handler(event, realPath, 1, {
                previewRequestId: 'destroy-preview-1',
                subsample: 3,
            });
            const secondRun = handler(event, realPath, 2, {
                previewRequestId: 'destroy-preview-2',
                subsample: 3,
            });
            const queuedRun = handler(event, realPath, 3, {
                previewRequestId: 'destroy-preview-3',
                subsample: 3,
            });

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2));
            const firstSignal = mocks.renderDjvuPagePreview.mock.calls[0]?.[3]?.signal as AbortSignal | undefined;
            const secondSignal = mocks.renderDjvuPagePreview.mock.calls[1]?.[3]?.signal as AbortSignal | undefined;

            const queuedRejection = expect(queuedRun).rejects.toThrow('Renderer lifecycle ended');
            const capacity = mainJobBroker.getSnapshot().capacity;
            let overflowingGranted = false;
            const overflowingJob = mainJobBroker
                .acquire({
                    ownerId: 'other-heavy-job',
                    kind: 'heavy-competitor',
                    priority: 'user',
                    resources: {
                        ...capacity,
                        cpuTokens: Math.max(1, capacity.cpuTokens - 1),
                        nativeProcesses: Math.max(1, capacity.nativeProcesses - 1),
                        ioWeight: Math.max(1, capacity.ioWeight - 1),
                    },
                })
                .then((lease) => {
                    overflowingGranted = true;
                    return lease;
                });
            event.sender.emit('destroyed');

            await queuedRejection;
            await Promise.resolve();
            expect(firstSignal?.aborted).toBe(true);
            expect(secondSignal?.aborted).toBe(true);
            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2);
            expect(overflowingGranted).toBe(false);
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 2,
                queued: 1,
                used: {
                    cpuTokens: 2,
                    nativeProcesses: 2,
                    ioWeight: 2,
                },
            });

            resolvePreview(firstPreview!, 1);
            resolvePreview(secondPreview!, 2);
            await expect(firstRun).resolves.toMatchObject({width: 100});
            await expect(secondRun).resolves.toMatchObject({width: 100});
            const overflowingLease = await overflowingJob;
            expect(overflowingGranted).toBe(true);
            expect(overflowingLease.release()).toBe(true);
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 0,
                queued: 0,
            });
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('cancels a sender first queued preview on main-frame navigation before broker admission', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-nav-queued-test-'));
        const capacity = mainJobBroker.getSnapshot().capacity;
        const blocker = await mainJobBroker.acquire({
            ownerId: 'busy-heavy-job',
            kind: 'heavy-work',
            priority: 'user',
            resources: capacity,
        });
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(55);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:renderPagePreview');

            const queuedPreview = handler(event, realPath, 1, {
                previewRequestId: 'first-queued-preview',
                subsample: 3,
            });
            const queuedRejection = expect(queuedPreview).rejects.toThrow('Renderer navigation canceled DjVu preview operations');
            await vi.waitFor(() => expect(mainJobBroker.getSnapshot().queued).toBe(1));

            event.sender.emit('did-start-navigation', {}, 'https://example.test/next', false, true);
            await queuedRejection;

            expect(blocker.release()).toBe(true);
            await Promise.resolve();
            await Promise.resolve();
            expect(mocks.renderDjvuPagePreview).not.toHaveBeenCalled();
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 0,
                queued: 0,
            });
        } finally {
            blocker.release();
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('retains a low-tier preview slot on unproven termination and frees it when termination proof resolves true', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-proof-release-test-'));
        const delayedProof = createDeferred<boolean>();
        try {
            mocks.hostResourceTier = 'low';
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(56);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:renderPagePreview');

            const watchdogError = markUnprovenNativeTermination(
                new Error('ddjvu watchdog expired'),
                'ddjvu process tree not proven dead yet',
            );
            mocks.renderDjvuPagePreview
                .mockImplementationOnce(
                    async (
                        _path: string,
                        _page: number,
                        _options: unknown,
                        lifecycle?: {onTerminationProof?: (proof: Promise<boolean>) => void},
                    ) => {
                        lifecycle?.onTerminationProof?.(delayedProof.promise);
                        throw watchdogError;
                    },
                )
                .mockResolvedValueOnce({
                    bytes: new Uint8Array([7]),
                    width: 100,
                    height: 200,
                });

            await expect(
                handler(event, realPath, 1, {
                    previewRequestId: 'low-tier-watchdog-1',
                }),
            ).rejects.toBe(watchdogError);

            let secondResolved = false;
            const secondPreview = Promise.resolve(
                handler(event, realPath, 2, {
                    previewRequestId: 'low-tier-watchdog-2',
                }),
            ).then((result) => {
                secondResolved = true;
                return result;
            });

            await Promise.resolve();
            await Promise.resolve();
            expect(secondResolved).toBe(false);
            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(1);
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 1,
                queued: 1,
                used: {
                    cpuTokens: 1,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
            });
            // The PNG encoder runs under this lease: a 45 MP RGB page's
            // decoded pixels alone need about 129 MiB.
            const {capacity, used} = mainJobBroker.getSnapshot();
            expect(used.estimatedResidentBytes).toBeGreaterThanOrEqual(Math.min(capacity.estimatedResidentBytes, 45_000_000 * 3));

            delayedProof.resolve(true);
            await expect(secondPreview).resolves.toMatchObject({
                bytes: new Uint8Array([7]),
                width: 100,
                height: 200,
            });
            expect(secondResolved).toBe(true);
            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2);
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 0,
                queued: 0,
            });
        } finally {
            delayedProof.resolve(true);
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('cancels a queued native preview before it consumes a native-process slot', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-cancel-queued-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const [firstPreview, secondPreview] = createPendingPreviews(2);

            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(14);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const renderHandler = getHandler('djvu:renderPagePreview');
            const cancelHandler = getHandler('djvu:cancelPagePreview');
            const firstRun = renderHandler(event, realPath, 1, {previewRequestId: 'preview-active-1'});
            const secondRun = renderHandler(event, realPath, 2, {previewRequestId: 'preview-active-2'});
            const queuedRun = renderHandler(event, realPath, 3, {previewRequestId: 'preview-queued'});

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2));
            await expect(cancelHandler(event, 'preview-queued')).resolves.toEqual({canceled: true});
            await expect(queuedRun).rejects.toThrow('DjVu preview request canceled');

            resolvePreview(firstPreview!, 1);
            resolvePreview(secondPreview!, 2);
            await expect(firstRun).resolves.toMatchObject({width: 100});
            await expect(secondRun).resolves.toMatchObject({width: 100});
            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2);
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('aborts active estimate size requests when their sender is destroyed', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-estimate-destroy-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const estimateState: {signal: AbortSignal | undefined} = {signal: undefined};
            mocks.estimateSizes.mockImplementation(
                (_djvuPath: string, _pageCount: number, options?: {signal?: AbortSignal}) =>
                    new Promise((_resolve, reject) => {
                        const signal = options?.signal;
                        estimateState.signal = signal;
                        signal?.addEventListener(
                            'abort',
                            () => {
                                reject(signal.reason);
                            },
                            {once: true},
                        );
                    }),
            );

            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(13);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:estimateSizes');

            const estimateRun = handler(event, realPath);

            await vi.waitFor(() => expect(mocks.estimateSizes).toHaveBeenCalledTimes(1));
            event.sender.emit('destroyed');

            expect(estimateState.signal?.aborted).toBe(true);
            await expect(estimateRun).rejects.toThrow('Renderer lifecycle ended');
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects an estimate the operation lifecycle cancels as an abort error', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-estimate-lifecycle-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            mocks.estimateSizes.mockImplementation(
                (_djvuPath: string, _pageCount: number, options?: {signal?: AbortSignal}) =>
                    new Promise((_resolve, reject) => {
                        options?.signal?.addEventListener(
                            'abort',
                            () => {
                                reject(options.signal?.reason);
                            },
                            {once: true},
                        );
                    }),
            );

            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const {cancelMainOperationsForOwner} = await import('@electron/operation-lifecycle/mainOperationLifecycle');
            const event = createIpcEvent(14);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const estimateRun = getHandler('djvu:estimateSizes')(event, realPath);

            await vi.waitFor(() => expect(mocks.estimateSizes).toHaveBeenCalledTimes(1));
            cancelMainOperationsForOwner(14, 'Renderer main frame navigated', 'mainFrameNavigation');

            // The IPC registrar logs abort errors at debug level, as an expected cancellation.
            await expect(estimateRun).rejects.toMatchObject({
                name: 'AbortError',
                message: 'Renderer main frame navigated',
            });
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('preserves TimeoutError identity when a DjVu preview or estimate IPC deadline expires', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-timeout-identity-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            mocks.estimateSizes.mockImplementation(
                (_djvuPath: string, _pageCount: number, options?: {signal?: AbortSignal}) =>
                    new Promise((_resolve, reject) => {
                        options?.signal?.addEventListener(
                            'abort',
                            () => {
                                reject(options.signal?.reason);
                            },
                            {once: true},
                        );
                    }),
            );
            mocks.renderDjvuPagePreview.mockImplementation(
                (_djvuPath: string, _pageNumber: number, _options: unknown, lifecycle?: {signal?: AbortSignal}) =>
                    new Promise((_resolve, reject) => {
                        lifecycle?.signal?.addEventListener(
                            'abort',
                            () => {
                                reject(lifecycle.signal?.reason);
                            },
                            {once: true},
                        );
                    }),
            );

            const {isAbortError} = await import('@contracts/isAbortError');
            const {isTimeoutError} = await import('@contracts/isTimeoutError');
            const {requireRequestId} = await import('@contracts/shared');
            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const {beginIpcInvokeCancellation, cancelIpcInvoke} = await import('@electron/platform-ipc/ipcInvokeCancellation');
            const {runWithMainOperationCancellationSignal} = await import('@electron/operation-lifecycle/mainOperationLifecycle');
            const event = createIpcEvent(15);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();

            const estimateCancel = beginIpcInvokeCancellation(event.sender as never, requireRequestId('djvu-est-timeout'));
            const estimateRun = runWithMainOperationCancellationSignal(estimateCancel.signal, () =>
                getHandler('djvu:estimateSizes')(event, realPath),
            );
            await vi.waitFor(() => expect(mocks.estimateSizes).toHaveBeenCalledTimes(1));
            cancelIpcInvoke(event.sender as never, requireRequestId('djvu-est-timeout'), undefined, {timedOut: true});
            const estimateError = await Promise.resolve(estimateRun).then(
                () => null,
                (caught: unknown) => caught,
            );
            estimateCancel.complete();
            expect(isTimeoutError(estimateError)).toBe(true);
            expect(isAbortError(estimateError)).toBe(false);

            const previewCancel = beginIpcInvokeCancellation(event.sender as never, requireRequestId('djvu-prev-timeout'));
            const previewRun = runWithMainOperationCancellationSignal(previewCancel.signal, () =>
                getHandler('djvu:renderPagePreview')(event, realPath, 1, {
                    previewPriority: 10,
                    previewRequestId: '1:1:1',
                    subsample: 3,
                }),
            );
            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(1));
            cancelIpcInvoke(event.sender as never, requireRequestId('djvu-prev-timeout'), undefined, {timedOut: true});
            const previewError = await Promise.resolve(previewRun).then(
                () => null,
                (caught: unknown) => caught,
            );
            previewCancel.complete();
            expect(isTimeoutError(previewError)).toBe(true);
            expect(isAbortError(previewError)).toBe(false);

            const preTimedCancel = beginIpcInvokeCancellation(event.sender as never, requireRequestId('djvu-prev-queued-timeout'));
            cancelIpcInvoke(event.sender as never, requireRequestId('djvu-prev-queued-timeout'), undefined, {timedOut: true});
            const preTimedError = await Promise.resolve(
                runWithMainOperationCancellationSignal(preTimedCancel.signal, () =>
                    getHandler('djvu:renderPagePreview')(event, realPath, 2, {
                        previewPriority: 10,
                        previewRequestId: '2:1:1',
                        subsample: 3,
                    }),
                ),
            ).then(
                () => null,
                (caught: unknown) => caught,
            );
            preTimedCancel.complete();
            expect(isTimeoutError(preTimedError)).toBe(true);
            expect(isAbortError(preTimedError)).toBe(false);
            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(1);
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('prioritizes visible native preview waiters over retained queued pages', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-priority-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const [firstPreview, secondPreview, visiblePreview, retainedPreview] = createPendingPreviews(4);

            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(10);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:renderPagePreview');

            const firstRun = handler(event, realPath, 1, {
                previewPriority: 10,
                previewRequestId: '1:1:1',
                subsample: 3,
            });
            const secondRun = handler(event, realPath, 2, {
                previewPriority: 9,
                previewRequestId: '1:2:1',
                subsample: 3,
            });
            const retainedRun = handler(event, realPath, 8, {
                previewPriority: 1,
                previewRequestId: '1:8:1',
                subsample: 3,
            });
            const visibleRun = handler(event, realPath, 3, {
                previewPriority: 20,
                previewRequestId: '1:3:1',
                subsample: 3,
            });

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2));

            resolvePreview(firstPreview!, 1);

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(3));
            expect(mocks.renderDjvuPagePreview).toHaveBeenNthCalledWith(
                3,
                realPath,
                3,
                {
                    previewPriority: 20,
                    previewRequestId: '1:3:1',
                    subsample: 3,
                },
                expect.objectContaining({
                    cancelGroup: 'djvu-preview:10:1:3:1',
                    signal: expect.any(AbortSignal),
                }),
            );

            resolvePreview(secondPreview!, 2);

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(4));
            expect(mocks.renderDjvuPagePreview).toHaveBeenNthCalledWith(
                4,
                realPath,
                8,
                {
                    previewPriority: 1,
                    previewRequestId: '1:8:1',
                    subsample: 3,
                },
                expect.objectContaining({
                    cancelGroup: 'djvu-preview:10:1:8:1',
                    signal: expect.any(AbortSignal),
                }),
            );

            resolvePreview(visiblePreview!, 3);
            resolvePreview(retainedPreview!, 8);

            await expect(firstRun).resolves.toMatchObject({width: 100});
            await expect(secondRun).resolves.toMatchObject({width: 100});
            await expect(visibleRun).resolves.toMatchObject({width: 100});
            await expect(retainedRun).resolves.toMatchObject({width: 100});
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('drops older generation native preview waiters before they consume render slots', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-generation-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const [firstPreview, secondPreview, nextGenerationPreview] = createPendingPreviews(3);

            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(11);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:renderPagePreview');

            const firstRun = handler(event, realPath, 1, {
                previewPriority: 10,
                previewRequestId: '1:1:1',
                subsample: 3,
            });
            const secondRun = handler(event, realPath, 2, {
                previewPriority: 9,
                previewRequestId: '1:2:1',
                subsample: 3,
            });
            const staleRun = handler(event, realPath, 8, {
                previewPriority: 1,
                previewRequestId: '1:8:1',
                subsample: 3,
            });
            const staleRejection = expect(staleRun).rejects.toThrow('DjVu preview request superseded');
            const nextGenerationRun = handler(event, realPath, 3, {
                previewPriority: 20,
                previewRequestId: '2:3:1',
                subsample: 3,
            });

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2));
            await staleRejection;

            resolvePreview(firstPreview!, 1);

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(3));
            expect(mocks.renderDjvuPagePreview).toHaveBeenNthCalledWith(
                3,
                realPath,
                3,
                {
                    previewPriority: 20,
                    previewRequestId: '2:3:1',
                    subsample: 3,
                },
                expect.objectContaining({
                    cancelGroup: 'djvu-preview:11:2:3:1',
                    signal: expect.any(AbortSignal),
                }),
            );

            resolvePreview(secondPreview!, 2);
            resolvePreview(nextGenerationPreview!, 3);

            await expect(firstRun).resolves.toMatchObject({width: 100});
            await expect(secondRun).resolves.toMatchObject({width: 100});
            await expect(nextGenerationRun).resolves.toMatchObject({width: 100});
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});

describe('native DjVu open admission', async () => {
    const {getAdmittedDjvuViewingSource, handleDjvuOpenForViewing, releaseDjvuViewingPath} = await vi.importActual<typeof TViewingModule>(
        '@electron/features/djvu/main/viewing',
    );
    const {NativeProcessError} = await import('@electron/native-tools/processResult');
    const DJVU_FIXTURE_SOURCES = join(process.cwd(), 'tests/fixtures/djvu/sources');
    const nativeRejection = 'djvused failed with exit code 10. Unrecognized DjVu Message: DjVuDocEditor.open_fail';

    async function openWithProbeFailure(
        pageCountFailure: unknown,
        source: Buffer | string = readFileSync(join(DJVU_FIXTURE_SOURCES, 'layered.djvu')),
        options: {unreadableAfterProbe?: boolean} = {},
    ) {
        const directory = mkdtempSync(join(tmpdir(), 'djvu-open-admission-'));
        const djvuPath = join(directory, 'book.djvu');
        writeFileSync(djvuPath, source);
        mocks.getDjvuPageSourceInfoForViewing.mockReset().mockRejectedValueOnce(pageCountFailure);
        mocks.getDjvuPageCount.mockReset().mockImplementationOnce(() => {
            // A directory has no bytes to read on any platform or as any user.
            if (options.unreadableAfterProbe) {
                rmSync(djvuPath);
                mkdirSync(djvuPath);
            }
            return Promise.reject(pageCountFailure);
        });
        try {
            return await handleDjvuOpenForViewing(createIpcEvent(91) as never, djvuPath as never, undefined, false);
        } finally {
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
    }

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getDjvuPageSourceInfoForViewing.mockReset();
        mocks.getDjvuPageCount.mockReset();
    });

    it.each([
        ['HTML', '<html><head><title>Сайт временно недоступен</title></head></html>', 'html'],
        ['HTML with a BOM and comments', '\ufeff  <!-- failed download -->\n<!doctype html>', 'html'],
        ['PDF', '%PDF-1.7\n%%EOF\n', 'pdf'],
        ['ZIP', 'PK\x03\x04archive', 'zip'],
        ['empty', '', 'empty'],
        ['unknown', 'not a document', 'unknown'],
    ])('refuses %s bytes named .djvu before invoking a native probe', async (_label, bytes, detectedFormat) => {
        const result = await openWithProbeFailure(new Error('Native probe must not run'), bytes);
        expect(result).toMatchObject({
            success: false,
            errorEnvelope: {
                code: 'not-djvu',
                detectedFormat,
            },
        });
        expect(result.error).not.toContain('Native probe must not run');
        expect(mocks.getDjvuPageSourceInfoForViewing).not.toHaveBeenCalled();
        expect(mocks.getDjvuPageCount).not.toHaveBeenCalled();
    });

    it('classifies a djvused refusal of a truncated DjVu as invalid and keeps the native message as diagnostics', async () => {
        const truncated = readFileSync(join(DJVU_FIXTURE_SOURCES, 'corrupt-truncated.djvu'));
        for (const bytes of [truncated, truncated.subarray(4), Buffer.from('AT&TFORM')]) {
            await expect(openWithProbeFailure(new NativeProcessError('exit-code', 10, null, nativeRejection), bytes)).resolves.toEqual({
                success: false,
                error: nativeRejection,
                errorEnvelope: {
                    code: 'invalid-djvu',
                    message: nativeRejection,
                },
            });
            expect(mocks.getDjvuPageCount).toHaveBeenCalledOnce();
        }
    });

    it('does not call a killed, failed or unavailable native tool an invalid DjVu', async () => {
        for (const failure of [
            new NativeProcessError('signal', null, 'SIGKILL', 'djvused failed after signal SIGKILL'),
            new NativeProcessError('exit-code', 1, null, 'djvused failed with exit code 1'),
            Object.assign(new Error('spawn djvused ENOENT'), {code: 'EACCES'}),
        ]) {
            const result = await openWithProbeFailure(failure);
            expect(result).toEqual({
                success: false,
                error: failure.message,
            });
        }
    });

    it('reports an unreadable DjVu source when djvused exits 10', async () => {
        const denied = "djvused failed with exit code 10. Failed to open 'book.djvu': Permission denied.";
        const failure = new NativeProcessError('exit-code', 10, null, denied);

        await expect(openWithProbeFailure(failure)).resolves.toEqual({
            success: false,
            error: denied,
        });
        await expect(openWithProbeFailure(failure, undefined, {unreadableAfterProbe: true})).resolves.toEqual({
            success: false,
            error: denied,
        });
    });

    it('keeps native diagnostics for supported legacy FORM and SDJV containers', async () => {
        const layered = readFileSync(join(DJVU_FIXTURE_SOURCES, 'layered.djvu'));
        const failure = new NativeProcessError('exit-code', 10, null, nativeRejection);
        for (const source of [layered.subarray(4), Buffer.concat([Buffer.from('SDJV', 'latin1'), layered.subarray(4)])]) {
            await expect(openWithProbeFailure(failure, source)).resolves.toEqual({
                success: false,
                error: nativeRejection,
            });
        }
    });

    it('reports a missing source as not found before asking djvused about it', async () => {
        mocks.getDjvuPageSourceInfoForViewing.mockRejectedValueOnce(new Error('probe failed'));
        const result = await handleDjvuOpenForViewing(
            createIpcEvent(92) as never,
            join(tmpdir(), 'evb-missing-djvu-open-admission.djvu') as never,
            undefined,
            false,
        );

        expect(result).toMatchObject({
            success: false,
            errorEnvelope: {code: 'not-found'},
        });
        expect(mocks.getDjvuPageCount).not.toHaveBeenCalled();
    });

    it('returns a canceled open as expected, without falling back to the page-count probe', async () => {
        const controller = new AbortController();
        const abort = Object.assign(new Error('The operation was aborted'), {name: 'AbortError'});
        controller.abort(abort);
        mocks.getDjvuPageSourceInfoForViewing.mockRejectedValueOnce(abort);

        await expect(
            handleDjvuOpenForViewing(createIpcEvent(93) as never, '/tmp/canceled.djvu' as never, controller.signal, false),
        ).resolves.toEqual({
            success: false,
            error: 'The operation was aborted',
            expected: {
                kind: 'expected',
                code: 'canceled',
            },
        });
        expect(mocks.getDjvuPageCount).not.toHaveBeenCalled();
    });

    it('keeps the page-count fallback when only the page-source probe fails', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'djvu-open-admission-'));
        const djvuPath = join(directory, 'book.djvu');
        writeFileSync(djvuPath, readFileSync(join(DJVU_FIXTURE_SOURCES, 'layered.djvu')));
        mocks.getDjvuPageSourceInfoForViewing.mockRejectedValueOnce(new Error('page size probe failed'));
        mocks.getDjvuPageCount.mockResolvedValueOnce(12);
        try {
            await expect(handleDjvuOpenForViewing(createIpcEvent(94) as never, djvuPath as never, undefined, false)).resolves.toEqual({
                success: true,
                pageCount: 12,
                source: {
                    sourceSize: readFileSync(join(DJVU_FIXTURE_SOURCES, 'layered.djvu')).length,
                    sourceModifiedAt: Math.trunc(statSync(djvuPath).mtimeMs),
                },
            });
        } finally {
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
    });

    it('carries the page-count fallback source through a durable open completion into the sender grant', async () => {
        const {startDurableDjvuOpenJob} = await vi.importActual<typeof TPdfExportModule>('@electron/features/djvu/main/pdfExport');
        const directory = mkdtempSync(join(tmpdir(), 'djvu-open-durable-'));
        const djvuPath = join(directory, 'book.djvu');
        writeFileSync(djvuPath, readFileSync(join(DJVU_FIXTURE_SOURCES, 'layered.djvu')));
        const openDurably = async (senderId: number, requestId: string) => {
            const context = {
                ...createIpcEvent(senderId),
                senderId,
            };
            mocks.safeSendToWindow.mockClear();
            startDurableDjvuOpenJob(
                context as never,
                requireJobId(`djvu-open-${senderId}-${requestId}`),
                djvuPath as never,
                requireRequestId(requestId),
                (signal) => handleDjvuOpenForViewing(context as never, djvuPath as never, signal, false),
            );
            const completion = await vi.waitFor(() => {
                const sent = mocks.safeSendToWindow.mock.calls.find(
                    ([, channel]) => channel === DJVU_PLATFORM_FEATURE.eventChannels.onOpenComplete,
                );
                expect(sent).toBeDefined();
                return sent![2];
            });
            return v.parse(DJVU_PLATFORM_FEATURE.events.onOpenComplete.payload, completion);
        };
        try {
            mocks.getDjvuPageSourceInfoForViewing.mockRejectedValueOnce(new Error('page size probe failed'));
            mocks.getDjvuPageCount.mockResolvedValueOnce(12);
            const source = {
                sourceSize: readFileSync(join(DJVU_FIXTURE_SOURCES, 'layered.djvu')).length,
                sourceModifiedAt: Math.trunc(statSync(djvuPath).mtimeMs),
            };
            await expect(openDurably(97, 'durable-unchanged')).resolves.toMatchObject({
                success: true,
                pageCount: 12,
                source,
            });
            await expect(getAdmittedDjvuViewingSource(djvuPath, 97)).resolves.toEqual({
                originalPath: djvuPath,
                ...source,
            });

            mocks.getDjvuPageSourceInfoForViewing.mockRejectedValueOnce(new Error('page size probe failed'));
            mocks.getDjvuPageCount.mockImplementationOnce(() => {
                writeFileSync(djvuPath, 'AT&TFORM replaced while counting');
                return Promise.resolve(12);
            });
            const changed = await openDurably(98, 'durable-changed');
            expect(changed).toMatchObject({success: true});
            expect(changed).not.toHaveProperty('source');
            await expect(getAdmittedDjvuViewingSource(djvuPath, 98)).resolves.toBeNull();
        } finally {
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
    });

    it('admits the page-count fallback as the source it counted only when the source did not change during the count', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'djvu-open-admission-'));
        const djvuPath = join(directory, 'book.djvu');
        const context = {
            ...createIpcEvent(95),
            senderId: 95,
        };
        writeFileSync(djvuPath, readFileSync(join(DJVU_FIXTURE_SOURCES, 'layered.djvu')));
        try {
            mocks.getDjvuPageSourceInfoForViewing.mockRejectedValueOnce(new Error('page size probe failed'));
            mocks.getDjvuPageCount.mockResolvedValueOnce(12);
            await expect(handleDjvuOpenForViewing(context as never, djvuPath as never)).resolves.toMatchObject({success: true});
            await expect(getAdmittedDjvuViewingSource(djvuPath, 95)).resolves.toMatchObject({
                originalPath: djvuPath,
                sourceSize: readFileSync(join(DJVU_FIXTURE_SOURCES, 'layered.djvu')).length,
            });
            await expect(getAdmittedDjvuViewingSource(djvuPath, 96)).resolves.toBeNull();
            releaseDjvuViewingPath(context as never, djvuPath);

            mocks.getDjvuPageSourceInfoForViewing.mockRejectedValueOnce(new Error('page size probe failed'));
            mocks.getDjvuPageCount.mockImplementationOnce(() => {
                writeFileSync(djvuPath, 'AT&TFORM replaced while counting');
                return Promise.resolve(12);
            });
            const changed = await handleDjvuOpenForViewing(context as never, djvuPath as never);
            expect(changed).toMatchObject({success: true});
            expect(changed).not.toHaveProperty('source');
            await expect(getAdmittedDjvuViewingSource(djvuPath, 95)).resolves.toBeNull();
            releaseDjvuViewingPath(context as never, djvuPath);
        } finally {
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
    });

    it('holds active DjVu conversion broker charges during cancel until the native child exits', async () => {
        const {handleDjvuCancel, handleDjvuConvertToPdf} = await vi.importActual<typeof TPdfExportModule>(
            '@electron/features/djvu/main/pdfExport',
        );
        const {allowDjvuWritePath} = await import('@electron/features/djvu/main/exportPaths');
        const directory = mkdtempSync(join(tmpdir(), 'djvu-cancel-charges-'));
        const djvuPath = join(directory, 'book.djvu');
        const outputPath = join(directory, 'book.pdf');
        writeFileSync(djvuPath, readFileSync(join(DJVU_FIXTURE_SOURCES, 'layered.djvu')));
        const senderId = 99;
        const event = createIpcEvent(senderId);
        const context = {
            ...event,
            senderId,
        };
        allowDjvuWritePath(outputPath, senderId);
        const jobId = requireJobId('djvu-convert-cancel-charges');
        const capacity = mainJobBroker.getSnapshot().capacity;
        const conversionActive = createDeferred<void>();
        const childExited = createDeferred<void>();

        mocks.getDjvuPageCount.mockResolvedValueOnce(1);
        mocks.getDjvuResolution.mockResolvedValueOnce(300);
        mocks.getDjvuPageSizesForViewing.mockResolvedValueOnce([
            {
                width: 100,
                height: 200,
                dpi: 300,
            },
        ]);
        mocks.withDjvuNativeResourceLease.mockImplementation(async (options: {task: () => Promise<unknown>}) => options.task());
        mocks.cancelConversion.mockResolvedValue(true);
        mocks.convertDjvuToPdfFile.mockImplementationOnce(async (_input: string, targetOutputPath: string, activeJobId: string) => {
            const activeLease = await mainJobBroker.acquire({
                ownerId: activeJobId,
                kind: 'djvu-conversion',
                priority: 'user',
                resources: capacity,
            });
            try {
                conversionActive.resolve(undefined);
                await childExited.promise;
                return {
                    success: false,
                    outputPath: targetOutputPath,
                    fileSize: 0,
                    error: 'DjVu conversion canceled',
                };
            } finally {
                activeLease.release();
            }
        });

        const competitorState: {lease: {release: () => boolean} | null} = {lease: null};
        try {
            const convertPromise = handleDjvuConvertToPdf(context as never, djvuPath as never, outputPath, {
                jobId,
                pdfStrategy: 'direct',
                preserveBookmarks: false,
            });
            await Promise.race([
                conversionActive.promise,
                convertPromise.then((earlyResult) => {
                    throw new Error(`DjVu conversion exited before becoming active: ${JSON.stringify(earlyResult)}`);
                }),
            ]);

            const queuedOwnerStage = mainJobBroker.acquire({
                ownerId: jobId,
                kind: 'djvu-range-conversion',
                priority: 'user',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 64 * 1024 * 1024,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
            });
            let competitorGranted = false;
            const competitor = mainJobBroker
                .acquire({
                    ownerId: 'other-heavy-job',
                    kind: 'djvu-conversion',
                    priority: 'user',
                    resources: {
                        cpuTokens: 1,
                        estimatedResidentBytes: 64 * 1024 * 1024,
                        nativeProcesses: 1,
                        ioWeight: 1,
                    },
                })
                .then((lease) => {
                    competitorGranted = true;
                    competitorState.lease = lease;
                    return lease;
                });
            void competitor.catch(() => undefined);

            const cancelPromise = handleDjvuCancel(context as never, jobId);

            await expect(queuedOwnerStage).rejects.toThrow('DjVu conversion canceled');
            await vi.waitFor(() => expect(mocks.cancelConversion).toHaveBeenCalledWith(jobId));
            await Promise.resolve();
            expect(competitorGranted).toBe(false);
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 2,
                queued: 1,
                used: capacity,
                usedBulk: capacity,
            });

            childExited.resolve(undefined);
            const competitorLease = await competitor;
            expect(competitorGranted).toBe(true);
            await expect(cancelPromise).resolves.toEqual({canceled: true});
            await expect(convertPromise).resolves.toMatchObject({
                success: false,
                jobId,
                error: 'DjVu conversion canceled',
            });
            expect(competitorLease.release()).toBe(true);
            competitorState.lease = null;
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 0,
                queued: 0,
            });
        } finally {
            mainJobBroker.cancelOwner('other-heavy-job');
            competitorState.lease?.release();
            childExited.resolve(undefined);
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
    });

    it('releases the zero-resource DjVu coordination lease after an inner marked error so the jobId can be retried', async () => {
        const {handleDjvuConvertToPdf} = await vi.importActual<typeof TPdfExportModule>('@electron/features/djvu/main/pdfExport');
        const {allowDjvuWritePath} = await import('@electron/features/djvu/main/exportPaths');
        const directory = mkdtempSync(join(tmpdir(), 'djvu-coordination-lease-'));
        const djvuPath = join(directory, 'book.djvu');
        const outputPath = join(directory, 'book.pdf');
        writeFileSync(djvuPath, readFileSync(join(DJVU_FIXTURE_SOURCES, 'layered.djvu')));
        const senderId = 104;
        const event = createIpcEvent(senderId);
        const context = {
            ...event,
            senderId,
        };
        allowDjvuWritePath(outputPath, senderId);
        const jobId = requireJobId('djvu-convert-retryable-slot');
        const innerError = markUnprovenNativeTermination(new Error('ddjvu child not proven dead'), 'ddjvu process tree still running');

        mocks.getDjvuPageCount.mockResolvedValueOnce(1);
        mocks.getDjvuResolution.mockResolvedValueOnce(300);
        mocks.getDjvuPageSizesForViewing.mockResolvedValueOnce([
            {
                width: 100,
                height: 200,
                dpi: 300,
            },
        ]);
        mocks.withDjvuNativeResourceLease.mockImplementation(async (options: {task: () => Promise<unknown>}) => options.task());
        mocks.convertDjvuToPdfFile.mockRejectedValueOnce(innerError);

        try {
            await expect(
                handleDjvuConvertToPdf(context as never, djvuPath as never, outputPath, {
                    jobId,
                    pdfStrategy: 'direct',
                    preserveBookmarks: false,
                }),
            ).resolves.toMatchObject({
                success: false,
                jobId,
                error: 'ddjvu child not proven dead',
            });

            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 0,
                queued: 0,
            });
            const retrySlot = await mainJobBroker.acquire({
                ownerId: jobId,
                kind: 'djvu-output',
                priority: 'user',
                perOwnerLimit: 1,
                resources: {
                    cpuTokens: 0,
                    estimatedResidentBytes: 0,
                    nativeProcesses: 0,
                    ioWeight: 0,
                },
            });
            expect(retrySlot.release()).toBe(true);
        } finally {
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
    });

    it('releases the export metadata DPI broker lease when delayed termination proof resolves true', async () => {
        const {handleDjvuConvertToPdf} = await vi.importActual<typeof TPdfExportModule>('@electron/features/djvu/main/pdfExport');
        const {withDjvuNativeResourceLease} = await vi.importActual<typeof TDdjvuConversionModule>(
            '@electron/features/djvu/main/ddjvuConversion',
        );
        const {allowDjvuWritePath} = await import('@electron/features/djvu/main/exportPaths');
        const directory = mkdtempSync(join(tmpdir(), 'djvu-metadata-dpi-proof-'));
        const djvuPath = join(directory, 'book.djvu');
        const outputPath = join(directory, 'book.pdf');
        writeFileSync(djvuPath, readFileSync(join(DJVU_FIXTURE_SOURCES, 'layered.djvu')));
        const senderId = 105;
        const event = createIpcEvent(senderId);
        const context = {
            ...event,
            senderId,
        };
        allowDjvuWritePath(outputPath, senderId);
        const jobId = requireJobId('djvu-convert-dpi-proof');
        const delayedProof = createDeferred<boolean>();
        const dpiError = markUnprovenNativeTermination(new Error('djvused dpi watchdog expired'), 'djvused dpi tree not proven dead yet');

        mocks.withDjvuNativeResourceLease.mockImplementation(withDjvuNativeResourceLease);
        mocks.getDjvuPageCount.mockResolvedValueOnce(1);
        mocks.getDjvuResolution.mockImplementationOnce(
            async (_path: string, options?: {onTerminationProof?: (proof: Promise<boolean>) => void}) => {
                options?.onTerminationProof?.(delayedProof.promise);
                throw dpiError;
            },
        );

        const competitorState: {lease: {release: () => boolean} | null} = {lease: null};
        try {
            await expect(
                handleDjvuConvertToPdf(context as never, djvuPath as never, outputPath, {
                    jobId,
                    pdfStrategy: 'direct',
                    preserveBookmarks: false,
                }),
            ).resolves.toMatchObject({
                success: false,
                jobId,
                error: 'djvused dpi watchdog expired',
            });

            const capacity = mainJobBroker.getSnapshot().capacity;
            let competitorGranted = false;
            const competitor = mainJobBroker
                .acquire({
                    ownerId: 'competitor-after-dpi',
                    kind: 'djvu-conversion',
                    priority: 'user',
                    resources: capacity,
                })
                .then((lease) => {
                    competitorGranted = true;
                    competitorState.lease = lease;
                    return lease;
                });
            void competitor.catch(() => undefined);

            await Promise.resolve();
            expect(competitorGranted).toBe(false);
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 1,
                queued: 1,
                used: {
                    cpuTokens: 1,
                    nativeProcesses: 0,
                    ioWeight: 1,
                },
            });

            delayedProof.resolve(true);
            const competitorLease = await competitor;
            expect(competitorGranted).toBe(true);
            expect(competitorLease.release()).toBe(true);
            competitorState.lease = null;
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 0,
                queued: 0,
            });
        } finally {
            mainJobBroker.cancelOwner('competitor-after-dpi');
            competitorState.lease?.release();
            delayedProof.resolve(true);
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
    });

    it('preserves unproven termination in getDjvuConversionPageSizes even when the conversion signal is aborted', async () => {
        const {handleDjvuCancel, handleDjvuConvertToPdf} = await vi.importActual<typeof TPdfExportModule>(
            '@electron/features/djvu/main/pdfExport',
        );
        const {withDjvuNativeResourceLease} = await vi.importActual<typeof TDdjvuConversionModule>(
            '@electron/features/djvu/main/ddjvuConversion',
        );
        const {allowDjvuWritePath} = await import('@electron/features/djvu/main/exportPaths');
        const directory = mkdtempSync(join(tmpdir(), 'djvu-page-sizes-unproven-'));
        const djvuPath = join(directory, 'book.djvu');
        const outputPath = join(directory, 'book.pdf');
        writeFileSync(djvuPath, readFileSync(join(DJVU_FIXTURE_SOURCES, 'layered.djvu')));
        const senderId = 106;
        const event = createIpcEvent(senderId);
        const context = {
            ...event,
            senderId,
        };
        allowDjvuWritePath(outputPath, senderId);
        const jobId = requireJobId('djvu-convert-page-sizes-proof');
        const probeStarted = createDeferred<void>();
        const releaseProbe = createDeferred<void>();
        const delayedProof = createDeferred<boolean>();
        const sizeProbeError = markUnprovenNativeTermination(
            new Error('djvused page-sizes watchdog expired'),
            'djvused page-sizes tree not proven dead yet',
        );

        mocks.withDjvuNativeResourceLease.mockImplementation(withDjvuNativeResourceLease);
        mocks.getDjvuPageCount.mockResolvedValueOnce(1);
        mocks.getDjvuResolution.mockResolvedValueOnce(300);
        mocks.cancelConversion.mockResolvedValue(true);
        mocks.getDjvuPageSizesForViewing.mockImplementationOnce(
            async (
                _path: string,
                _count: number,
                options?: {
                    signal?: AbortSignal;
                    onTerminationProof?: (proof: Promise<boolean>) => void;
                },
            ) => {
                probeStarted.resolve(undefined);
                await releaseProbe.promise;
                expect(options?.signal?.aborted).toBe(true);
                options?.onTerminationProof?.(delayedProof.promise);
                throw sizeProbeError;
            },
        );

        const competitorState: {lease: {release: () => boolean} | null} = {lease: null};
        try {
            const convertPromise = handleDjvuConvertToPdf(context as never, djvuPath as never, outputPath, {
                jobId,
                pdfStrategy: 'direct',
                preserveBookmarks: false,
            });
            await Promise.race([
                probeStarted.promise,
                convertPromise.then((earlyResult) => {
                    throw new Error(`DjVu conversion exited before page-size probe started: ${JSON.stringify(earlyResult)}`);
                }),
            ]);

            const cancelPromise = handleDjvuCancel(context as never, jobId);
            await vi.waitFor(() => expect(mocks.cancelConversion).toHaveBeenCalledWith(jobId));
            releaseProbe.resolve(undefined);

            await expect(cancelPromise).resolves.toEqual({canceled: true});
            await expect(convertPromise).resolves.toMatchObject({
                success: false,
                jobId,
                error: 'DjVu conversion canceled',
            });

            const capacity = mainJobBroker.getSnapshot().capacity;
            let competitorGranted = false;
            const competitor = mainJobBroker
                .acquire({
                    ownerId: 'competitor-after-page-sizes',
                    kind: 'djvu-conversion',
                    priority: 'user',
                    resources: capacity,
                })
                .then((lease) => {
                    competitorGranted = true;
                    competitorState.lease = lease;
                    return lease;
                });
            void competitor.catch(() => undefined);

            await Promise.resolve();
            expect(competitorGranted).toBe(false);
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 1,
                queued: 1,
                used: {
                    cpuTokens: 1,
                    nativeProcesses: 0,
                    ioWeight: 1,
                },
            });

            delayedProof.resolve(true);
            const competitorLease = await competitor;
            expect(competitorGranted).toBe(true);
            expect(competitorLease.release()).toBe(true);
            competitorState.lease = null;
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 0,
                queued: 0,
            });
        } finally {
            mainJobBroker.cancelOwner('competitor-after-page-sizes');
            competitorState.lease?.release();
            releaseProbe.resolve(undefined);
            delayedProof.resolve(true);
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
    });

    it('releases the compact export detectDjvuHasText metadata lease once delayed termination proof resolves true', async () => {
        const {handleDjvuConvertToPdf} = await vi.importActual<typeof TPdfExportModule>('@electron/features/djvu/main/pdfExport');
        const {withDjvuNativeResourceLease} = await vi.importActual<typeof TDdjvuConversionModule>(
            '@electron/features/djvu/main/ddjvuConversion',
        );
        const {allowDjvuWritePath} = await import('@electron/features/djvu/main/exportPaths');
        const directory = mkdtempSync(join(tmpdir(), 'djvu-compact-has-text-proof-'));
        const djvuPath = join(directory, 'book.djvu');
        const outputPath = join(directory, 'book.pdf');
        writeFileSync(djvuPath, readFileSync(join(DJVU_FIXTURE_SOURCES, 'layered.djvu')));
        const senderId = 107;
        const event = createIpcEvent(senderId);
        const context = {
            ...event,
            senderId,
        };
        allowDjvuWritePath(outputPath, senderId);
        const jobId = requireJobId('djvu-convert-has-text-proof');
        const delayedProof = createDeferred<boolean>();
        const hasTextError = markUnprovenNativeTermination(
            new Error('djvused text probe watchdog expired'),
            'djvused text probe tree not proven dead yet',
        );

        mocks.withDjvuNativeResourceLease.mockImplementation(withDjvuNativeResourceLease);
        mocks.getDjvuPageCount.mockResolvedValueOnce(1);
        mocks.getDjvuResolution.mockResolvedValueOnce(300);
        mocks.getDjvuPageSizesForViewing.mockResolvedValueOnce([
            {
                width: 100,
                height: 200,
                dpi: 300,
            },
        ]);
        mocks.buildCompactDjvuAwarePdfFromDjvu.mockImplementationOnce(async (options: {outputPath: string}) => ({
            success: true,
            outputPath: options.outputPath,
            fileSize: 16,
        }));
        mocks.detectDjvuHasText.mockImplementationOnce(
            async (_path: string, _signal?: AbortSignal, onTerminationProof?: (proof: Promise<boolean>) => void) => {
                onTerminationProof?.(delayedProof.promise);
                throw hasTextError;
            },
        );

        const competitorState: {lease: {release: () => boolean} | null} = {lease: null};
        try {
            await expect(
                handleDjvuConvertToPdf(context as never, djvuPath as never, outputPath, {
                    jobId,
                    pdfStrategy: 'compact-djvu-aware',
                    preserveBookmarks: false,
                }),
            ).resolves.toMatchObject({
                success: false,
                jobId,
                error: 'djvused text probe watchdog expired',
            });

            const capacity = mainJobBroker.getSnapshot().capacity;
            let competitorGranted = false;
            const competitor = mainJobBroker
                .acquire({
                    ownerId: 'competitor-after-has-text',
                    kind: 'djvu-conversion',
                    priority: 'user',
                    resources: capacity,
                })
                .then((lease) => {
                    competitorGranted = true;
                    competitorState.lease = lease;
                    return lease;
                });
            void competitor.catch(() => undefined);

            await Promise.resolve();
            expect(competitorGranted).toBe(false);
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 1,
                queued: 1,
                used: {
                    cpuTokens: 1,
                    nativeProcesses: 0,
                    ioWeight: 1,
                },
            });

            delayedProof.resolve(true);
            const competitorLease = await competitor;
            expect(competitorGranted).toBe(true);
            expect(competitorLease.release()).toBe(true);
            competitorState.lease = null;
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 0,
                queued: 0,
            });
        } finally {
            mainJobBroker.cancelOwner('competitor-after-has-text');
            competitorState.lease?.release();
            delayedProof.resolve(true);
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
    });

    it('holds the initiator broker lease when handleDjvuGetPageSourceInfo starts a shared probe joined by renderDjvuPagePreview', async () => {
        const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const {withDjvuNativeResourceLease} = await vi.importActual<typeof TDdjvuConversionModule>(
            '@electron/features/djvu/main/ddjvuConversion',
        );
        const actualPagePreview = await vi.importActual<typeof TPagePreviewModule>('@electron/features/djvu/main/pagePreview');
        const directory = mkdtempSync(join(tmpdir(), 'djvu-shared-source-info-proof-'));
        const djvuPath = join(directory, 'book.djvu');
        const senderId = 108;
        const event = createIpcEvent(senderId);
        const context = {
            ...event,
            senderId,
        };
        const probeStarted = createDeferred<void>();
        const releaseProbe = createDeferred<void>();
        const delayedProof = createDeferred<boolean>();
        const unprovenError = markUnprovenNativeTermination(
            new Error('djvused shared page-source probe watchdog expired'),
            'djvused shared page-source tree not proven dead yet',
        );
        const competitorState: {lease: {release: () => boolean} | null} = {lease: null};

        try {
            writeFileSync(djvuPath, readFileSync(join(DJVU_FIXTURE_SOURCES, 'layered.djvu')));
            allowOpenPath(djvuPath, event.sender as never);
            mocks.withDjvuNativeResourceLease.mockImplementation(withDjvuNativeResourceLease);
            mocks.getDjvuPageSourceInfoForViewing.mockImplementationOnce(actualPagePreview.getDjvuPageSourceInfoForViewing);
            mocks.renderDjvuPagePreview.mockImplementationOnce(actualPagePreview.renderDjvuPagePreview);
            mocks.getDjvuPageCount.mockImplementationOnce(
                async (_path: string, options?: {onTerminationProof?: (proof: Promise<boolean>) => void}) => {
                    probeStarted.resolve(undefined);
                    await releaseProbe.promise;
                    options?.onTerminationProof?.(delayedProof.promise);
                    throw unprovenError;
                },
            );

            const initiatorPromise = handleDjvuGetPageSourceInfo(context as never, djvuPath, 1);
            void initiatorPromise.catch(() => undefined);
            await Promise.race([
                probeStarted.promise,
                initiatorPromise.then((earlyResult) => {
                    throw new Error(`handleDjvuGetPageSourceInfo settled before probe started: ${JSON.stringify(earlyResult)}`);
                }),
            ]);

            const joinerPromise = handleDjvuRenderPagePreview(context as never, djvuPath, 1, {subsample: 2});
            void joinerPromise.catch(() => undefined);
            await vi.waitFor(() => expect(mainJobBroker.getSnapshot().active).toBe(2));
            expect(mocks.getDjvuPageCount).toHaveBeenCalledTimes(1);

            releaseProbe.resolve(undefined);
            const initiatorError = await initiatorPromise.then(
                () => {
                    throw new Error('Expected initiatorPromise to reject');
                },
                (error: unknown) => error,
            );
            const joinerError = await joinerPromise.then(
                () => {
                    throw new Error('Expected joinerPromise to reject');
                },
                (error: unknown) => error,
            );

            expect(initiatorError).toBe(unprovenError);
            expect(joinerError).toBeInstanceOf(Error);
            expect(getUnprovenNativeTerminationDetail(joinerError)).toBeUndefined();

            const capacity = mainJobBroker.getSnapshot().capacity;
            let competitorGranted = false;
            const competitor = mainJobBroker
                .acquire({
                    ownerId: 'competitor-after-shared-source-info',
                    kind: 'djvu-conversion',
                    priority: 'user',
                    resources: capacity,
                })
                .then((lease) => {
                    competitorGranted = true;
                    competitorState.lease = lease;
                    return lease;
                });
            void competitor.catch(() => undefined);

            await Promise.resolve();
            expect(competitorGranted).toBe(false);
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 1,
                queued: 1,
                used: {
                    cpuTokens: 1,
                    nativeProcesses: 0,
                    ioWeight: 1,
                },
            });

            delayedProof.resolve(true);
            const competitorLease = await competitor;
            expect(competitorGranted).toBe(true);
            expect(competitorLease.release()).toBe(true);
            competitorState.lease = null;
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 0,
                queued: 0,
            });
        } finally {
            mainJobBroker.cancelOwner('competitor-after-shared-source-info');
            competitorState.lease?.release();
            releaseProbe.resolve(undefined);
            delayedProof.resolve(true);
            actualPagePreview.clearDjvuPageSizeCacheForTests();
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
    });

    it('holds DjVu bookmark worker broker charges during cancel until delayed termination proof resolves true', async () => {
        const {handleDjvuCancel, handleDjvuConvertToPdf} = await vi.importActual<typeof TPdfExportModule>(
            '@electron/features/djvu/main/pdfExport',
        );
        const {allowDjvuWritePath} = await import('@electron/features/djvu/main/exportPaths');
        const directory = mkdtempSync(join(tmpdir(), 'djvu-bookmark-cancel-proof-'));
        const djvuPath = join(directory, 'book.djvu');
        const outputPath = join(directory, 'book.pdf');
        writeFileSync(djvuPath, readFileSync(join(DJVU_FIXTURE_SOURCES, 'layered.djvu')));
        const senderId = 109;
        const event = createIpcEvent(senderId);
        const context = {
            ...event,
            senderId,
        };
        allowDjvuWritePath(outputPath, senderId);
        const jobId = requireJobId('djvu-convert-bookmark-cancel-proof');
        const bookmarkStarted = createDeferred<void>();
        const delayedProof = createDeferred<boolean>();
        const bookmarkError = markUnprovenNativeTermination(
            new Error('qpdf bookmark worker terminated without proof'),
            'qpdf bookmark child remains alive',
        );

        mocks.getDjvuPageCount.mockResolvedValueOnce(1);
        mocks.getDjvuResolution.mockResolvedValueOnce(300);
        mocks.getDjvuPageSizesForViewing.mockResolvedValueOnce([
            {
                width: 100,
                height: 200,
                dpi: 300,
            },
        ]);
        mocks.buildCompactDjvuAwarePdfFromDjvu.mockImplementationOnce(async (options: {outputPath: string}) => {
            writeFileSync(options.outputPath, '%PDF-1.4\n');
            return {
                success: true,
                outputPath: options.outputPath,
                fileSize: 9,
            };
        });
        mocks.detectDjvuHasText.mockResolvedValueOnce(true);
        mocks.getDjvuOutlineBookmarks.mockResolvedValueOnce([
            {
                title: 'Chapter 1',
                pageIndex: 0,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            },
        ]);
        mocks.embedBookmarksIntoPdfFile = (_inputPdfPath, _outputPdfPath, _bookmarks, signal, brokerRun) => {
            bookmarkStarted.resolve(undefined);
            return new Promise<number>((_resolve, reject) => {
                const rejectUnproven = () => {
                    brokerRun?.onTerminationProof?.(delayedProof.promise);
                    reject(bookmarkError);
                };
                if (signal?.aborted) {
                    rejectUnproven();
                    return;
                }
                signal?.addEventListener('abort', rejectUnproven, {once: true});
            });
        };

        const competitorState: {lease: {release: () => boolean} | null} = {lease: null};
        try {
            const convertPromise = handleDjvuConvertToPdf(context as never, djvuPath as never, outputPath, {
                jobId,
                pdfStrategy: 'compact-djvu-aware',
                preserveBookmarks: true,
            });

            await bookmarkStarted.promise;

            const cancelPromise = handleDjvuCancel(context as never, jobId);
            await expect(cancelPromise).resolves.toEqual({canceled: true});
            await expect(convertPromise).resolves.toMatchObject({
                success: false,
                jobId,
                error: 'DjVu conversion canceled',
            });

            const capacity = mainJobBroker.getSnapshot().capacity;
            let competitorGranted = false;
            const competitor = mainJobBroker
                .acquire({
                    ownerId: 'competitor-after-bookmarks',
                    kind: 'djvu-conversion',
                    priority: 'user',
                    resources: capacity,
                })
                .then((lease) => {
                    competitorGranted = true;
                    competitorState.lease = lease;
                    return lease;
                });
            void competitor.catch(() => undefined);

            await Promise.resolve();
            expect(competitorGranted).toBe(false);
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 1,
                queued: 1,
                used: {
                    cpuTokens: 1,
                    nativeProcesses: 1,
                    ioWeight: 3,
                },
            });

            delayedProof.resolve(true);
            const competitorLease = await competitor;
            expect(competitorGranted).toBe(true);
            expect(competitorLease.release()).toBe(true);
            competitorState.lease = null;
            expect(mainJobBroker.getSnapshot()).toMatchObject({
                active: 0,
                queued: 0,
            });
        } finally {
            mainJobBroker.cancelOwner('competitor-after-bookmarks');
            competitorState.lease?.release();
            bookmarkStarted.resolve(undefined);
            delayedProof.resolve(true);
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
    });
});
