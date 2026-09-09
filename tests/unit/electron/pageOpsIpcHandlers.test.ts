import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';

import type { TRegisteredHandler } from '@tests/unit/electron/helpers/ipcRegistryHarness';
import type * as PageIdentityStore from '@electron/file-access/pageIdentityStore';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import { PAGE_OPS_PLATFORM_FEATURE } from '@contracts/pageOpsPlatformFeature';
import { registerPlatformFeatureHandlers } from '@electron/platform-ipc/validatedIpcRegistrar';

type TProgressCallback = (progress: {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}) => void;

interface IDeferred<T> {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
}

function createDeferred<T = undefined>(): IDeferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });

    return {
        promise,
        resolve,
        reject,
    };
}

function flushQueuedMutationStart() {
    return delay(0);
}

const mocks = vi.hoisted(() => ({
    handlers: new Map<string, TRegisteredHandler>(),
    ipcHandle: vi.fn<(channel: string, handler: TRegisteredHandler) => void>(),
    existsSync: vi.fn<(path: string) => boolean>(),
    resolveAllowedWritePath: vi.fn<(path: string) => Promise<string | null>>(),
    deletePages: vi.fn(),
    deletePageRanges: vi.fn(),
    extractPages: vi.fn(),
    extractPageRanges: vi.fn(),
    getPdfPageCount: vi.fn(),
    reorderPages: vi.fn(),
    rotatePages: vi.fn(),
    verifyPdfStructureStrict: vi.fn(),
    cropPages: vi.fn(),
    removeCropFromPages: vi.fn(),
    getPageGeometry: vi.fn(),
    createPdfFileFromInputPaths: vi.fn(),
    createPdfFromInputPaths: vi.fn(),
    isPdfOrImagePath: vi.fn(),
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
    getFocusedWindow: vi.fn(),
    runCommand: vi.fn(),
    ensureWorkingCopyDirectory: vi.fn(),
    findWorkingCopyPathByOriginalPath: vi.fn(),
    assertWorkingCopyMutationAllowed: vi.fn(),
    assertWorkingCopyResyncAllowed: vi.fn(),
    assertWorkingCopyRevisionCurrent: vi.fn(),
    markWorkingCopyContentChanged: vi.fn(),
    transitionWorkingCopyContentRevision: vi.fn(),
    awaitPageIdentityStoreInitialization: vi.fn(),
    commitPageIdentityDelta: vi.fn(),
    applyPageMetadataRemap: vi.fn(),
    allowOpenPath: vi.fn(),
    allowOpenPaths: vi.fn(),
    requireOpenPath: vi.fn((path: string) => path),
    writeFile: vi.fn(),
    open: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
}));

vi.mock('electron', () => ({
    app: {
        getPath: vi.fn(() => '/home/test/Documents'),
        isPackaged: false,
    },
    BrowserWindow: {
        fromWebContents: () => null,
        getFocusedWindow: () => mocks.getFocusedWindow(),
    },
    dialog: {
        showSaveDialog: (...args: unknown[]) => mocks.showSaveDialog(...args),
        showOpenDialog: (...args: unknown[]) => mocks.showOpenDialog(...args),
    },
    ipcMain: { handle: (channel: string, handler: TRegisteredHandler) => {
        mocks.ipcHandle(channel, handler);
        mocks.handlers.set(channel, handler);
    } },
}));

