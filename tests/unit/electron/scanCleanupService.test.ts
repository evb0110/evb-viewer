import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';

import {
    access,
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {WebContents} from 'electron';
import type {IHostResourceProfileSnapshot} from '@contracts/hostResourceProfile';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import type * as TPageOpsModule from '@electron/features/page-ops/public';
import type * as TJobBrokerModule from '@electron/resources/jobBroker';
import type * as TOpenPathCapabilitiesModule from '@electron/file-access/openPathCapabilities';
import {OPEN_PATH_CAPABILITY_TTL_MS} from '@electron/file-access/openPathCapabilities';
import {decodeScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import {
    JobBroker,
    type IJobBrokerRequest,
    resolveMainJobBrokerCapacity,
} from '@electron/resources/jobBroker';
import {
    createScanCleanupService,
    grantScanCleanupOutputAccess,
} from '@electron/features/scan-cleanup/createScanCleanupService';
import {classifyScanCleanupPreviewError as classifyScanCleanupError} from '@electron/features/scan-cleanup/scanCleanupPreviewPolicy';
import {ScanCleanupPageScopeError} from '@evb/scan-cleanup/core/pageScope';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';
import {registerScanCleanupDetectionResultStore} from '@electron/features/scan-cleanup/detectionResultStoreRegistry';
import {createScanCleanupDetectionSignature} from '@contracts/scan-cleanup/detectionSignature';
import {
    beginMainOperationShutdown,
    resetMainOperationLifecycleForTests,
} from '@electron/operation-lifecycle/mainOperationLifecycle';

const mocks = vi.hoisted(() => {
    const acquire = vi.fn(async (_request: IJobBrokerRequest) => ({release: vi.fn()}));
    const runWorker = vi.fn(async (
        _request: unknown,
        _paths: unknown,
        _runtimePolicy: unknown,
        _signal: unknown,
        _onProgress: unknown,
    ) => ({
        inputPages: 1,
        outputPages: 1,
        spreadsSplit: 0,
        offcutsDiscarded: 0,
        deskewSkipped: 0,
        cropSkipped: 0,
        excludedPages: 0,
        blankPagesSkipped: 0,
        warnings: [],
    }));
    const host = {
        logicalCpus: 11,
        totalRamBytes: 32 * 1024 ** 3,
        tier: 'high' as 'low' | 'medium' | 'high',
    };
    const failureReceipt = {
        eventId: '0123456789abcdef0123456789abcdef',
        code: 'UNCLASSIFIED_MAIN_ERROR',
        occurredAt: 1,
        severity: 'error',
    } as FailureReceipt;
    return {
        acquire,
        allowOpenPath: vi.fn(() => '/managed/cleaned.pdf'),
        createOutput: vi.fn(async () => '/managed/cleaned.pdf'),
        host,
        hostProfile: () => host as IHostResourceProfileSnapshot,
        isWorkingCopyOriginalPathRegistered: vi.fn(() => false),
        pageOpsDisabled: false,
        pruneOutputs: vi.fn(async () => 0),
        runWorker,
        failureReceipt,
        loggerError: vi.fn(() => failureReceipt),
        workerFailures: new WeakMap<object, FailureReceipt>(),
    };
});

vi.mock('@electron/features/scan-cleanup/runScanCleanupWorkerTask', () => (
    {runScanCleanupWorkerTask: mocks.runWorker}
));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    error: mocks.loggerError,
    info: vi.fn(),
    warn: vi.fn(),
})}));
vi.mock('@electron/utils/workerTask', () => ({getWorkerTaskFailureReceipt: (error: unknown) => (
    typeof error === 'object' && error !== null ? mocks.workerFailures.get(error) : undefined
)}));
vi.mock('@electron/resources/jobBroker', async importOriginal => {
    const actual = await importOriginal<typeof TJobBrokerModule>();
    return {
        ...actual,
        mainJobBroker: {
            acquire: mocks.acquire,
            getSnapshot: () => ({capacity: actual.resolveMainJobBrokerCapacity(mocks.hostProfile())}),
        },
    };
});
vi.mock('@electron/resources/hostResourceProfile', () => ({getHostResourceProfileSnapshot: mocks.hostProfile}));
vi.mock('@electron/pdf/nativeToolPaths', () => {
    const getPdfNativeToolPaths = () => ({
        qpdf: '/qpdf',
        pdftoppm: '/pdftoppm',
        pdfinfo: '/pdfinfo',
    });
    return {getPdfNativeToolPaths};
});
vi.mock('@electron/native-tools/resolveNativeToolPath', () => ({resolveNativeToolPath: () => '/scan-cleanup'}));
vi.mock('@electron/features/page-ops/public', async importOriginal => ({
    ...await importOriginal<typeof TPageOpsModule>(),
    isNativePageOpsDisabled: () => mocks.pageOpsDisabled,
    resolveNativePageOpsPath: () => '/page-ops',
}));
vi.mock('@electron/image/tryCreatePdfWithNativeImageCombiner', () => (
    {resolveNativePdfImageCombinePath: () => '/pdf-image-combine'}
));
vi.mock('@electron/features/scan-cleanup/public/generatedOutputs', () => {
    return {
        createScanCleanupGeneratedOutputPath: mocks.createOutput,
        pruneScanCleanupGeneratedOutputs: mocks.pruneOutputs,
    };
});
vi.mock('@electron/file-access/workingCopyStore', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule>()),
    getWorkingCopyBackingEntry: () => ({backing: 'materialized'}),
    isWorkingCopyOriginalPathRegistered: mocks.isWorkingCopyOriginalPathRegistered,
}));
vi.mock('@electron/file-access/openPathCapabilities', async importOriginal => ({
    ...await importOriginal<typeof TOpenPathCapabilitiesModule>(),
    allowOpenPath: mocks.allowOpenPath,
}));
vi.mock('@electron/file-access/workingCopyMaterialization', () => ({ensureWorkingCopyMaterialized: async (sourcePdfPath: string) => ({physicalWorkingCopyPath: sourcePdfPath})}));

