import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {TJobId} from '@contracts/shared';
import {requireJobId} from '@contracts/shared';
import {requireEpochMs} from '@contracts/timestamps';
import type {TDocumentRef} from '@contracts/documentRef';
import type {
    IScanCleanupCapability,
    IScanCleanupOptions,
    TScanCleanupJobState,
} from '@contracts/electronApiScanCleanup';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import type {TTranslateFn} from '@i18n-app';

const capability = vi.hoisted(() => ({value: null as IScanCleanupCapability | null}));
const diagnosticMocks = vi.hoisted(() => ({
    failure: {
        eventId: '0123456789abcdef0123456789abcdef',
        code: 'UNCLASSIFIED_RENDERER_ERROR',
        occurredAt: 1,
        severity: 'error',
    } as FailureReceipt,
    error: vi.fn(),
}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {error: diagnosticMocks.error}}));

vi.mock('@app/utils/getScanCleanupCapability', () => ({getScanCleanupCapability: () => capability.value}));

function progress(processedCount = 0, totalPages = 4) {
    return {
        stage: 'rendering' as const,
        completedUnits: processedCount,
        totalUnits: totalPages,
        percent: processedCount / totalPages * 100,
        completedPageNumbers: Array.from({length: processedCount}, (_, index) => index + 1),
    };
}

const ownerContext = {
    ownerId: 'scan-cleanup-test-owner',
    documentRevision: 'scan-cleanup-test-revision',
};

const translate: TTranslateFn = (key, ...args) => (args.length === 0 ? key : `${key}:${JSON.stringify(args[0])}`);

function createScanCleanupOptions(): IScanCleanupOptions {
    return {
        preserveOriginalQuality: false,
        layoutMode: 'auto',
        outputMode: 'bw',
        readingOrder: 'ltr',
        thickness: 0,
        crop: true,
        matchPageSize: true,
        pageAlignment: 'top-center',
        marginsMm: {
            leftMm: 5,
            topMm: 5,
            rightMm: 5,
            bottomMm: 5,
        },
        despeckle: true,
        skipBlankPages: false,
        pageOverrides: {},
    };
}

function completedState(jobId: string, outputPdfPath = `/managed/${jobId}.pdf`): TScanCleanupJobState {
    return {
        jobId: requireJobId(jobId),
        status: 'completed',
        outputPdfPath,
        summary: {
            inputPages: 1,
            outputPages: 1,
            spreadsSplit: 0,
            offcutsDiscarded: 0,
            deskewSkipped: 0,
            cropSkipped: 0,
            excludedPages: 0,
            blankPagesSkipped: 0,
            warnings: [],
        },
        partial: false,
        progress: progress(1, 1),
        updatedAtMs: requireEpochMs(Date.now()),
    };
}

function startResult(jobId: string, outputPdfPath = `/managed/${jobId}.pdf`) {
    return {
        started: true as const,
        jobId: requireJobId(jobId),
        outputPdfPath,
    };
}

function runningJobState(jobId: TJobId): TScanCleanupJobState {
    return {
        jobId,
        status: 'running',
        progress: progress(),
        updatedAtMs: requireEpochMs(Date.now()),
    };
}

function stubCapability(
    onListener: (listener: (state: TScanCleanupJobState) => void) => void,
    nextJobId: () => string,
): IScanCleanupCapability {
    return {
        preview: vi.fn(),
        cancelPreview: vi.fn(),
        detectAll: vi.fn(),
        cancelDetection: vi.fn(),
        getDetectionJobState: vi.fn(),
        subscribeDetectionJob: vi.fn(),
        // One id per start: minting a second one for the output path would let
        // the state the bridge reports and the file it names drift apart.
        start: vi.fn(async () => {
            const jobId = nextJobId();
            return startResult(jobId);
        }),
        cancel: vi.fn(async () => true),
        getJobState: vi.fn(async () => null),
        subscribeJob: vi.fn(async () => null),
        reconnectJob: vi.fn(async () => null),
        pruneGeneratedOutputs: vi.fn(async () => 0),
        onPreviewRaw: vi.fn(() => () => undefined),
        onJobState: vi.fn((listener) => {
            onListener(listener);
            return () => undefined;
        }),
        onDetectionJobState: vi.fn(() => () => undefined),
    };
}

