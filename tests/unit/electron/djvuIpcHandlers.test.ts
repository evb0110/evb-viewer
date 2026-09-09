import type * as TViMockOriginalModule from '@electron/features/djvu/main/parseDjvuOutline';

import type { TRegisteredHandler } from '@tests/unit/electron/helpers/ipcRegistryHarness';
import {
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireRequestId} from '@contracts/shared';
import type {ISearchDjvuTextOptions} from '@electron/features/djvu/main/textSearch';
import { DJVU_PLATFORM_FEATURE } from '@contracts/djvuPlatformFeature';
import { registerPlatformFeatureHandlers } from '@electron/platform-ipc/validatedIpcRegistrar';
import {
    createDeferred,
    createTestEventSender,
} from '@tests/helpers/electronEventEmitterHarness';

const mocks = vi.hoisted(() => ({
    handlers: new Map<string, TRegisteredHandler>(),
    ipcHandle: vi.fn<(channel: string, handler: TRegisteredHandler) => void>(),
    estimateSizes: vi.fn(),
    getDjvuPageCount: vi.fn(),
    getDjvuResolution: vi.fn(),
    getDjvuOutline: vi.fn(),
    getDjvuHasText: vi.fn(),
    getDjvuMetadata: vi.fn(),
    parseDjvuOutline: vi.fn(),
    handleDjvuConvertToPdf: vi.fn(),
    handleDjvuCancel: vi.fn(),
    handleDjvuOpenForViewing: vi.fn(),
    getDjvuOutputJobState: vi.fn(),
    subscribeDjvuOutputJob: vi.fn(),
    subscribeDjvuProgress: vi.fn(),
    cancelConversion: vi.fn(),
    isAllowedDjvuViewingPath: vi.fn(),
    getDjvuPageSizesForViewing: vi.fn(),
    getDjvuPageSourceInfoForViewing: vi.fn(),
    renderDjvuPagePreview: vi.fn(),
    releaseDjvuViewingPath: vi.fn(),
    cleanupDjvuTempPdfPath: vi.fn(),
    pruneStaleDjvuArtifactJobs: vi.fn(),
    getRecentFiles: vi.fn(),
    readDjvuPageText: vi.fn(),
    searchDjvuText: vi.fn(),
    safeSendToWindow: vi.fn(),
    senderSend: vi.fn(),
    hostResourceTier: 'high' as 'low' | 'medium' | 'high',
}));

vi.mock('electron', () => ({
    app: {
        isPackaged: false,
        getPath: vi.fn(() => '/tmp'),
    },
    BrowserWindow: {fromWebContents: vi.fn(() => null)},
    ipcMain: {handle: (channel: string, handler: TRegisteredHandler) => {
        mocks.ipcHandle(channel, handler);
        mocks.handlers.set(channel, handler);
    }},
}));