const owner = {
    ownerId: 'cleanup-owner',
    documentRevision: 'revision-1',
};
const startRequest = {
    ...owner,
    sourcePdfPath: '/source.pdf',
    sourcePageNumbers: [3],
    layoutByPage: {'3': 'two-page-spread' as const},
    options: {
        preserveOriginalQuality: false,
        layoutMode: 'auto' as const,
        outputMode: 'color' as const,
        readingOrder: 'ltr' as const,
        thickness: 0,
        crop: true,
        matchPageSize: true,
        pageAlignment: 'top-center' as const,
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
};
const outputDirs: string[] = [];

function sender(): WebContents {
    return {
        id: 42,
        isDestroyed: () => false,
        send: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
    } as never;
}

class LifecycleWebContents extends EventEmitter {
    readonly id: number;
    readonly isDestroyed = () => false;
    readonly send = vi.fn();

    constructor(id: number) {
        super();
        this.id = id;
    }
}

describe('scan cleanup service', () => {
    it('classifies a page-scope validation failure as an invalid request', () => {
        expect(classifyScanCleanupError(
            new ScanCleanupPageScopeError('outside document', [9], 3),
            false,
        )).toBe('invalid-request');
        expect(classifyScanCleanupError({code: 'SCAN_CLEANUP_INVALID_PAGE_SCOPE'}, false)).toBe('invalid-request');
    });
    afterEach(async () => {
        await Promise.all(outputDirs.splice(0).map(path => rm(path, {
            recursive: true,
            force: true,
        })));
    });

    beforeEach(() => {
        mocks.acquire.mockClear();
        mocks.allowOpenPath.mockClear();
        mocks.createOutput.mockClear();
        mocks.createOutput.mockImplementation(async () => '/managed/cleaned.pdf');
        mocks.isWorkingCopyOriginalPathRegistered.mockReset();
        mocks.isWorkingCopyOriginalPathRegistered.mockReturnValue(false);
        mocks.pruneOutputs.mockClear();
        mocks.runWorker.mockClear();
        mocks.loggerError.mockClear();
        mocks.pageOpsDisabled = false;
        Object.assign(mocks.host, {
            logicalCpus: 11,
            totalRamBytes: 32 * 1024 ** 3,
            tier: 'high',
        });
    });

    it('deduplicates output grants per WebContents and regrants after lifecycle replacement', () => {
        const first: WebContents = new LifecycleWebContents(90_001) as never;
        const other: WebContents = new LifecycleWebContents(90_002) as never;

        grantScanCleanupOutputAccess('/managed/run/../cleaned.pdf', [first]);
        grantScanCleanupOutputAccess('/managed/cleaned.pdf', [first]);
        grantScanCleanupOutputAccess('/managed/cleaned.pdf', [other]);
        expect(mocks.allowOpenPath).toHaveBeenCalledTimes(2);

        first.emit('render-process-gone');
        grantScanCleanupOutputAccess('/managed/cleaned.pdf', [first]);
        expect(mocks.allowOpenPath).toHaveBeenCalledTimes(3);

        first.emit('did-start-navigation', {}, 'app://reconnected', false, true);
        grantScanCleanupOutputAccess('/managed/cleaned.pdf', [first]);
        expect(mocks.allowOpenPath).toHaveBeenCalledTimes(4);

        const replacement: WebContents = new LifecycleWebContents(90_001) as never;
        grantScanCleanupOutputAccess('/managed/cleaned.pdf', [replacement]);
        grantScanCleanupOutputAccess('/managed/cleaned.pdf', [replacement]);
        expect(mocks.allowOpenPath).toHaveBeenCalledTimes(5);
    });

    it('refreshes a deduplicated output grant after the authoritative capability TTL', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
            const webContents: WebContents = new LifecycleWebContents(90_003) as never;

            grantScanCleanupOutputAccess('/managed/cleaned.pdf', [webContents]);
            grantScanCleanupOutputAccess('/managed/cleaned.pdf', [webContents]);
            vi.advanceTimersByTime(OPEN_PATH_CAPABILITY_TTL_MS - 1);
            grantScanCleanupOutputAccess('/managed/cleaned.pdf', [webContents]);
            expect(mocks.allowOpenPath).toHaveBeenCalledOnce();

            vi.advanceTimersByTime(2);
            grantScanCleanupOutputAccess('/managed/cleaned.pdf', [webContents]);
            expect(mocks.allowOpenPath).toHaveBeenCalledTimes(2);
            webContents.emit('destroyed');
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses main-owned liveness when pruning generated outputs', async () => {
        const service = createScanCleanupService();

        await expect(service.pruneGeneratedOutputs()).resolves.toBe(0);

        expect(mocks.pruneOutputs).toHaveBeenCalledWith({isOutputLive: mocks.isWorkingCopyOriginalPathRegistered});
    });

    it('refuses xlarge ink placement after claiming bounded detection evidence', async () => {
        const close = vi.fn(async () => undefined);
        const resultStore: IScanCleanupDetectionResultStore = {
            pageCount: 20_001,
            resultCount: 20_001,
            append: async () => undefined,
            replace: async () => undefined,
            getPage: async () => undefined,
            readRange: async () => [],
            forEachChunk: async () => undefined,
            close,
        };
        const detectionResultStoreId = registerScanCleanupDetectionResultStore({
            detectionSignature: createScanCleanupDetectionSignature({
                ...startRequest.options,
                pageAlignment: 'ink',
            }),
            documentRevision: owner.documentRevision,
            ownerId: owner.ownerId,
            resultStore,
            sourcePdfPath: startRequest.sourcePdfPath,
        });
        const service = createScanCleanupService();

        const result = await service.start(sender(), {
            ...startRequest,
            detectionResultStoreId,
            options: {
                ...startRequest.options,
                pageAlignment: 'ink',
            },
        });

        expect(result).toMatchObject({
            started: false,
            errorCode: 'too-large',
        });
        if (result.started) {
            throw new Error('xlarge ink placement unexpectedly started');
        }
        expect(result.error).toContain('20,000');
        expect(mocks.runWorker).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
    });

    it.each([
        [
            '4-core / 8 GiB',
            4,
            8,
            'low',
            1,
            1,
        ],
        [
            '6-core / 12 GiB',
            6,
            12,
            'medium',
            2,
            1,
        ],
        [
            '11-core / 32 GiB',
            11,
            32,
            'high',
            4,
            3,
        ],
        [
            '32-core / 128 GiB',
            32,
            128,
            'high',
            7,
            6,
        ],
    ] as const)('fans raster work out to the %s host without consuming all bulk native slots', async (
        _label,
        logicalCpus,
        totalRamGiB,
        tier,
        sequentialRasterConcurrency,
        streamingRasterConcurrency,
    ) => {
        Object.assign(mocks.host, {
            logicalCpus,
            totalRamBytes: totalRamGiB * 1024 ** 3,
            tier,
        });
        const rasterStreaming = process.platform !== 'win32'
            && resolveMainJobBrokerCapacity(mocks.hostProfile()).nativeProcesses >= 3;
        const rasterConcurrency = rasterStreaming
            ? streamingRasterConcurrency
            : sequentialRasterConcurrency;
        const service = createScanCleanupService();
        await service.start(sender(), startRequest);

        await vi.waitFor(() => expect(mocks.runWorker).toHaveBeenCalledOnce());
        expect(decodeScanCleanupRuntimePolicy(mocks.runWorker.mock.calls[0]![2])).toEqual({
            rasterConcurrency,
            rasterStreaming,
            logicalCpus,
            totalRamBytes: totalRamGiB * 1024 ** 3,
        });

        const leased = mocks.acquire.mock.calls[0]![0].resources;
        expect(mocks.acquire.mock.calls[0]![0]).toMatchObject({
            ownerId: 'scan-cleanup:42:cleanup-owner',
            perOwnerLimit: 1,
        });
        expect(leased).toMatchObject({
            cpuTokens: rasterConcurrency,
            nativeProcesses: rasterConcurrency + Number(rasterStreaming),
        });
        expect(leased.estimatedResidentBytes / rasterConcurrency).toBeGreaterThanOrEqual(64 * 1024 * 1024);
        await expect(new JobBroker(resolveMainJobBrokerCapacity(mocks.hostProfile())).acquire({
            ownerId: 'admission-probe',
            kind: 'scan-cleanup',
            priority: 'user',
            resources: leased,
        })).resolves.toBeDefined();
        expect(resolveMainJobBrokerCapacity(mocks.hostProfile()).nativeProcesses
            - leased.nativeProcesses).toBeGreaterThanOrEqual(1);
    });

    it('gives a default raster run the page-ops tool its matched canvas is measured with', async () => {
        const service = createScanCleanupService();
        await service.start(sender(), startRequest);

        await vi.waitFor(() => expect(mocks.runWorker).toHaveBeenCalledOnce());
        // The default run is a raster run with matching on. Resolving page-ops
        // only for lossless runs is how matching used to be dropped without
        // telling anyone.
        expect(mocks.runWorker.mock.calls[0]![0]).toMatchObject({options: {
            preserveOriginalQuality: false,
            matchPageSize: true,
        }});
        expect(mocks.runWorker.mock.calls[0]![1]).toMatchObject({pdfPageOpsBinary: '/page-ops'});
        // And the layouts the preview measured its canvas from reach the run, so
        // the run measures the same rectangle.
        expect(mocks.runWorker.mock.calls[0]![0]).toMatchObject({layoutByPage: {'3': 'two-page-spread'}});
    });

    it('joins an identical active request and replaces a superseded request for the same owner', async () => {
        const entered = Promise.withResolvers<AbortSignal>();
        mocks.runWorker.mockImplementationOnce(async (_request, _paths, _policy, signal) => {
            entered.resolve(signal as AbortSignal);
            return new Promise((_, reject) => {
                (signal as AbortSignal).addEventListener('abort', () => reject((signal as AbortSignal).reason), {once: true});
            });
        });
        const service = createScanCleanupService();
        const first = await service.start(sender(), startRequest);
        const signal = await entered.promise;

        await expect(service.start(sender(), startRequest)).resolves.toEqual(first);
        expect(mocks.runWorker).toHaveBeenCalledOnce();

        const replacement = await service.start(sender(), {
            ...startRequest,
            options: {
                ...startRequest.options,
                thickness: 1,
            },
        });
        expect(replacement.jobId).not.toBe(first.jobId);
        expect(signal.aborted).toBe(true);
        await vi.waitFor(() => expect(mocks.runWorker).toHaveBeenCalledTimes(2));
    });

    it('serializes overlapping starts until their generated output is reserved', async () => {
        const output = Promise.withResolvers<string>();
        mocks.createOutput.mockImplementationOnce(async () => output.promise);
        const service = createScanCleanupService();
        const first = service.start(sender(), startRequest);
        await vi.waitFor(() => expect(mocks.createOutput).toHaveBeenCalledOnce());
        const duplicate = service.start(sender(), startRequest);

        output.resolve('/managed/cleaned.pdf');
        await expect(duplicate).resolves.toEqual(await first);
        expect(mocks.createOutput).toHaveBeenCalledOnce();
        expect(mocks.runWorker).toHaveBeenCalledOnce();
    });

    it('releases a start reservation when job registration throws', async () => {
        const service = createScanCleanupService();
        beginMainOperationShutdown('simulated shutdown admission failure');
        try {
            await expect(service.start(sender(), startRequest))
                .rejects.toThrow('simulated shutdown admission failure');
        } finally {
            resetMainOperationLifecycleForTests();
        }

        await expect(service.start(sender(), startRequest)).resolves.toMatchObject({
            started: true,
            outputPdfPath: '/managed/cleaned.pdf',
        });
        await vi.waitFor(() => expect(mocks.runWorker).toHaveBeenCalledOnce());
    });

    it('leaves page-ops out of a run that needs no page geometry', async () => {
        const service = createScanCleanupService();
        await service.start(sender(), {
            ...startRequest,
            options: {
                ...startRequest.options,
                matchPageSize: false,
            },
        });

        await vi.waitFor(() => expect(mocks.runWorker).toHaveBeenCalledOnce());
        expect(mocks.runWorker.mock.calls[0]![1]).not.toHaveProperty('pdfPageOpsBinary');
    });

    it('keeps a matched raster run going on Poppler geometry when page-ops is disabled', async () => {
        mocks.pageOpsDisabled = true;
        const service = createScanCleanupService();
        await service.start(sender(), startRequest);

        // Matching is a default setting and the geometry it needs is something
        // Poppler reports too, so disabling page-ops does not take the feature
        // away — the worker is handed pdfinfo instead.
        await vi.waitFor(() => expect(mocks.runWorker).toHaveBeenCalledOnce());
        expect(mocks.runWorker.mock.calls[0]![1]).not.toHaveProperty('pdfPageOpsBinary');
        expect(mocks.runWorker.mock.calls[0]![1]).toMatchObject({pdfinfoBinary: expect.any(String)});
        expect(mocks.runWorker.mock.calls[0]![0]).toMatchObject({options: {matchPageSize: true}});
    });

    it('names the tool a lossless run cannot start without', async () => {
        mocks.pageOpsDisabled = true;
        const service = createScanCleanupService();
        const webContents = sender();
        const started = await service.start(webContents, {
            ...startRequest,
            options: {
                ...startRequest.options,
                preserveOriginalQuality: true,
            },
        });
        if (!started.started) throw new Error('Expected scan cleanup to start');

        // The lossless path assembles with evb-pdf-page-ops itself, so there is
        // nothing to fall back to and the run says which tool is missing.
        await vi.waitFor(() => expect(service.getState(webContents, started.jobId, owner))
            .toMatchObject({
                status: 'failed',
                errorCode: 'tools-unavailable',
            }));
        const terminal = service.getState(webContents, started.jobId, owner);
        expect(terminal?.status === 'failed' ? terminal.error : '').toContain('evb-pdf-page-ops');
        expect(mocks.runWorker).not.toHaveBeenCalled();
        expect(terminal?.status === 'failed' ? terminal.failure : undefined).toEqual(mocks.failureReceipt);
    });

    it('reuses a worker-owned receipt in the failed state without another error log', async () => {
        const workerFailure = new Error('worker failed');
        mocks.workerFailures.set(workerFailure, mocks.failureReceipt);
        mocks.runWorker.mockRejectedValueOnce(workerFailure);
        const service = createScanCleanupService();
        const webContents = sender();
        const started = await service.start(webContents, startRequest);
        if (!started.started) throw new Error('Expected scan cleanup to start');

        await vi.waitFor(() => expect(service.getState(webContents, started.jobId, owner))
            .toMatchObject({
                status: 'failed',
                failure: mocks.failureReceipt,
            }));

        expect(mocks.loggerError).not.toHaveBeenCalled();
    });

    it('treats cancellation of an already-terminal owned job as a successful no-op', async () => {
        const service = createScanCleanupService();
        const webContents = sender();
        const started = await service.start(webContents, startRequest);
        expect(started.started).toBe(true);
        if (!started.started) throw new Error('Expected scan cleanup to start');

        await vi.waitFor(() => expect(service.getState(webContents, started.jobId, owner))
            .toMatchObject({
                status: 'completed',
                partial: true,
                progress: {
                    completedPageNumbers: [3],
                    totalUnits: 1,
                },
            }));
        expect(service.cancel(webContents, started.jobId, owner)).toBe(true);
        expect(service.getState(webContents, started.jobId, owner)?.status).toBe('completed');
    });

    it.each([
        'destroyed',
        'render-process-gone',
    ] as const)('cancels an active run when its renderer emits %s', async eventName => {
        const entered = Promise.withResolvers<AbortSignal>();
        mocks.runWorker.mockImplementationOnce(async (_request, _paths, _policy, signal) => {
            entered.resolve(signal as AbortSignal);
            return new Promise((_, reject) => {
                (signal as AbortSignal).addEventListener(
                    'abort',
                    () => reject((signal as AbortSignal).reason),
                    {once: true},
                );
            });
        });
        const service = createScanCleanupService();
        const webContents: WebContents = new LifecycleWebContents(42) as never;
        const started = await service.start(webContents, startRequest);
        if (!started.started) throw new Error('Expected scan cleanup to start');
        const signal = await entered.promise;

        webContents.emit(eventName);

        await vi.waitFor(() => expect(signal.aborted).toBe(true));
        await vi.waitFor(() => expect(service.getState(webContents, started.jobId, owner))
            .toMatchObject({status: 'canceled'}));
    });

    it('detaches across main-frame navigation and rebinds on reconnect', async () => {
        const entered = Promise.withResolvers<AbortSignal>();
        mocks.runWorker.mockImplementationOnce(async (_request, _paths, _policy, signal) => {
            entered.resolve(signal as AbortSignal);
            return new Promise((_, reject) => {
                (signal as AbortSignal).addEventListener(
                    'abort',
                    () => reject((signal as AbortSignal).reason),
                    {once: true},
                );
            });
        });
        const service = createScanCleanupService();
        const lifecycleSender = new LifecycleWebContents(42);
        const webContents: WebContents = lifecycleSender as never;
        const started = await service.start(webContents, startRequest);
        if (!started.started) throw new Error('Expected scan cleanup to start');
        const signal = await entered.promise;
        const publishProgress = mocks.runWorker.mock.calls[0]![4] as (progress: {
            stage: 'rendering';
            completedUnits: number;
            totalUnits: number;
            percent: number;
        }) => void;
        expect(webContents.listenerCount('did-start-navigation')).toBe(1);

        expect(service.subscribe(webContents, started.jobId, owner))
            .toMatchObject({status: expect.stringMatching(/queued|running/u)});
        lifecycleSender.send.mockClear();
        publishProgress({
            stage: 'rendering',
            completedUnits: 1,
            totalUnits: 2,
            percent: 50,
        });
        expect(lifecycleSender.send).toHaveBeenCalledOnce();

        webContents.emit('did-start-navigation', {}, 'app://reload', false, true);

        expect(signal.aborted).toBe(false);
        expect(webContents.listenerCount('did-start-navigation')).toBe(0);
        lifecycleSender.send.mockClear();
        publishProgress({
            stage: 'rendering',
            completedUnits: 2,
            totalUnits: 3,
            percent: 2 / 3 * 100,
        });
        expect(lifecycleSender.send).not.toHaveBeenCalled();
        expect(service.subscribe(webContents, started.jobId, owner))
            .toMatchObject({status: expect.stringMatching(/queued|running/u)});
        expect(webContents.listenerCount('did-start-navigation')).toBe(1);
        lifecycleSender.send.mockClear();
        publishProgress({
            stage: 'rendering',
            completedUnits: 3,
            totalUnits: 4,
            percent: 75,
        });
        expect(lifecycleSender.send).toHaveBeenCalledOnce();
        expect(service.cancel(webContents, started.jobId, owner)).toBe(true);
        await vi.waitFor(() => expect(signal.aborted).toBe(true));
    });

    it('keeps one progress listener per sender and job across repeated reconnects', async () => {
        const entered = Promise.withResolvers<AbortSignal>();
        mocks.runWorker.mockImplementationOnce(async (_request, _paths, _policy, signal) => {
            entered.resolve(signal as AbortSignal);
            return new Promise((_, reject) => {
                (signal as AbortSignal).addEventListener(
                    'abort',
                    () => reject((signal as AbortSignal).reason),
                    {once: true},
                );
            });
        });
        const service = createScanCleanupService();
        const lifecycleSender = new LifecycleWebContents(42);
        const webContents: WebContents = lifecycleSender as never;
        const started = await service.start(webContents, startRequest);
        if (!started.started) throw new Error('Expected scan cleanup to start');
        await entered.promise;
        const publishProgress = mocks.runWorker.mock.calls[0]![4] as (progress: {
            stage: 'rendering';
            completedUnits: number;
            totalUnits: number;
            percent: number;
        }) => void;

        for (let reconnect = 0; reconnect < 4; reconnect += 1) {
            expect(service.subscribe(webContents, started.jobId, owner)).not.toBeNull();
        }
        lifecycleSender.send.mockClear();
        publishProgress({
            stage: 'rendering',
            completedUnits: 1,
            totalUnits: 2,
            percent: 50,
        });

        expect(lifecycleSender.send).toHaveBeenCalledOnce();
        expect(service.cancel(webContents, started.jobId, owner)).toBe(true);
        await vi.waitFor(() => expect(service.getState(webContents, started.jobId, owner))
            .toMatchObject({status: 'canceled'}));
    });

    it('removes the just-registered listener when its state is unavailable', () => {
        const listeners = new Set<() => void>();
        const jobs = {
            subscribe: (_jobId: string, _actor: unknown, listener: () => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            get: () => null,
        };
        const service = createScanCleanupService(jobs as never);

        expect(service.subscribe(sender(), 'missing-job', owner)).toBeNull();
        expect(listeners).toHaveLength(0);
    });

    it('deletes a published output when cancellation wins before worker completion is handled', async () => {
        const outputDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-cancel-race-'));
        outputDirs.push(outputDir);
        const outputPdfPath = join(outputDir, 'cleaned.pdf');
        mocks.createOutput.mockResolvedValueOnce(outputPdfPath);
        const entered = Promise.withResolvers<AbortSignal>();
        const returned = Promise.withResolvers<{
            inputPages: number;
            outputPages: number;
            spreadsSplit: number;
            offcutsDiscarded: number;
            deskewSkipped: number;
            cropSkipped: number;
            excludedPages: number;
            blankPagesSkipped: number;
            warnings: never[]
        }>();
        mocks.runWorker.mockImplementationOnce(async (_request, _paths, _policy, signal) => {
            entered.resolve(signal as AbortSignal);
            return returned.promise;
        });
        const service = createScanCleanupService();
        const webContents = sender();
        const started = await service.start(webContents, startRequest);
        if (!started.started) throw new Error('Expected scan cleanup to start');
        await entered.promise;

        expect(service.cancel(webContents, started.jobId, owner)).toBe(true);
        await writeFile(outputPdfPath, '%PDF-1.7\n%%EOF\n');
        returned.resolve({
            inputPages: 1,
            outputPages: 1,
            spreadsSplit: 0,
            offcutsDiscarded: 0,
            deskewSkipped: 0,
            cropSkipped: 0,
            excludedPages: 0,
            blankPagesSkipped: 0,
            warnings: [],
        });

        await vi.waitFor(() => expect(service.getState(webContents, started.jobId, owner))
            .toMatchObject({status: 'canceled'}));
        await expect(access(outputPdfPath)).rejects.toThrow();
    });

    it('treats cancellation after completion as idempotent', async () => {
        const returned = Promise.withResolvers<{
            inputPages: number;
            outputPages: number;
            spreadsSplit: number;
            offcutsDiscarded: number;
            deskewSkipped: number;
            cropSkipped: number;
            excludedPages: number;
            blankPagesSkipped: number;
            warnings: never[]
        }>();
        mocks.runWorker.mockImplementationOnce(async () => returned.promise);
        const service = createScanCleanupService();
        const webContents = sender();
        const started = await service.start(webContents, startRequest);
        if (!started.started) throw new Error('Expected scan cleanup to start');
        returned.resolve({
            inputPages: 1,
            outputPages: 1,
            spreadsSplit: 0,
            offcutsDiscarded: 0,
            deskewSkipped: 0,
            cropSkipped: 0,
            excludedPages: 0,
            blankPagesSkipped: 0,
            warnings: [],
        });

        await vi.waitFor(() => expect(service.getState(webContents, started.jobId, owner))
            .toMatchObject({status: 'completed'}));
        expect(service.cancel(webContents, started.jobId, owner)).toBe(true);
    });
});
