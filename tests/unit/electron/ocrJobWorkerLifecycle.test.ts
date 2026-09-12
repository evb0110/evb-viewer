import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { Worker } from 'worker_threads';
import {
    requireJobId,
    requireRequestId,
} from '@contracts/shared';
import type { ILogger } from '@electron/utils/createLogger';
import type { IOcrActiveJob } from '@electron/features/ocr/main/jobManager.types';
import { createPendingResultFileStore } from '@electron/features/ocr/main/createPendingResultFileStore';
import { createOcrJobWorkerLifecycleController } from '@electron/features/ocr/main/ocrJobWorkerLifecycle';
import { ocrResourceGovernor } from '@electron/features/ocr/main/ocrResourceGovernor';

function createWorker() {
    return coerce<Worker>({
        postMessage: vi.fn(),
        terminate: vi.fn(async () => 0),
    });
}

const cleanupTimerMaps = new Set<Map<string, NodeJS.Timeout>>();

function coerce<T>(value: unknown) {
    return value as T;
}

function createFixture() {
    const worker = createWorker();
    const release = vi.fn();
    const resolveWorkerSettlement = vi.fn();
    const terminal = {
        cancel: vi.fn(),
        complete: vi.fn(),
        fail: vi.fn(),
    };
    const job = coerce<IOcrActiveJob>({
        scopedJobId: requireJobId('ocr-scope:job-1'),
        documentJobKey: 'document\0revision',
        requestId: requireRequestId('job-1'),
        webContentsId: 1,
        sourcePdfPath: '/tmp/ocr-source.pdf',
        documentRevision: {
            version: 1 as const,
            documentRef: '/tmp/ocr-source.pdf',
            authority: 'electron-working-copy' as const,
            token: 'revision-token',
            contentRevision: 1,
            mintedAt: 1,
        },
        pages: [{
            pageNumber: 1,
            languages: ['eng'],
        }],
        options: {},
        queuedAtMs: 0,
        requestedBytes: 1,
        registry: {
            signal: new AbortController().signal,
            terminal,
            publish: vi.fn(),
        },
        cancel: vi.fn(() => true),
        settled: Promise.resolve(),
        workerSettlement: new Promise(() => undefined),
        resolveWorkerSettlement,
        terminalResult: null,
        workerAdmissionLease: {release},
        worker,
        completed: false,
        terminatedByUs: false,
        pendingCompletionResult: null,
        terminalResultSent: false,
        startedAtMs: 0,
        watchdogTimer: null,
        workerExitProven: false,
        workerExitCode: null,
        cleanupCompleteReceived: false,
        nativeChildren: new Map(),
        nativeChildProtocolUnsafe: false,
        physicalFinalized: false,
        brokeredResourcesReleased: false,
        discardPendingCompletionResult: false,
    });
    const activeJobs = new Map<string, IOcrActiveJob>([[
        job.scopedJobId,
        job,
    ]]);
    const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    } as ILogger;
    const pendingResultFileStore = createPendingResultFileStore({
        logger,
        ttlMs: 60_000,
        removeResultFile: vi.fn(async () => true),
    });
    const onFinalizeActiveJob = vi.fn();
    const releaseJob = vi.spyOn(ocrResourceGovernor, 'releaseJob');
    const nativeChildCleanupTimers = new Map<string, NodeJS.Timeout>();
    cleanupTimerMaps.add(nativeChildCleanupTimers);
    const controller = createOcrJobWorkerLifecycleController({
        activeJobs,
        workerCleanupTimersByScopedJobId: new Map(),
        nativeChildCleanupTimersByScopedJobId: nativeChildCleanupTimers,
        nativeChildTermination: {terminate: vi.fn(async () => false)},
        pendingResultFileStore,
        logger,
        publishProgress: vi.fn(),
        getJobWindow: vi.fn(() => null),
        onFinalizeActiveJob,
        removeResultFile: vi.fn(async () => true),
        safeSendToWindow: vi.fn(),
    });
    return {
        activeJobs,
        controller,
        job,
        logger,
        onFinalizeActiveJob,
        releaseJob,
        release,
        worker,
        nativeChildCleanupTimers,
    };
}

const childIdentity = {
    kind: 'linux-proc-start-time' as const,
    value: '12345',
};