vi.mock('@electron/features/djvu/main/estimateSizes', () => ({estimateSizes: mocks.estimateSizes}));
vi.mock('@electron/features/djvu/main/metadata', () => ({
    getDjvuPageCount: mocks.getDjvuPageCount,
    getDjvuResolution: mocks.getDjvuResolution,
    getDjvuOutline: mocks.getDjvuOutline,
    getDjvuHasText: mocks.getDjvuHasText,
    getDjvuMetadata: mocks.getDjvuMetadata,
}));
vi.mock('@electron/features/djvu/main/parseDjvuOutline', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    parseDjvuOutline: mocks.parseDjvuOutline,
}));
vi.mock('@electron/features/djvu/main/pdfExport', () => ({
    handleDjvuConvertToPdf: mocks.handleDjvuConvertToPdf,
    handleDjvuCancel: mocks.handleDjvuCancel,
    getDjvuOutputJobState: mocks.getDjvuOutputJobState,
    subscribeDjvuOutputJob: mocks.subscribeDjvuOutputJob,
    subscribeDjvuProgress: mocks.subscribeDjvuProgress,
}));
vi.mock('@electron/features/djvu/main/viewing', () => ({
    handleDjvuOpenForViewing: mocks.handleDjvuOpenForViewing,
    isAllowedDjvuViewingPath: mocks.isAllowedDjvuViewingPath,
    releaseDjvuViewingPath: mocks.releaseDjvuViewingPath,
    cleanupDjvuTempPdfPath: mocks.cleanupDjvuTempPdfPath,
}));
vi.mock('@electron/features/djvu/main/djvuArtifactManifest', () => ({pruneStaleDjvuArtifactJobs: mocks.pruneStaleDjvuArtifactJobs}));
vi.mock('@electron/recentFiles', () => ({getRecentFiles: mocks.getRecentFiles}));
vi.mock('@electron/features/djvu/main/pagePreview', () => ({
    getDjvuPageSourceInfoForViewing: mocks.getDjvuPageSourceInfoForViewing,
    getDjvuPageSizesForViewing: mocks.getDjvuPageSizesForViewing,
    renderDjvuPagePreview: mocks.renderDjvuPagePreview,
}));
vi.mock('@electron/features/djvu/main/ddjvuConversion', () => ({cancelConversion: mocks.cancelConversion}));
vi.mock('@electron/features/djvu/main/textSearch', () => ({
    readDjvuPageText: mocks.readDjvuPageText,
    searchDjvuText: mocks.searchDjvuText,
}));
vi.mock('@electron/features/djvu/main/safeSendToWindow', () => ({safeSendToWindow: mocks.safeSendToWindow}));
vi.mock('@electron/resources/hostResourceProfile', () => ({getHostResourceProfileSnapshot: () => ({
    logicalCpus: 8,
    totalRamBytes: 16 * 1024 * 1024 * 1024,
    safeMode: false,
    detectedTier: mocks.hostResourceTier,
    performanceMode: 'auto',
    tier: mocks.hostResourceTier,
})}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));
const {resolveDjvuPreviewBrokerPriority} = await import('@electron/features/djvu/main/djvuOperations');
const {prepareDjvuMainBindings} = await import('@electron/features/djvu/mainBindings');
const { configureMainJobBroker } = await import('@electron/resources/jobBroker');

