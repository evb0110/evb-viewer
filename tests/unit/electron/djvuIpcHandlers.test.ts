import type * as TViMockOriginalModule from '@electron/features/djvu/main/parseDjvuOutline';
import type * as TPdfExportModule from '@electron/features/djvu/main/pdfExport';
import type * as TViewingModule from '@electron/features/djvu/main/viewing';

import type { TRegisteredHandler } from '@tests/unit/electron/helpers/ipcRegistryHarness';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
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
import {resolve} from 'node:path';
import { DJVU_PLATFORM_FEATURE } from '@contracts/djvuPlatformFeature';
import {createAbortError} from '@electron/utils/abort';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';
import {
    requireJobId,
    requireRequestId,
} from '@contracts/shared';
import * as v from 'valibot';
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
    subscribeDjvuProgress: mocks.subscribeDjvuProgress,
}));
vi.mock('@electron/features/djvu/main/viewing', async importOriginal => ({
    ...await importOriginal<typeof TViewingModule>(),
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
vi.mock('@electron/features/djvu/main/textSearch', () => ({readDjvuPageText: mocks.readDjvuPageText}));
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
const {default: prepareDjvuMainBindings} = await import('@electron/features/djvu/mainBindings');
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
            mocks.getDjvuOutline.mockRejectedValue(failure);
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
            mocks.getDjvuOutline.mockRejectedValue(new Error('outline output exceeded limit'));
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

describe('native DjVu open admission', async () => {
    const {
        getAdmittedDjvuViewingSource, handleDjvuOpenForViewing, releaseDjvuViewingPath,
    } = await vi.importActual<typeof TViewingModule>(
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
        mocks.getDjvuPageSourceInfoForViewing.mockRejectedValueOnce(pageCountFailure);
        mocks.getDjvuPageCount.mockImplementationOnce(() => {
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
    });

    it('classifies a djvused refusal of a truncated DjVu as invalid and keeps the native message as diagnostics', async () => {
        const truncated = readFileSync(join(DJVU_FIXTURE_SOURCES, 'corrupt-truncated.djvu'));
        await expect(openWithProbeFailure(new NativeProcessError('exit-code', 10, null, nativeRejection), truncated)).resolves.toEqual({
            success: false,
            error: nativeRejection,
            errorEnvelope: {
                code: 'invalid-djvu',
                message: nativeRejection,
            },
        });
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
        const denied = 'djvused failed with exit code 10. Failed to open \'book.djvu\': Permission denied.';
        const failure = new NativeProcessError('exit-code', 10, null, denied);

        await expect(openWithProbeFailure(failure)).resolves.toEqual({
            success: false,
            error: denied,
        });
        await expect(openWithProbeFailure(failure, readFileSync(join(DJVU_FIXTURE_SOURCES, 'corrupt-truncated.djvu')), {unreadableAfterProbe: true}))
            .resolves.toEqual({
                success: false,
                error: denied,
            });
    });

    it('preserves an unknown-header native refusal as unclassified', async () => {
        const layered = readFileSync(join(DJVU_FIXTURE_SOURCES, 'layered.djvu'));
        const failure = new NativeProcessError('exit-code', 10, null, nativeRejection);
        const truncatedForm = (prefix: string, type: string) => {
            const header = Buffer.from(`${prefix}FORM\0\0\0\0${type}`, 'latin1');
            header.writeUInt32BE(18100, prefix.length + 4);
            return header;
        };
        for (const source of [
            layered.subarray(4),
            Buffer.concat([
                Buffer.from('SDJV', 'latin1'),
                layered.subarray(4),
            ]),
            truncatedForm('', 'DJVU'),
            truncatedForm('SDJV', 'DJVU'),
            truncatedForm('AT&T', 'PM44'),
            truncatedForm('AT&T', 'BM44'),
            Buffer.from('AT&TFORM', 'latin1'),
        ]) {
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
        controller.abort();
        const abort = Object.assign(new Error('The operation was aborted'), {name: 'AbortError'});
        mocks.getDjvuPageSourceInfoForViewing.mockRejectedValueOnce(abort);

        await expect(handleDjvuOpenForViewing(createIpcEvent(93) as never, '/tmp/canceled.djvu' as never, controller.signal, false))
            .resolves.toEqual({
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
        writeFileSync(djvuPath, 'AT&TFORM');
        mocks.getDjvuPageSourceInfoForViewing.mockRejectedValueOnce(new Error('page size probe failed'));
        mocks.getDjvuPageCount.mockResolvedValueOnce(12);
        try {
            await expect(handleDjvuOpenForViewing(createIpcEvent(94) as never, djvuPath as never, undefined, false))
                .resolves.toEqual({
                    success: true,
                    pageCount: 12,
                    source: {
                        sourceSize: 8,
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
        const {startDurableDjvuOpenJob} = await vi.importActual<typeof TPdfExportModule>(
            '@electron/features/djvu/main/pdfExport',
        );
        const directory = mkdtempSync(join(tmpdir(), 'djvu-open-durable-'));
        const djvuPath = join(directory, 'book.djvu');
        writeFileSync(djvuPath, 'AT&TFORM');
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
                signal => handleDjvuOpenForViewing(context as never, djvuPath as never, signal, false),
            );
            const completion = await vi.waitFor(() => {
                const sent = mocks.safeSendToWindow.mock.calls
                    .find(([
                        , channel,
                    ]) => channel === DJVU_PLATFORM_FEATURE.eventChannels.onOpenComplete);
                expect(sent).toBeDefined();
                return sent![2];
            });
            return v.parse(DJVU_PLATFORM_FEATURE.events.onOpenComplete.payload, completion);
        };
        try {
            mocks.getDjvuPageSourceInfoForViewing.mockRejectedValueOnce(new Error('page size probe failed'));
            mocks.getDjvuPageCount.mockResolvedValueOnce(12);
            const source = {
                sourceSize: 8,
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
        writeFileSync(djvuPath, 'AT&TFORM');
        try {
            mocks.getDjvuPageSourceInfoForViewing.mockRejectedValueOnce(new Error('page size probe failed'));
            mocks.getDjvuPageCount.mockResolvedValueOnce(12);
            await expect(handleDjvuOpenForViewing(context as never, djvuPath as never)).resolves.toMatchObject({success: true});
            await expect(getAdmittedDjvuViewingSource(djvuPath, 95)).resolves.toMatchObject({
                originalPath: djvuPath,
                sourceSize: 8,
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
});
