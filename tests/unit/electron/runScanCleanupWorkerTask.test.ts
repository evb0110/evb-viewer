import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
    reportedErrors: new WeakMap<object, object>(),
    failureReceipt: {
        eventId: '0123456789abcdef0123456789abcdef',
        code: 'UNCLASSIFIED_MAIN_ERROR',
        occurredAt: 1,
        severity: 'error',
    },
    startStreamingWorkerTask: vi.fn(),
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

vi.mock('@electron/utils/workerTask', () => ({
    getWorkerTaskFailureReceipt: (error: unknown) => (
        typeof error === 'object' && error !== null ? mocks.reportedErrors.get(error) : undefined
    ),
    rememberWorkerTaskFailureReceipt: (error: unknown, receipt: object | undefined) => {
        if (typeof error === 'object' && error !== null && receipt !== undefined) {
            mocks.reportedErrors.set(error, receipt);
        }
        return receipt;
    },
    resolveUnpackedWorkerPath: (_baseDir: string, workerFileName: string) => workerFileName,
    startStreamingWorkerTask: mocks.startStreamingWorkerTask,
}));

vi.mock('@electron-worker-bundles/electronWorkerBundles.js', () => ({WORKER_BUNDLES_BY_ID: {'scan-cleanup': {fileName: 'scan-cleanup-worker.js'}}}));

describe('runScanCleanupWorkerTask', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.logger.error.mockReturnValue(mocks.failureReceipt);
        mocks.startStreamingWorkerTask.mockReturnValue({
            worker: {},
            promise: Promise.resolve({}),
        });
    });

    it('uses progress inactivity rather than wall-clock time to bound long cleanup jobs', async () => {
        const {runScanCleanupWorkerTask} = await import(
            '@electron/features/scan-cleanup/runScanCleanupWorkerTask'
        );

        await runScanCleanupWorkerTask(
            {} as never,
            {} as never,
            {} as never,
            new AbortController().signal,
            vi.fn(),
        );

        const options = mocks.startStreamingWorkerTask.mock.calls[0]?.[0];
        expect(options).toEqual(expect.objectContaining({
            inactivityTimeoutMs: 60 * 60 * 1_000,
            onProgressMessage: expect.any(Function),
        }));
        expect(options).not.toHaveProperty('timeoutMs');
    });

    it('does not report an expected caller cancellation as a worker failure', async () => {
        const controller = new AbortController();
        const cancellation = new Error('Scan cleanup canceled');
        controller.abort(cancellation);
        mocks.startStreamingWorkerTask.mockReturnValue({
            worker: {},
            promise: Promise.reject(cancellation),
        });
        const {runScanCleanupWorkerTask} = await import(
            '@electron/features/scan-cleanup/runScanCleanupWorkerTask'
        );

        await expect(runScanCleanupWorkerTask(
            {} as never,
            {} as never,
            {} as never,
            controller.signal,
            vi.fn(),
        )).rejects.toBe(cancellation);

        expect(mocks.logger.info).toHaveBeenCalledWith('Scan cleanup worker task canceled');
        expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    it('leaves a failure the worker-task layer already reported below the error threshold', async () => {
        // Both layers see the same rejected object. The renderer's runtime
        // report stream keys diagnostics by source and message, so a second
        // error-level line would count one underlying failure twice.
        const failure = new Error('pdftoppm: No such file or directory');
        mocks.reportedErrors.set(failure, mocks.failureReceipt);
        mocks.startStreamingWorkerTask.mockReturnValue({
            worker: {},
            promise: Promise.reject(failure),
        });
        const {runScanCleanupWorkerTask} = await import(
            '@electron/features/scan-cleanup/runScanCleanupWorkerTask'
        );

        await expect(runScanCleanupWorkerTask(
            {} as never,
            {} as never,
            {} as never,
            new AbortController().signal,
            vi.fn(),
        )).rejects.toBe(failure);

        expect(mocks.logger.error).not.toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('pdftoppm: No such file or directory'),
        );
    });

    it('still reports a genuine worker rejection as an error', async () => {
        const failure = new Error('native pipeline failed');
        mocks.startStreamingWorkerTask.mockReturnValue({
            worker: {},
            promise: Promise.reject(failure),
        });
        const {runScanCleanupWorkerTask} = await import(
            '@electron/features/scan-cleanup/runScanCleanupWorkerTask'
        );

        await expect(runScanCleanupWorkerTask(
            {} as never,
            {} as never,
            {} as never,
            new AbortController().signal,
            vi.fn(),
        )).rejects.toBe(failure);

        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.stringContaining('native pipeline failed'),
            {
                code: 'MAIN_SCAN_CLEANUP_FAILED',
                context: {
                    stage: 'worker-task',
                    errorCode: 'unknown',
                    failureClass: 'unknown',
                },
                cause: failure,
            },
        );
        expect(mocks.logger.info).not.toHaveBeenCalled();
        expect(mocks.reportedErrors.get(failure)).toBe(mocks.failureReceipt);
    });
});