vi.mock('fs', () => ({
    existsSync: (path: string) => mocks.existsSync(path),
    lstatSync: vi.fn(() => ({isSymbolicLink: () => false})),
}));
vi.mock('fs/promises', () => ({
    writeFile: (...args: unknown[]) => mocks.writeFile(...args),
    open: (...args: unknown[]) => mocks.open(...args),
    rename: (...args: unknown[]) => mocks.rename(...args),
    rm: (...args: unknown[]) => mocks.rm(...args),
    stat: (...args: unknown[]) => mocks.stat(...args),
    unlink: (...args: unknown[]) => mocks.unlink(...args),
}));
vi.mock('@electron/utils/pathValidator', () => ({resolveAllowedWritePath: (path: string) => mocks.resolveAllowedWritePath(path)}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: (...args: unknown[]) => mocks.ensureWorkingCopyDirectory(...args)}));
vi.mock('@electron/file-access/workingCopyStore', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule>()),
    findWorkingCopyPathByOriginalPath: (...args: unknown[]) => mocks.findWorkingCopyPathByOriginalPath(...args),
    normalizePathForLookup: (path: string) => path.trim(),
}));
vi.mock('@electron/file-access/documentRevisionStore', () => ({
    assertWorkingCopyMutationAllowed: (...args: unknown[]) => mocks.assertWorkingCopyMutationAllowed(...args),
    assertWorkingCopyResyncAllowed: (...args: unknown[]) => mocks.assertWorkingCopyResyncAllowed(...args),
    assertWorkingCopyRevisionCurrent: (...args: unknown[]) => mocks.assertWorkingCopyRevisionCurrent(...args),
    markWorkingCopyContentChanged: (...args: unknown[]) => mocks.markWorkingCopyContentChanged(...args),
    transitionWorkingCopyContentRevision: (...args: unknown[]) => mocks.transitionWorkingCopyContentRevision(...args),
}));
vi.mock('@electron/file-access/pageIdentityStore', async importOriginal => ({
    ...await importOriginal<typeof PageIdentityStore>(),
    awaitPageIdentityStoreInitialization: (...args: unknown[]) => mocks.awaitPageIdentityStoreInitialization(...args),
    commitPageIdentityDelta: (...args: unknown[]) => mocks.commitPageIdentityDelta(...args),
}));
vi.mock('@electron/features/page-ops/main/pageMetadataRemap', () => ({applyPageMetadataRemap: (...args: unknown[]) => mocks.applyPageMetadataRemap(...args)}));
vi.mock('@electron/features/page-ops/main/qpdf', () => ({
    QPDF_OUTPUT_SUCCESS_EXIT_CODES: [
        0,
        3,
    ],
    QPDF_TIMEOUT_MS: 120000,
    assertNonEmptyPdfOutput: vi.fn(),
    deletePageRanges: (...args: unknown[]) => mocks.deletePageRanges(...args),
    deletePages: (...args: unknown[]) => mocks.deletePages(...args),
    extractPages: (...args: unknown[]) => mocks.extractPages(...args),
    extractPageRanges: (...args: unknown[]) => mocks.extractPageRanges(...args),
    getPdfPageCount: (...args: unknown[]) => mocks.getPdfPageCount(...args),
    reorderPages: (...args: unknown[]) => mocks.reorderPages(...args),
    runQpdfCommand: (...args: unknown[]) => mocks.runCommand(...args),
    rotatePages: (...args: unknown[]) => mocks.rotatePages(...args),
    verifyPdfStructureStrict: (...args: unknown[]) => mocks.verifyPdfStructureStrict(...args),
}));
vi.mock('@electron/features/page-ops/main/crop', () => ({
    cropPages: (...args: unknown[]) => mocks.cropPages(...args),
    removeCropFromPages: (...args: unknown[]) => mocks.removeCropFromPages(...args),
    getPageGeometry: (...args: unknown[]) => mocks.getPageGeometry(...args),
}));
vi.mock('@electron/image/pdfConversion', () => ({
    createPdfFileFromInputPaths: (...args: unknown[]) => mocks.createPdfFileFromInputPaths(...args),
    createPdfFromInputPaths: (...args: unknown[]) => mocks.createPdfFromInputPaths(...args),
    isPdfOrImagePath: (...args: unknown[]) => mocks.isPdfOrImagePath(...args),
}));
vi.mock('@electron/image/pdfCombineShared', () => ({ PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS: [
    '.png',
    '.jpg',
] }));
vi.mock('@electron/te', () => ({te: (key: string) => key}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runCommand(...args)}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({
    allowOpenPath: (...args: unknown[]) => mocks.allowOpenPath(...args),
    allowOpenPaths: (...args: unknown[]) => mocks.allowOpenPaths(...args),
    requireOpenPath: (path: string) => mocks.requireOpenPath(path),
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

const { pageOpsMainBindings } = await import('@electron/features/page-ops/main/pageOpsMainBindings');
const {
    cancelAllMainOperations,
    resetMainOperationLifecycleForTests,
} = await import('@electron/operation-lifecycle/mainOperationLifecycle');
const REVISION_OPTIONS = {expectedDocumentRevisionToken: 'drt1:test:before-page-op'} as const;

function expectNativeMutationOptions() {
    return expect.objectContaining({
        signal: expect.any(AbortSignal),
        cancelGroup: expect.stringMatching(/^working-copy-mutation:/u),
    });
}

function getHandler(channel: string) {
    const handler = mocks.handlers.get(channel);
    if (!handler) {
        throw new Error(`IPC handler is not registered for channel "${channel}"`);
    }
    return handler;
}

describe('page ops main bindings', () => {
    beforeEach(() => {
        resetMainOperationLifecycleForTests();
        mocks.handlers.clear();
        vi.clearAllMocks();

        mocks.existsSync.mockReturnValue(true);
        mocks.resolveAllowedWritePath.mockImplementation(async (path: string) => path);
        mocks.getFocusedWindow.mockReturnValue(null);
        mocks.showSaveDialog.mockResolvedValue({
            canceled: true,
            filePath: undefined,
        });
        mocks.showOpenDialog.mockResolvedValue({
            canceled: true,
            filePaths: [],
        });
        mocks.createPdfFromInputPaths.mockResolvedValue(new Uint8Array([1]));
        mocks.createPdfFileFromInputPaths.mockResolvedValue(undefined);
        mocks.isPdfOrImagePath.mockReturnValue(true);
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(null);
        mocks.assertWorkingCopyMutationAllowed.mockResolvedValue(undefined);
        mocks.assertWorkingCopyRevisionCurrent.mockResolvedValue(undefined);
        mocks.markWorkingCopyContentChanged.mockImplementation(async (workingPath: string) => ({
            version: 1,
            documentRef: workingPath,
            authority: 'electron-working-copy',
            token: 'drt1:test:after-page-op',
            contentRevision: 2,
            mintedAt: 2,
            reason: 'page-ops',
        }));
        mocks.transitionWorkingCopyContentRevision.mockImplementation(async (
            workingPath: string,
            reason: string,
            commit: (revision: unknown) => Promise<void>,
        ) => {
            const revision = {
                version: 1,
                documentRef: workingPath,
                authority: 'electron-working-copy',
                token: 'drt1:test:after-page-op',
                contentRevision: 2,
                mintedAt: 2,
                reason,
            };
            await commit(revision);
            return revision;
        });
        mocks.awaitPageIdentityStoreInitialization.mockResolvedValue(undefined);
        mocks.commitPageIdentityDelta.mockResolvedValue(undefined);
        mocks.applyPageMetadataRemap.mockResolvedValue(undefined);
        mocks.writeFile.mockResolvedValue(undefined);
        mocks.open.mockResolvedValue({
            close: vi.fn(async () => undefined),
            sync: vi.fn(async () => undefined),
        });
        mocks.rename.mockResolvedValue(undefined);
        mocks.rm.mockResolvedValue(undefined);
        mocks.stat.mockResolvedValue({size: 1});
        mocks.unlink.mockResolvedValue(undefined);

        mocks.deletePages.mockResolvedValue({pageCount: 1});
        mocks.deletePageRanges.mockResolvedValue({pageCount: 1});
        mocks.extractPages.mockResolvedValue(undefined);
        mocks.extractPageRanges.mockResolvedValue(undefined);
        mocks.getPdfPageCount.mockResolvedValue(3);
        mocks.reorderPages.mockResolvedValue({pageCount: 1});
        mocks.rotatePages.mockResolvedValue(undefined);
        mocks.verifyPdfStructureStrict.mockResolvedValue(undefined);
        mocks.cropPages.mockResolvedValue(undefined);
        mocks.removeCropFromPages.mockResolvedValue(undefined);
        mocks.getPageGeometry.mockResolvedValue(null);
        mocks.runCommand.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
        });

        registerPlatformFeatureHandlers(
            {handle: (channel, handler) => {
                mocks.ipcHandle(channel, handler as TRegisteredHandler);
                mocks.handlers.set(channel, handler as TRegisteredHandler);
            }},
            PAGE_OPS_PLATFORM_FEATURE,
            pageOpsMainBindings,
        );
    });

    it('serializes mutating operations for the same workingCopyPath', async () => {
        const firstGate = createDeferred();
        const callOrder: string[] = [];
        let invocation = 0;

        mocks.reorderPages.mockImplementation(async (_workingCopyPath: string, newOrder: number[]) => {
            invocation += 1;
            callOrder.push(`start-${invocation}`);
            if (invocation === 1) {
                await firstGate.promise;
            }
            callOrder.push(`end-${invocation}`);
            return {pageCount: newOrder.length};
        });

        const handler = getHandler('page-ops:reorder');
        const first = handler({sender: {id: 1}}, '/tmp/same.pdf', [
            1,
            2,
            3,
        ], REVISION_OPTIONS) as Promise<{
            success: boolean;
            pageCount: number
        }>;
        const second = handler({sender: {id: 1}}, '/tmp/same.pdf', [
            3,
            2,
            1,
        ], REVISION_OPTIONS) as Promise<{
            success: boolean;
            pageCount: number
        }>;

        await flushQueuedMutationStart();

        expect(mocks.reorderPages).toHaveBeenCalledTimes(1);

        firstGate.resolve(undefined);

        await expect(first).resolves.toMatchObject({
            success: true,
            pageCount: 3,
        });
        await expect(second).resolves.toMatchObject({
            success: true,
            pageCount: 3,
        });

        expect(mocks.awaitPageIdentityStoreInitialization).toHaveBeenNthCalledWith(1, '/tmp/same.pdf');
        expect(mocks.awaitPageIdentityStoreInitialization).toHaveBeenNthCalledWith(2, '/tmp/same.pdf');

        expect(callOrder).toEqual([
            'start-1',
            'end-1',
            'start-2',
            'end-2',
        ]);
    });

    it('allows different workingCopyPath mutations to run concurrently', async () => {
        const pathOneGate = createDeferred();
        const pathTwoGate = createDeferred();

        mocks.rotatePages.mockImplementation(async (workingCopyPath: string) => {
            if (workingCopyPath === '/tmp/a.pdf') {
                await pathOneGate.promise;
                return;
            }
            if (workingCopyPath === '/tmp/b.pdf') {
                await pathTwoGate.promise;
                return;
            }
        });

        const handler = getHandler('page-ops:rotate');
        const first = handler({sender: {id: 1}}, '/tmp/a.pdf', [1], 3, 90, REVISION_OPTIONS) as Promise<{ success: boolean }>;
        const second = handler({sender: {id: 1}}, '/tmp/b.pdf', [1], 3, 90, REVISION_OPTIONS) as Promise<{ success: boolean }>;

        await flushQueuedMutationStart();

        expect(mocks.rotatePages).toHaveBeenCalledTimes(2);

        pathOneGate.resolve(undefined);
        pathTwoGate.resolve(undefined);

        await expect(first).resolves.toMatchObject({success: true});
        await expect(second).resolves.toMatchObject({success: true});
    });

    it('rechecks reorder permutations against the actual working-copy page count inside the queue', async () => {
        mocks.getPdfPageCount.mockResolvedValueOnce(3);
        const handler = getHandler('page-ops:reorder');

        await expect(handler({sender: {id: 1}}, '/tmp/stale-reorder.pdf', [
            1,
            2,
        ], REVISION_OPTIONS)).rejects.toThrow('expected 3 page(s), received 2');

        expect(mocks.getPdfPageCount).toHaveBeenCalledWith(
            '/tmp/stale-reorder.pdf',
            expectNativeMutationOptions(),
        );
        expect(mocks.reorderPages).not.toHaveBeenCalled();
    });

    it('rejects stale rotate page selections inside the mutation queue', async () => {
        mocks.getPdfPageCount.mockResolvedValueOnce(2);
        const handler = getHandler('page-ops:rotate');

        await expect(handler({sender: {id: 1}}, '/tmp/stale-rotate.pdf', [3], 3, 90, REVISION_OPTIONS))
            .rejects.toThrow('Renderer page count is stale');

        expect(mocks.rotatePages).not.toHaveBeenCalled();
    });

    it('asserts page-op expected revision inside the mutation queue', async () => {
        const handler = getHandler('page-ops:rotate');

        await expect(handler(
            {sender: {id: 1}},
            '/tmp/revision-guarded.pdf',
            [1],
            3,
            90,
            {expectedDocumentRevisionToken: 'drt1:test:before-page-op'},
        )).resolves.toMatchObject({success: true});

        expect(mocks.assertWorkingCopyMutationAllowed).toHaveBeenCalledWith('/tmp/revision-guarded.pdf');
        expect(mocks.assertWorkingCopyRevisionCurrent).toHaveBeenCalledWith(
            '/tmp/revision-guarded.pdf',
            'drt1:test:before-page-op',
        );
        expect(mocks.assertWorkingCopyRevisionCurrent.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.rotatePages.mock.invocationCallOrder[0]!);
    });

    it('passes mutation cancellation to qpdf page-count and rotate helpers', async () => {
        const handler = getHandler('page-ops:rotate');

        await expect(handler({sender: {id: 1}}, '/tmp/native-rotate.pdf', [1], 3, 90, REVISION_OPTIONS))
            .resolves.toMatchObject({success: true});

        expect(mocks.getPdfPageCount).toHaveBeenCalledWith(
            '/tmp/native-rotate.pdf',
            expectNativeMutationOptions(),
        );
        expect(mocks.rotatePages).toHaveBeenCalledWith(
            '/tmp/native-rotate.pdf',
            [1],
            90,
            1,
            expectNativeMutationOptions(),
        );
    });

    it('publishes a sparse identity delta for a million-page rotate', async () => {
        const handler = getHandler('page-ops:rotate');
        mocks.getPdfPageCount
            .mockResolvedValueOnce(1_000_000)
            .mockResolvedValueOnce(1_000_000);

        await expect(handler(
            {sender: {id: 1}},
            '/tmp/million-page-rotate.pdf',
            [500_000],
            1_000_000,
            90,
            REVISION_OPTIONS,
        )).resolves.toMatchObject({success: true});

        expect(mocks.commitPageIdentityDelta).toHaveBeenCalledWith(
            '/tmp/million-page-rotate.pdf',
            expect.objectContaining({
                previousPageCount: 1_000_000,
                nextPageCount: 1_000_000,
                ranges: expect.arrayContaining([{
                    kind: 'touch',
                    toPageNumber: 500_000,
                    count: 1,
                    reason: 'rotate',
                }]),
            }),
            expect.objectContaining({contentRevision: 2}),
        );
    });

    it('runs a large compact rotate in bounded native batches under one revision', async () => {
        const handler = getHandler('page-ops:rotate');
        mocks.getPdfPageCount.mockResolvedValue(110_000);

        await expect(handler(
            {sender: {id: 1}},
            '/tmp/large-rotate.pdf',
            {
                pageCount: 110_000,
                ranges: [{
                    startPage: 1,
                    endPage: 100_001,
                }],
            },
            110_000,
            90,
            REVISION_OPTIONS,
        )).resolves.toMatchObject({success: true});

        expect(mocks.rotatePages).toHaveBeenCalledTimes(11);
        expect(mocks.rotatePages.mock.calls.every(call => call[1].length <= 10_000)).toBe(true);
        expect(mocks.rotatePages.mock.calls.flatMap(call => call[1])).toEqual(
            Array.from({length: 100_001}, (_, index) => index + 1),
        );
        expect(mocks.rotatePages.mock.calls.at(-1)?.[1]).toEqual([100_001]);
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalledOnce();
        expect(mocks.applyPageMetadataRemap).toHaveBeenCalledOnce();
        expect(mocks.commitPageIdentityDelta).toHaveBeenCalledOnce();
    });

    it('does not publish a revision when a later rotate batch fails', async () => {
        const handler = getHandler('page-ops:rotate');
        mocks.getPdfPageCount.mockResolvedValue(30_000);
        mocks.rotatePages
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('second batch failed'));

        await expect(handler(
            {sender: {id: 1}},
            '/tmp/failed-large-rotate.pdf',
            {
                pageCount: 30_000,
                ranges: [{
                    startPage: 1,
                    endPage: 25_001,
                }],
            },
            30_000,
            90,
            REVISION_OPTIONS,
        )).rejects.toThrow('second batch failed');

        expect(mocks.rotatePages).toHaveBeenCalledTimes(2);
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalledOnce();
        expect(mocks.applyPageMetadataRemap).not.toHaveBeenCalled();
        expect(mocks.commitPageIdentityDelta).not.toHaveBeenCalled();
    });

    it('deletes a million-page select-all range without a legacy page array', async () => {
        const handler = getHandler('page-ops:delete-ranges');
        mocks.getPdfPageCount
            .mockResolvedValueOnce(1_000_000)
            .mockResolvedValueOnce(1);
        mocks.deletePageRanges.mockResolvedValueOnce({pageCount: 1});

        await expect(handler(
            {sender: {id: 1}},
            '/tmp/million-page-delete.pdf',
            [{
                startPage: 2,
                endPage: 1_000_000,
            }],
            1_000_000,
            REVISION_OPTIONS,
        )).resolves.toMatchObject({
            success: true,
            pageCount: 1,
        });

        expect(mocks.deletePageRanges).toHaveBeenCalledOnce();
        expect(mocks.deletePageRanges).toHaveBeenCalledWith(
            '/tmp/million-page-delete.pdf',
            [{
                startPage: 2,
                endPage: 1_000_000,
            }],
            1_000_000,
            1,
            expectNativeMutationOptions(),
        );
        expect(mocks.deletePages).not.toHaveBeenCalled();
        expect(mocks.commitPageIdentityDelta).toHaveBeenCalledWith(
            '/tmp/million-page-delete.pdf',
            expect.objectContaining({
                previousPageCount: 1_000_000,
                nextPageCount: 1,
                ranges: [
                    {
                        kind: 'retain',
                        fromPageNumber: 1,
                        toPageNumber: 1,
                        count: 1,
                    },
                    {
                        kind: 'delete',
                        fromPageNumber: 2,
                        count: 999_999,
                    },
                ],
            }),
            expect.objectContaining({contentRevision: 2}),
        );
    });

    it('passes the mutation abort signal to crop helpers', async () => {
        const handler = getHandler('page-ops:crop');
        const margins = {
            top: 1,
            bottom: 2,
            left: 3,
            right: 4,
        };

        await expect(handler({sender: {id: 1}}, '/tmp/native-crop.pdf', [1], 3, margins, REVISION_OPTIONS))
            .resolves.toMatchObject({success: true});

        const nativeOptions = mocks.getPdfPageCount.mock.calls[0]?.[1] as {
            signal?: AbortSignal;
            cancelGroup?: string;
        };
        expect(nativeOptions).toEqual(expectNativeMutationOptions());
        expect(mocks.cropPages).toHaveBeenCalledWith(
            '/tmp/native-crop.pdf',
            [1],
            margins,
            1,
            nativeOptions.signal,
        );
    });

    it('passes mutation cancellation to insert-source combine and qpdf helpers', async () => {
        const handler = getHandler('page-ops:insert-file');

        await expect(handler(
            {sender: {id: 1}},
            '/tmp/pdf-work-1/work.pdf',
            3,
            1,
            ['/tmp/source.png'],
            undefined,
            REVISION_OPTIONS,
        )).resolves.toMatchObject({success: true});

        const nativeOptions = mocks.getPdfPageCount.mock.calls[0]?.[1] as {
            signal?: AbortSignal;
            cancelGroup?: string;
        };
        expect(nativeOptions).toEqual(expectNativeMutationOptions());
        expect(mocks.createPdfFileFromInputPaths).toHaveBeenCalledWith(
            ['/tmp/source.png'],
            expect.stringMatching(/^\/tmp\/pdf-work-1\/insert-source-.+\.pdf$/u),
            expect.objectContaining({signal: nativeOptions.signal}),
        );
        expect(mocks.runCommand).toHaveBeenCalledWith(
            expect.any(Array),
            expect.objectContaining({
                signal: nativeOptions.signal,
                cancelGroup: nativeOptions.cancelGroup,
            }),
        );
    });

    it('opens insert-page sources from the validated working-copy directory', async () => {
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue('/tmp/pdf-work-1/work.pdf');
        const handler = getHandler('page-ops:insert');

        await expect(handler(
            {sender: {id: 1}},
            '/home/test/Documents/original.pdf',
            3,
            1,
        )).resolves.toEqual({
            success: false,
            canceled: true,
        });

        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledWith('/tmp/pdf-work-1/work.pdf', 1);
        expect(mocks.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({defaultPath: '/tmp/pdf-work-1'}));
    });

    it('rejects unmanaged insert-page paths before opening the source dialog', async () => {
        mocks.ensureWorkingCopyDirectory.mockResolvedValueOnce(false);
        const handler = getHandler('page-ops:insert');

        await expect(handler(
            {sender: {id: 1}},
            '/tmp/unmanaged/work.pdf',
            3,
            1,
        )).rejects.toThrow('Path is not a managed working copy');

        expect(mocks.showOpenDialog).not.toHaveBeenCalled();
    });

    it('rejects a running page-op helper when the mutation operation is canceled', async () => {
        const handler = getHandler('page-ops:rotate');
        let helperSignal: AbortSignal | undefined;
        mocks.rotatePages.mockImplementationOnce((
            _workingCopyPath: string,
            _pages: number[],
            _angle: number,
            _senderWebContentsId: number,
            nativeOptions?: {signal?: AbortSignal},
        ) => new Promise((_resolve, reject) => {
            helperSignal = nativeOptions?.signal;
            helperSignal?.addEventListener('abort', () => {
                reject(helperSignal?.reason);
            }, {once: true});
        }));

        const operationPromise = handler(
            {sender: {id: 1}},
            '/tmp/cancel-rotate.pdf',
            [1],
            3,
            90,
            REVISION_OPTIONS,
        ) as Promise<unknown>;

        for (let attempt = 0; attempt < 5 && !helperSignal; attempt += 1) {
            await flushQueuedMutationStart();
        }
        expect(helperSignal).toBeInstanceOf(AbortSignal);

        cancelAllMainOperations('tab closed during page operation');

        await expect(operationPromise).rejects.toThrow('tab closed during page operation');
        expect(helperSignal?.aborted).toBe(true);
    });

    it('rejects stale crop page selections inside the mutation queue', async () => {
        mocks.getPdfPageCount.mockResolvedValueOnce(2);
        const handler = getHandler('page-ops:crop');

        await expect(handler({sender: {id: 1}}, '/tmp/stale-crop.pdf', [3], 3, {
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
        }, REVISION_OPTIONS)).rejects.toThrow('Renderer page count is stale');

        expect(mocks.cropPages).not.toHaveBeenCalled();
    });

    it('does not publish a revision when a later compact crop batch fails', async () => {
        mocks.getPdfPageCount.mockResolvedValue(3_000);
        mocks.cropPages
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('second crop batch failed'));
        const handler = getHandler('page-ops:crop');

        await expect(handler(
            {sender: {id: 1}},
            '/tmp/failed-large-crop.pdf',
            {
                pageCount: 3_000,
                ranges: [{
                    startPage: 1,
                    endPage: 2_049,
                }],
            },
            3_000,
            {
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
            },
            REVISION_OPTIONS,
        )).rejects.toThrow('second crop batch failed');

        expect(mocks.cropPages).toHaveBeenCalledTimes(2);
        expect(mocks.cropPages.mock.calls[0]?.[1]).toHaveLength(1_024);
        expect(mocks.cropPages.mock.calls[1]?.[1]).toHaveLength(1_024);
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalledOnce();
        expect(mocks.applyPageMetadataRemap).not.toHaveBeenCalled();
        expect(mocks.commitPageIdentityDelta).not.toHaveBeenCalled();
    });

    it('rejects stale remove-crop page selections inside the mutation queue', async () => {
        mocks.getPdfPageCount.mockResolvedValueOnce(2);
        const handler = getHandler('page-ops:remove-crop');

        await expect(handler({sender: {id: 1}}, '/tmp/stale-remove-crop.pdf', [3], 3, REVISION_OPTIONS))
            .rejects.toThrow('Renderer page count is stale');

        expect(mocks.removeCropFromPages).not.toHaveBeenCalled();
    });

    it('rejects insert-file batches above the shared open-input cap', async () => {
        const handler = getHandler('page-ops:insert-file');
        const sourcePaths = Array.from({length: 513}, (_, index) => `/tmp/source-${index}.png`);

        await expect(handler({sender: {id: 1}}, '/tmp/pdf-work-1/work.pdf', 3, 1, sourcePaths))
            .rejects.toThrow('errors.file.invalid');

        expect(mocks.createPdfFileFromInputPaths).not.toHaveBeenCalled();
        expect(mocks.createPdfFromInputPaths).not.toHaveBeenCalled();
        expect(mocks.runCommand).not.toHaveBeenCalled();
    });

    it('continues processing same-path queue after a mutation failure', async () => {
        const firstGate = createDeferred();
        let invocation = 0;
        mocks.getPdfPageCount
            .mockResolvedValueOnce(3)
            .mockResolvedValueOnce(3)
            .mockResolvedValueOnce(2);

        mocks.deletePages.mockImplementation(async () => {
            invocation += 1;
            if (invocation === 1) {
                await firstGate.promise;
                throw new Error('delete failed');
            }
            return {pageCount: 2};
        });

        const handler = getHandler('page-ops:delete');
        const first = handler({sender: {id: 1}}, '/tmp/fail.pdf', [1], 3, REVISION_OPTIONS);
        const second = handler({sender: {id: 1}}, '/tmp/fail.pdf', [2], 3, REVISION_OPTIONS);

        await flushQueuedMutationStart();

        expect(mocks.deletePages).toHaveBeenCalledTimes(1);

        firstGate.resolve(undefined);

        await expect(first).rejects.toThrow('delete failed');
        await expect(second).resolves.toMatchObject({
            success: true,
            pageCount: 2,
        });
        expect(mocks.deletePages).toHaveBeenCalledTimes(2);
    });

    it('allows the extracted PDF path before returning it for a new-tab open', async () => {
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/extracted-pages',
        });

        const handler = getHandler('page-ops:extract');

        await expect(handler({sender: {id: 1}}, '/tmp/work.pdf', [
            1,
            2,
        ])).resolves.toEqual({
            success: true,
            destPath: '/tmp/extracted-pages.pdf',
        });

        expect(mocks.extractPages).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            '/tmp/extracted-pages.pdf',
            [
                1,
                2,
            ],
            expectNativeMutationOptions(),
        );
        expect(mocks.allowOpenPath).toHaveBeenCalledWith('/tmp/extracted-pages.pdf', {id: 1});
        expect(mocks.extractPages.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.allowOpenPath.mock.invocationCallOrder[0]!,
        );
    });

    it('extracts a large compact selection through one dialog and one native lifecycle', async () => {
        mocks.getPdfPageCount.mockResolvedValueOnce(50_000);
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/large-extract.pdf',
        });
        const handler = getHandler('page-ops:extract');
        const ranges = [{
            startPage: 5_000,
            endPage: 35_000,
        }];

        await expect(handler(
            {sender: {id: 1}},
            '/tmp/work.pdf',
            {
                pageCount: 50_000,
                ranges,
            },
        )).resolves.toEqual({
            success: true,
            destPath: '/tmp/large-extract.pdf',
        });

        expect(mocks.showSaveDialog).toHaveBeenCalledOnce();
        expect(mocks.extractPageRanges).toHaveBeenCalledOnce();
        expect(mocks.extractPageRanges).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            '/tmp/large-extract.pdf',
            ranges,
            expectNativeMutationOptions(),
        );
        expect(mocks.extractPages).not.toHaveBeenCalled();
    });

    it('recovers the working copy before validating an extract request', async () => {
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/extracted-pages.pdf',
        });

        const handler = getHandler('page-ops:extract');

        await expect(handler({sender: {id: 1}}, '/tmp/pdf-work-1/work.pdf', [1]))
            .resolves.toEqual({
                success: true,
                destPath: '/tmp/extracted-pages.pdf',
            });

        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledWith('/tmp/pdf-work-1/work.pdf', 1);
        expect(mocks.ensureWorkingCopyDirectory.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.resolveAllowedWritePath.mock.invocationCallOrder[0]!,
        );
    });

    it('maps a known original document path back to the managed working copy for extraction', async () => {
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue('/tmp/pdf-work-1/work.pdf');
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/extracted-pages.pdf',
        });

        const handler = getHandler('page-ops:extract');

        await expect(handler({sender: {id: 1}}, 'C:\\Users\\Rustaveli15\\Documents\\book.pdf', [1]))
            .resolves.toEqual({
                success: true,
                destPath: '/tmp/extracted-pages.pdf',
            });

        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledWith('/tmp/pdf-work-1/work.pdf', 1);
        expect(mocks.findWorkingCopyPathByOriginalPath).toHaveBeenCalledWith(
            'C:\\Users\\Rustaveli15\\Documents\\book.pdf',
            1,
        );
        expect(mocks.extractPages).toHaveBeenCalledWith(
            '/tmp/pdf-work-1/work.pdf',
            '/tmp/extracted-pages.pdf',
            [1],
            expectNativeMutationOptions(),
        );
    });

    it('accepts a Windows temp working copy path for extraction', async () => {
        const workingCopyPath = 'C:\\Users\\Alice\\AppData\\Local\\Temp\\pdf-work-1\\work.pdf';
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: 'C:\\Users\\Alice\\Desktop\\extracted-pages.pdf',
        });

        const handler = getHandler('page-ops:extract');

        await expect(handler({sender: {id: 1}}, workingCopyPath, [1]))
            .resolves.toEqual({
                success: true,
                destPath: 'C:\\Users\\Alice\\Desktop\\extracted-pages.pdf',
            });

        expect(mocks.resolveAllowedWritePath).toHaveBeenCalledWith(workingCopyPath);
        expect(mocks.extractPages).toHaveBeenCalledWith(
            workingCopyPath,
            'C:\\Users\\Alice\\Desktop\\extracted-pages.pdf',
            [1],
            expectNativeMutationOptions(),
        );
    });

    it('accepts a Windows native namespaced temp working copy path for extraction', async () => {
        const workingCopyPath = '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\pdf-work-1\\work.pdf';
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: 'C:\\Users\\Alice\\Desktop\\extracted-pages.pdf',
        });

        const handler = getHandler('page-ops:extract');

        await expect(handler({sender: {id: 1}}, workingCopyPath, [1]))
            .resolves.toEqual({
                success: true,
                destPath: 'C:\\Users\\Alice\\Desktop\\extracted-pages.pdf',
            });

        expect(mocks.resolveAllowedWritePath).toHaveBeenCalledWith(workingCopyPath);
        expect(mocks.extractPages).toHaveBeenCalledWith(
            workingCopyPath,
            'C:\\Users\\Alice\\Desktop\\extracted-pages.pdf',
            [1],
            expectNativeMutationOptions(),
        );
    });

    it('rejects an unmapped original Windows path before showing the extract destination dialog', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValueOnce(null);

        const handler = getHandler('page-ops:extract');

        await expect(handler({sender: {id: 1}}, 'C:\\Users\\Alice\\Documents\\book.pdf', [1]))
            .rejects.toThrow('Path is outside the allowed working directory');

        expect(mocks.showSaveDialog).not.toHaveBeenCalled();
        expect(mocks.extractPages).not.toHaveBeenCalled();
    });

    it.each([
        [
            'non-finite',
            {
                top: Number.NaN,
                bottom: 0,
                left: 0,
                right: 0,
            },
        ],
        [
            'negative',
            {
                top: -1,
                bottom: 0,
                left: 0,
                right: 0,
            },
        ],
        [
            'structurally invalid',
            {
                top: 0,
                bottom: 0,
                left: 0,
            },
        ],
    ])('rejects %s crop margins before reaching Electron page crop mutations', async (_label, margins) => {
        const handler = getHandler('page-ops:crop');

        await expect(handler({sender: {id: 1}}, '/tmp/crop.pdf', [1], 3, margins))
            .rejects.toThrow('Invalid crop margins');

        expect(mocks.cropPages).not.toHaveBeenCalled();
    });

    it('returns page geometry for a managed working copy', async () => {
        const geometry = {
            mediaBox: {
                x: 0,
                y: 0,
                width: 612,
                height: 792,
            },
            cropBox: null,
            rotation: 90,
        };
        mocks.getPageGeometry.mockResolvedValueOnce(geometry);
        const handler = getHandler('page-ops:get-page-geometry');

        await expect(handler({sender: {id: 1}}, '/tmp/work.pdf', 2)).resolves.toEqual(geometry);

        expect(mocks.getPageGeometry).toHaveBeenCalledWith('/tmp/work.pdf', 2, 1);
    });

    it('resolves original paths before reading page geometry', async () => {
        const geometry = {
            mediaBox: {
                x: 0,
                y: 0,
                width: 612,
                height: 792,
            },
            cropBox: {
                x: 10,
                y: 20,
                width: 500,
                height: 700,
            },
            rotation: 0,
        };
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue('/tmp/pdf-work-1/work.pdf');
        mocks.getPageGeometry.mockResolvedValueOnce(geometry);
        const handler = getHandler('page-ops:get-page-geometry');

        await expect(handler({sender: {id: 7}}, '/Users/Alice/book.pdf', 1)).resolves.toEqual(geometry);

        expect(mocks.findWorkingCopyPathByOriginalPath).toHaveBeenCalledWith('/Users/Alice/book.pdf', 7);
        expect(mocks.getPageGeometry).toHaveBeenCalledWith('/tmp/pdf-work-1/work.pdf', 1, 7);
    });

    it('rejects invalid page geometry page numbers before reading geometry', async () => {
        const handler = getHandler('page-ops:get-page-geometry');

        await expect(handler({sender: {id: 1}}, '/tmp/work.pdf', 0))
            .rejects.toThrow('Invalid page number');
        await expect(handler({sender: {id: 1}}, '/tmp/work.pdf', 1.5))
            .rejects.toThrow('Invalid page number');

        expect(mocks.getPageGeometry).not.toHaveBeenCalled();
    });

    it('recovers the working-copy directory before inserting converted source files', async () => {
        mocks.isPdfOrImagePath.mockReturnValue(true);
        mocks.createPdfFileFromInputPaths.mockResolvedValue(undefined);

        const handler = getHandler('page-ops:insert-file');

        await expect(handler({sender: {id: 1}}, '/tmp/pdf-work-1/work.pdf', 3, 1, ['/tmp/source.png'], undefined, REVISION_OPTIONS))
            .resolves.toMatchObject({success: true});

        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledWith('/tmp/pdf-work-1/work.pdf', 1);
        expect(mocks.createPdfFileFromInputPaths).toHaveBeenCalledWith(
            ['/tmp/source.png'],
            expect.stringMatching(/^\/tmp\/pdf-work-1\/insert-source-.+\.pdf$/u),
            expect.objectContaining({signal: expect.any(AbortSignal)}),
        );
        expect(mocks.createPdfFromInputPaths).not.toHaveBeenCalled();
        expect(mocks.writeFile).not.toHaveBeenCalled();
        expect(mocks.runCommand).toHaveBeenCalled();
        expect(mocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(/^\/tmp\/pdf-work-1\/tmp-.+\.pdf$/),
            '/tmp/pdf-work-1/work.pdf',
        );
    });

    it('emits insert-file batch progress with the supplied request id', async () => {
        mocks.createPdfFileFromInputPaths.mockImplementation(async (
            _paths: string[],
            _outputPath: string,
            options?: { onProgress?: TProgressCallback },
        ) => {
            options?.onProgress?.({
                processed: 1,
                total: 2,
                percent: 50,
                elapsedMs: 25,
                estimatedRemainingMs: 25,
            });
            return undefined;
        });
        const sender = {
            id: 1,
            send: vi.fn(),
        };

        const handler = getHandler('page-ops:insert-file');

        await expect(handler({sender}, '/tmp/pdf-work-1/work.pdf', 3, 1, [
            '/tmp/source-a.png',
            '/tmp/source-b.png',
        ], 'insert-request-1', REVISION_OPTIONS)).resolves.toMatchObject({success: true});

        expect(sender.send).toHaveBeenCalledWith('dialog:openPdfDirectBatch:progress', {
            operation: 'page-insert',
            requestId: 'insert-request-1',
            processed: 1,
            total: 2,
            percent: 50,
            elapsedMs: 25,
            estimatedRemainingMs: 25,
        });
    });

    it('rejects oversized insert-file batch progress request ids', async () => {
        const handler = getHandler('page-ops:insert-file');
        const oversizedRequestId = 'x'.repeat(129);

        await expect(handler(
            {sender: {id: 1}},
            '/tmp/pdf-work-1/work.pdf',
            3,
            1,
            ['/tmp/source-a.png'],
            oversizedRequestId,
        )).rejects.toThrow('requestId exceeds maximum length (128)');

        expect(mocks.createPdfFileFromInputPaths).not.toHaveBeenCalled();
        expect(mocks.createPdfFromInputPaths).not.toHaveBeenCalled();
        expect(mocks.runCommand).not.toHaveBeenCalled();
    });

    it('marks stale derived artifacts after mutating the working copy', async () => {
        const handler = getHandler('page-ops:rotate');

        await expect(handler({sender: {id: 1}}, '/tmp/a.pdf', [1], 3, 90, REVISION_OPTIONS)).resolves.toMatchObject({success: true});

        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalled();
    });

    it('applies the renderer metadata snapshot through the structural identity delta', async () => {
        const handler = getHandler('page-ops:reorder');
        const metadataSnapshot = {
            pageLabels: [
                'i',
                '1',
                '2',
            ],
            bookmarks: [],
            untitledBookmarkLabel: 'Untitled',
        };

        await expect(handler({sender: {id: 1}}, '/tmp/a.pdf', [
            3,
            1,
            2,
        ], {
            ...REVISION_OPTIONS,
            metadataSnapshot,
        })).resolves.toMatchObject({success: true});

        expect(mocks.applyPageMetadataRemap).toHaveBeenCalledWith(expect.objectContaining({
            workingCopyPath: '/tmp/a.pdf',
            metadataSnapshot,
            delta: {
                previousPageCount: 3,
                pages: [
                    {fromPageNumber: 3},
                    {fromPageNumber: 1},
                    {fromPageNumber: 2},
                ],
            },
        }));
    });

    it('does not publish page identities when metadata remapping fails', async () => {
        mocks.applyPageMetadataRemap.mockRejectedValueOnce(new Error('metadata append failed'));
        const handler = getHandler('page-ops:rotate');

        await expect(handler({sender: {id: 1}}, '/tmp/a.pdf', [1], 3, 90, {
            ...REVISION_OPTIONS,
            metadataSnapshot: {
                pageLabels: [
                    'i',
                    '1',
                    '2',
                ],
                bookmarks: [],
                untitledBookmarkLabel: 'Untitled',
            },
        })).rejects.toThrow('metadata append failed');

        expect(mocks.rotatePages).toHaveBeenCalledOnce();
        expect(mocks.commitPageIdentityDelta).not.toHaveBeenCalled();
        expect(mocks.verifyPdfStructureStrict).not.toHaveBeenCalled();
    });
});