function registerDjvuIpcAdapter() {
    registerPlatformFeatureHandlers(
        {handle: (channel: string, handler: TRegisteredHandler) => {
            mocks.ipcHandle(channel, handler);
            mocks.handlers.set(channel, handler);
        }} as never,
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

async function createAuthorizedSearchHarness(senderId: number) {
    const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-search-progress-test-'));
    const realPath = join(tempRoot, 'real.djvu');
    writeFileSync(realPath, new Uint8Array([1]));
    const event = createIpcEvent(senderId);
    const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
    allowOpenPath(realPath, event.sender as never);
    registerDjvuIpcAdapter();
    return {
        event,
        realPath,
        cleanup() {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        },
    };
}

function getSentTextSearchProgress() {
    return mocks.senderSend.mock.calls.flatMap(([
        channel,
        payload,
    ]) => channel === 'djvu:text:progress' ? [payload as {
        processed: number;
        status: string
    }] : []);
}

interface IPreviewResult {
    bytes: Uint8Array;
    width: number;
    height: number;
}

function createPendingPreviews(count: number) {
    const previews = Array.from({length: count}, () => createDeferred<IPreviewResult>());
    previews.forEach(preview => mocks.renderDjvuPagePreview.mockReturnValueOnce(preview.promise));
    return previews;
}

function resolvePreview(
    preview: ReturnType<typeof createDeferred<IPreviewResult>>,
    byte: number,
) {
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
        delete process.env.EVB_DJVU_SWEEP_STALE_TEMP;
        mocks.hostResourceTier = 'high';

        mocks.getDjvuPageCount.mockResolvedValue(1);
        mocks.getDjvuResolution.mockResolvedValue(300);
        mocks.getDjvuOutline.mockResolvedValue('');
        mocks.getDjvuHasText.mockResolvedValue(true);
        mocks.getDjvuMetadata.mockResolvedValue({});
        mocks.parseDjvuOutline.mockReturnValue([]);
        mocks.readDjvuPageText.mockResolvedValue('');
        mocks.estimateSizes.mockReturnValue([]);
        mocks.handleDjvuConvertToPdf.mockResolvedValue({success: true});
        mocks.handleDjvuCancel.mockResolvedValue({canceled: true});
        mocks.handleDjvuOpenForViewing.mockResolvedValue({success: true});
        mocks.cancelConversion.mockResolvedValue(true);
        mocks.isAllowedDjvuViewingPath.mockReturnValue(true);
        mocks.getDjvuPageSizesForViewing.mockResolvedValue([{
            width: 100,
            height: 200,
            dpi: 300,
        }]);
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
        mocks.searchDjvuText.mockResolvedValue({
            results: [],
            truncated: false,
        });
    });

    it('prunes only manifest-owned stale artifact jobs during registration', () => {
        registerDjvuIpcAdapter();

        expect(mocks.pruneStaleDjvuArtifactJobs).toHaveBeenCalledOnce();
    });

    it('allows manifest pruning to be disabled for deterministic hosts', () => {
        process.env.EVB_DJVU_SWEEP_STALE_TEMP = '0';

        registerDjvuIpcAdapter();

        expect(mocks.pruneStaleDjvuArtifactJobs).not.toHaveBeenCalled();
    });

    it('runs a full-document text search through one authorized native operation', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-text-search-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const canonicalRealPath = realpathSync.native(realPath);
            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(1);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            mocks.searchDjvuText.mockResolvedValue({
                results: [{
                    pageNumber: 9,
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

            await expect(getHandler('djvu:text:search')(
                event,
                realPath,
                'needle',
                {
                    requestId: 'native-search',
                    pageCount: 431,
                    matchCase: false,
                    wholeWord: true,
                    useRegex: false,
                },
            )).resolves.toMatchObject({results: [{pageNumber: 9}]});

            expect(mocks.searchDjvuText).toHaveBeenCalledOnce();
            expect(mocks.searchDjvuText).toHaveBeenCalledWith(
                canonicalRealPath,
                expect.objectContaining({
                    requestId: 'native-search',
                    pageCount: 431,
                    query: 'needle',
                    matchOptions: {
                        matchCase: false,
                        wholeWord: true,
                        useRegex: false,
                    },
                    signal: expect.any(AbortSignal),
                }),
            );
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('reports the actual early-truncation page without inflating terminal success progress', async () => {
        const harness = await createAuthorizedSearchHarness(21);
        try {
            mocks.searchDjvuText.mockImplementation(async (
                _path: string,
                options: ISearchDjvuTextOptions,
            ) => {
                options.onProgress?.({
                    requestId: options.requestId,
                    processed: 32,
                    total: options.pageCount,
                    status: 'running',
                });
                options.onPageProcessed?.(37);
                return {
                    results: [],
                    truncated: true,
                };
            });

            await expect(getHandler('djvu:text:search')(
                harness.event,
                harness.realPath,
                'needle',
                {
                    requestId: 'truncated-progress',
                    pageCount: 431,
                },
            )).resolves.toMatchObject({truncated: true});

            const progress = getSentTextSearchProgress();
            expect(progress.map(item => item.processed)).toEqual([
                32,
                37,
            ]);
            expect(progress.at(-1)).toEqual(expect.objectContaining({
                processed: 37,
                status: 'success',
            }));
        } finally {
            harness.cleanup();
        }
    });

    it('keeps canceled terminal progress at the last actually processed page', async () => {
        const harness = await createAuthorizedSearchHarness(22);
        try {
            mocks.searchDjvuText.mockImplementation(async (
                _path: string,
                options: ISearchDjvuTextOptions,
            ) => {
                options.onProgress?.({
                    requestId: options.requestId,
                    processed: 16,
                    total: options.pageCount,
                    status: 'running',
                });
                options.onPageProcessed?.(23);
                throw new DOMException('Operation aborted', 'AbortError');
            });

            await expect(getHandler('djvu:text:search')(
                harness.event,
                harness.realPath,
                'needle',
                {
                    requestId: 'canceled-progress',
                    pageCount: 431,
                },
            )).resolves.toMatchObject({canceled: true});

            const progress = getSentTextSearchProgress();
            expect(progress.map(item => item.processed)).toEqual([
                16,
                23,
            ]);
            expect(progress.at(-1)).toEqual(expect.objectContaining({
                processed: 23,
                status: 'canceled',
            }));
        } finally {
            harness.cleanup();
        }
    });

    it('suppresses stale progress and terminal events after a native request ID is superseded', async () => {
        const harness = await createAuthorizedSearchHarness(24);
        const runs = [
            createDeferred<{
                results: [];
                truncated: false
            }>(),
            createDeferred<{
                results: [];
                truncated: false
            }>(),
            createDeferred<{
                results: [];
                truncated: false
            }>(),
        ];
        const searchOptions: ISearchDjvuTextOptions[] = [];
        try {
            mocks.searchDjvuText.mockImplementation((
                _path: string,
                options: ISearchDjvuTextOptions,
            ) => {
                searchOptions.push(options);
                return runs[searchOptions.length - 1]!.promise;
            });
            const handler = getHandler('djvu:text:search');
            const request = {
                requestId: requireRequestId('reused-native-search'),
                pageCount: 431,
            };

            const firstRun = handler(harness.event, harness.realPath, 'first', request);
            await vi.waitFor(() => expect(searchOptions).toHaveLength(1));
            const secondRun = handler(harness.event, harness.realPath, 'second', request);
            await vi.waitFor(() => expect(searchOptions).toHaveLength(2));
            const currentRun = handler(harness.event, harness.realPath, 'current', request);
            await vi.waitFor(() => expect(searchOptions).toHaveLength(3));

            expect(searchOptions[0]!.signal!.aborted).toBe(true);
            expect(searchOptions[1]!.signal!.aborted).toBe(true);
            expect(searchOptions[2]!.signal!.aborted).toBe(false);

            searchOptions[0]!.onProgress?.({
                requestId: request.requestId,
                processed: 101,
                total: request.pageCount,
                status: 'running',
            });
            searchOptions[1]!.onProgress?.({
                requestId: request.requestId,
                processed: 202,
                total: request.pageCount,
                status: 'running',
            });
            searchOptions[2]!.onProgress?.({
                requestId: request.requestId,
                processed: 3,
                total: request.pageCount,
                status: 'running',
            });

            runs[0]!.reject(new DOMException('Operation aborted', 'AbortError'));
            runs[1]!.resolve({
                results: [],
                truncated: false,
            });
            runs[2]!.resolve({
                results: [],
                truncated: false,
            });

            await expect(firstRun).resolves.toMatchObject({canceled: true});
            await expect(secondRun).resolves.toMatchObject({canceled: true});
            await expect(currentRun).resolves.toEqual({
                results: [],
                truncated: false,
            });

            const progress = getSentTextSearchProgress();
            expect(progress.map(item => item.processed)).toEqual([
                3,
                3,
            ]);
            expect(progress.map(item => item.status)).toEqual([
                'running',
                'success',
            ]);
        } finally {
            harness.cleanup();
        }
    });

    it('keeps failed terminal progress at the last actually processed page', async () => {
        const harness = await createAuthorizedSearchHarness(23);
        try {
            mocks.searchDjvuText.mockImplementation(async (
                _path: string,
                options: ISearchDjvuTextOptions,
            ) => {
                options.onProgress?.({
                    requestId: options.requestId,
                    processed: 24,
                    total: options.pageCount,
                    status: 'running',
                });
                options.onPageProcessed?.(41);
                throw new Error('native parser failed');
            });

            await expect(getHandler('djvu:text:search')(
                harness.event,
                harness.realPath,
                'needle',
                {
                    requestId: 'failed-progress',
                    pageCount: 431,
                },
            )).rejects.toThrow('native parser failed');

            const progress = getSentTextSearchProgress();
            expect(progress.map(item => item.processed)).toEqual([
                24,
                41,
            ]);
            expect(progress.at(-1)).toEqual(expect.objectContaining({
                processed: 41,
                status: 'failed',
            }));
        } finally {
            harness.cleanup();
        }
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
            '/tmp/missing.djvu',
        );
    });

    it('releases symlinked viewing paths using the granted realpath while the source still exists', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-release-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            const symlinkPath = join(tempRoot, 'link.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            symlinkSync(realPath, symlinkPath);
            const canonicalRealPath = realpathSync.native(realPath);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
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
                canonicalRealPath,
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

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
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

    it('returns native page text and maps a nested outline to interactive provider shape', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-provider-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(1);
            allowOpenPath(realPath, event.sender as never);
            mocks.readDjvuPageText.mockResolvedValue('Native page text');
            mocks.getDjvuOutline.mockResolvedValue('(bookmarks)');
            mocks.parseDjvuOutline.mockReturnValue([{
                title: 'Chapter',
                pageIndex: 0,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [{
                    title: 'Section',
                    pageIndex: 2,
                    namedDest: null,
                    bold: false,
                    italic: false,
                    color: null,
                    items: [],
                }],
            }]);
            registerDjvuIpcAdapter();

            await expect(getHandler('djvu:getPageText')(event, realPath, 3))
                .resolves
                .toBe('Native page text');
            await expect(getHandler('djvu:getOutline')(event, realPath))
                .resolves
                .toEqual([{
                    title: 'Chapter',
                    pageNumber: 1,
                    children: [{
                        title: 'Section',
                        pageNumber: 3,
                        children: [],
                    }],
                }]);
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('probes only the prioritized page size when creating a viewing source', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-source-info-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const canonicalRealPath = realpathSync.native(realPath);
            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
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

            expect(mocks.getDjvuPageSourceInfoForViewing).toHaveBeenCalledWith(canonicalRealPath, 7);
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
            const canonicalRealPath = realpathSync.native(realPath);
            mocks.getRecentFiles.mockResolvedValue([{
                originalPath: realPath,
                fileName: 'recent.djvu',
                timestamp: 1,
            }]);
            registerDjvuIpcAdapter();

            await expect(getHandler('djvu:getPageSourceInfo')(
                createIpcEvent(1),
                realPath,
                1,
            )).resolves.toMatchObject({
                pageCount: 1,
                pageNumber: 1,
            });

            expect(mocks.getDjvuPageSourceInfoForViewing).toHaveBeenCalledWith(canonicalRealPath, 1);
            expect(mocks.isAllowedDjvuViewingPath).not.toHaveBeenCalled();
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects opening geometry prewarm for an ungranted DjVu outside the persisted Recent list', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-untrusted-source-info-test-'));
        try {
            const realPath = join(tempRoot, 'untrusted.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            registerDjvuIpcAdapter();

            await expect(getHandler('djvu:getPageSourceInfo')(
                createIpcEvent(1),
                realPath,
                1,
            )).rejects.toThrow('Path not allowed');

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
            const canonicalRealPath = realpathSync.native(realPath);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
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
                canonicalRealPath,
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
        [
            'low',
            1,
        ],
        [
            'medium',
            2,
        ],
        [
            'high',
            2,
        ],
    ] as const)('caps %s-tier native previews at %i per sender', async (tier, maxInFlight) => {
        const tempRoot = mkdtempSync(join(tmpdir(), `evb-djvu-${tier}-preview-cap-test-`));
        try {
            mocks.hostResourceTier = tier;
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const previews = createPendingPreviews(maxInFlight + 1);
            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(30);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:renderPagePreview');
            const runs = previews.map((_preview, index) => handler(
                event,
                realPath,
                index + 1,
                {previewRequestId: `${tier}-preview-${index}`},
            ));

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
            const [
                firstPreview,
                secondPreview,
            ] = createPendingPreviews(2);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
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
            const [
                firstPreview,
                secondPreview,
            ] = createPendingPreviews(2);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
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
        const codec = DJVU_PLATFORM_FEATURE.ipcCodecs[
            DJVU_PLATFORM_FEATURE.invokeChannels.renderPagePreview
        ]!;
        expect(() => codec.decodeArgs([
            '/tmp/book.djvu',
            1,
            {previewRequestId: 'x'.repeat(129)},
        ])).toThrow('renderPagePreview.options.previewRequestId exceeds maximum length (128)');
        expect(mocks.renderDjvuPagePreview).not.toHaveBeenCalled();
    });

    it('drops superseded queued native preview requests per sender before spawning conversion', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-coalesce-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const canonicalRealPath = realpathSync.native(realPath);
            const [
                firstPreview,
                secondPreview,
                fourthPreview,
            ] = createPendingPreviews(3);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
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
            expect(mocks.renderDjvuPagePreview).toHaveBeenNthCalledWith(3, canonicalRealPath, 1, {
                previewRequestId: 'preview-4',
                subsample: 3,
            }, expect.objectContaining({
                cancelGroup: 'djvu-preview:9:preview-4',
                signal: expect.any(AbortSignal),
            }));

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
            const [
                firstPreview,
                secondPreview,
            ] = createPendingPreviews(2);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
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
            event.sender.emit('destroyed');

            await queuedRejection;
            expect(firstSignal?.aborted).toBe(true);
            expect(secondSignal?.aborted).toBe(true);
            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2);

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

    it('cancels a queued native preview before it consumes a native-process slot', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-cancel-queued-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const [
                firstPreview,
                secondPreview,
            ] = createPendingPreviews(2);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
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
            mocks.estimateSizes.mockImplementation((
                _djvuPath: string,
                _pageCount: number,
                options?: {signal?: AbortSignal},
            ) => new Promise((_resolve, reject) => {
                const signal = options?.signal;
                estimateState.signal = signal;
                signal?.addEventListener('abort', () => {
                    reject(signal.reason);
                }, {once: true});
            }));

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
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

    it('prioritizes visible native preview waiters over retained queued pages', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-priority-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const canonicalRealPath = realpathSync.native(realPath);
            const [
                firstPreview,
                secondPreview,
                visiblePreview,
                retainedPreview,
            ] = createPendingPreviews(4);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
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
            expect(mocks.renderDjvuPagePreview).toHaveBeenNthCalledWith(3, canonicalRealPath, 3, {
                previewPriority: 20,
                previewRequestId: '1:3:1',
                subsample: 3,
            }, expect.objectContaining({
                cancelGroup: 'djvu-preview:10:1:3:1',
                signal: expect.any(AbortSignal),
            }));

            resolvePreview(secondPreview!, 2);

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(4));
            expect(mocks.renderDjvuPagePreview).toHaveBeenNthCalledWith(4, canonicalRealPath, 8, {
                previewPriority: 1,
                previewRequestId: '1:8:1',
                subsample: 3,
            }, expect.objectContaining({
                cancelGroup: 'djvu-preview:10:1:8:1',
                signal: expect.any(AbortSignal),
            }));

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
            const canonicalRealPath = realpathSync.native(realPath);
            const [
                firstPreview,
                secondPreview,
                nextGenerationPreview,
            ] = createPendingPreviews(3);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
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
            expect(mocks.renderDjvuPagePreview).toHaveBeenNthCalledWith(3, canonicalRealPath, 3, {
                previewPriority: 20,
                previewRequestId: '2:3:1',
                subsample: 3,
            }, expect.objectContaining({
                cancelGroup: 'djvu-preview:11:2:3:1',
                signal: expect.any(AbortSignal),
            }));

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