async function flushBarriers() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('OCR worker lifecycle physical ownership', () => {
    afterEach(() => {
        for (const timers of cleanupTimerMaps) {
            for (const timer of timers.values()) {
                clearTimeout(timer);
            }
            timers.clear();
        }
        cleanupTimerMaps.clear();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('releases brokered resources after worker exit until delayed native-child cleanup proves exit', async () => {
        const fixture = createFixture();
        let proveChildExit!: (proven: boolean) => void;
        const cleanup = vi.fn(() => new Promise<boolean>(resolve => {
            proveChildExit = resolve;
        }));
        const cleanupTimers = new Map<string, NodeJS.Timeout>();
        cleanupTimerMaps.add(cleanupTimers);
        const controller = createOcrJobWorkerLifecycleController({
            activeJobs: fixture.activeJobs,
            workerCleanupTimersByScopedJobId: new Map(),
            nativeChildCleanupTimersByScopedJobId: cleanupTimers,
            nativeChildTermination: {terminate: cleanup},
            pendingResultFileStore: createPendingResultFileStore({
                logger: fixture.logger,
                ttlMs: 60_000,
                removeResultFile: vi.fn(async () => true),
            }),
            logger: fixture.logger,
            publishProgress: vi.fn(),
            getJobWindow: vi.fn(() => null),
            onFinalizeActiveJob: fixture.onFinalizeActiveJob,
            removeResultFile: vi.fn(async () => true),
            safeSendToWindow: vi.fn(),
        });

        controller.handleNativeChildIntent(fixture.job.scopedJobId, fixture.worker, 'job-1', 'child-1', 'tesseract');
        controller.handleNativeChildRegister(
            fixture.job.scopedJobId,
            fixture.worker,
            'job-1',
            'child-1',
            123,
            childIdentity,
        );
        controller.markWorkerExit(fixture.job.scopedJobId, fixture.worker, 1);
        await flushBarriers();

        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(fixture.activeJobs.has(fixture.job.scopedJobId)).toBe(true);
        expect(fixture.release).toHaveBeenCalledTimes(1);
        expect(fixture.releaseJob).toHaveBeenCalledWith(fixture.job.scopedJobId);
        expect(fixture.onFinalizeActiveJob).not.toHaveBeenCalled();

        proveChildExit(true);
        await flushBarriers();
        expect(fixture.activeJobs.has(fixture.job.scopedJobId)).toBe(false);
        expect(fixture.release).toHaveBeenCalledTimes(1);
        expect(fixture.onFinalizeActiveJob).toHaveBeenCalledTimes(1);

        controller.markWorkerExit(fixture.job.scopedJobId, fixture.worker, 0);
        expect(fixture.release).toHaveBeenCalledTimes(1);
    });

    it('fails closed when registration handoff crashes before a child identity is registered', () => {
        const fixture = createFixture();

        fixture.controller.handleNativeChildIntent(
            fixture.job.scopedJobId,
            fixture.worker,
            'job-1',
            'child-crashed',
            'qpdf',
        );
        fixture.controller.markWorkerExit(fixture.job.scopedJobId, fixture.worker, 1);
        fixture.controller.handleNativeChildRegister(
            fixture.job.scopedJobId,
            fixture.worker,
            'job-1',
            'child-crashed',
            321,
            childIdentity,
        );

        expect(fixture.activeJobs.has(fixture.job.scopedJobId)).toBe(true);
        expect(fixture.release).toHaveBeenCalledTimes(1);
        expect(fixture.releaseJob).toHaveBeenCalledWith(fixture.job.scopedJobId);
        expect(fixture.worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
            type: 'native-child-register-ack',
            accepted: false,
        }));
    });

    it('retains the job for unknown or reused child identities and ignores stale worker proof', () => {
        const fixture = createFixture();

        fixture.controller.handleNativeChildIntent(fixture.job.scopedJobId, fixture.worker, 'job-1', 'child-1', 'qpdf');
        fixture.controller.handleNativeChildRegister(
            fixture.job.scopedJobId,
            fixture.worker,
            'job-1',
            'child-1',
            111,
            childIdentity,
        );
        fixture.controller.handleNativeChildRegister(
            fixture.job.scopedJobId,
            fixture.worker,
            'job-1',
            'child-1',
            222,
            {
                kind: 'linux-proc-start-time',
                value: '99999',
            },
        );
        fixture.controller.handleNativeChildRegister(
            fixture.job.scopedJobId,
            fixture.worker,
            'job-1',
            'unknown-child',
            333,
            childIdentity,
        );
        fixture.controller.handleNativeChildExit(
            fixture.job.scopedJobId,
            fixture.worker,
            'job-1',
            'child-1',
            222,
            childIdentity,
        );

        expect(fixture.activeJobs.has(fixture.job.scopedJobId)).toBe(true);
        expect(fixture.release).not.toHaveBeenCalled();
    });

    it('releases exactly once for a proven worker and child exit, including duplicate messages', () => {
        const fixture = createFixture();

        fixture.controller.handleNativeChildIntent(fixture.job.scopedJobId, fixture.worker, 'job-1', 'child-1', 'qpdf');
        fixture.controller.handleNativeChildRegister(
            fixture.job.scopedJobId,
            fixture.worker,
            'job-1',
            'child-1',
            111,
            childIdentity,
        );
        fixture.controller.handleNativeChildExit(
            fixture.job.scopedJobId,
            fixture.worker,
            'job-1',
            'child-1',
            111,
            childIdentity,
        );
        fixture.controller.handleNativeChildExit(
            fixture.job.scopedJobId,
            fixture.worker,
            'job-1',
            'child-1',
            111,
            childIdentity,
        );
        fixture.controller.markWorkerExit(fixture.job.scopedJobId, fixture.worker, 0);
        fixture.controller.markWorkerExit(fixture.job.scopedJobId, fixture.worker, 0);

        expect(fixture.activeJobs.has(fixture.job.scopedJobId)).toBe(false);
        expect(fixture.release).toHaveBeenCalledTimes(1);
        expect(fixture.onFinalizeActiveJob).toHaveBeenCalledTimes(1);
    });
});
