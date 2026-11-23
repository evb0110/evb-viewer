import type * as TViMockOriginalModule from '@electron/pdf/nativeToolPaths';
import type * as TInputLimits from '@contracts/scan-cleanup/inputLimits';

import {
    existsSync,
    writeFileSync,
} from 'node:fs';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    dirname,
    join,
} from 'node:path';
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
import type * as TJobBrokerModule from '@electron/resources/jobBroker';
import type * as TPageOpsModule from '@electron/features/page-ops/public';
import {createScanCleanupService} from '@electron/features/scan-cleanup/createScanCleanupService';
import {createMainJobRegistry} from '@electron/operation-lifecycle/createMainJobRegistry';
import {
    cleanupWorkingCopy,
    openDocumentFromFile,
    openDocuments,
    setDocumentStoreRootForTests,
} from '@electron/file-access/documentStore';
import {clearWorkingCopyQuarantinesForTests} from '@electron/file-access/workingCopyQuarantine';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';
import {
    drainCriticalMainOperations,
    resetMainOperationLifecycleForTests,
    snapshotMainOperations,
} from '@electron/operation-lifecycle/mainOperationLifecycle';
import {getErrorMessage} from '@contracts/getErrorMessage';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {TScanCleanupDetectionJobState} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {createScanCleanupDetectionSignature} from '@contracts/scan-cleanup/createScanCleanupDetectionSignature';
import {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scan-cleanup/scanCleanupPlatformFeature';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';
import {scanCleanupPreviewLifecycle} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';
import {claimScanCleanupDetectionResultStore} from '@electron/features/scan-cleanup/detectionResultStoreRegistry';
import {createArrayBackedPdfPageSizeStore} from '@evb/scan-cleanup/core/pdfPageSizes';
import {
    createScanCleanupPreviewDependencies,
    DOCUMENT_PAGE_SIZES,
    lifecycleSender,
} from '@tests/unit/electron/scanCleanupPreviewHarness';
import {writeScanCleanupDetectionMetadata} from '@tests/unit/electron/writeScanCleanupDetectionMetadata';
import {cast} from '@tests/helpers/cast';

// The close test needs a completed store above the streaming boundary. Three
// pages exercise that handoff and its real file-backed store without 1,025
// pages of unrelated detection I/O, as in scanCleanupDetectionLifecycle.test.
vi.mock('@contracts/scan-cleanup/inputLimits', async importOriginal => ({
    ...await importOriginal<typeof TInputLimits>(),
    SCAN_CLEANUP_STREAMING_BATCH_PAGES: 2,
}));


const state = vi.hoisted(() => ({
    // Every main-process logger in the close path writes here, so a test can
    // ask what the renderer's runtime-report stream would have been handed.
    logs: [] as Array<{
        level: 'debug' | 'info' | 'warn' | 'error';
        source: string;
        message: string;
    }>,
    tempRoot: '',
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: (source: string) => {
    const record = (level: 'debug' | 'info' | 'warn' | 'error') => (message: string) => {
        state.logs.push({
            level,
            source,
            message,
        });
    };
    return {
        debug: record('debug'),
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
    };
}}));

const mocks = vi.hoisted(() => {
    const host: IHostResourceProfileSnapshot = {
        logicalCpus: 11,
        totalRamBytes: 32 * 1024 ** 3,
        safeMode: false,
        detectedTier: 'high',
        performanceMode: 'auto',
        tier: 'high',
    };
    return {
        // Every grant from the main broker passes through here; a test may
        // park a request instead of admitting it.
        acquire: vi.fn((
            request: TJobBrokerModule.IJobBrokerRequest,
            admit: (request: TJobBrokerModule.IJobBrokerRequest) => Promise<TJobBrokerModule.IJobBrokerLease>,
        ) => admit(request)),
        broker: null as TJobBrokerModule.JobBroker | null,
        createBroker: null as (() => TJobBrokerModule.JobBroker) | null,
        ensureMaterialized: vi.fn(),
        host,
        hostProfile: () => host,
        outputRoot: '',
        runWorker: vi.fn(),
    };
});

vi.mock('@electron/features/scan-cleanup/runScanCleanupWorkerTask', () => (
    {runScanCleanupWorkerTask: mocks.runWorker}
));
vi.mock('@electron/resources/jobBroker', async importOriginal => {
    const actual = await importOriginal<typeof TJobBrokerModule>();
    class TestJobBroker extends actual.JobBroker {
        override acquire(request: TJobBrokerModule.IJobBrokerRequest) {
            return mocks.acquire(request, admitted => super.acquire(admitted));
        }
    }
    mocks.createBroker = () => new TestJobBroker(actual.resolveMainJobBrokerCapacity(mocks.hostProfile()));
    const broker = () => (mocks.broker ??= mocks.createBroker!());
    return {
        ...actual,
        // A real broker per test, so the charge a run keeps is observable.
        mainJobBroker: {
            acquire: (request: TJobBrokerModule.IJobBrokerRequest) => broker().acquire(request),
            run: (...args: Parameters<TJobBrokerModule.JobBroker['run']>) => broker().run(...args),
            getSnapshot: () => broker().getSnapshot(),
        },
    };
});
vi.mock('@electron/resources/hostResourceProfile', () => ({getHostResourceProfileSnapshot: mocks.hostProfile}));
vi.mock('@electron/pdf/nativeToolPaths', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule>()),
    getPdfNativeToolPaths: () => ({
        qpdf: '/qpdf',
        pdftoppm: '/pdftoppm',
        pdfinfo: '/pdfinfo',
    }),
}));
vi.mock('@electron/native-tools/resolveNativeToolPath', () => ({resolveNativeToolPath: () => '/scan-cleanup'}));
vi.mock('@electron/image/tryCreatePdfWithNativeImageCombiner', () => (
    {resolveNativePdfImageCombinePath: () => '/pdf-image-combine'}
));
vi.mock('@electron/features/page-ops/public', async importOriginal => ({
    ...await importOriginal<typeof TPageOpsModule>(),
    resolveNativePageOpsPath: () => '/page-ops',
}));
vi.mock('@electron/features/scan-cleanup/public/generatedOutputs', () => ({
    createScanCleanupGeneratedOutputPath: async () => join(mocks.outputRoot, 'run', 'cleaned.pdf'),
    pruneScanCleanupGeneratedOutputs: async () => 0,
    recordScanCleanupCompletedOutput: async () => undefined,
}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({
    allowOpenPath: () => '/managed/cleaned.pdf',
    MAX_ALLOWED_OPEN_PATHS: 8,
    OPEN_PATH_CAPABILITY_TTL_MS: 60_000,
}));

vi.mock('@electron/file-access/documentStore', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(),
    ensureWorkingCopyMaterialized: mocks.ensureMaterialized,
}));
vi.mock('@electron/utils/appTempDir', () => ({
    getAppTempDir: () => state.tempRoot,
    getLegacyAppTempDirPath: () => join(dirname(state.tempRoot), 'evb-viewer-legacy'),
    getManagedAppTempRoots: () => [
        state.tempRoot,
        join(dirname(state.tempRoot), 'evb-viewer-retired'),
    ],
}));
vi.mock('@electron/file-access/pageIdentityStore', () => ({
    clearPageIdentityStoreInitializations: vi.fn(),
    forgetPageIdentityStoreInitialization: vi.fn(),
}));

