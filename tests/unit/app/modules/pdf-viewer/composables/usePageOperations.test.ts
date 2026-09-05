import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePageOperations } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePageOperations';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {requireDocumentRevisionToken} from '@contracts';
import {
    createPageMoveRange,
    createPageMoveRanges,
    createRangePageSelection,
} from '@contracts/pageNumbers';

const pageOpsApi = {
    delete: vi.fn(),
    deleteRanges: vi.fn(),
    extract: vi.fn(),
    rotate: vi.fn(),
    insert: vi.fn(),
    insertFile: vi.fn(),
    reorder: vi.fn(),
    move: vi.fn(),
    moveRanges: vi.fn(),
    crop: vi.fn(),
    removeCrop: vi.fn(),
};

type TBatchProgressListener = (progress: {
    operation: 'document-open' | 'page-insert';
    requestId: string;
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}) => void;

const progressListeners = new Set<TBatchProgressListener>();

const loggerError = vi.fn();
const loggerWarn = vi.fn();
const reportRuntimeError = vi.fn();
const pageOperationFailure = {
    eventId: '0123456789abcdef0123456789abcdef',
    code: 'UNCLASSIFIED_RENDERER_ERROR',
    occurredAt: 1,
    severity: 'error',
};

vi.mock('@app/utils/platformDocuments', () => ({
    getPageOpsCapability: () => pageOpsApi,
    getDocumentOpenCapability: () => {
        const onOpenDocumentDirectBatchProgress = (callback: TBatchProgressListener) => {
            progressListeners.add(callback);
            return () => {
                progressListeners.delete(callback);
            };
        };

        return {onOpenDocumentDirectBatchProgress};
    },
}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    error: (...args: unknown[]) => loggerError(...args),
    warn: (...args: unknown[]) => loggerWarn(...args),
}}));
vi.mock('@app/composables/useRuntimeErrorReports', () => ({useRuntimeErrorReports: () => ({ reportRuntimeError })}));

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({
    t: (key: string) => `msg:${key}`,
    setLocale: vi.fn(async () => {}),
    loadLocaleMessages: vi.fn(async () => {}),
})}));

function deferred<T>() {
    let resolve: ((value: T | PromiseLike<T>) => void) | null = null;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });

    return {
        promise,
        resolve: (value: T) => resolve?.(value),
    };
}

function createHarness(path: string | null = '/tmp/work.pdf', options: {
    documentRevisionToken?: TDocumentRevisionToken | null;
    ensureHistoryBaselineForMutation?: () => Promise<boolean>;
    saveAnnotationsForPageMutation?: () => Promise<boolean>;
    ensureWorkingCopyFreshForRead?: () => Promise<boolean>;
    runWithDocumentOperationLease?: <T>(kind: TDocumentOperationKind, operation: () => Promise<T>) => Promise<T>;
} = {}) {
    const workingCopyPath = ref<string | null>(path);
    const documentRevisionToken = ref<TDocumentRevisionToken | null>(options.documentRevisionToken ?? null);
    const ensureHistoryBaselineForMutation = options.ensureHistoryBaselineForMutation
        ? vi.fn(options.ensureHistoryBaselineForMutation)
        : vi.fn(async () => true);
    const reloadWorkingCopyIntoHistory = vi.fn(async () => true);
    const clearOcrCache = vi.fn();
    const resetSearchCache = vi.fn();
    const onExtractedDocument = vi.fn(async () => {});
    const pageOps = usePageOperations({
        workingCopyPath,
        documentRevisionToken,
        ensureHistoryBaselineForMutation,
        ...(options.saveAnnotationsForPageMutation
            ? {saveAnnotationsForPageMutation: options.saveAnnotationsForPageMutation}
            : {}),
        reloadWorkingCopyIntoHistory,
        clearOcrCache,
        resetSearchCache,
        onExtractedDocument,
        ...(options.ensureWorkingCopyFreshForRead ? { ensureWorkingCopyFreshForRead: options.ensureWorkingCopyFreshForRead } : {}),
        ...(options.runWithDocumentOperationLease ? { runWithDocumentOperationLease: options.runWithDocumentOperationLease } : {}),
    });

    return {
        pageOps,
        workingCopyPath,
        documentRevisionToken,
        ensureHistoryBaselineForMutation,
        reloadWorkingCopyIntoHistory,
        clearOcrCache,
        resetSearchCache,
        onExtractedDocument,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    loggerError.mockReturnValue(pageOperationFailure);
    pageOpsApi.move.mockResolvedValue({
        success: true,
        pageCount: 1_000_000,
    });
    pageOpsApi.moveRanges.mockResolvedValue({
        success: true,
        pageCount: 1_000_000,
    });
    pageOpsApi.deleteRanges.mockResolvedValue({
        success: true,
        pageCount: 1,
    });
    progressListeners.clear();
});