describe('scan cleanup run coordinator', () => {
    beforeEach(() => {
        vi.resetModules();
        diagnosticMocks.error.mockReset();
        diagnosticMocks.error.mockReturnValue(diagnosticMocks.failure);
    });

    it('keeps a pending start single-flight across rapid callers', async () => {
        const pendingStart = Promise.withResolvers<{
            started: true;
            jobId: TJobId;
            outputPdfPath: string;
        }>();
        capability.value = {
            preview: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(() => pendingStart.promise),
            cancel: vi.fn(),
            getJobState: vi.fn(),
            subscribeJob: vi.fn(async (jobId: TJobId) => runningJobState(jobId)),
            reconnectJob: vi.fn(),
            pruneGeneratedOutputs: vi.fn(),
            onPreviewRaw: vi.fn(() => () => undefined),
            onJobState: vi.fn(() => () => undefined),
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const request = {
            ...ownerContext,
            sourcePdfPath: '/source/book.pdf',
            options: createScanCleanupOptions(),
        };

        const first = coordinator.startScanCleanup(request);
        const second = coordinator.startScanCleanup(request);
        expect(capability.value!.start).toHaveBeenCalledOnce();
        expect(coordinator.isScanCleanupRunning.value).toBe(true);

        pendingStart.resolve({...startResult('single-flight-job', '/managed/single-flight.pdf')});
        await expect(first).resolves.toEqual(await second);
        expect(capability.value!.start).toHaveBeenCalledOnce();
    }, 30_000);

    it('surfaces the durable output journal after a persisted job is gone', async () => {
        const storage = new Map<string, string>();
        vi.stubGlobal('sessionStorage', {
            clear: () => storage.clear(),
            getItem: (key: string) => storage.get(key) ?? null,
            removeItem: (key: string) => storage.delete(key),
            setItem: (key: string, value: string) => storage.set(key, value),
        });
        storage.set('evb.scanCleanup.activeJobId', 'scan-cleanup-stale-job');
        storage.set('evb.scanCleanup.activeOwnerId', ownerContext.ownerId);
        storage.set('evb.scanCleanup.activeDocumentRevision', ownerContext.documentRevision);
        const openGeneratedPdf = vi.fn(async () => true);
        const acknowledgeCompletedOutputs = vi.fn(async () => undefined);
        const pendingCapability = {
            ...stubCapability(() => undefined, () => 'scan-cleanup-replacement'),
            getJobState: vi.fn(async () => null),
            reconnectJob: vi.fn(async () => null),
            getPendingCompletedOutputs: vi.fn(async () => ['/managed/recovered.pdf' as TDocumentRef]),
            acknowledgeCompletedOutputs,
        } satisfies IScanCleanupCapability;
        capability.value = pendingCapability;
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf,
            saveActiveDocumentAs: vi.fn(async () => undefined),
            t: translate,
            toast: {add: vi.fn()},
        });
        try {
            await vi.waitFor(() => expect(openGeneratedPdf).toHaveBeenCalledWith(
                '/managed/recovered.pdf',
                expect.any(AbortSignal),
            ));
            await vi.waitFor(() => expect(acknowledgeCompletedOutputs).toHaveBeenCalledWith(['/managed/recovered.pdf']));
        } finally {
            cleanup();
            storage.clear();
            vi.unstubAllGlobals();
        }
    });

    it('clears terminal run state before opening a recovered output queued behind it', async () => {
        const storage = new Map<string, string>();
        vi.stubGlobal('sessionStorage', {
            clear: () => storage.clear(),
            getItem: (key: string) => storage.get(key) ?? null,
            removeItem: (key: string) => storage.delete(key),
            setItem: (key: string, value: string) => storage.set(key, value),
        });
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        const pendingOutputs = Promise.withResolvers<TDocumentRef[]>();
        const terminalOpen = Promise.withResolvers<boolean>();
        const terminalPath = '/managed/terminal.pdf';
        const recoveredPath = '/managed/recovered-after-terminal.pdf' as TDocumentRef;
        interface IRunState {
            activeJobId: TJobId | null;
            inFlight: boolean;
        }
        const currentRunState: {value: IRunState | undefined} = {value: undefined};
        const recoveryStateAtOpen: Array<{
            activeJobId: TJobId | null;
            inFlight: boolean;
        }> = [];
        const openGeneratedPdf = vi.fn((path: string) => {
            if (path === terminalPath) {
                return terminalOpen.promise;
            }
            recoveryStateAtOpen.push({
                activeJobId: currentRunState.value?.activeJobId ?? null,
                inFlight: currentRunState.value?.inFlight ?? false,
            });
            return Promise.resolve(true);
        });
        const acknowledgeCompletedOutputs = vi.fn(async () => undefined);
        capability.value = {
            ...stubCapability(next => { listener = next; }, () => 'job-terminal'),
            getPendingCompletedOutputs: vi.fn(() => pendingOutputs.promise),
            acknowledgeCompletedOutputs,
        } satisfies IScanCleanupCapability;
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        currentRunState.value = coordinator.scanCleanupRun;
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf,
            saveActiveDocumentAs: vi.fn(),
            t: translate,
            toast: {add: vi.fn()},
        });
        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/terminal.pdf',
                options: createScanCleanupOptions(),
            });
            listener(completedState('job-terminal', terminalPath));
            await vi.waitFor(() => expect(openGeneratedPdf).toHaveBeenCalledWith(
                terminalPath,
                expect.any(AbortSignal),
            ));

            pendingOutputs.resolve([recoveredPath]);
            await Promise.resolve();
            expect(openGeneratedPdf).toHaveBeenCalledOnce();
            expect(coordinator.scanCleanupRun.activeJobId).toBe('job-terminal');
            expect(coordinator.scanCleanupRun.inFlight).toBe(true);

            terminalOpen.resolve(true);
            await vi.waitFor(() => expect(openGeneratedPdf).toHaveBeenCalledWith(
                recoveredPath,
                expect.any(AbortSignal),
            ));
            await vi.waitFor(() => expect(acknowledgeCompletedOutputs).toHaveBeenCalledWith([recoveredPath]));
            expect(recoveryStateAtOpen).toEqual([{
                activeJobId: null,
                inFlight: false,
            }]);
        } finally {
            terminalOpen.resolve(true);
            pendingOutputs.resolve([]);
            cleanup();
            storage.clear();
            vi.unstubAllGlobals();
        }
    });

    it('bounds each recovered output open and continues to later journal entries', async () => {
        vi.useFakeTimers();
        const storage = new Map<string, string>();
        vi.stubGlobal('sessionStorage', {
            clear: () => storage.clear(),
            getItem: (key: string) => storage.get(key) ?? null,
            removeItem: (key: string) => storage.delete(key),
            setItem: (key: string, value: string) => storage.set(key, value),
        });
        const firstPath = '/managed/hung-recovered.pdf' as TDocumentRef;
        const secondPath = '/managed/recovered-after-timeout.pdf' as TDocumentRef;
        const firstOpen = Promise.withResolvers<boolean>();
        const signals: AbortSignal[] = [];
        const openGeneratedPdf = vi.fn((path: string, signal: AbortSignal) => {
            signals.push(signal);
            return path === firstPath ? firstOpen.promise : Promise.resolve(true);
        });
        const acknowledgeCompletedOutputs = vi.fn(async () => undefined);
        capability.value = {
            ...stubCapability(() => undefined, () => 'scan-cleanup-replacement'),
            getJobState: vi.fn(async () => null),
            reconnectJob: vi.fn(async () => null),
            getPendingCompletedOutputs: vi.fn(async () => [
                firstPath,
                secondPath,
            ]),
            acknowledgeCompletedOutputs,
        } satisfies IScanCleanupCapability;
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf,
            saveActiveDocumentAs: vi.fn(async () => undefined),
            t: translate,
            toast: {add: vi.fn()},
        });
        try {
            await vi.waitFor(() => expect(openGeneratedPdf).toHaveBeenCalledWith(
                firstPath,
                expect.any(AbortSignal),
            ));
            await vi.advanceTimersByTimeAsync(30_000);
            await vi.waitFor(() => expect(openGeneratedPdf).toHaveBeenCalledWith(
                secondPath,
                expect.any(AbortSignal),
            ));
            await vi.waitFor(() => expect(acknowledgeCompletedOutputs).toHaveBeenCalledWith([secondPath]));
            expect(signals[0]?.aborted).toBe(true);
            expect(acknowledgeCompletedOutputs).not.toHaveBeenCalledWith([
                firstPath,
                secondPath,
            ]);
        } finally {
            firstOpen.resolve(false);
            cleanup();
            storage.clear();
            vi.unstubAllGlobals();
            vi.useRealTimers();
        }
    });

    it('returns renderer fallback metadata instead of user-facing bridge text', async () => {
        capability.value = null;
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const request = {
            ...ownerContext,
            sourcePdfPath: '/source/book.pdf',
            options: createScanCleanupOptions(),
        };

        await expect(coordinator.startScanCleanup(request)).resolves.toMatchObject({
            started: false,
            error: '',
            errorCode: 'tools-unavailable',
            fallback: 'unavailable',
        });

        coordinator.scanCleanupRun.inFlight = true;
        try {
            await expect(coordinator.startScanCleanup(request)).resolves.toMatchObject({
                started: false,
                error: '',
                errorCode: 'internal',
                fallback: 'already-running',
            });
        } finally {
            coordinator.scanCleanupRun.inFlight = false;
        }
    });

    it('reconciles a rejected subscription from the authoritative job state', async () => {
        const reconciledState: TScanCleanupJobState = {
            jobId: requireJobId('reconciled-job'),
            status: 'running',
            progress: progress(),
            updatedAtMs: requireEpochMs(Date.now()),
        };
        capability.value = {
            preview: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(async () => startResult('reconciled-job', '/managed/reconciled.pdf')),
            cancel: vi.fn(),
            getJobState: vi.fn(async () => reconciledState),
            subscribeJob: vi.fn(async () => {
                throw new Error('subscription transport failed');
            }),
            reconnectJob: vi.fn(async () => null),
            pruneGeneratedOutputs: vi.fn(),
            onPreviewRaw: vi.fn(() => () => undefined),
            onJobState: vi.fn(() => () => undefined),
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');

        await expect(coordinator.startScanCleanup({
            ...ownerContext,
            sourcePdfPath: '/source/book.pdf',
            options: createScanCleanupOptions(),
        })).resolves.toMatchObject({
            started: true,
            jobId: 'reconciled-job',
        });

        expect(capability.value!.getJobState).toHaveBeenCalledWith('reconciled-job', ownerContext);
        expect(capability.value!.reconnectJob).toHaveBeenCalledWith('reconciled-job', ownerContext);
        expect(coordinator.scanCleanupRun.jobState).toEqual(reconciledState);
        expect(coordinator.isScanCleanupRunning.value).toBe(true);
    });

    it('resets the run guard and cancels when a subscription cannot be reconciled', async () => {
        const cancel = vi.fn(async () => true);
        capability.value = {
            preview: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(async () => null),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(async () => startResult('unobserved-job', '/managed/unobserved.pdf')),
            cancel,
            getJobState: vi.fn(async () => null),
            subscribeJob: vi.fn(async () => {
                throw new Error('subscription transport failed');
            }),
            reconnectJob: vi.fn(async () => null),
            pruneGeneratedOutputs: vi.fn(),
            onPreviewRaw: vi.fn(() => () => undefined),
            onJobState: vi.fn(() => () => undefined),
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');

        await expect(coordinator.startScanCleanup({
            ...ownerContext,
            sourcePdfPath: '/source/book.pdf',
            options: createScanCleanupOptions(),
        })).rejects.toMatchObject({
            name: 'ScanCleanupRunReconciliationError',
            errorCode: 'internal',
            failure: 'subscription',
            technicalDetail: 'subscription transport failed',
        });

        expect(cancel).toHaveBeenCalledWith('unobserved-job', ownerContext);
        expect(coordinator.scanCleanupRun.activeJobId).toBeNull();
        expect(coordinator.scanCleanupRun.inFlight).toBe(false);
        expect(coordinator.scanCleanupRun.jobState).toBeNull();
        expect(coordinator.isScanCleanupRunning.value).toBe(false);
    });

    it('disposes an installed coordinator and clears the guard when a start rejects', async () => {
        const onJobState = vi.fn(() => () => undefined);
        const toastAdd = vi.fn();
        capability.value = {
            preview: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(async () => {
                throw new Error('scan cleanup bridge failed');
            }),
            cancel: vi.fn(),
            getJobState: vi.fn(),
            subscribeJob: vi.fn(),
            reconnectJob: vi.fn(),
            pruneGeneratedOutputs: vi.fn(),
            onPreviewRaw: vi.fn(() => () => undefined),
            onJobState,
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const dependencies = {
            openGeneratedPdf: vi.fn(async () => true),
            saveActiveDocumentAs: vi.fn(),
            t: translate,
            toast: {add: toastAdd},
        };
        const cleanup = coordinator.installScanCleanupRunCoordinator(dependencies);
        try {
            await expect(coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/rejected.pdf',
                options: createScanCleanupOptions(),
            })).rejects.toThrow('scan cleanup bridge failed');

            // A start that throws owns nothing: no job to talk about, no guard
            // to hold, and no terminal state to report.
            expect(coordinator.scanCleanupRun.activeJobId).toBeNull();
            expect(coordinator.scanCleanupRun.inFlight).toBe(false);
            expect(coordinator.scanCleanupRun.jobState).toBeNull();
            expect(coordinator.isScanCleanupRunning.value).toBe(false);
            expect(toastAdd).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }

        // Disposal happened even though the run rejected: the next
        // installation subscribes again instead of being refused as a
        // duplicate of an installation nobody released.
        const reinstall = coordinator.installScanCleanupRunCoordinator(dependencies);
        try {
            expect(onJobState).toHaveBeenCalledTimes(2);
        } finally {
            reinstall();
        }
    });

    it('retires the previous job state when a new attempt begins', async () => {
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const canceled: TScanCleanupJobState = {
            jobId: requireJobId('canceled-job'),
            status: 'canceled',
            progress: progress(3),
            updatedAtMs: requireEpochMs(Date.now()),
        };
        coordinator.scanCleanupRun.jobState = canceled;

        // The run the user starts after cancelling one has no progress of its
        // own yet; reading the cancelled job's would show its percentage and
        // its processed pages as this attempt's.
        coordinator.beginScanCleanupAttempt();

        expect(coordinator.scanCleanupRun.jobState).toBeNull();

        // A job that is still live owns the state: an attempt cannot begin over
        // one that is running, so its progress is never discarded.
        coordinator.scanCleanupRun.activeJobId = requireJobId('live-job');
        coordinator.scanCleanupRun.jobState = {
            ...canceled,
            jobId: requireJobId('live-job'),
            status: 'running',
        };
        coordinator.beginScanCleanupAttempt();

        expect(coordinator.scanCleanupRun.jobState?.jobId).toBe('live-job');
        coordinator.scanCleanupRun.activeJobId = null;
        coordinator.scanCleanupRun.jobState = null;
    });

    it('exposes a run error only to its owning surface', async () => {
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');

        coordinator.setScanCleanupRunError('owner-a', 'native cleanup failed');

        expect(coordinator.getScanCleanupRunError('owner-a')).toBe('native cleanup failed');
        expect(coordinator.getScanCleanupRunError('owner-b')).toBe('');
    });

    it('falls back to a coordinator toast when a thrown start error has no open owning surface', async () => {
        const toastAdd = vi.fn();
        capability.value = {
            preview: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(),
            cancel: vi.fn(),
            getJobState: vi.fn(),
            subscribeJob: vi.fn(),
            reconnectJob: vi.fn(),
            pruneGeneratedOutputs: vi.fn(),
            onPreviewRaw: vi.fn(() => () => undefined),
            onJobState: vi.fn(() => () => undefined),
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf: vi.fn(),
            saveActiveDocumentAs: vi.fn(),
            openScanCleanupForDocument: vi.fn(),
            t: translate,
            toast: {add: toastAdd},
        });
        try {
            coordinator.reportScanCleanupRunError(
                'closed-owner',
                'scan-cleanup IPC codec failed',
                '/source/book.pdf',
            );

            expect(coordinator.getScanCleanupRunError('closed-owner')).toBe('scan-cleanup IPC codec failed');
            expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({
                color: 'error',
                title: 'scanCleanup.failed',
                description: expect.stringContaining('scan-cleanup IPC codec failed\nError ID: 01234567'),
            }));
            expect(coordinator.scanCleanupRun.lastError?.failure).toEqual(diagnosticMocks.failure);
        } finally {
            cleanup();
        }
    });

    it('uses a non-navigating toast when the owning cleanup workspace is open', async () => {
        const toastAdd = vi.fn();
        capability.value = {
            preview: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(),
            cancel: vi.fn(),
            getJobState: vi.fn(),
            subscribeJob: vi.fn(),
            reconnectJob: vi.fn(),
            pruneGeneratedOutputs: vi.fn(),
            onPreviewRaw: vi.fn(() => () => undefined),
            onJobState: vi.fn(() => () => undefined),
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf: vi.fn(),
            saveActiveDocumentAs: vi.fn(),
            openScanCleanupForDocument: vi.fn(),
            t: translate,
            toast: {add: toastAdd},
        });
        try {
            coordinator.setScanCleanupWorkspaceOwnerOpen('open-owner', true);

            coordinator.reportScanCleanupRunError(
                'open-owner',
                'page 17 has invalid geometry',
                '/source/book.pdf',
            );

            expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({
                color: 'error',
                title: 'scanCleanup.failed',
                description: expect.stringContaining('page 17 has invalid geometry\nError ID: 01234567'),
            }));
        } finally {
            cleanup();
        }
    });

    it('keeps runs global and routes completed, failed, and canceled terminal states', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        let nextJob = 0;
        capability.value = {
            preview: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(async () => startResult(`job-${++nextJob}`, '/managed/book — cleaned.pdf')),
            cancel: vi.fn(async () => true),
            getJobState: vi.fn(async () => null),
            subscribeJob: vi.fn(async (jobId: TJobId) => runningJobState(jobId)),
            reconnectJob: vi.fn(async () => null),
            pruneGeneratedOutputs: vi.fn(async () => 0),
            onPreviewRaw: vi.fn(() => () => undefined),
            onJobState: vi.fn(callback => {
                listener = callback;
                return () => { listener = () => undefined; };
            }),
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const openGeneratedPdf = vi.fn(async () => true);
        const saveActiveDocumentAs = vi.fn(async () => true);
        const openScanCleanupForDocument = vi.fn(async () => true);
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf,
            saveActiveDocumentAs,
            openScanCleanupForDocument,
            t: translate,
            toast: {add: toastAdd},
        });
        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/book.pdf',
                options: {
                    preserveOriginalQuality: false,
                    layoutMode: 'auto',
                    outputMode: 'bw',
                    readingOrder: 'ltr',
                    thickness: 0,
                    crop: true,
                    matchPageSize: true,
                    pageAlignment: 'top-center',
                    marginsMm: {
                        leftMm: 5,
                        topMm: 5,
                        rightMm: 5,
                        bottomMm: 5,
                    },
                    despeckle: true,
                    skipBlankPages: false,
                    pageOverrides: {},
                },
            });
            expect(capability.value!.start).toHaveBeenCalledWith(expect.not.objectContaining({outputPdfPath: expect.anything()}));
            listener({
                jobId: requireJobId('job-1'),
                status: 'completed',
                outputPdfPath: '/managed/book — cleaned.pdf',
                summary: {
                    inputPages: 4,
                    outputPages: 8,
                    spreadsSplit: 4,
                    offcutsDiscarded: 0,
                    deskewSkipped: 0,
                    cropSkipped: 0,
                    excludedPages: 0,
                    blankPagesSkipped: 0,
                    warnings: [],
                },
                partial: false,
                progress: progress(4),
                updatedAtMs: requireEpochMs(Date.now()),
            });
            await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({color: 'success'})));
            expect(openGeneratedPdf).toHaveBeenCalledWith('/managed/book — cleaned.pdf', expect.any(AbortSignal));
            const completeToast = toastAdd.mock.calls.at(-1)?.[0];
            expect(saveActiveDocumentAs).not.toHaveBeenCalled();
            completeToast.actions[0].onClick();
            expect(saveActiveDocumentAs).toHaveBeenCalledOnce();

            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/book.pdf',
                options: createScanCleanupOptions(),
            });
            coordinator.scanCleanupRun.workspaceOwnerIds.clear();
            listener({
                jobId: requireJobId('job-2'),
                status: 'failed',
                error: 'sidecar failed',
                errorCode: 'native-failure',
                failure: diagnosticMocks.failure,
                progress: progress(1),
                updatedAtMs: requireEpochMs(Date.now()),
            });
            expect(coordinator.getScanCleanupRunError(ownerContext.ownerId))
                .toBe('scanCleanup.failed (sidecar failed)');
            expect(coordinator.getScanCleanupRunError('another-owner')).toBe('');
            await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({color: 'error'})));
            const failureToast = toastAdd.mock.calls.at(-1)?.[0];
            failureToast.actions.find((action: {label: string}) => action.label === 'scanCleanup.details').onClick();
            expect(openScanCleanupForDocument).toHaveBeenCalledWith('/source/book.pdf');
            expect(diagnosticMocks.error).not.toHaveBeenCalledWith(
                'scan-cleanup',
                'Scan cleanup run failed',
                expect.anything(),
            );

            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/book.pdf',
                options: createScanCleanupOptions(),
            });
            listener({
                jobId: requireJobId('job-3'),
                status: 'canceled',
                progress: progress(1),
                updatedAtMs: requireEpochMs(Date.now()),
            });
            await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({color: 'info'})));
            expect(openGeneratedPdf).toHaveBeenCalledOnce();
        } finally {
            cleanup();
        }
    });

    it('fails the run when the generated-PDF handoff outlives its deadline, once', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        let jobId = 'job-deadline';
        const nextJobId = vi.fn(() => jobId);
        capability.value = stubCapability((next) => { listener = next; }, nextJobId);
        const openGate = Promise.withResolvers<boolean>();
        const signals: AbortSignal[] = [];
        const openGeneratedPdf = vi.fn((_path: string, signal: AbortSignal) => {
            signals.push(signal);
            return openGate.promise;
        });
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf,
            saveActiveDocumentAs: vi.fn(),
            t: translate,
            toast: {add: toastAdd},
        });
        try {
            const started = await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/deadline.pdf',
                options: createScanCleanupOptions(),
            });

            // One id was minted, and the run and the output it hands over are
            // both talking about that id.
            expect(nextJobId).toHaveBeenCalledOnce();
            expect(started).toMatchObject({
                started: true,
                jobId: 'job-deadline',
                outputPdfPath: '/managed/job-deadline.pdf',
            });

            vi.useFakeTimers();
            try {
                listener(completedState('job-deadline'));
                expect(openGeneratedPdf).toHaveBeenCalledWith('/managed/job-deadline.pdf', expect.any(AbortSignal));
                expect(coordinator.isScanCleanupRunning.value).toBe(true);

                await vi.advanceTimersByTimeAsync(30_000);
            } finally {
                vi.useRealTimers();
            }

            expect(signals[0]!.aborted).toBe(true);
            expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({
                color: 'error',
                title: 'scanCleanup.openResultFailed',
            }));
            expect(coordinator.scanCleanupRun.activeJobId).toBeNull();
            expect(coordinator.isScanCleanupRunning.value).toBe(false);

            // The abandoned open still answers eventually, and it can answer by
            // failing. Nobody is waiting for that answer any more, so the
            // coordinator has to keep consuming it: it must neither surface as
            // an unhandled rejection nor re-report an outcome or clear the
            // guard a second time.
            const unhandledRejection = vi.fn();
            process.once('unhandledRejection', unhandledRejection);
            try {
                openGate.reject(new Error('open failed after the deadline'));
                await new Promise(resolve => setTimeout(resolve, 0));
                expect(unhandledRejection).not.toHaveBeenCalled();
            } finally {
                process.removeListener('unhandledRejection', unhandledRejection);
            }
            expect(toastAdd).toHaveBeenCalledOnce();
            expect(coordinator.scanCleanupRun.activeJobId).toBeNull();
            expect(coordinator.isScanCleanupRunning.value).toBe(false);

            // And the released guard admits the next run.
            jobId = 'job-after-deadline';
            await expect(coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/next.pdf',
                options: createScanCleanupOptions(),
            })).resolves.toMatchObject({started: true});
            expect(nextJobId).toHaveBeenCalledTimes(2);
            expect(coordinator.scanCleanupRun.activeJobId).toBe('job-after-deadline');
        } finally {
            cleanup();
        }
    });

    it('hands a disposed handoff back to the next installation instead of losing the run', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        let jobId = 'job-disposed';
        const nextJobId = vi.fn(() => jobId);
        capability.value = stubCapability((next) => { listener = next; }, nextJobId);
        const abandonedOpen = Promise.withResolvers<boolean>();
        const firstOpen = vi.fn((_path: string, _signal: AbortSignal) => abandonedOpen.promise);
        const firstToast = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const dispose = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf: firstOpen,
            saveActiveDocumentAs: vi.fn(),
            t: translate,
            toast: {add: firstToast},
        });
        let reinstall: (() => void) | null = null;
        try {
            const started = await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/disposed.pdf',
                options: createScanCleanupOptions(),
            });

            expect(nextJobId).toHaveBeenCalledOnce();
            expect(started).toMatchObject({
                started: true,
                jobId: 'job-disposed',
                outputPdfPath: '/managed/job-disposed.pdf',
            });
            listener(completedState('job-disposed'));
            expect(firstOpen).toHaveBeenCalledOnce();

            const secondOpen = vi.fn(async () => true);
            const secondToast = vi.fn();

            // Disposal, reinstallation and the replay all land in one tick, the
            // way a window that swaps its coordinator does. Nothing is awaited
            // in between, so the abandoned handoff has not resumed yet and
            // cannot be what releases the job for the replacement.
            dispose();
            const firstSignal = firstOpen.mock.calls[0]![1];
            expect(firstSignal.aborted).toBe(true);
            expect(firstToast).not.toHaveBeenCalled();
            // Disposal cancels the handoff but keeps the run recorded: the job
            // is still the persisted active one and nobody has reported it yet.
            expect(coordinator.scanCleanupRun.activeJobId).toBe('job-disposed');
            reinstall = coordinator.installScanCleanupRunCoordinator({
                openGeneratedPdf: secondOpen,
                saveActiveDocumentAs: vi.fn(),
                t: translate,
                toast: {add: secondToast},
            });
            listener(completedState('job-disposed'));
            expect(secondOpen).toHaveBeenCalledOnce();

            await vi.waitFor(() => expect(secondToast).toHaveBeenCalledWith(expect.objectContaining({color: 'success'})));
            expect(secondOpen).toHaveBeenCalledWith('/managed/job-disposed.pdf', expect.any(AbortSignal));
            expect(coordinator.scanCleanupRun.activeJobId).toBeNull();

            // The replayed run owns the state now, so the abandoned open cannot
            // report through the disposed dependencies or clear what replaced it.
            jobId = 'job-after-replay';
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/after-replay.pdf',
                options: createScanCleanupOptions(),
            });
            abandonedOpen.resolve(true);
            await Promise.resolve();
            await Promise.resolve();
            expect(firstToast).not.toHaveBeenCalled();
            expect(secondToast).toHaveBeenCalledOnce();
            expect(nextJobId).toHaveBeenCalledTimes(2);
            expect(coordinator.scanCleanupRun.activeJobId).toBe('job-after-replay');
            expect(coordinator.isScanCleanupRunning.value).toBe(true);
        } finally {
            reinstall?.();
            dispose();
        }
    });

    it('maps out-of-order completion to exact source-page ticks only for that workspace', async () => {
        const {resolveScanCleanupProcessedPages} = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const runningState: TScanCleanupJobState = {
            jobId: requireJobId('job-progress'),
            status: 'running',
            progress: {
                ...progress(3, 6),
                completedPageNumbers: [
                    5,
                    2,
                    4,
                ],
            },
            updatedAtMs: requireEpochMs(Date.now()),
        };

        expect([...resolveScanCleanupProcessedPages(
            runningState,
            '/source/book.pdf',
            '/source/book.pdf',
            6,
        )]).toEqual([
            5,
            2,
            4,
        ]);
        expect(resolveScanCleanupProcessedPages(
            runningState,
            '/source/book.pdf',
            '/source/other.pdf',
            6,
        ).size).toBe(0);
        expect(resolveScanCleanupProcessedPages({
            ...runningState,
            status: 'canceled',
        }, '/source/book.pdf', '/source/book.pdf', 6).size).toBe(0);
    });

    it('does not infer sparse page identities from a truncated completion count', async () => {
        const {resolveScanCleanupProcessedPages} = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const truncatedState: TScanCleanupJobState = {
            jobId: requireJobId('job-sparse-progress'),
            status: 'running',
            progress: {
                ...progress(2, 2),
                completedPageNumbers: [
                    100,
                    200,
                ],
                completedPageNumbersTruncated: true,
            },
            updatedAtMs: requireEpochMs(Date.now()),
        };

        expect([...resolveScanCleanupProcessedPages(
            truncatedState,
            '/source/book.pdf',
            '/source/book.pdf',
            200,
        )]).toEqual([
            100,
            200,
        ]);
        expect([...resolveScanCleanupProcessedPages({
            ...truncatedState,
            progress: {
                ...truncatedState.progress,
                completedPageNumbers: [],
            },
        }, '/source/book.pdf', '/source/book.pdf', 200)]).toEqual([]);
    });

    it('makes partial-scope completion explicit in the result toast', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        capability.value = {
            preview: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(async () => startResult('job-partial', '/managed/job-partial.pdf')),
            cancel: vi.fn(async () => true),
            getJobState: vi.fn(async () => null),
            subscribeJob: vi.fn(async (jobId: TJobId) => runningJobState(jobId)),
            reconnectJob: vi.fn(async () => null),
            pruneGeneratedOutputs: vi.fn(async () => 0),
            onPreviewRaw: vi.fn(() => () => undefined),
            onJobState: vi.fn(callback => {
                listener = callback;
                return () => undefined;
            }),
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf: vi.fn(async () => true),
            saveActiveDocumentAs: vi.fn(),
            t: translate,
            toast: {add: toastAdd},
        });
        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/book.pdf',
                options: createScanCleanupOptions(),
                sourcePageNumbers: [3],
            });
            listener({
                jobId: requireJobId('job-partial'),
                status: 'completed',
                outputPdfPath: '/managed/book-cleaned.pdf',
                summary: {
                    inputPages: 1,
                    outputPages: 1,
                    spreadsSplit: 0,
                    offcutsDiscarded: 0,
                    deskewSkipped: 0,
                    cropSkipped: 0,
                    excludedPages: 0,
                    blankPagesSkipped: 0,
                    warnings: [],
                },
                partial: true,
                progress: progress(1, 1),
                updatedAtMs: requireEpochMs(Date.now()),
            });
            await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(
                expect.objectContaining({title: 'scanCleanup.completedPartialTitle'}),
            ));
        } finally {
            cleanup();
        }
    });

    it('holds the run guard and active job until the generated PDF finishes opening', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        const openGate = Promise.withResolvers<boolean>();
        capability.value = {
            preview: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(async () => startResult('job-open-gate', '/managed/job-open-gate.pdf')),
            cancel: vi.fn(async () => true),
            getJobState: vi.fn(async () => null),
            subscribeJob: vi.fn(async (jobId: TJobId) => runningJobState(jobId)),
            reconnectJob: vi.fn(async () => null),
            pruneGeneratedOutputs: vi.fn(async () => 0),
            onPreviewRaw: vi.fn(() => () => undefined),
            onJobState: vi.fn(callback => {
                listener = callback;
                return () => undefined;
            }),
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const openGeneratedPdf = vi.fn(() => openGate.promise);
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf,
            saveActiveDocumentAs: vi.fn(),
            t: translate,
            toast: {add: toastAdd},
        });
        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/book.pdf',
                options: createScanCleanupOptions(),
            });
            const completed: TScanCleanupJobState = {
                jobId: requireJobId('job-open-gate'),
                status: 'completed',
                outputPdfPath: '/managed/job-open-gate.pdf',
                summary: {
                    inputPages: 1,
                    outputPages: 1,
                    spreadsSplit: 0,
                    offcutsDiscarded: 0,
                    deskewSkipped: 0,
                    cropSkipped: 0,
                    excludedPages: 0,
                    blankPagesSkipped: 0,
                    warnings: [],
                },
                partial: false,
                progress: progress(1, 1),
                updatedAtMs: requireEpochMs(Date.now()),
            };
            listener(completed);
            await vi.waitFor(() => expect(openGeneratedPdf).toHaveBeenCalledOnce());

            // While the output document is still being claimed, the run must stay
            // observable as active so workspace detection cannot restart against
            // the source document mid-handoff.
            expect(coordinator.isScanCleanupRunning.value).toBe(true);
            expect(coordinator.scanCleanupRun.activeJobId).toBe('job-open-gate');
            expect(toastAdd).not.toHaveBeenCalled();

            listener(completed);
            await Promise.resolve();
            expect(openGeneratedPdf).toHaveBeenCalledOnce();

            openGate.resolve(true);
            await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({color: 'success'})));
            expect(coordinator.isScanCleanupRunning.value).toBe(false);
            expect(coordinator.scanCleanupRun.activeJobId).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('contains generated-document open failures and reports them', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        capability.value = {
            preview: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(async () => startResult('job-open-failure', '/managed/job-open-failure.pdf')),
            cancel: vi.fn(async () => true),
            getJobState: vi.fn(async () => null),
            subscribeJob: vi.fn(async (jobId: TJobId) => runningJobState(jobId)),
            reconnectJob: vi.fn(async () => null),
            pruneGeneratedOutputs: vi.fn(async () => 0),
            onPreviewRaw: vi.fn(() => () => undefined),
            onJobState: vi.fn(callback => {
                listener = callback;
                return () => undefined;
            }),
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const openGeneratedPdf = vi.fn(async () => {
            throw new Error('Invalid or non-existent file');
        });
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf,
            saveActiveDocumentAs: vi.fn(),
            t: translate,
            toast: {add: toastAdd},
        });
        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/book.pdf',
                options: createScanCleanupOptions(),
            });
            listener({
                jobId: requireJobId('job-open-failure'),
                status: 'completed',
                outputPdfPath: '/managed/missing.pdf',
                summary: {
                    inputPages: 1,
                    outputPages: 1,
                    spreadsSplit: 0,
                    offcutsDiscarded: 0,
                    deskewSkipped: 0,
                    cropSkipped: 0,
                    excludedPages: 0,
                    blankPagesSkipped: 0,
                    warnings: [],
                },
                partial: false,
                progress: progress(1, 1),
                updatedAtMs: requireEpochMs(Date.now()),
            });

            await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({
                color: 'error',
                title: 'scanCleanup.openResultFailed',
            })));
            expect(openGeneratedPdf).toHaveBeenCalledWith('/managed/missing.pdf', expect.any(AbortSignal));
        } finally {
            cleanup();
        }
    });

    it('does not restore a stale active id when a terminal event beats start resolution', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        const completed: TScanCleanupJobState = {
            jobId: requireJobId('job-instant'),
            status: 'completed',
            outputPdfPath: '/managed/instant.pdf',
            summary: {
                inputPages: 1,
                outputPages: 1,
                spreadsSplit: 0,
                offcutsDiscarded: 0,
                deskewSkipped: 0,
                cropSkipped: 0,
                excludedPages: 0,
                blankPagesSkipped: 0,
                warnings: [],
            },
            partial: false,
            progress: progress(1, 1),
            updatedAtMs: requireEpochMs(Date.now()),
        };
        const subscribeJob = vi.fn(async () => completed);
        capability.value = {
            preview: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(async () => {
                listener(completed);
                return startResult('job-instant', '/managed/instant.pdf');
            }),
            cancel: vi.fn(async () => true),
            getJobState: vi.fn(async () => null),
            subscribeJob,
            reconnectJob: vi.fn(async () => null),
            pruneGeneratedOutputs: vi.fn(async () => 0),
            onPreviewRaw: vi.fn(() => () => undefined),
            onJobState: vi.fn(callback => {
                listener = callback;
                return () => undefined;
            }),
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const openGeneratedPdf = vi.fn(async () => true);
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf,
            saveActiveDocumentAs: vi.fn(),
            t: translate,
            toast: {add: vi.fn()},
        });
        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/instant.pdf',
                options: createScanCleanupOptions(),
            });
            await vi.waitFor(() => expect(openGeneratedPdf).toHaveBeenCalledWith('/managed/instant.pdf', expect.any(AbortSignal)));
            await vi.waitFor(() => expect(coordinator.scanCleanupRun.activeJobId).toBeNull());
            expect(coordinator.scanCleanupRun.jobState).toEqual(completed);
            expect(subscribeJob).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('remembers a terminal job only while it can still suppress a duplicate', async () => {
        // A session cleans document after document, and every finished job used
        // to be remembered forever so its terminal state could not be handled
        // twice. The memory is bounded now, so this pins both halves: a job the
        // coordinator is still talking about is never handled twice, and a job
        // far enough behind it is forgotten rather than accumulated.
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        let nextJobId = 'job-0';
        const openGeneratedPdf = vi.fn(async () => true);
        capability.value = {
            preview: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(async () => startResult(nextJobId)),
            cancel: vi.fn(async () => true),
            getJobState: vi.fn(async () => null),
            subscribeJob: vi.fn(async () => null),
            reconnectJob: vi.fn(async () => null),
            pruneGeneratedOutputs: vi.fn(async () => 0),
            onPreviewRaw: vi.fn(() => () => undefined),
            onJobState: vi.fn(callback => {
                listener = callback;
                return () => undefined;
            }),
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf,
            saveActiveDocumentAs: vi.fn(),
            t: translate,
            toast: {add: vi.fn()},
        });
        try {
            const completed = (jobId: string): TScanCleanupJobState => completedState(jobId);
            const runJobToCompletion = async (jobId: string) => {
                nextJobId = jobId;
                await coordinator.startScanCleanup({
                    ...ownerContext,
                    sourcePdfPath: `/source/${jobId}.pdf`,
                    options: createScanCleanupOptions(),
                });
                // The bridge replays the state a reconnect answers, so every job's
                // terminal state arrives more than once.
                listener(completed(jobId));
                listener(completed(jobId));
                await vi.waitFor(() => expect(coordinator.scanCleanupRun.activeJobId).toBeNull());
            };

            await runJobToCompletion('job-0');
            expect(openGeneratedPdf).toHaveBeenCalledOnce();

            // Still the job the coordinator last handled: its id is remembered, so
            // a start that answers it is a job already finished, not a new run.
            nextJobId = 'job-0';
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/job-0.pdf',
                options: createScanCleanupOptions(),
            });
            expect(coordinator.scanCleanupRun.activeJobId).toBeNull();
            expect(coordinator.isScanCleanupRunning.value).toBe(false);

            for (let index = 1; index <= 32; index += 1) {
                await runJobToCompletion(`job-${String(index)}`);
            }
            // Every completed run opened its own output exactly once, duplicates
            // and all.
            expect(openGeneratedPdf).toHaveBeenCalledTimes(33);

            // And the first job is far enough behind that it can no longer be
            // confused with a live one: the coordinator has forgotten it rather
            // than holding every id the session ever produced.
            nextJobId = 'job-0';
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/job-0.pdf',
                options: createScanCleanupOptions(),
            });
            expect(coordinator.scanCleanupRun.activeJobId).toBe('job-0');
        } finally {
            cleanup();
        }
    });

    it('retries coordinator installation when the capability appears later', async () => {
        capability.value = null;
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const dependencies = {
            openGeneratedPdf: vi.fn(async () => true),
            saveActiveDocumentAs: vi.fn(),
            t: translate,
            toast: {add: vi.fn()},
        };
        const firstCleanup = coordinator.installScanCleanupRunCoordinator(dependencies);
        let secondCleanup: (() => void) | null = null;
        const onJobState = vi.fn(() => () => undefined);
        capability.value = {
            onPreviewRaw: vi.fn(() => () => undefined),
            preview: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(),
            cancel: vi.fn(),
            getJobState: vi.fn(),
            subscribeJob: vi.fn(),
            reconnectJob: vi.fn(),
            pruneGeneratedOutputs: vi.fn(),
            onJobState,
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        try {
            secondCleanup = coordinator.installScanCleanupRunCoordinator(dependencies);

            expect(onJobState).toHaveBeenCalledOnce();
        } finally {
            secondCleanup?.();
            firstCleanup();
        }
    });
});