// The renderer promotes exactly the error-level main-process logs to runtime
// application-error reports, so this is the whole set a close is allowed to
// produce: none.
function errorLogs() {
    return state.logs.filter(entry => entry.level === 'error');
}

function toAbortError(signal: AbortSignal) {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error(String(signal.reason));
}

const OWNER_WEB_CONTENTS_ID = 42;
const owner = {
    ownerId: 'cleanup-owner',
    documentRevision: 'revision-1',
};

function sender(): WebContents {
    return {
        id: OWNER_WEB_CONTENTS_ID,
        isDestroyed: () => false,
        send: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
    } as never;
}

function startRequest(sourcePdfPath: string) {
    return {
        ...owner,
        sourcePdfPath,
        options: {
            preserveOriginalQuality: false,
            layoutMode: 'auto' as const,
            outputMode: 'color' as const,
            readingOrder: 'ltr' as const,
            thickness: 0,
            crop: true,
            matchPageSize: false,
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
}

async function createManagedWorkingCopy(name: string) {
    const originalPath = join(state.tempRoot, `${name}-original.pdf`);
    writeFileSync(originalPath, 'original');
    const {ref: workingPath} = await openDocumentFromFile(originalPath, {ownerWebContentsId: OWNER_WEB_CONTENTS_ID});
    return {
        originalPath,
        workingPath,
    };
}

describe('closing a source document during scan cleanup', () => {
    beforeEach(async () => {
        state.tempRoot = await mkdtemp(join(tmpdir(), 'evb-scan-cleanup-close-'));
        mocks.outputRoot = state.tempRoot;
        await setDocumentStoreRootForTests(join(state.tempRoot, 'store'));
        mocks.broker = mocks.createBroker?.() ?? null;
        mocks.acquire.mockClear();
        mocks.acquire.mockImplementation((request, admit) => admit(request));
        mocks.ensureMaterialized.mockReset();
        mocks.ensureMaterialized.mockImplementation(async (sourcePdfPath: string) => (
            {physicalWorkingCopyPath: sourcePdfPath}
        ));
        mocks.runWorker.mockReset();
        state.logs.length = 0;
    });

    afterEach(async () => {
        resetMainOperationLifecycleForTests();
        clearWorkingCopyQuarantinesForTests();
        await setDocumentStoreRootForTests(null);
        await rm(state.tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('replays a terminal run that finished before the first subscription and on reconnect', async () => {
        const {workingPath} = await createManagedWorkingCopy('late-subscription');
        mocks.runWorker.mockRejectedValue(new Error('Fixture worker could not read the scan'));
        const service = createScanCleanupService();
        const contents = lifecycleSender(OWNER_WEB_CONTENTS_ID);
        const subscriber = cast<WebContents>(contents);
        const started = await service.start(subscriber, startRequest(workingPath));
        expect(started.started).toBe(true);
        try {
            await expect(drainCriticalMainOperations({timeoutMs: 2_000})).resolves.toMatchObject({completed: true});
            const terminal = expect.objectContaining({
                jobId: started.jobId,
                status: 'failed',
                error: 'Fixture worker could not read the scan',
            });
            const subscribe = () => service.subscribe(subscriber, started.jobId, owner);
            expect(subscribe()).toEqual(terminal);
            expect(contents.send).toHaveBeenCalledWith(SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onJobState, terminal);

            // Navigation detaches the old subscription and a new page in the
            // same WebContents can reconnect via the same service method.
            contents.emit('did-start-navigation', {}, 'about:blank', false, true);
            contents.send.mockClear();
            expect(subscribe()).toEqual(terminal);
            expect(contents.send).toHaveBeenCalledWith(SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onJobState, terminal);
        } finally {
            await cleanupWorkingCopy(workingPath, OWNER_WEB_CONTENTS_ID);
        }
    });

    it('publishes a disconnected outcome on the run channel when the live owner detaches', async () => {
        const {workingPath} = await createManagedWorkingCopy('detached-subscription');
        const worker = Promise.withResolvers<never>();
        const entered = Promise.withResolvers<void>();
        mocks.runWorker.mockImplementation(() => {
            entered.resolve();
            return worker.promise;
        });
        const service = createScanCleanupService();
        const contents = lifecycleSender(OWNER_WEB_CONTENTS_ID);
        const subscriber = cast<WebContents>(contents);
        const started = await service.start(subscriber, startRequest(workingPath));
        expect(started.started).toBe(true);
        await entered.promise;
        try {
            expect(service.subscribe(subscriber, started.jobId, owner))
                .toMatchObject({jobId: started.jobId, status: 'queued'});
            contents.emit('did-start-navigation', {}, 'about:blank', false, true);

            expect(contents.send).toHaveBeenCalledWith(
                SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onJobState,
                expect.objectContaining({
                    jobId: started.jobId,
                    status: 'disconnected',
                }),
            );
        } finally {
            worker.reject(new Error('Fixture worker stopped'));
            await cleanupWorkingCopy(workingPath, OWNER_WEB_CONTENTS_ID);
        }
    });

    it('starts a replacement run after cancellation is accepted while the old worker is retiring', async () => {
        const {workingPath} = await createManagedWorkingCopy('restart');
        const entered = Promise.withResolvers<AbortSignal>();
        const release = Promise.withResolvers<never>();
        mocks.runWorker.mockImplementation(async (
            _request: unknown,
            _paths: unknown,
            _policy: unknown,
            signal: AbortSignal,
        ) => {
            entered.resolve(signal);
            return release.promise;
        });
        const service = createScanCleanupService();
        const webContents = sender();
        try {
            const first = await service.start(webContents, startRequest(workingPath));
            if (!first.started) throw new Error('Expected the original cleanup to start');
            const signal = await entered.promise;
            expect(service.cancel(webContents, first.jobId, owner)).toBe(true);
            expect(signal.aborted).toBe(true);
            expect(service.getState(webContents, first.jobId, owner)).toMatchObject({status: 'canceling'});

            const replacement = await service.start(webContents, startRequest(workingPath));

            expect(replacement.started).toBe(true);
            expect(replacement.jobId, 'an accepted restart must not inherit the canceled job').not.toBe(first.jobId);
            expect(service.getState(webContents, replacement.jobId, owner)?.status).toMatch(/^(?:queued|running)$/u);
        } finally {
            release.reject(new DOMException('Test worker retirement', 'AbortError'));
            await cleanupWorkingCopy(workingPath, OWNER_WEB_CONTENTS_ID);
        }
    });

    it('retires completed detection evidence on document close while preserving an active borrower', async () => {
        const {workingPath} = await createManagedWorkingCopy('completed-detection');
        const deps = createScanCleanupPreviewDependencies(state.tempRoot);
        const totalPages = SCAN_CLEANUP_STREAMING_BATCH_PAGES + 1;
        deps.getPageCount = vi.fn(async () => totalPages);
        deps.getPageSizeStore = vi.fn(async () => createArrayBackedPdfPageSizeStore(DOCUMENT_PAGE_SIZES, totalPages));
        deps.runSidecar = async (_binary, manifestPath, _signal, _log, onProgress) => {
            await writeScanCleanupDetectionMetadata(manifestPath);
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{sourcePageIndex: number}>};
            for (const [index] of manifest.pages.entries()) {
                await onProgress({
                    stage: 'page-complete',
                    completedPages: index + 1,
                    totalPages: manifest.pages.length,
                    pageNumber: requirePageNumber(index + 1),
                    classification: 'single-uncut-page',
                    confidence: 0.9,
                });
            }
        };
        const service = scanCleanupPreviewLifecycle(deps);
        const webContents = lifecycleSender(OWNER_WEB_CONTENTS_ID);
        const completed = Promise.withResolvers<TScanCleanupDetectionJobState>();
        webContents.send.mockImplementation((channel: string, frame: TScanCleanupDetectionJobState) => {
            if (channel !== SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onDetectionJobState) return;
            if (frame.status === 'completed') completed.resolve(frame);
            if (frame.status === 'failed') completed.reject(new Error(frame.error));
            if (frame.status === 'canceled') completed.reject(new Error(frame.status));
        });
        const detection = {
            ...startRequest(workingPath),
            ownerId: 'completed-document-owner',
        };
        let borrower: ReturnType<typeof claimScanCleanupDetectionResultStore> = null;
        try {
            const started = await service.detectAll(webContents, detection);
            const terminal = await completed.promise;
            const storeId = terminal.detectionResultStoreId;
            expect(storeId).toBeTypeOf('string');
            const storeOwner = {
                detectionSignature: createScanCleanupDetectionSignature(detection.options),
                documentRevision: detection.documentRevision,
                ownerId: detection.ownerId,
                sourcePdfPath: workingPath,
            };
            borrower = claimScanCleanupDetectionResultStore(storeId!, storeOwner);
            expect(borrower).not.toBeNull();
            const firstPage = await borrower!.resultStore.getPage(1);
            expect(firstPage?.pageNumber).toBe(1);

            // A repeated cancel is not a document-close signal. The real
            // working-copy close below must retire the document owner even
            // after its detection job has handed off the completed store.
            expect(service.cancelDetection(webContents, started.jobId, detection)).toBe(false);
            await cleanupWorkingCopy(workingPath, OWNER_WEB_CONTENTS_ID);

            expect(existsSync(dirname(workingPath))).toBe(false);
            const staleClaim = claimScanCleanupDetectionResultStore(storeId!, storeOwner);
            try {
                expect.soft(staleClaim, 'a closed document must not admit new detection-store borrowers').toBeNull();
            } finally {
                await staleClaim?.release();
            }
            await expect(borrower!.resultStore.getPage(1)).resolves.toEqual(firstPage);
            await borrower!.release();
            await expect(Promise.resolve().then(() => borrower!.resultStore.readRange(1, 2)), 'the last borrower must release the retired evidence files').rejects.toThrow(/closed/iu);
        } finally {
            await borrower?.release();
            await service.dispose();
        }
    });

    it.each([
        'queued',
        'materializing',
        'probing',
        'rendering',
    ] as const)('cancels a %s run and waits for it before deleting the working copy', async (stage) => {
        const {
            originalPath,
            workingPath,
        } = await createManagedWorkingCopy(stage);
        const workDir = dirname(workingPath);
        const observed = Promise.withResolvers<AbortSignal>();
        // Every dependency the run can be parked on has to release only after
        // the close asks it to, and the directory it reads has to still be there
        // at that moment.
        const sourceExistedWhileStopping = Promise.withResolvers<boolean>();
        const parkUntilAborted = (signal: AbortSignal) => new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => {
                // Stopping is asynchronous: a real run is unwinding a
                // cooperative worker cancel and its native children here, and
                // only lets go of the working copy when it finally rejects.
                setTimeout(() => {
                    sourceExistedWhileStopping.resolve(existsSync(workDir));
                    reject(toAbortError(signal));
                }, 25);
            }, {once: true});
        });

        if (stage === 'queued') {
            mocks.acquire.mockImplementation(async (request) => {
                observed.resolve(request.signal!);
                return parkUntilAborted(request.signal!);
            });
        } else if (stage === 'materializing') {
            mocks.ensureMaterialized.mockImplementation(async (
                _path: string,
                options: {signal?: AbortSignal},
            ) => {
                observed.resolve(options.signal!);
                return parkUntilAborted(options.signal!);
            });
        } else {
            mocks.runWorker.mockImplementation(async (
                _request: unknown,
                _paths: unknown,
                _policy: unknown,
                signal: AbortSignal,
                onProgress: (progress: unknown) => void,
            ) => {
                onProgress({
                    stage,
                    completedUnits: 0,
                    totalUnits: 4,
                    percent: 0,
                    completedPageNumbers: [],
                });
                observed.resolve(signal);
                return parkUntilAborted(signal);
            });
        }

        const service = createScanCleanupService();
        const webContents = sender();
        const started = await service.start(webContents, startRequest(workingPath));
        if (!started.started) throw new Error('Expected scan cleanup to start');
        const signal = await observed.promise;
        expect(signal.aborted).toBe(false);
        expect(snapshotMainOperations()).toEqual([expect.objectContaining({
            kind: 'critical-write',
            workingCopyPath: workingPath,
            commitStarted: false,
        })]);

        await cleanupWorkingCopy(workingPath, OWNER_WEB_CONTENTS_ID);

        expect(signal.aborted).toBe(true);
        await expect(sourceExistedWhileStopping.promise).resolves.toBe(true);
        expect(snapshotMainOperations()).toEqual([]);
        expect(existsSync(workDir)).toBe(false);
        expect(existsSync(originalPath)).toBe(true);
        expect(service.getState(webContents, started.jobId, owner)).toMatchObject({status: 'canceled'});
        // Closing a tab is the user's decision, not a fault. Any error-level
        // line here becomes an application-error report in the renderer.
        expect(errorLogs()).toEqual([]);
    });

    it('ends as canceled when the stopping run reports a source-read failure', async () => {
        const {workingPath} = await createManagedWorkingCopy('enoent');
        const observed = Promise.withResolvers<AbortSignal>();
        mocks.runWorker.mockImplementation(async (
            _request: unknown,
            _paths: unknown,
            _policy: unknown,
            signal: AbortSignal,
        ) => {
            observed.resolve(signal);
            return new Promise<never>((_, reject) => {
                signal.addEventListener('abort', () => {
                    // Poppler was mid-page when the cancel arrived, so what the
                    // run actually reports is a read failure rather than an
                    // abort. The user closed a tab: that is a cancellation.
                    const failure = Object.assign(
                        new Error('pdftoppm: No such file or directory'),
                        {code: 'ENOENT'},
                    );
                    setTimeout(() => reject(failure), 5);
                }, {once: true});
            });
        });

        const service = createScanCleanupService();
        const webContents = sender();
        const started = await service.start(webContents, startRequest(workingPath));
        if (!started.started) throw new Error('Expected scan cleanup to start');
        await observed.promise;

        await cleanupWorkingCopy(workingPath, OWNER_WEB_CONTENTS_ID);

        const terminalState = service.getState(webContents, started.jobId, owner);
        expect(terminalState).toMatchObject({status: 'canceled'});
        expect(terminalState).not.toHaveProperty('error');
        expect(terminalState).not.toHaveProperty('errorCode');
        // This is the incident shape: Poppler reports a read failure while the
        // run is stopping. It is still the cancellation the user asked for.
        expect(errorLogs()).toEqual([]);
    });

    it('keeps a genuine run failure visible and closes without adding to it', async () => {
        const {workingPath} = await createManagedWorkingCopy('genuine-failure');
        // Nothing cancelled this run. Classifying it as a cancellation would
        // hide a failure the user has to act on, and the close that follows
        // must not turn one fault into a second diagnostic either.
        mocks.runWorker.mockImplementation(async () => {
            throw new Error('evb-scan-cleanup exited with code 3');
        });

        const service = createScanCleanupService();
        const webContents = sender();
        const started = await service.start(webContents, startRequest(workingPath));
        if (!started.started) throw new Error('Expected scan cleanup to start');
        await vi.waitFor(() => {
            expect(service.getState(webContents, started.jobId, owner)).toMatchObject({
                status: 'failed',
                error: expect.stringContaining('exited with code 3'),
            });
        });
        const beforeClose = errorLogs();

        await cleanupWorkingCopy(workingPath, OWNER_WEB_CONTENTS_ID);

        // Reporting the underlying failure belongs to the worker-task layer,
        // which is stubbed here; what this asserts is that neither the service's
        // failure handling nor the close adds a diagnostic of its own. Comparing
        // the entries rather than their count also catches a close that swapped
        // one error line for another.
        expect(errorLogs()).toEqual(beforeClose);
        expect(existsSync(dirname(workingPath))).toBe(false);
    });

    it('leaves unrelated working copies and their runs alone', async () => {
        const closing = await createManagedWorkingCopy('closing');
        const other = await createManagedWorkingCopy('other');
        const observed = Promise.withResolvers<AbortSignal>();
        mocks.runWorker.mockImplementation(async (
            _request: unknown,
            _paths: unknown,
            _policy: unknown,
            signal: AbortSignal,
        ) => {
            observed.resolve(signal);
            return new Promise<never>((_, reject) => {
                signal.addEventListener('abort', () => reject(toAbortError(signal)), {once: true});
            });
        });

        const service = createScanCleanupService();
        const webContents = sender();
        const started = await service.start(webContents, startRequest(other.workingPath));
        if (!started.started) throw new Error('Expected scan cleanup to start');
        const signal = await observed.promise;

        await cleanupWorkingCopy(closing.workingPath, OWNER_WEB_CONTENTS_ID);

        expect(signal.aborted).toBe(false);
        expect(existsSync(dirname(closing.workingPath))).toBe(false);
        expect(existsSync(dirname(other.workingPath))).toBe(true);
        expect(service.getState(webContents, started.jobId, owner))
            .toMatchObject({status: expect.stringMatching(/queued|running/u)});

        service.cancel(webContents, started.jobId, owner);
        await vi.waitFor(() => {
            expect(snapshotMainOperations()).toEqual([]);
        });
    });

    it('retains the source bytes and the broker charge when the run could not prove its native tree died', async () => {
        const {workingPath} = await createManagedWorkingCopy('unproven');
        const observed = Promise.withResolvers<AbortSignal>();
        mocks.runWorker.mockImplementation(async (
            _request: unknown,
            _paths: unknown,
            _policy: unknown,
            signal: AbortSignal,
            _onProgress: unknown,
            _jobId: unknown,
            options?: {onTerminationProof?: (proof: Promise<boolean>) => void},
        ) => {
            observed.resolve(signal);
            return new Promise<never>((_, reject) => {
                signal.addEventListener('abort', () => {
                    // The worker asked its Poppler tree to die and never got an
                    // answer. A surviving child would still be reading the
                    // source, so the run reports the stop as unproven, to the
                    // lease its children run under as the worker task does.
                    options?.onTerminationProof?.(Promise.resolve(false));
                    setTimeout(() => reject(markUnprovenNativeTermination(
                        toAbortError(signal),
                        'evb-scan-cleanup process tree (pid=4242) was not proven dead within 8000ms of termination',
                    )), 5);
                }, {once: true});
            });
        });

        const service = createScanCleanupService();
        const webContents = sender();
        const started = await service.start(webContents, startRequest(workingPath));
        if (!started.started) throw new Error('Expected scan cleanup to start');
        await observed.promise;

        await cleanupWorkingCopy(workingPath, OWNER_WEB_CONTENTS_ID);

        // The registration is gone: the document is closed either way. Only the
        // bytes stay, for the stale sweep to reclaim once no process can hold
        // them.
        expect(openDocuments.has(workingPath)).toBe(false);
        expect(existsSync(dirname(workingPath))).toBe(true);
        expect(service.getState(webContents, started.jobId, owner)).toMatchObject({status: 'canceled'});
        // Sol's probe: the worker's native children may still run, so the
        // only charge they have stays on the broker.
        const charge = mocks.broker!.getSnapshot();
        expect(charge.active).toBe(1);
        expect(charge.used.nativeProcesses).toBeGreaterThan(0);
    });

    it('keeps a scan-cleanup critical write that has crossed its commit boundary', async () => {
        const {workingPath} = await createManagedWorkingCopy('committed');
        const jobs = createMainJobRegistry<{step: string}, {ok: true}, {
            code: string;
            message: string;
        }>({
            retention: {
                eventReplayTtlMs: 1_000,
                terminalRecordTtlMs: 1_000,
            },
            toError: (cause, kind) => ({
                code: kind,
                message: getErrorMessage(cause),
            }),
            terminalProgress: {
                completed: latest => latest,
                canceled: latest => latest,
                failed: latest => latest,
            },
        });
        const committing = Promise.withResolvers<'committing'>();
        const release = Promise.withResolvers<{ok: true}>();
        const handle = jobs.start({
            owner: {sender: sender()},
            operation: {
                kind: 'critical-write',
                workingCopyPath: workingPath,
                cancelOnWorkingCopyClose: true,
            },
            initialProgress: {step: 'start'},
            run: async job => {
                job.markCommitStarted();
                committing.resolve('committing');
                return release.promise;
            },
        });
        await committing.promise;

        // This test owns a job registry and a job parked on `release`, and both
        // outlive a failed assertion: an unresolved run would keep a registered
        // operation and its retention timers alive for whatever runs next in
        // this file. The teardown is unconditional for that reason, and
        // resolving an already-resolved deferred is a no-op, so the normal path
        // below still reads as the assertions it is.
        try {
            // The real close path, not the predicate in isolation: a write past
            // its commit boundary is publishing rather than reading, so the
            // close leaves it alone and it finishes normally.
            await cleanupWorkingCopy(workingPath, OWNER_WEB_CONTENTS_ID);

            expect(handle.signal.aborted).toBe(false);
            expect(snapshotMainOperations()).toEqual([expect.objectContaining({
                kind: 'critical-write',
                commitStarted: true,
                aborted: false,
            })]);

            release.resolve({ok: true});
            await expect(handle.terminal).resolves.toMatchObject({status: 'completed'});
            await handle.settled;
        } finally {
            // `dispose` cancels and awaits every record it holds, so
            // releasing the parked run first is all it needs to drain.
            release.resolve({ok: true});
            await jobs.dispose();
        }
    });

    it('preserves a resumable checkpoint when cancellation wins between worker publish and main commit, and reclaims it on commit', async () => {
        const {workingPath} = await createManagedWorkingCopy('checkpoint-commit-race');
        const service = createScanCleanupService();
        const webContents = sender();

        // 1. Cancel wins after worker publishes & reports checkpoint-ready,
        // right before main reaches job.markCommitStarted().
        const checkpointDir = join(state.tempRoot, 'scan-cleanup-checkpoints');
        const canceledEntryDir = join(checkpointDir, `entry-${'a'.repeat(64)}`);
        const workerReady = Promise.withResolvers<void>();
        const releaseWorker = Promise.withResolvers<void>();
        mocks.runWorker.mockImplementation(async (
            _request: unknown,
            paths: {
                checkpointDir?: string;
                deferCheckpointCleanup?: boolean;
            },
            _policy: unknown,
            _signal: AbortSignal,
            _onProgress: unknown,
            _jobId: string,
            options?: {onCheckpointReady?: (entryDir: string) => void},
        ) => {
            expect(paths.checkpointDir).toBe(checkpointDir);
            expect(paths.deferCheckpointCleanup).toBe(true);
            await mkdir(canceledEntryDir, {recursive: true});
            await writeFile(join(canceledEntryDir, 'checkpoint.json'), '{}');
            options?.onCheckpointReady?.(canceledEntryDir);
            workerReady.resolve();
            await releaseWorker.promise;
            return {
                inputPages: 1,
                outputPages: 1,
                spreadsSplit: 0,
                offcutsDiscarded: 0,
                deskewSkipped: 0,
                cropSkipped: 0,
                excludedPages: 0,
                blankPagesSkipped: 0,
                accessibilityTagsRemoved: false,
                warnings: [],
            };
        });

        const startedCanceled = await service.start(webContents, startRequest(workingPath));
        if (!startedCanceled.started) throw new Error('Expected scan cleanup to start');
        try {
            await workerReady.promise;
            // Cancel arrives BEFORE the worker's result reaches main's markCommitStarted().
            expect(service.cancel(webContents, startedCanceled.jobId, owner)).toBe(true);
            releaseWorker.resolve();
            await vi.waitFor(() => {
                expect(service.getState(webContents, startedCanceled.jobId, owner)).toMatchObject({status: 'canceled'});
            });
        } finally {
            releaseWorker.resolve();
        }
        // Checkpoint entry MUST survive on disk because main never committed!
        expect(existsSync(join(canceledEntryDir, 'checkpoint.json'))).toBe(true);

        // 2. When no cancellation occurs, main crosses markCommitStarted() and
        // reclaims the completed checkpoint cleanly.
        mocks.runWorker.mockImplementation(async (
            _request: unknown,
            paths: {
                checkpointDir?: string;
                deferCheckpointCleanup?: boolean;
            },
            _policy: unknown,
            _signal: AbortSignal,
            _onProgress: unknown,
            _jobId: string,
            options?: {onCheckpointReady?: (entryDir: string) => void},
        ) => {
            expect(paths.deferCheckpointCleanup).toBe(true);
            options?.onCheckpointReady?.(canceledEntryDir);
            return {
                inputPages: 1,
                outputPages: 1,
                spreadsSplit: 0,
                offcutsDiscarded: 0,
                deskewSkipped: 0,
                cropSkipped: 0,
                excludedPages: 0,
                blankPagesSkipped: 0,
                accessibilityTagsRemoved: false,
                warnings: [],
            };
        });

        const startedCommitted = await service.start(webContents, startRequest(workingPath));
        if (!startedCommitted.started) throw new Error('Expected second scan cleanup to start');
        await vi.waitFor(() => {
            expect(service.getState(webContents, startedCommitted.jobId, owner)).toMatchObject({status: 'completed'});
        });
        expect(existsSync(canceledEntryDir)).toBe(false);
    });
});