describe('usePageOperations', () => {
    it.each([
        [
            'rotate',
            (pageOps: ReturnType<typeof usePageOperations>, selection: ReturnType<typeof createRangePageSelection>) => pageOps.rotatePages(selection, 200_000, 90),
        ],
        [
            'crop',
            (pageOps: ReturnType<typeof usePageOperations>, selection: ReturnType<typeof createRangePageSelection>) => pageOps.cropPages(selection, 200_000, {
                top: 1,
                right: 1,
                bottom: 1,
                left: 1,
            }),
        ],
        [
            'removeCrop',
            (pageOps: ReturnType<typeof usePageOperations>, selection: ReturnType<typeof createRangePageSelection>) => pageOps.removeCrop(selection, 200_000),
        ],
    ] as const)('sends one compact selection request for a large %s operation', async (apiMethod, invoke) => {
        pageOpsApi[apiMethod].mockResolvedValueOnce({success: true});
        const {
            pageOps,
            ensureHistoryBaselineForMutation,
            reloadWorkingCopyIntoHistory,
        } = createHarness(
            '/tmp/work.pdf',
            {documentRevisionToken: requireDocumentRevisionToken('drt1:before')},
        );
        const selection = createRangePageSelection(200_000, 2, 150_001);

        await expect(invoke(pageOps, selection)).resolves.toBe(true);

        expect(pageOpsApi[apiMethod]).toHaveBeenCalledOnce();
        expect(pageOpsApi[apiMethod].mock.calls[0]?.[1]).toEqual({
            pageCount: 200_000,
            ranges: [{
                startPage: 2,
                endPage: 150_001,
            }],
        });
        expect(ensureHistoryBaselineForMutation).toHaveBeenCalledOnce();
        expect(reloadWorkingCopyIntoHistory).toHaveBeenCalledOnce();
    });
    it.each([
        {
            name: 'rotate',
            api: 'rotate' as const,
            invoke: (pageOps: ReturnType<typeof usePageOperations>) => pageOps.rotatePages([1], 3, 90),
        },
        {
            name: 'delete',
            api: 'delete' as const,
            invoke: (pageOps: ReturnType<typeof usePageOperations>) => pageOps.deletePages([2], 3),
        },
        {
            name: 'reorder',
            api: 'reorder' as const,
            invoke: (pageOps: ReturnType<typeof usePageOperations>) => pageOps.reorderPages([
                3,
                1,
                2,
            ]),
        },
    ])('materializes live annotations before $name and preserves the materialized reload frontier', async ({
        api,
        invoke,
    }) => {
        const callOrder: string[] = [];
        const saveAnnotationsForPageMutation = vi.fn(async () => {
            callOrder.push('materialize-and-reload');
            return true;
        });
        pageOpsApi[api].mockImplementation(async () => {
            callOrder.push(api);
            return {success: true};
        });
        const {
            pageOps,
            reloadWorkingCopyIntoHistory,
        } = createHarness('/tmp/work.pdf', {saveAnnotationsForPageMutation});

        await expect(invoke(pageOps)).resolves.toBe(true);

        expect(callOrder).toEqual([
            'materialize-and-reload',
            api,
        ]);
        expect(saveAnnotationsForPageMutation).toHaveBeenCalledOnce();
        expect(reloadWorkingCopyIntoHistory).toHaveBeenCalledWith({markDirty: true});
    });

    it('runs mutating operations through shared progress/reload flow', async () => {
        const {
            pageOps,
            ensureHistoryBaselineForMutation,
            reloadWorkingCopyIntoHistory,
            clearOcrCache,
            resetSearchCache,
        } = createHarness();
        const pendingRotate = deferred<{ success: boolean }>();
        pageOpsApi.rotate.mockReturnValueOnce(pendingRotate.promise);

        const rotatePromise = pageOps.rotatePages([
            2,
            4,
        ], 10, 90);
        expect(pageOps.isOperationInProgress.value).toBe(true);

        pendingRotate.resolve({ success: true });
        await expect(rotatePromise).resolves.toBe(true);

        expect(pageOpsApi.rotate).toHaveBeenCalledWith('/tmp/work.pdf', [
            2,
            4,
        ], 10, 90);
        expect(ensureHistoryBaselineForMutation).toHaveBeenCalledOnce();
        expect(clearOcrCache).toHaveBeenCalledWith('/tmp/work.pdf');
        expect(resetSearchCache).toHaveBeenCalledOnce();
        expect(reloadWorkingCopyIntoHistory).toHaveBeenCalledWith({ markDirty: true });
        expect(pageOps.error.value).toBeNull();
        expect(pageOps.isOperationInProgress.value).toBe(false);
    });

    it('does not reload document when extract operation is canceled', async () => {
        const {
            pageOps,
            ensureHistoryBaselineForMutation,
            reloadWorkingCopyIntoHistory,
            clearOcrCache,
            resetSearchCache,
            onExtractedDocument,
        } = createHarness();
        pageOpsApi.extract.mockResolvedValueOnce({
            success: true,
            canceled: true,
        });

        await expect(pageOps.extractPages([3])).resolves.toBe(false);

        expect(pageOps.lastOutcome.value).toEqual({
            status: 'canceled',
            result: {
                success: true,
                canceled: true,
            },
        });
        expect(ensureHistoryBaselineForMutation).not.toHaveBeenCalled();
        expect(reloadWorkingCopyIntoHistory).not.toHaveBeenCalled();
        expect(clearOcrCache).not.toHaveBeenCalled();
        expect(resetSearchCache).not.toHaveBeenCalled();
        expect(onExtractedDocument).not.toHaveBeenCalled();
    });

    it('opens the extracted PDF when the page-op returns a destination path', async () => {
        const {
            pageOps,
            ensureHistoryBaselineForMutation,
            reloadWorkingCopyIntoHistory,
            clearOcrCache,
            resetSearchCache,
            onExtractedDocument,
        } = createHarness();
        pageOpsApi.extract.mockResolvedValueOnce({
            success: true,
            destPath: 'browser://documents/extract.pdf',
        });

        await expect(pageOps.extractPages([3])).resolves.toBe(true);

        expect(pageOpsApi.extract).toHaveBeenCalledWith('/tmp/work.pdf', [3]);
        expect(ensureHistoryBaselineForMutation).not.toHaveBeenCalled();
        expect(reloadWorkingCopyIntoHistory).not.toHaveBeenCalled();
        expect(clearOcrCache).not.toHaveBeenCalled();
        expect(resetSearchCache).not.toHaveBeenCalled();
        expect(onExtractedDocument).toHaveBeenCalledWith('browser://documents/extract.pdf');
    });

    it('does not report success when a mutating operation reload becomes stale', async () => {
        const {
            pageOps,
            workingCopyPath,
            reloadWorkingCopyIntoHistory,
        } = createHarness();
        pageOpsApi.rotate.mockResolvedValueOnce({ success: true });
        reloadWorkingCopyIntoHistory.mockImplementationOnce(async () => {
            workingCopyPath.value = '/tmp/other.pdf';
            return false;
        });

        await expect(pageOps.rotatePages([1], 10, 90)).resolves.toBe(false);

        expect(pageOps.lastOutcome.value).toEqual({
            status: 'stale',
            phase: 'reload',
        });
        expect(pageOpsApi.rotate).toHaveBeenCalledWith('/tmp/work.pdf', [1], 10, 90);
        expect(reloadWorkingCopyIntoHistory).toHaveBeenCalledWith({ markDirty: true });
    });

    it('returns detailed outcomes for API-level page operation failures', async () => {
        const { pageOps } = createHarness();
        pageOpsApi.rotate.mockResolvedValueOnce({ success: false });

        await expect(pageOps.rotatePagesDetailed([1], 10, 90)).resolves.toEqual({
            status: 'failed',
            error: 'msg:errors.pageOps.rotate',
            result: { success: false },
        });

        expect(pageOps.error.value).toBeNull();
        expect(pageOps.lastOutcome.value).toEqual({
            status: 'failed',
            error: 'msg:errors.pageOps.rotate',
            result: { success: false },
        });
    });

    it('persists pending changes before extracting pages from the working copy', async () => {
        const ensureWorkingCopyFreshForRead = vi.fn(async () => true);
        const {
            pageOps,
            onExtractedDocument,
        } = createHarness('/tmp/work.pdf', { ensureWorkingCopyFreshForRead });
        pageOpsApi.extract.mockResolvedValueOnce({
            success: true,
            destPath: 'browser://documents/extract.pdf',
        });

        await expect(pageOps.extractPages([3])).resolves.toBe(true);

        expect(ensureWorkingCopyFreshForRead).toHaveBeenCalledOnce();
        expect(pageOpsApi.extract).toHaveBeenCalledWith('/tmp/work.pdf', [3]);
        expect(onExtractedDocument).toHaveBeenCalledWith('browser://documents/extract.pdf');
    });

    it('stages history before persisting pending changes and running structural page mutations', async () => {
        const ensureWorkingCopyFreshForRead = vi.fn(async () => true);
        const {
            pageOps,
            ensureHistoryBaselineForMutation,
        } = createHarness('/tmp/work.pdf', { ensureWorkingCopyFreshForRead });
        pageOpsApi.rotate.mockResolvedValueOnce({ success: true });

        await expect(pageOps.rotatePages([1], 10, 90)).resolves.toBe(true);

        expect(ensureWorkingCopyFreshForRead).toHaveBeenCalledOnce();
        expect(ensureHistoryBaselineForMutation).toHaveBeenCalledOnce();
        expect(pageOpsApi.rotate).toHaveBeenCalledWith('/tmp/work.pdf', [1], 10, 90);
        expect(ensureHistoryBaselineForMutation.mock.invocationCallOrder[0]!)
            .toBeLessThan(ensureWorkingCopyFreshForRead.mock.invocationCallOrder[0]!);
        expect(ensureWorkingCopyFreshForRead.mock.invocationCallOrder[0]!)
            .toBeLessThan(pageOpsApi.rotate.mock.invocationCallOrder[0]!);
    });

    it('performs no page-operation writes when history staging fails', async () => {
        const ensureWorkingCopyFreshForRead = vi.fn(async () => true);
        const saveAnnotationsForPageMutation = vi.fn(async () => true);
        const {pageOps} = createHarness('/tmp/work.pdf', {
            ensureHistoryBaselineForMutation: async () => false,
            ensureWorkingCopyFreshForRead,
            saveAnnotationsForPageMutation,
        });

        await expect(pageOps.rotatePages([1], 10, 90)).resolves.toBe(false);

        expect(pageOps.lastOutcome.value).toEqual({
            status: 'blocked',
            reason: 'history-baseline',
        });
        expect(ensureWorkingCopyFreshForRead).not.toHaveBeenCalled();
        expect(saveAnnotationsForPageMutation).not.toHaveBeenCalled();
        expect(pageOpsApi.rotate).not.toHaveBeenCalled();
    });

    it('does not run structural page mutations when pending changes cannot be persisted', async () => {
        const ensureWorkingCopyFreshForRead = vi.fn(async () => false);
        const {
            pageOps,
            ensureHistoryBaselineForMutation,
        } = createHarness('/tmp/work.pdf', { ensureWorkingCopyFreshForRead });

        await expect(pageOps.rotatePages([1], 10, 90)).resolves.toBe(false);

        expect(pageOps.lastOutcome.value).toEqual({
            status: 'blocked',
            reason: 'preflight',
        });
        expect(ensureWorkingCopyFreshForRead).toHaveBeenCalledOnce();
        expect(ensureHistoryBaselineForMutation).toHaveBeenCalledOnce();
        expect(pageOpsApi.rotate).not.toHaveBeenCalled();
    });

    it('runs page mutations inside the document operation lease', async () => {
        const leaseRelease = deferred<undefined>();
        const runWithDocumentOperationLeaseSpy = vi.fn();
        const runWithDocumentOperationLease = async <T>(
            kind: TDocumentOperationKind,
            operation: () => Promise<T>,
        ): Promise<T> => {
            runWithDocumentOperationLeaseSpy(kind, operation);
            await leaseRelease.promise;
            return operation();
        };
        const { pageOps } = createHarness('/tmp/work.pdf', { runWithDocumentOperationLease });
        pageOpsApi.rotate.mockResolvedValueOnce({ success: true });

        const rotatePromise = pageOps.rotatePages([1], 10, 90);
        await Promise.resolve();

        expect(runWithDocumentOperationLeaseSpy).toHaveBeenCalledWith('page-operation', expect.any(Function));
        expect(pageOps.isOperationInProgress.value).toBe(true);
        expect(pageOpsApi.rotate).not.toHaveBeenCalled();

        leaseRelease.resolve(undefined);
        await expect(rotatePromise).resolves.toBe(true);

        expect(pageOpsApi.rotate).toHaveBeenCalledWith('/tmp/work.pdf', [1], 10, 90);
        expect(pageOps.isOperationInProgress.value).toBe(false);
    });

    it('does not extract pages when pending changes cannot be persisted', async () => {
        const ensureWorkingCopyFreshForRead = vi.fn(async () => false);
        const {
            pageOps,
            onExtractedDocument,
        } = createHarness('/tmp/work.pdf', { ensureWorkingCopyFreshForRead });

        await expect(pageOps.extractPages([3])).resolves.toBe(false);

        expect(ensureWorkingCopyFreshForRead).toHaveBeenCalledOnce();
        expect(pageOpsApi.extract).not.toHaveBeenCalled();
        expect(onExtractedDocument).not.toHaveBeenCalled();
    });

    it('rejects deleting all pages before calling electron API', async () => {
        const { pageOps } = createHarness();

        await expect(pageOps.deletePages([
            1,
            2,
        ], 2)).resolves.toBe(false);

        expect(pageOpsApi.delete).not.toHaveBeenCalled();
        expect(pageOps.error.value).toBe('msg:errors.pageOps.deleteAll');
        expect(loggerError).not.toHaveBeenCalled();
        expect(reportRuntimeError).not.toHaveBeenCalled();
    });

    it('sends a compact delete range for a million-page selection', async () => {
        const { pageOps } = createHarness();

        await expect(pageOps.deletePageRanges([{
            startPage: 2,
            endPage: 1_000_000,
        }], 1_000_000)).resolves.toBe(true);

        expect(pageOpsApi.deleteRanges).toHaveBeenCalledOnce();
        expect(pageOpsApi.deleteRanges).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            [{
                startPage: 2,
                endPage: 1_000_000,
            }],
            1_000_000,
        );
        expect(pageOpsApi.delete).not.toHaveBeenCalled();
        const deleteArgs = pageOpsApi.deleteRanges.mock.calls[0] as unknown[];
        expect(deleteArgs.some(argument => argument instanceof Array && argument.length > 10_000)).toBe(false);
    });

    it('sends a compact native move tuple for a million-page document', async () => {
        const { pageOps } = createHarness();
        const move = createPageMoveRange(1_000_000, 900_000, 900_000, 0);

        await expect(pageOps.movePages(move)).resolves.toBe(true);

        expect(pageOpsApi.move).toHaveBeenCalledOnce();
        expect(pageOpsApi.move).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            900_000,
            900_000,
            0,
            1_000_000,
        );
        const moveArgs = pageOpsApi.move.mock.calls[0] as unknown[];
        expect(moveArgs.some(argument => Array.isArray(argument))).toBe(false);
    });

    it('sends compact non-contiguous ranges without a full permutation', async () => {
        const { pageOps } = createHarness();
        const move = createPageMoveRanges(1_000_000, [
            {
                startPage: 900_000,
                endPage: 900_000,
            },
            {
                startPage: 900_002,
                endPage: 900_002,
            },
        ], 0);

        await expect(pageOps.movePages(move)).resolves.toBe(true);

        expect(pageOpsApi.moveRanges).toHaveBeenCalledOnce();
        expect(pageOpsApi.moveRanges).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            [
                {
                    startPage: 900_000,
                    endPage: 900_000,
                },
                {
                    startPage: 900_002,
                    endPage: 900_002,
                },
            ],
            0,
            1_000_000,
        );
        expect(pageOpsApi.move).not.toHaveBeenCalled();
        const moveArgs = pageOpsApi.moveRanges.mock.calls[0] as unknown[];
        expect(moveArgs.some(argument => argument instanceof Array && argument.length > 10_000)).toBe(false);
    });

    it('writes localized fallback error message when operation throws a non-Error value', async () => {
        const { pageOps } = createHarness();
        pageOpsApi.insert.mockRejectedValueOnce('ipc failed');

        await expect(pageOps.insertPages(5, 0)).resolves.toBe(false);

        expect(loggerError).toHaveBeenCalledWith(
            'page-ops',
            'insertPages failed',
            'ipc failed',
            {
                code: 'RENDERER_PDF_PAGE_OPERATION_FAILED',
                context: {},
            },
        );
        expect(reportRuntimeError).toHaveBeenCalledExactlyOnceWith({
            failure: pageOperationFailure,
            title: 'msg:errors.pageOps.insert',
        });
        expect(pageOps.error.value).toBe('msg:errors.pageOps.insert');
        expect(pageOps.isOperationInProgress.value).toBe(false);
    });

    it('exits early when working copy path is unavailable', async () => {
        const { pageOps } = createHarness(null);

        await expect(pageOps.reorderPages([
            2,
            1,
        ])).resolves.toBe(false);

        expect(pageOps.lastOutcome.value).toEqual({
            status: 'blocked',
            reason: 'missing-working-copy',
        });
        expect(pageOpsApi.reorder).not.toHaveBeenCalled();
        expect(pageOps.isOperationInProgress.value).toBe(false);
    });

    it('tracks browser combine progress during multi-file insert jobs', async () => {
        const { pageOps } = createHarness();
        const pendingInsert = deferred<{ success: boolean }>();
        pageOpsApi.insertFile.mockImplementationOnce(
            async (
                _path: string,
                _totalPages: number,
                _afterPage: number,
                _sourcePaths: string[],
                requestId?: string,
            ) => {
                if (!requestId) {
                    throw new Error('Expected requestId for multi-file insert');
                }

                progressListeners.forEach((listener) => {
                    listener({
                        operation: 'document-open',
                        requestId,
                        processed: 1,
                        total: 3,
                        percent: 33,
                        elapsedMs: 500,
                        estimatedRemainingMs: 1000,
                    });
                    listener({
                        operation: 'page-insert',
                        requestId,
                        processed: 2,
                        total: 3,
                        percent: 66,
                        elapsedMs: 1200,
                        estimatedRemainingMs: 600,
                    });
                });

                return pendingInsert.promise;
            },
        );

        const insertPromise = pageOps.insertFile(5, 2, [
            'browser://documents/a.pdf',
            'browser://documents/b.png',
            'browser://documents/c.pdf',
        ]);
        await Promise.resolve();

        expect(pageOps.batchProgress.value).toEqual({
            processed: 2,
            total: 3,
            percent: 66,
            elapsedMs: 1200,
            estimatedRemainingMs: 600,
        });

        pendingInsert.resolve({ success: true });
        await expect(insertPromise).resolves.toBe(true);

        expect(pageOpsApi.insertFile).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            5,
            2,
            [
                'browser://documents/a.pdf',
                'browser://documents/b.png',
                'browser://documents/c.pdf',
            ],
            expect.stringMatching(/^browser-page-op-insert-/u),
        );
        expect(pageOps.batchProgress.value).toBeNull();
    });

    it.each([
        {
            apiMethod: 'delete' as const,
            expectedArgs: [
                '/tmp/work.pdf',
                [
                    2,
                    4,
                ],
                10,
                { expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-after-save') },
            ],
            invoke: (pageOps: ReturnType<typeof usePageOperations>) => pageOps.deletePages([
                2,
                4,
            ], 10),
            name: 'delete',
        },
        {
            apiMethod: 'rotate' as const,
            expectedArgs: [
                '/tmp/work.pdf',
                [
                    2,
                    4,
                ],
                10,
                90,
                { expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-after-save') },
            ],
            invoke: (pageOps: ReturnType<typeof usePageOperations>) => pageOps.rotatePages([
                2,
                4,
            ], 10, 90),
            name: 'rotate',
        },
        {
            apiMethod: 'insert' as const,
            expectedArgs: [
                '/tmp/work.pdf',
                10,
                4,
                { expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-after-save') },
            ],
            invoke: (pageOps: ReturnType<typeof usePageOperations>) => pageOps.insertPages(10, 4),
            name: 'insert blank',
        },
        {
            apiMethod: 'insertFile' as const,
            expectedArgs: [
                '/tmp/work.pdf',
                10,
                4,
                ['browser://documents/source.pdf'],
                undefined,
                { expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-after-save') },
            ],
            invoke: (pageOps: ReturnType<typeof usePageOperations>) => pageOps.insertFile(10, 4, ['browser://documents/source.pdf']),
            name: 'insert file',
        },
        {
            apiMethod: 'reorder' as const,
            expectedArgs: [
                '/tmp/work.pdf',
                [
                    3,
                    1,
                    2,
                ],
                { expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-after-save') },
            ],
            invoke: (pageOps: ReturnType<typeof usePageOperations>) => pageOps.reorderPages([
                3,
                1,
                2,
            ]),
            name: 'reorder',
        },
        {
            apiMethod: 'crop' as const,
            expectedArgs: [
                '/tmp/work.pdf',
                [
                    2,
                    4,
                ],
                10,
                {
                    top: 12,
                    bottom: 8,
                    left: 6,
                    right: 4,
                },
                { expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-after-save') },
            ],
            invoke: (pageOps: ReturnType<typeof usePageOperations>) => pageOps.cropPages([
                2,
                4,
            ], 10, {
                top: 12,
                bottom: 8,
                left: 6,
                right: 4,
            }),
            name: 'crop',
        },
        {
            apiMethod: 'removeCrop' as const,
            expectedArgs: [
                '/tmp/work.pdf',
                [
                    2,
                    4,
                ],
                10,
                { expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-after-save') },
            ],
            invoke: (pageOps: ReturnType<typeof usePageOperations>) => pageOps.removeCrop([
                2,
                4,
            ], 10),
            name: 'remove crop',
        },
    ])('captures the post-preflight revision token for $name page ops', async ({
        apiMethod,
        expectedArgs,
        invoke,
    }) => {
        const baselineGate = deferred<boolean>();
        let updateRevisionToken: ((value: TDocumentRevisionToken) => void) | null = null;
        const ensureWorkingCopyFreshForRead = vi.fn(async () => {
            updateRevisionToken?.(requireDocumentRevisionToken('rev-after-save'));
            return true;
        });
        const {
            pageOps,
            documentRevisionToken,
        } = createHarness('/tmp/work.pdf', {
            documentRevisionToken: requireDocumentRevisionToken('rev-before-save'),
            ensureWorkingCopyFreshForRead,
            ensureHistoryBaselineForMutation: () => baselineGate.promise,
        });
        updateRevisionToken = (value) => {
            documentRevisionToken.value = value;
        };
        const pageOpSpy = pageOpsApi[apiMethod];
        pageOpSpy.mockResolvedValueOnce({ success: true });

        const operationPromise = invoke(pageOps);
        await Promise.resolve();

        expect(pageOpSpy).not.toHaveBeenCalled();

        documentRevisionToken.value = requireDocumentRevisionToken('rev-after-baseline');
        baselineGate.resolve(true);

        await expect(operationPromise).resolves.toBe(true);
        expect(ensureWorkingCopyFreshForRead).toHaveBeenCalledOnce();
        expect(pageOpSpy).toHaveBeenCalledWith(...expectedArgs);
    });
});
