import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import type {WebContents} from 'electron';
import type {IPlatformMainSenderContext} from '@contracts/platformFeature';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {requireEpochMs} from '@contracts/timestamps';
import {
    requireJobId,
    requireRequestId,
} from '@contracts/shared';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    createDeferred,
    createTestEventSender,
    type ITestEventSender,
} from '@tests/helpers/electronEventEmitterHarness';
import {cast} from '@tests/helpers/cast';

const mocks = vi.hoisted(() => {
    class MockDjvuPdfWorkerStartupError extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'DjvuPdfWorkerStartupError';
        }
    }

    return {
        StartupError: MockDjvuPdfWorkerStartupError,
        bookmarkTaskState: {
            mode: 'success',
            workerTerminate: vi.fn(() => Promise.resolve(0)),
            rejectPendingBookmark: null as ((error: Error) => void) | null,
            lastBookmarkSignal: null as AbortSignal | null,
        },
        browserWindowFromWebContents: vi.fn(() => null),
        randomUUID: vi.fn(),
        copyFile: vi.fn(),
        makeSiblingTempPath: vi.fn(),
        mkdtemp: vi.fn(),
        open: vi.fn(),
        readFile: vi.fn(),
        rename: vi.fn(),
        rm: vi.fn(),
        stat: vi.fn(),
        statfs: vi.fn(),
        fileHandleWrite: vi.fn(),
        fileHandleSync: vi.fn(),
        fileHandleClose: vi.fn(),
        unlink: vi.fn(),
        writeFile: vi.fn(),
        atomicReplace: vi.fn(),
        getAppTempDir: vi.fn(),
        getDjvuPageCount: vi.fn(),
        getDjvuResolution: vi.fn(),
        getDjvuOutline: vi.fn(),
        getDjvuPageSizesForViewing: vi.fn(),
        parseDjvuOutline: vi.fn(),
        convertDjvuToPdfFile: vi.fn(),
        buildCompactDjvuAwarePdfFromDjvu: vi.fn(),
        cancelConversion: vi.fn(),
        embedBookmarksIntoPdfFile: vi.fn(),
        optimizeGeneratedPdfForInteraction: vi.fn(),
        printManagedTempPdfPath: vi.fn(),
        createDjvuPdfBookmarkTask: vi.fn(),
        consumeAllowedDjvuWritePath: vi.fn(),
        safeSendToWindow: vi.fn(),
        loggerInfo: vi.fn(),
        loggerWarn: vi.fn(),
        loggerError: vi.fn(),
        getWorkerTaskFailureReceipt: vi.fn(),
        adoptDjvuViewingPath: vi.fn(),
        allowOpenPath: vi.fn(),
    };
});

vi.mock('electron', () => ({
    app: {getPath: vi.fn(() => '/tmp')},
    BrowserWindow: {fromWebContents: mocks.browserWindowFromWebContents},
}));

vi.mock('node:crypto', () => ({randomUUID: mocks.randomUUID}));

vi.mock('fs/promises', () => ({
    copyFile: mocks.copyFile,
    mkdtemp: mocks.mkdtemp,
    open: mocks.open,
    readFile: mocks.readFile,
    rename: mocks.rename,
    rm: mocks.rm,
    stat: mocks.stat,
    statfs: mocks.statfs,
    unlink: mocks.unlink,
    writeFile: mocks.writeFile,
}));

vi.mock('@electron/features/djvu/main/ddjvuConversion', () => ({
    cancelConversion: mocks.cancelConversion,
    convertDjvuToPdfFile: mocks.convertDjvuToPdfFile,
}));

vi.mock('@electron/features/djvu/main/buildCompactDjvuAwarePdfFromDjvu', () => ({buildCompactDjvuAwarePdfFromDjvu: mocks.buildCompactDjvuAwarePdfFromDjvu}));

vi.mock('@electron/features/djvu/main/metadata', () => ({
    getDjvuOutline: mocks.getDjvuOutline,
    getDjvuPageCount: mocks.getDjvuPageCount,
    getDjvuResolution: mocks.getDjvuResolution,
}));

vi.mock('@electron/features/djvu/main/pagePreview', () => ({
    DJVU_PAGE_SIZE_ARRAY_MAX_PAGES: 10_000,
    getDjvuPageSizesForViewing: mocks.getDjvuPageSizesForViewing,
}));

vi.mock('@electron/features/djvu/main/parseDjvuOutline', () => ({parseDjvuOutline: mocks.parseDjvuOutline}));
vi.mock('@electron/features/djvu/main/embedBookmarksIntoPdfFile', () => ({embedBookmarksIntoPdfFile: mocks.embedBookmarksIntoPdfFile}));
vi.mock('@electron/features/documents/public/pdfSaveAsOptimization', () => ({optimizeGeneratedPdfForInteraction: (...args: unknown[]) => mocks.optimizeGeneratedPdfForInteraction(...args)}));
vi.mock('@electron/utils/printHandoff', () => ({
    PRINT_DJVU_TEMP_PREFIX: 'print-djvu-',
    printManagedTempPdfPath: (...args: unknown[]) => mocks.printManagedTempPdfPath(...args),
}));
vi.mock('@electron/utils/appTempDir', () => ({getAppTempDir: () => mocks.getAppTempDir()}));
vi.mock('@electron/features/djvu/main/exportPaths', () => ({consumeAllowedDjvuWritePath: mocks.consumeAllowedDjvuWritePath}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({allowOpenPath: mocks.allowOpenPath}));
vi.mock('@electron/features/djvu/main/viewing', () => ({adoptDjvuViewingPath: mocks.adoptDjvuViewingPath}));
vi.mock('@electron/features/djvu/main/safeSendToWindow', () => ({safeSendToWindow: mocks.safeSendToWindow}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: vi.fn(),
})}));

vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: mocks.atomicReplace,
    makeSiblingTempPath: mocks.makeSiblingTempPath,
}));

vi.mock('@electron/features/djvu/main/pdfWorkerClient', () => ({
    createDjvuPdfBookmarkTask: mocks.createDjvuPdfBookmarkTask,
    DjvuPdfWorkerStartupError: mocks.StartupError,
}));
vi.mock('@electron/utils/workerTask', () => ({getWorkerTaskFailureReceipt: mocks.getWorkerTaskFailureReceipt}));

const {
    awaitDurableDjvuConvertJob,
    awaitDurableDjvuOpenJob,
    clearDjvuJobsForTests,
    getDjvuOutputJobState,
    handleDjvuCancel,
    handleDjvuConvertToPdf,
    handleDjvuPrintPath,
    shutdownDjvuConversions,
    startDurableDjvuConvertJob,
    startDurableDjvuOpenJob,
    subscribeDjvuOutputJob,
    subscribeDjvuProgress,
} = await import('@electron/features/djvu/main/pdfExport');

