import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {TScanCleanupProgress} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';

const mocks = vi.hoisted(() => ({
    logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
    on: vi.fn(),
    postMessage: vi.fn(),
    runScanCleanupPipeline: vi.fn(),
    workerData: {} as Record<string, unknown>,
}));

vi.mock('worker_threads', () => ({
    isMainThread: false,
    parentPort: {
        on: mocks.on,
        postMessage: mocks.postMessage,
    },
    threadId: 1,
    // Only imported as a value by modules the entrypoint pulls in; nothing here
    // constructs one.
    Worker: function WorkerStub() {},
    get workerData() {
        return mocks.workerData;
    },
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));
vi.mock(
    '@electron/features/scan-cleanup/worker/runScanCleanupPipeline',
    () => ({runScanCleanupPipeline: mocks.runScanCleanupPipeline}),
);

const VALID_RUNTIME_POLICY = {
    rasterConcurrency: 2,
    rasterStreaming: true,
    logicalCpus: 8,
    totalRamBytes: 16 * 1024 * 1024 * 1024,
};

function pageProgress(stage: TScanCleanupProgress['stage'], completedUnits: number): TScanCleanupProgress {
    return {
        stage,
        completedUnits,
        totalUnits: 2,
        percent: completedUnits * 50,
        completedPageNumbers: Array.from({length: completedUnits}, (_, index) => index + 1),
    };
}

// The worker entrypoint runs as a module body, so booting it is the only way
// to execute it: each case reloads the module against a fresh parent port.
async function bootWorker(
    runtimePolicy: unknown = VALID_RUNTIME_POLICY,
    includeRequestOptions = true,
) {
    const request: Record<string, unknown> = {
        sourcePdfPath: '/tmp/scan-cleanup/source.pdf',
        sourcePageNumbers: [
            1,
            2,
        ],
    };
    if (includeRequestOptions) {
        request.options = {
            pageOverrides: {},
            pageOverrideDefaults: undefined,
            marginsMm: {
                leftMm: 0,
                topMm: 0,
                rightMm: 0,
                bottomMm: 0,
            },
        };
    }
    mocks.workerData = {
        request,
        paths: {workDir: '/tmp/scan-cleanup/work'},
        runtimePolicy,
    };
    vi.resetModules();
    await import('@electron/features/scan-cleanup/worker/main');
}

function lastResultMessage() {
    const resultCalls = mocks.postMessage.mock.calls.filter(call => call[0]?.type === 'result');
    return resultCalls.at(-1)?.[0] as {
        ok: boolean;
        data?: unknown;
        error?: string;
        errorFrame?: {
            canceled?: boolean;
            terminationUnproven?: string;
        };
    } | undefined;
}

describe('scan cleanup worker entrypoint', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reports pipeline progress once per stage and returns the summary', async () => {
        mocks.runScanCleanupPipeline.mockImplementation(async (
            _request: unknown,
            _paths: unknown,
            _signal: AbortSignal,
            onProgress: (progress: TScanCleanupProgress) => void,
        ) => {
            onProgress(pageProgress('rasterizing', 1));
            onProgress(pageProgress('rasterizing', 2));
            onProgress(pageProgress('rendering', 1));
            return {
                inputPages: 2,
                outputPages: 3,
            };
        });

        await bootWorker();

        expect(mocks.on).toHaveBeenCalledWith('message', expect.any(Function));
        expect(mocks.postMessage.mock.calls.filter(call => call[0]?.type === 'progress')).toHaveLength(3);
        expect(lastResultMessage()).toMatchObject({
            ok: true,
            data: {
                inputPages: 2,
                outputPages: 3,
            },
        });
        // One "Phase started" line per stage, not per progress event.
        const phaseLines = mocks.logger.info.mock.calls.filter(call => call[0] === 'Scan cleanup phase started');
        expect(phaseLines).toHaveLength(2);
        expect(mocks.logger.info.mock.calls.some(call => call[0] === 'Scan cleanup run completed')).toBe(true);
        expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    it('fails the run when the runtime policy cannot be decoded', async () => {
        await bootWorker({rasterConcurrency: 0}, false);

        expect(mocks.runScanCleanupPipeline).not.toHaveBeenCalled();
        expect(lastResultMessage()).toMatchObject({
            ok: false,
            error: 'Scan cleanup worker received an invalid runtime policy',
        });
        expect(mocks.logger.error).toHaveBeenCalledWith(
            'Scan cleanup run failed',
            expect.objectContaining({
                code: 'MAIN_SCAN_CLEANUP_FAILED',
                context: {
                    stage: 'worker',
                    errorCode: 'unknown',
                    failureClass: 'unknown',
                },
                cause: expect.objectContaining({message: 'Scan cleanup worker received an invalid runtime policy'}),
            }),
            expect.objectContaining({errorMessage: 'Scan cleanup worker received an invalid runtime policy'}),
        );
    });

    it('reports a cancellation requested by the parent port as the end of the run', async () => {
        mocks.runScanCleanupPipeline.mockImplementation(async (
            _request: unknown,
            _paths: unknown,
            signal: AbortSignal,
        ) => {
            const onMessage = mocks.on.mock.calls.find(call => call[0] === 'message')?.[1] as
                (message: unknown) => void;
            onMessage({type: 'ignored'});
            onMessage({type: 'cancel'});
            expect(signal.aborted).toBe(true);
            throw signal.reason;
        });

        await bootWorker();

        expect(mocks.logger.info).toHaveBeenCalledWith('Scan cleanup run canceled', expect.any(Object));
        expect(mocks.logger.error).not.toHaveBeenCalled();
        const result = lastResultMessage();
        expect(result?.ok).toBe(false);
        expect(result?.errorFrame?.canceled).toBe(true);
    });

    it('reports an abort raised without a cancel request as the end of the run', async () => {
        mocks.runScanCleanupPipeline.mockImplementation(async () => {
            const error = new Error('Scan cleanup aborted downstream');
            error.name = 'AbortError';
            throw error;
        });

        await bootWorker();

        expect(mocks.logger.info).toHaveBeenCalledWith('Scan cleanup run canceled', expect.any(Object));
        expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    // Main quarantines the working copy on this outcome, so the worker must
    // keep it distinguishable from both a clean cancel and an application fault.
    it('warns instead of failing when the run could not prove its native tree died', async () => {
        mocks.runScanCleanupPipeline.mockImplementation(async () => {
            throw markUnprovenNativeTermination(
                new Error('sidecar kill unconfirmed'),
                'scan-cleanup-sidecar survived SIGKILL',
            );
        });

        await bootWorker();

        expect(mocks.logger.warn).toHaveBeenCalledWith(
            'Scan cleanup run stopped without proving native termination',
            expect.objectContaining({detail: 'scan-cleanup-sidecar survived SIGKILL'}),
        );
        expect(mocks.logger.error).not.toHaveBeenCalled();
        expect(lastResultMessage()).toMatchObject({
            ok: false,
            errorFrame: {terminationUnproven: 'scan-cleanup-sidecar survived SIGKILL'},
        });
    });

    it('fails the run when the pipeline throws an unexpected error', async () => {
        const failure = new Error('sidecar exited with code 3');
        mocks.runScanCleanupPipeline.mockImplementation(async () => {
            throw failure;
        });

        await bootWorker();

        expect(mocks.logger.error).toHaveBeenCalledWith(
            'Scan cleanup run failed',
            expect.objectContaining({
                code: 'MAIN_SCAN_CLEANUP_FAILED',
                context: {
                    stage: 'worker',
                    errorCode: 'unknown',
                    failureClass: 'unknown',
                },
                cause: failure,
            }),
            expect.objectContaining({errorMessage: 'sidecar exited with code 3'}),
        );
        expect(lastResultMessage()).toMatchObject({
            ok: false,
            error: 'sidecar exited with code 3',
        });
    });
});