const trustedDjvuPath = '/tmp/input.djvu' as TOpenPath;
const conversionFailure: FailureReceipt = {
    eventId: '0123456789abcdef0123456789abcdef' as FailureReceipt['eventId'],
    code: 'UNCLASSIFIED_MAIN_ERROR',
    occurredAt: requireEpochMs(1),
    severity: 'error',
};
const workerFailure: FailureReceipt = {
    eventId: 'fedcba9876543210fedcba9876543210' as FailureReceipt['eventId'],
    code: 'UNCLASSIFIED_MAIN_ERROR',
    occurredAt: requireEpochMs(2),
    severity: 'error',
};

type TDjvuOperationContext = IPlatformMainSenderContext<WebContents> & {parentWindow: null};

function asJobId(id: string) {
    return requireJobId(id);
}

function createEvent(senderId: number) {
    const sender = createTestEventSender(senderId);
    if (!isDjvuWebContentsTestDouble(sender)) {
        throw new Error('Invalid WebContents test double');
    }
    return {sender};
}

function isDjvuWebContentsTestDouble(value: ITestEventSender): value is ITestEventSender & WebContents {
    return typeof value.id === 'number'
        && typeof value.isDestroyed === 'function'
        && typeof value.on === 'function'
        && typeof value.once === 'function'
        && typeof value.removeListener === 'function'
        && typeof value.send === 'function';
}

function createOperationContext(senderId: number): TDjvuOperationContext {
    const event = createEvent(senderId);
    return cast<TDjvuOperationContext>({
        ...event,
        senderId,
        parentWindow: null,
    });
}

describe('handleDjvuConvertToPdf', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.randomUUID.mockReset();
        mocks.bookmarkTaskState.mode = 'success';
        mocks.bookmarkTaskState.rejectPendingBookmark = null;
        mocks.bookmarkTaskState.lastBookmarkSignal = null;
        mocks.bookmarkTaskState.workerTerminate = vi.fn(() => {
            mocks.bookmarkTaskState.rejectPendingBookmark?.(new Error('worker terminated'));
            return Promise.resolve(0);
        });
        mocks.loggerError.mockReturnValue(conversionFailure);
        mocks.getWorkerTaskFailureReceipt.mockReturnValue(undefined);

        mocks.randomUUID
            .mockReturnValueOnce('convert-123')
            .mockReturnValue('temp-456');
        mocks.copyFile.mockResolvedValue(undefined);
        mocks.makeSiblingTempPath.mockReturnValue('/tmp/.staged-output.tmp');
        mocks.mkdtemp.mockResolvedValue('/tmp/djvu-export-test');
        mocks.open.mockImplementation(async (_path: string, flags: string) => {
            if (flags === 'r') {
                let completed = false;
                return {
                    read: vi.fn(async (buffer: Buffer) => {
                        if (completed) {
                            return {
                                bytesRead: 0,
                                buffer,
                            };
                        }
                        completed = true;
                        buffer[0] = 0x25;
                        return {
                            bytesRead: 1,
                            buffer,
                        };
                    }),
                    close: mocks.fileHandleClose,
                };
            }
            return {
                write: mocks.fileHandleWrite.mockResolvedValue({bytesWritten: 1}),
                sync: mocks.fileHandleSync.mockResolvedValue(undefined),
                close: mocks.fileHandleClose,
            };
        });
        mocks.readFile.mockResolvedValue(Buffer.from('%PDF-1.7\n%%EOF\n'));
        mocks.rename.mockResolvedValue(undefined);
        mocks.rm.mockResolvedValue(undefined);
        mocks.stat.mockResolvedValue({size: 8 * 1024 * 1024});
        mocks.statfs.mockResolvedValue({
            bavail: 1_000_000,
            bsize: 4096,
        });
        mocks.unlink.mockResolvedValue(undefined);
        mocks.writeFile.mockResolvedValue(undefined);
        mocks.atomicReplace.mockResolvedValue(undefined);
        mocks.getAppTempDir.mockReturnValue('/tmp/evb-viewer');
        mocks.getDjvuPageCount.mockResolvedValue(2);
        mocks.getDjvuResolution.mockResolvedValue(300);
        mocks.getDjvuPageSizesForViewing.mockResolvedValue([
            {
                width: 1200,
                height: 1600,
                dpi: 300,
            },
            {
                width: 1200,
                height: 1600,
                dpi: 300,
            },
        ]);
        mocks.getDjvuOutline.mockResolvedValue('(bookmarks)');
        mocks.parseDjvuOutline.mockReturnValue([{
            title: 'Chapter 1',
            pageIndex: 0,
            items: [],
        }]);
        mocks.convertDjvuToPdfFile.mockImplementation(async (
            _djvuPath: string,
            _outputPath: string,
            _jobId: string,
            options?: { onProgress?: (percent: number) => void },
        ) => {
            options?.onProgress?.(90);
            return {success: true};
        });
        mocks.buildCompactDjvuAwarePdfFromDjvu.mockImplementation(async (options?: {onProgress?: (percent: number) => void;}) => {
            options?.onProgress?.(90);
            return {
                success: true,
                outputPath: '/tmp/djvu-export-test/convert-123.convert.pdf',
                fileSize: 1024,
            };
        });
        mocks.cancelConversion.mockReturnValue(false);
        mocks.embedBookmarksIntoPdfFile.mockResolvedValue(123);
        mocks.optimizeGeneratedPdfForInteraction.mockResolvedValue(null);
        mocks.printManagedTempPdfPath.mockResolvedValue({ success: true });
        mocks.createDjvuPdfBookmarkTask.mockImplementation((
            _inputPdfPath: string,
            _outputPdfPath: string,
            _bookmarks: unknown[],
            options?: { signal?: AbortSignal },
        ) => {
            mocks.bookmarkTaskState.lastBookmarkSignal = options?.signal ?? null;
            if (mocks.bookmarkTaskState.mode === 'startup-error') {
                throw new mocks.StartupError('bookmark worker missing');
            }

            if (mocks.bookmarkTaskState.mode === 'cancel-pending') {
                const promise = new Promise<void>((_resolve, reject) => {
                    mocks.bookmarkTaskState.rejectPendingBookmark = reject;
                    const rejectCanceled = () => reject(new Error('DjVu PDF worker canceled'));
                    if (options?.signal?.aborted) {
                        rejectCanceled();
                        return;
                    }
                    options?.signal?.addEventListener('abort', rejectCanceled, {once: true});
                });
                return {
                    worker: { terminate: mocks.bookmarkTaskState.workerTerminate },
                    promise,
                };
            }

            if (mocks.bookmarkTaskState.mode === 'worker-failure') {
                return {
                    worker: { terminate: vi.fn(() => Promise.resolve(0)) },
                    promise: Promise.reject(new Error('DjVu bookmark worker failed')),
                };
            }

            return {
                worker: { terminate: vi.fn(() => Promise.resolve(0)) },
                promise: Promise.resolve(),
            };
        });
        mocks.consumeAllowedDjvuWritePath.mockImplementation((outputPath: string) => outputPath);
    });

    afterEach(async () => {
        await shutdownDjvuConversions();
        await clearDjvuJobsForTests();
    });

    it('uses the path-backed native bookmark helper when worker startup fails', async () => {
        mocks.bookmarkTaskState.mode = 'startup-error';

        const result = await handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        expect(result).toMatchObject({
            success: true,
            pdfPath: '/tmp/output.pdf',
            jobId: asJobId('djvu-convert-convert-123'),
        });
        expect(mocks.getDjvuPageCount).toHaveBeenCalledWith(trustedDjvuPath, {signal: expect.any(AbortSignal)});
        expect(mocks.getDjvuOutline).toHaveBeenCalledWith(trustedDjvuPath, {signal: expect.any(AbortSignal)});
        expect(mocks.convertDjvuToPdfFile).toHaveBeenCalledTimes(1);
        expect(mocks.convertDjvuToPdfFile).toHaveBeenCalledWith(
            trustedDjvuPath,
            '/tmp/djvu-export-test/convert-123.convert.pdf',
            asJobId('djvu-convert-convert-123'),
            expect.objectContaining({pageCount: 2}),
        );
        expect(mocks.createDjvuPdfBookmarkTask).toHaveBeenCalledTimes(1);
        expect(mocks.embedBookmarksIntoPdfFile).toHaveBeenCalledTimes(1);
        expect(mocks.optimizeGeneratedPdfForInteraction)
            .toHaveBeenCalledWith('/tmp/djvu-export-test/convert-123.bookmarks.pdf', { signal: expect.any(AbortSignal) });
        expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    });

    it('keeps the path-backed bookmark helper above the former 64 MiB fallback cap', async () => {
        mocks.bookmarkTaskState.mode = 'startup-error';
        mocks.stat.mockResolvedValue({size: 256 * 1024 * 1024});

        const result = await handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        expect(result).toMatchObject({
            success: true,
            jobId: asJobId('djvu-convert-convert-123'),
        });
        expect(mocks.embedBookmarksIntoPdfFile).toHaveBeenCalledWith(
            '/tmp/djvu-export-test/convert-123.convert.pdf',
            '/tmp/djvu-export-test/convert-123.bookmarks.pdf',
            [{
                title: 'Chapter 1',
                pageIndex: 0,
                items: [],
            }],
            expect.any(AbortSignal),
        );
    });

    it('rejects unsafe full-resolution direct PDF conversion before spawning ddjvu', async () => {
        mocks.getDjvuPageCount.mockResolvedValue(564);
        mocks.getDjvuResolution.mockResolvedValue(600);
        mocks.getDjvuPageSizesForViewing.mockResolvedValue(Array.from({length: 564}, () => ({
            width: 5100,
            height: 6600,
            dpi: 600,
        })));

        const result = await handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/output.pdf',
            {
                preserveBookmarks: true,
                subsample: 1,
            },
        );

        expect(result).toMatchObject({
            success: false,
            jobId: asJobId('djvu-convert-convert-123'),
            error: expect.stringContaining('Choose Good Quality or higher'),
        });
        expect(mocks.convertDjvuToPdfFile).not.toHaveBeenCalled();
        expect(mocks.getDjvuOutline).not.toHaveBeenCalled();
    });

    it.each([
        {
            strategy: 'direct' as const,
            options: {
                pdfStrategy: 'direct' as const,
                preserveBookmarks: false,
                subsample: 2,
            },
            expectedSubsample: 2,
        },
        {
            strategy: 'auto' as const,
            options: {
                pdfStrategy: 'auto' as const,
                preserveBookmarks: false,
            },
            expectedSubsample: undefined,
        },
    ])('routes the $strategy strategy through direct conversion', async ({
        expectedSubsample,
        options,
    }) => {
        const result = await handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/output.pdf',
            options,
        );

        expect(result).toMatchObject({
            success: true,
            pdfPath: '/tmp/output.pdf',
            jobId: asJobId('djvu-convert-convert-123'),
        });
        expect(mocks.convertDjvuToPdfFile).toHaveBeenCalledWith(
            trustedDjvuPath,
            '/tmp/djvu-export-test/convert-123.convert.pdf',
            asJobId('djvu-convert-convert-123'),
            expect.objectContaining({
                pageCount: 2,
                ...(expectedSubsample === undefined ? {} : {subsample: expectedSubsample}),
            }),
        );
        expect(mocks.createDjvuPdfBookmarkTask).not.toHaveBeenCalled();
    });

    it('reserves visible progress for final direct-conversion stages', async () => {
        mocks.convertDjvuToPdfFile.mockImplementationOnce(async (
            _djvuPath: string,
            _outputPath: string,
            _jobId: string,
            options?: { onProgress?: (percent: number) => void },
        ) => {
            options?.onProgress?.(100);
            await delay(60);
            return {success: true};
        });
        mocks.createDjvuPdfBookmarkTask.mockImplementationOnce((
            _inputPdfPath: string,
            _outputPdfPath: string,
            _bookmarks: unknown[],
            options?: { signal?: AbortSignal },
        ) => {
            mocks.bookmarkTaskState.lastBookmarkSignal = options?.signal ?? null;
            return {
                worker: { terminate: vi.fn(() => Promise.resolve(0)) },
                promise: delay(60),
            };
        });
        mocks.optimizeGeneratedPdfForInteraction.mockImplementationOnce(() => delay(60));

        const result = await handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/output.pdf',
            {
                pdfStrategy: 'direct',
                preserveBookmarks: true,
            },
        );

        expect(result.success).toBe(true);
        const payloads = mocks.safeSendToWindow.mock.calls
            .filter(call => call[1] === 'djvu:progress')
            .map(call => call[2]);
        expect(payloads).toEqual(expect.arrayContaining([
            expect.objectContaining({
                phase: 'converting',
                percent: 94,
            }),
            expect.objectContaining({
                phase: 'bookmarks',
                percent: 95,
            }),
            expect.objectContaining({
                phase: 'optimizing',
                percent: 98,
            }),
            expect.objectContaining({
                phase: 'optimizing',
                percent: 100,
                status: 'success',
            }),
        ]));
    });

    it('uses the compact DjVu-aware builder only for the explicit compact strategy', async () => {
        const result = await handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/output.pdf',
            {
                pdfStrategy: 'compact-djvu-aware',
                preserveBookmarks: false,
            },
        );

        expect(result).toMatchObject({
            success: true,
            pdfPath: '/tmp/output.pdf',
            jobId: asJobId('djvu-convert-convert-123'),
        });
        expect(mocks.getDjvuPageCount).toHaveBeenCalledWith(trustedDjvuPath, {signal: expect.any(AbortSignal)});
        expect(mocks.getDjvuResolution).toHaveBeenCalledWith(trustedDjvuPath, {signal: expect.any(AbortSignal)});
        expect(mocks.getDjvuPageSizesForViewing).toHaveBeenCalledWith(trustedDjvuPath, 2, { signal: expect.any(AbortSignal) });
        expect(mocks.buildCompactDjvuAwarePdfFromDjvu).toHaveBeenCalledWith(expect.objectContaining({
            jobId: asJobId('djvu-convert-convert-123'),
            djvuPath: trustedDjvuPath,
            outputPath: '/tmp/djvu-export-test/convert-123.convert.pdf',
            tempDir: '/tmp/djvu-export-test',
            pageCount: 2,
            sourceDpi: 300,
            pageSizes: [
                {
                    width: 1200,
                    height: 1600,
                    dpi: 300,
                },
                {
                    width: 1200,
                    height: 1600,
                    dpi: 300,
                },
            ],
            signal: expect.any(AbortSignal),
            onProgress: expect.any(Function),
        }));
        expect(mocks.convertDjvuToPdfFile).not.toHaveBeenCalled();
        expect(mocks.getDjvuOutline).not.toHaveBeenCalled();
        expect(mocks.optimizeGeneratedPdfForInteraction)
            .toHaveBeenCalledWith('/tmp/djvu-export-test/convert-123.convert.pdf', { signal: expect.any(AbortSignal) });
        expect(mocks.open).toHaveBeenCalledWith(
            '/tmp/djvu-export-test/convert-123.convert.pdf',
            'r',
        );
        expect(mocks.open).toHaveBeenCalledWith(
            '/tmp/.staged-output.tmp',
            'wx',
        );
        expect(mocks.atomicReplace).toHaveBeenCalledWith('/tmp/.staged-output.tmp', '/tmp/output.pdf');
    });

    it('stops compact PDF export before finalization when the compact builder fails', async () => {
        mocks.buildCompactDjvuAwarePdfFromDjvu.mockResolvedValueOnce({
            success: false,
            outputPath: '/tmp/djvu-export-test/convert-123.convert.pdf',
            fileSize: 0,
            error: 'compact failed',
        });

        const result = await handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/output.pdf',
            {
                pdfStrategy: 'compact-djvu-aware',
                preserveBookmarks: true,
            },
        );

        expect(result).toMatchObject({
            success: false,
            jobId: asJobId('djvu-convert-convert-123'),
            error: 'compact failed',
            failure: conversionFailure,
        });
        expect(mocks.loggerError).toHaveBeenCalledTimes(1);
        expect(mocks.getWorkerTaskFailureReceipt).not.toHaveBeenCalled();
        expect(mocks.convertDjvuToPdfFile).not.toHaveBeenCalled();
        expect(mocks.getDjvuOutline).not.toHaveBeenCalled();
        expect(mocks.optimizeGeneratedPdfForInteraction).not.toHaveBeenCalled();
        expect(mocks.open).not.toHaveBeenCalled();
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.safeSendToWindow).toHaveBeenLastCalledWith(null, 'djvu:progress', expect.objectContaining({
            jobId: asJobId('djvu-convert-convert-123'),
            documentRef: trustedDjvuPath,
            phase: 'converting',
            percent: 100,
            status: 'failed',
            error: 'compact failed',
        }));
    });

    it('reuses a receipt from the DjVu bookmark worker without capturing in main', async () => {
        mocks.bookmarkTaskState.mode = 'worker-failure';
        mocks.getWorkerTaskFailureReceipt.mockReturnValue(workerFailure);

        const result = await handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        expect(result).toMatchObject({
            success: false,
            jobId: asJobId('djvu-convert-convert-123'),
            error: 'DjVu bookmark worker failed',
            failure: workerFailure,
        });
        expect(mocks.getWorkerTaskFailureReceipt).toHaveBeenCalledWith(expect.any(Error));
        expect(mocks.loggerError).not.toHaveBeenCalled();
    });

    it('keeps direct conversion policy rejection expected and receipt-free', async () => {
        mocks.getDjvuPageCount.mockResolvedValue(564);
        mocks.getDjvuResolution.mockResolvedValue(600);
        mocks.getDjvuPageSizesForViewing.mockResolvedValue(Array.from({length: 564}, () => ({
            width: 5100,
            height: 6600,
            dpi: 600,
        })));

        const result = await handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/output.pdf',
            {
                preserveBookmarks: true,
                subsample: 1,
            },
        );

        expect(result).toMatchObject({
            success: false,
            expected: {
                kind: 'expected',
                code: 'validation-rejected',
            },
        });
        expect(result).not.toHaveProperty('failure');
        expect(mocks.loggerError).not.toHaveBeenCalled();
        expect(mocks.convertDjvuToPdfFile).not.toHaveBeenCalled();
    });

    it('projects a conversion-returned cancellation as canceled without a receipt', async () => {
        mocks.buildCompactDjvuAwarePdfFromDjvu.mockResolvedValueOnce({
            success: false,
            outputPath: '/tmp/djvu-export-test/convert-123.convert.pdf',
            fileSize: 0,
            error: 'DjVu conversion canceled',
        });
        const context = createOperationContext(8);

        const result = await handleDjvuConvertToPdf(
            context,
            trustedDjvuPath,
            '/tmp/canceled-output.pdf',
            {
                pdfStrategy: 'compact-djvu-aware',
                preserveBookmarks: false,
            },
        );

        expect(result).toMatchObject({
            success: false,
            expected: {
                kind: 'expected',
                code: 'canceled',
            },
        });
        expect(result).not.toHaveProperty('failure');
        expect(getDjvuOutputJobState(context, result.jobId!)).toMatchObject({
            status: 'canceled',
            expected: {
                kind: 'expected',
                code: 'canceled',
            },
        });
        expect(mocks.loggerError).not.toHaveBeenCalled();
    });

    it('aborts the active bookmark worker when cancel is requested', async () => {
        mocks.bookmarkTaskState.mode = 'cancel-pending';

        const convertPromise = handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        for (let attempt = 0; attempt < 50 && mocks.createDjvuPdfBookmarkTask.mock.calls.length === 0; attempt += 1) {
            await delay(0);
        }
        expect(mocks.createDjvuPdfBookmarkTask).toHaveBeenCalledTimes(1);
        mocks.getWorkerTaskFailureReceipt.mockReturnValue(workerFailure);
        const cancelResult = await handleDjvuCancel(
            createOperationContext(7),
            asJobId('djvu-convert-convert-123'),
        );
        const result = await convertPromise;

        expect(cancelResult).toEqual({canceled: true});
        expect(mocks.createDjvuPdfBookmarkTask).toHaveBeenCalledWith(
            '/tmp/djvu-export-test/convert-123.convert.pdf',
            '/tmp/djvu-export-test/convert-123.bookmarks.pdf',
            [{
                title: 'Chapter 1',
                pageIndex: 0,
                items: [],
            }],
            {signal: expect.any(AbortSignal)},
        );
        expect(mocks.bookmarkTaskState.lastBookmarkSignal?.aborted).toBe(true);
        expect(mocks.bookmarkTaskState.workerTerminate).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            success: false,
            jobId: asJobId('djvu-convert-convert-123'),
            error: 'DjVu conversion canceled',
            expected: {
                kind: 'expected',
                code: 'canceled',
            },
        });
        expect(result).not.toHaveProperty('failure');
        expect(mocks.safeSendToWindow).toHaveBeenLastCalledWith(null, 'djvu:progress', expect.objectContaining({
            jobId: asJobId('djvu-convert-convert-123'),
            documentRef: trustedDjvuPath,
            phase: 'bookmarks',
            percent: 100,
            status: 'canceled',
            error: 'DjVu conversion canceled',
        }));
    });

    it('aborts pending metadata commands when cancel is requested', async () => {
        mocks.getDjvuPageCount.mockImplementationOnce((
            _filePath: string,
            options?: { signal?: AbortSignal },
        ) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
                const error = new Error('DjVu conversion canceled');
                error.name = 'AbortError';
                reject(error);
            });
        }));

        const convertPromise = handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        for (let attempt = 0; attempt < 50 && mocks.getDjvuPageCount.mock.calls.length === 0; attempt += 1) {
            await delay(0);
        }
        const metadataOptions = mocks.getDjvuPageCount.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
        const cancelResult = await handleDjvuCancel(
            createOperationContext(7),
            asJobId('djvu-convert-convert-123'),
        );
        const result = await convertPromise;

        expect(cancelResult).toEqual({canceled: true});
        expect(metadataOptions?.signal?.aborted).toBe(true);
        expect(mocks.convertDjvuToPdfFile).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            success: false,
            jobId: asJobId('djvu-convert-convert-123'),
            error: 'DjVu conversion canceled',
        });
        expect(mocks.safeSendToWindow).toHaveBeenLastCalledWith(null, 'djvu:progress', expect.objectContaining({
            jobId: asJobId('djvu-convert-convert-123'),
            documentRef: trustedDjvuPath,
            phase: 'converting',
            percent: 100,
            status: 'canceled',
            error: 'DjVu conversion canceled',
        }));
    });

    it('aborts the path-backed bookmark helper after canceling a worker-startup failure', async () => {
        mocks.bookmarkTaskState.mode = 'startup-error';
        mocks.embedBookmarksIntoPdfFile.mockImplementationOnce(async (
            _inputPdfPath: string,
            _outputPdfPath: string,
            _bookmarks: unknown[],
            signal?: AbortSignal,
        ) => new Promise((_resolve, reject) => {
            if (signal?.aborted) {
                reject(new Error('DjVu conversion canceled'));
                return;
            }
            signal?.addEventListener('abort', () => {
                reject(new Error('DjVu conversion canceled'));
            }, {once: true});
        }));

        const convertPromise = handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        for (let attempt = 0; attempt < 50 && mocks.createDjvuPdfBookmarkTask.mock.calls.length === 0; attempt += 1) {
            await delay(0);
        }
        expect(mocks.createDjvuPdfBookmarkTask).toHaveBeenCalledTimes(1);

        const cancelResult = await handleDjvuCancel(
            createOperationContext(7),
            asJobId('djvu-convert-convert-123'),
        );
        const result = await convertPromise;

        expect(cancelResult).toEqual({canceled: true});
        expect(result).toMatchObject({
            success: false,
            jobId: asJobId('djvu-convert-convert-123'),
            error: 'DjVu conversion canceled',
        });
        expect(mocks.embedBookmarksIntoPdfFile).toHaveBeenCalledTimes(1);
    });

    it('emits initial progress immediately after registering the active job', async () => {
        mocks.getDjvuPageCount.mockImplementationOnce((
            _filePath: string,
            options?: { signal?: AbortSignal },
        ) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
                const error = new Error('DjVu conversion canceled');
                error.name = 'AbortError';
                reject(error);
            });
        }));

        const convertPromise = handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        await Promise.resolve();

        expect(mocks.safeSendToWindow).toHaveBeenCalledWith(null, 'djvu:progress', expect.objectContaining({
            jobId: asJobId('djvu-convert-convert-123'),
            documentRef: trustedDjvuPath,
            phase: 'converting',
            percent: 0,
        }));
        expect(mocks.convertDjvuToPdfFile).not.toHaveBeenCalled();
        for (let attempt = 0; attempt < 50 && mocks.getDjvuPageCount.mock.calls.length === 0; attempt += 1) {
            await delay(0);
        }
        expect(mocks.getDjvuPageCount).toHaveBeenCalledTimes(1);

        const cancelResult = await handleDjvuCancel(
            createOperationContext(7),
            asJobId('djvu-convert-convert-123'),
        );
        const result = await convertPromise;

        expect(cancelResult).toEqual({canceled: true});
        expect(result).toMatchObject({
            success: false,
            jobId: asJobId('djvu-convert-convert-123'),
            error: 'DjVu conversion canceled',
        });
    });

    it('atomically replaces the output file', async () => {
        const result = await handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: false},
        );

        expect(result).toMatchObject({
            success: true,
            pdfPath: '/tmp/output.pdf',
            jobId: asJobId('djvu-convert-convert-123'),
        });
        expect(mocks.open).toHaveBeenCalledWith(
            '/tmp/djvu-export-test/convert-123.convert.pdf',
            'r',
        );
        expect(mocks.open).toHaveBeenCalledWith(
            '/tmp/.staged-output.tmp',
            'wx',
        );
        expect(mocks.optimizeGeneratedPdfForInteraction)
            .toHaveBeenCalledWith('/tmp/djvu-export-test/convert-123.convert.pdf', { signal: expect.any(AbortSignal) });
        expect(
            mocks.optimizeGeneratedPdfForInteraction.mock.invocationCallOrder[0]!,
        ).toBeLessThan(mocks.fileHandleWrite.mock.invocationCallOrder[0]!);
        expect(mocks.atomicReplace).toHaveBeenCalledWith('/tmp/.staged-output.tmp', '/tmp/output.pdf');
    });

    it('completes partial writes without changing the published bytes', async () => {
        const sourceBytes = Buffer.alloc(2 * 4 * 1024 * 1024 + 123);
        for (let index = 0; index < sourceBytes.length; index += 1) {
            sourceBytes[index] = (index * 31 + 17) % 256;
        }
        let sourcePosition = 0;
        const publishedBytes = Buffer.alloc(sourceBytes.length);
        let writeCalls = 0;
        mocks.open.mockImplementation(async (_path: string, flags: string) => {
            if (flags === 'r') {
                return {
                    read: vi.fn(async (buffer: Buffer, offset: number, length: number) => {
                        const bytesRead = Math.min(length, sourceBytes.length - sourcePosition);
                        sourceBytes.copy(buffer, offset, sourcePosition, sourcePosition + bytesRead);
                        sourcePosition += bytesRead;
                        return {
                            bytesRead,
                            buffer,
                        };
                    }),
                    close: mocks.fileHandleClose,
                };
            }
            return {
                write: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
                    const plannedBytes = writeCalls === 0
                        ? 7
                        : writeCalls === 1
                            ? Math.floor(length / 2)
                            : length === 123
                                ? 1
                                : length;
                    writeCalls += 1;
                    buffer.copy(publishedBytes, position, offset, offset + plannedBytes);
                    return {bytesWritten: plannedBytes};
                }),
                sync: mocks.fileHandleSync.mockResolvedValue(undefined),
                close: mocks.fileHandleClose,
            };
        });

        const result = await handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: false},
        );

        expect(result).toMatchObject({
            success: true,
            pdfPath: '/tmp/output.pdf',
        });
        expect(publishedBytes.equals(sourceBytes)).toBe(true);
        expect(writeCalls).toBeGreaterThan(3);
        expect(mocks.atomicReplace).toHaveBeenCalledWith('/tmp/.staged-output.tmp', '/tmp/output.pdf');
    });

    it('preserves the destination when a staged write makes no progress', async () => {
        const write = vi.fn().mockResolvedValue({bytesWritten: 0});
        mocks.open.mockImplementation(async (_path: string, flags: string) => {
            if (flags === 'r') {
                return {
                    read: vi.fn(async (buffer: Buffer) => {
                        buffer[0] = 0x25;
                        return {
                            bytesRead: 1,
                            buffer,
                        };
                    }),
                    close: mocks.fileHandleClose,
                };
            }
            return {
                write,
                sync: mocks.fileHandleSync,
                close: mocks.fileHandleClose,
            };
        });

        const result = await handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/sentinel.pdf',
            {preserveBookmarks: false},
        );

        expect(result).toMatchObject({
            success: false,
            error: 'DjVu export write made invalid progress: 0',
        });
        expect(write).toHaveBeenCalledTimes(1);
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/.staged-output.tmp', {force: true});
        expect(mocks.fileHandleClose).toHaveBeenCalledTimes(2);
    });

    it('preserves the destination when a staged write fails after partial progress', async () => {
        const write = vi.fn()
            .mockResolvedValueOnce({bytesWritten: 1})
            .mockRejectedValueOnce(new Error('short write failed'));
        mocks.open.mockImplementation(async (_path: string, flags: string) => {
            if (flags === 'r') {
                return {
                    read: vi.fn(async (buffer: Buffer) => {
                        buffer[0] = 0x25;
                        buffer[1] = 0x50;
                        return {
                            bytesRead: 2,
                            buffer,
                        };
                    }),
                    close: mocks.fileHandleClose,
                };
            }
            return {
                write,
                sync: mocks.fileHandleSync,
                close: mocks.fileHandleClose,
            };
        });

        const result = await handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/sentinel.pdf',
            {preserveBookmarks: false},
        );

        expect(result).toMatchObject({
            success: false,
            error: 'short write failed',
        });
        expect(write).toHaveBeenCalledTimes(2);
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/.staged-output.tmp', {force: true});
        expect(mocks.fileHandleClose).toHaveBeenCalledTimes(2);
    });

    it('stops between partial writes when export is canceled', async () => {
        let cancelPromise: Promise<unknown> | undefined;
        const write = vi.fn()
            .mockImplementationOnce(async (_buffer: Buffer, _offset: number, _length: number) => {
                cancelPromise = handleDjvuCancel(
                    createOperationContext(7),
                    asJobId('djvu-convert-convert-123'),
                );
                return {bytesWritten: 1};
            })
            .mockResolvedValue({bytesWritten: 1});
        mocks.open.mockImplementation(async (_path: string, flags: string) => {
            if (flags === 'r') {
                return {
                    read: vi.fn(async (buffer: Buffer) => {
                        buffer[0] = 0x25;
                        buffer[1] = 0x50;
                        return {
                            bytesRead: 2,
                            buffer,
                        };
                    }),
                    close: mocks.fileHandleClose,
                };
            }
            return {
                write,
                sync: mocks.fileHandleSync,
                close: mocks.fileHandleClose,
            };
        });

        const conversionPromise = handleDjvuConvertToPdf(
            createOperationContext(7),
            trustedDjvuPath,
            '/tmp/canceled.pdf',
            {preserveBookmarks: false},
        );
        const result = await conversionPromise;
        await cancelPromise;

        expect(result).toMatchObject({
            success: false,
            error: 'DjVu conversion canceled',
        });
        expect(write).toHaveBeenCalledTimes(1);
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/.staged-output.tmp', {force: true});
    });

    it('prints selected DjVu pages through compact temp PDF and native print handoff', async () => {
        const event = createOperationContext(12);

        const result = await handleDjvuPrintPath(
            event,
            trustedDjvuPath,
            {
                requestId: requireRequestId('print-req'),
                fileName: 'book.djvu',
                pageNumbers: [
                    requirePageNumber(2),
                    requirePageNumber(1),
                    requirePageNumber(2),
                ],
                viewMode: 'single',
                orientation: 'auto',
            },
        );

        const expectedJobId = asJobId('djvu-print-print-req');
        const expectedFinalPath = `/tmp/evb-viewer/print-djvu-${expectedJobId}.pdf`;
        expect(result).toMatchObject({
            success: true,
            jobId: expectedJobId,
        });
        expect(mocks.buildCompactDjvuAwarePdfFromDjvu).toHaveBeenCalledWith(expect.objectContaining({
            jobId: expectedJobId,
            djvuPath: trustedDjvuPath,
            outputPath: expectedFinalPath,
            pages: [
                1,
                2,
            ],
        }));
        expect(mocks.getDjvuPageSizesForViewing).not.toHaveBeenCalled();
        expect(mocks.convertDjvuToPdfFile).not.toHaveBeenCalled();
        expect(mocks.optimizeGeneratedPdfForInteraction).toHaveBeenCalledWith(expectedFinalPath, { signal: expect.any(AbortSignal) });
        expect(mocks.safeSendToWindow).toHaveBeenCalledWith(null, 'djvu:progress', expect.objectContaining({
            jobId: expectedJobId,
            requestId: 'print-req',
            documentRef: trustedDjvuPath,
            phase: 'printing',
            percent: 100,
        }));
        expect(mocks.printManagedTempPdfPath).toHaveBeenCalledWith(
            {window: null},
            expectedFinalPath,
            'book p1-2',
            {
                signal: expect.any(AbortSignal),
                surface: 'rasterized-html',
            },
        );
        expect(mocks.printManagedTempPdfPath.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.safeSendToWindow.mock.invocationCallOrder.at(-1)!);
        expect(getDjvuOutputJobState(event, expectedJobId)).toMatchObject({
            operation: 'djvu-print',
            status: 'completed',
            artifactPath: expectedFinalPath,
        });
    });

    it('adds the selected DjVu page number to the native print save title', async () => {
        mocks.getDjvuPageCount.mockResolvedValueOnce(60);
        const event = createOperationContext(13);

        const result = await handleDjvuPrintPath(
            event,
            trustedDjvuPath,
            {
                requestId: requireRequestId('print-page-50'),
                fileName: 'book.djvu',
                pageNumbers: [requirePageNumber(50)],
                viewMode: 'single',
                orientation: 'auto',
            },
        );

        const expectedJobId = asJobId('djvu-print-print-page-50');
        const expectedFinalPath = `/tmp/evb-viewer/print-djvu-${expectedJobId}.pdf`;
        expect(result).toMatchObject({
            success: true,
            jobId: expectedJobId,
        });
        expect(mocks.buildCompactDjvuAwarePdfFromDjvu).toHaveBeenCalledWith(expect.objectContaining({pages: [50]}));
        expect(mocks.printManagedTempPdfPath).toHaveBeenCalledWith(
            {window: null},
            expectedFinalPath,
            'book p50',
            {
                signal: expect.any(AbortSignal),
                surface: 'rasterized-html',
            },
        );
    });

    it('reports failed terminal progress when DjVu print handoff fails', async () => {
        mocks.printManagedTempPdfPath.mockResolvedValueOnce({
            success: false,
            error: 'Print handoff failed',
        });
        const event = createOperationContext(14);

        const result = await handleDjvuPrintPath(
            event,
            trustedDjvuPath,
            {
                requestId: requireRequestId('print-failure'),
                fileName: 'book.djvu',
                viewMode: 'single',
                orientation: 'auto',
            },
        );

        const expectedJobId = asJobId('djvu-print-print-failure');
        expect(result).toMatchObject({
            success: false,
            jobId: expectedJobId,
            error: 'Print handoff failed',
        });
        const terminalProgressCalls = mocks.safeSendToWindow.mock.calls.filter((call) => {
            const progress = call[2] as { status?: string } | undefined;
            return call[1] === 'djvu:progress' && progress?.status !== undefined;
        });
        expect(terminalProgressCalls).toEqual([[
            null,
            'djvu:progress',
            expect.objectContaining({
                jobId: expectedJobId,
                requestId: 'print-failure',
                documentRef: trustedDjvuPath,
                phase: 'printing',
                percent: 100,
                status: 'failed',
                error: 'Print handoff failed',
            }),
        ]]);
    });

    it('aborts an active native DjVu print handoff when cancel is requested', async () => {
        let printSignal: AbortSignal | undefined;
        mocks.printManagedTempPdfPath.mockImplementationOnce((
            _context: unknown,
            _path: unknown,
            _fileName: unknown,
            options?: { signal?: AbortSignal },
        ) => {
            printSignal = options?.signal;
            return new Promise(resolve => {
                options?.signal?.addEventListener('abort', () => {
                    resolve({
                        success: false,
                        canceled: true,
                        error: 'Print handoff canceled',
                    });
                }, { once: true });
            });
        });
        const event = createOperationContext(14);

        const printPromise = handleDjvuPrintPath(
            event,
            trustedDjvuPath,
            {
                requestId: requireRequestId('cancel-print'),
                fileName: 'book.djvu',
                viewMode: 'single',
                orientation: 'auto',
            },
        );

        for (let attempt = 0; attempt < 20 && mocks.printManagedTempPdfPath.mock.calls.length === 0; attempt += 1) {
            await Promise.resolve();
        }
        expect(mocks.printManagedTempPdfPath).toHaveBeenCalledTimes(1);

        const cancelResult = await handleDjvuCancel(event, asJobId('djvu-print-cancel-print'));
        const result = await printPromise;

        expect(cancelResult).toEqual({ canceled: true });
        expect(printSignal?.aborted).toBe(true);
        expect(result).toMatchObject({
            success: false,
            canceled: true,
            jobId: asJobId('djvu-print-cancel-print'),
            error: 'DjVu print preparation canceled',
        });
        expect(mocks.loggerError).not.toHaveBeenCalled();
    });

    it('treats canceling DjVu print preparation as non-error logging', async () => {
        mocks.getDjvuPageCount.mockImplementationOnce((
            _filePath: string,
            options?: { signal?: AbortSignal },
        ) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
                reject(new Error('DjVu conversion canceled'));
            });
        }));
        const event = createOperationContext(15);

        const printPromise = handleDjvuPrintPath(
            event,
            trustedDjvuPath,
            {
                requestId: requireRequestId('cancel-prep'),
                fileName: 'book.djvu',
                viewMode: 'single',
                orientation: 'auto',
            },
        );

        for (let attempt = 0; attempt < 50 && mocks.getDjvuPageCount.mock.calls.length === 0; attempt += 1) {
            await delay(0);
        }
        const cancelResult = await handleDjvuCancel(event, asJobId('djvu-print-cancel-prep'));
        const result = await printPromise;

        expect(cancelResult).toEqual({ canceled: true });
        expect(result).toMatchObject({
            success: false,
            canceled: true,
            jobId: asJobId('djvu-print-cancel-prep'),
            error: 'DjVu print preparation canceled',
        });
        expect(mocks.loggerError).not.toHaveBeenCalled();
        expect(mocks.loggerInfo).toHaveBeenCalledWith(expect.stringContaining('DjVu print preparation canceled'));
    });

    it('cancels active jobs when the sender is destroyed', async () => {
        mocks.getDjvuPageCount.mockImplementationOnce((
            _filePath: string,
            options?: { signal?: AbortSignal },
        ) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
                const error = new Error('DjVu conversion canceled');
                error.name = 'AbortError';
                reject(error);
            });
        }));
        const event = createOperationContext(9);

        const convertPromise = handleDjvuConvertToPdf(
            event,
            trustedDjvuPath,
            '/tmp/output.pdf',
            {preserveBookmarks: true},
        );

        for (let attempt = 0; attempt < 50 && mocks.getDjvuPageCount.mock.calls.length === 0; attempt += 1) {
            await delay(0);
        }
        const metadataOptions = mocks.getDjvuPageCount.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
        event.sender.emit('destroyed');
        const result = await convertPromise;

        expect(metadataOptions?.signal?.aborted).toBe(true);
        expect(result).toMatchObject({
            success: false,
            jobId: asJobId('djvu-convert-convert-123'),
            error: 'DjVu conversion canceled',
        });
        expect(event.sender.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function));
        expect(event.sender.removeListener).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
    });

    it('removes queued jobs when their sender render process is gone', async () => {
        let finishFirstConversion!: () => void;
        mocks.convertDjvuToPdfFile.mockImplementationOnce(() => new Promise(resolve => {
            finishFirstConversion = () => {
                resolve({success: true});
            };
        }));
        const firstEvent = createOperationContext(10);
        const queuedEvent = createOperationContext(11);

        const firstPromise = handleDjvuConvertToPdf(
            firstEvent,
            trustedDjvuPath,
            '/tmp/first.pdf',
            {preserveBookmarks: false},
        );

        for (let attempt = 0; attempt < 50 && mocks.convertDjvuToPdfFile.mock.calls.length === 0; attempt += 1) {
            await delay(0);
        }
        expect(mocks.convertDjvuToPdfFile).toHaveBeenCalledTimes(1);

        const queuedPromise = handleDjvuConvertToPdf(
            queuedEvent,
            trustedDjvuPath,
            '/tmp/queued.pdf',
            {preserveBookmarks: false},
        );

        await Promise.resolve();
        queuedEvent.sender.emit('render-process-gone');
        await expect(queuedPromise).resolves.toMatchObject({
            success: false,
            jobId: asJobId('djvu-convert-temp-456'),
            error: 'DjVu conversion canceled',
        });
        expect(mocks.convertDjvuToPdfFile).toHaveBeenCalledTimes(1);

        finishFirstConversion();
        await expect(firstPromise).resolves.toMatchObject({
            success: true,
            jobId: asJobId('djvu-convert-convert-123'),
        });
    });

    it('retains a durable open across reload in its originating WebContents', async () => {
        const context = createOperationContext(21);
        const work = createDeferred<{
            success: true;
            pageCount: number
        }>();
        startDurableDjvuOpenJob(
            context,
            requireJobId('djvu-open-21-reload'),
            trustedDjvuPath,
            () => work.promise,
        );
        expect(getDjvuOutputJobState(context, requireJobId('djvu-open-21-reload'))).toMatchObject({
            operation: 'djvu-open',
            status: 'queued',
        });
        expect(subscribeDjvuOutputJob(context, requireJobId('djvu-open-21-reload'))).toMatchObject({status: 'queued'});
        mocks.safeSendToWindow.mockClear();

        context.sender.emit('did-start-navigation', {}, 'app://reload', false, true);
        work.resolve({
            success: true,
            pageCount: 3,
        });
        await expect(awaitDurableDjvuOpenJob(context, requireJobId('djvu-open-21-reload'))).resolves.toMatchObject({
            success: true,
            jobId: 'djvu-open-21-reload',
            pageCount: 3,
        });
        expect(mocks.adoptDjvuViewingPath).toHaveBeenCalledWith(context, trustedDjvuPath);
        expect(getDjvuOutputJobState(context, requireJobId('djvu-open-21-reload'))).toMatchObject({status: 'completed'});
        expect(mocks.safeSendToWindow.mock.calls.filter(([
            , , progress,
        ]) => (
            (progress as {jobId?: string}).jobId === 'djvu-open-21-reload'
        ))).toHaveLength(1);
    });

    it('does not grant a durable job to another WebContents', async () => {
        const owner = createOperationContext(22);
        const stranger = createOperationContext(23);
        startDurableDjvuOpenJob(
            owner,
            requireJobId('djvu-open-22-private'),
            trustedDjvuPath,
            async () => ({
                success: true,
                pageCount: 1,
            }),
        );

        await expect(awaitDurableDjvuOpenJob(stranger, requireJobId('djvu-open-22-private')))
            .rejects.toThrow('Unknown or expired DjVu open job');
        expect(getDjvuOutputJobState(stranger, requireJobId('djvu-open-22-private'))).toBeNull();
        await expect(handleDjvuCancel(stranger, requireJobId('djvu-open-22-private')))
            .resolves.toEqual({canceled: false});
        expect(subscribeDjvuOutputJob(stranger, requireJobId('djvu-open-22-private'))).toBeNull();
    });

    it('cancels durable open metadata through the registry signal', async () => {
        const context = createOperationContext(24);
        let receivedSignal: AbortSignal | undefined;
        startDurableDjvuOpenJob(
            context,
            requireJobId('djvu-open-24-cancel'),
            trustedDjvuPath,
            async (signal) => {
                receivedSignal = signal;
                await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}));
                return {
                    success: true,
                    pageCount: 1,
                };
            },
        );
        await vi.waitFor(() => expect(receivedSignal).toBeDefined());

        await expect(handleDjvuCancel(context, requireJobId('djvu-open-24-cancel')))
            .resolves.toEqual({canceled: true});
        await expect(awaitDurableDjvuOpenJob(context, requireJobId('djvu-open-24-cancel'))).resolves.toMatchObject({
            success: false,
            error: 'DjVu operation canceled',
        });
        expect(receivedSignal?.aborted).toBe(true);
        expect(getDjvuOutputJobState(context, requireJobId('djvu-open-24-cancel'))).toMatchObject({status: 'canceled'});
        expect(mocks.adoptDjvuViewingPath).not.toHaveBeenCalled();
    });

    it('retains durable conversion output and replays terminal progress', async () => {
        const context = createOperationContext(25);
        startDurableDjvuConvertJob(
            context,
            trustedDjvuPath,
            '/tmp/durable-output.pdf',
            {
                jobId: requireJobId('djvu-convert-25-reload'),
                preserveBookmarks: false,
                pdfStrategy: 'direct',
                requestId: requireRequestId('reload'),
            },
        );

        await expect(awaitDurableDjvuConvertJob(context, requireJobId('djvu-convert-25-reload'))).resolves.toMatchObject({
            success: true,
            jobId: 'djvu-convert-25-reload',
            pdfPath: '/tmp/durable-output.pdf',
        });
        expect(mocks.allowOpenPath).toHaveBeenLastCalledWith('/tmp/durable-output.pdf', context.sender);
        expect(getDjvuOutputJobState(context, requireJobId('djvu-convert-25-reload'))).toMatchObject({
            operation: 'djvu-convert',
            status: 'completed',
            artifactPath: '/tmp/durable-output.pdf',
        });

        mocks.safeSendToWindow.mockClear();
        subscribeDjvuProgress(context);
        expect(mocks.safeSendToWindow).toHaveBeenCalledWith(
            null,
            'djvu:progress',
            expect.objectContaining({
                jobId: 'djvu-convert-25-reload',
                status: 'success',
            }),
        );
        expect(subscribeDjvuOutputJob(context, requireJobId('djvu-convert-25-reload'))).toMatchObject({
            status: 'completed',
            artifactPath: '/tmp/durable-output.pdf',
        });
    });

    it('retains the conversion receipt in durable failed state for a later renderer', async () => {
        mocks.buildCompactDjvuAwarePdfFromDjvu.mockResolvedValueOnce({
            success: false,
            outputPath: '/tmp/djvu-export-test/convert-123.convert.pdf',
            fileSize: 0,
            error: 'durable conversion failed',
        });
        const context = createOperationContext(27);

        startDurableDjvuConvertJob(
            context,
            trustedDjvuPath,
            '/tmp/durable-failure.pdf',
            {
                jobId: requireJobId('djvu-convert-27-failure'),
                preserveBookmarks: false,
                pdfStrategy: 'compact-djvu-aware',
            },
        );

        await expect(awaitDurableDjvuConvertJob(context, requireJobId('djvu-convert-27-failure')))
            .resolves.toMatchObject({
                success: false,
                error: 'durable conversion failed',
                failure: conversionFailure,
            });
        expect(getDjvuOutputJobState(context, requireJobId('djvu-convert-27-failure'))).toMatchObject({
            status: 'failed',
            failure: conversionFailure,
        });
        expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    });

    it('retains at most 64 terminal DjVu records', async () => {
        const context = createOperationContext(26);
        for (let index = 0; index < 65; index += 1) {
            startDurableDjvuOpenJob(
                context,
                requireJobId(`djvu-open-26-bounded-${index}`),
                trustedDjvuPath,
                async () => ({
                    success: true,
                    pageCount: 1,
                }),
            );
        }
        await new Promise(resolve => setImmediate(resolve));

        expect(getDjvuOutputJobState(context, requireJobId('djvu-open-26-bounded-0'))).toBeNull();
        expect(getDjvuOutputJobState(context, requireJobId('djvu-open-26-bounded-64'))).toMatchObject({status: 'completed'});
    });
});
