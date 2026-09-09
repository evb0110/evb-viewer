import type * as TViMockOriginalModule from '@electron/pdf/nativeToolPaths';
import type * as TViMockOriginalModule2 from '@electron/file-access/workingCopyStore';

import {
    existsSync,
    mkdirSync,
    realpathSync,
    writeFileSync,
} from 'node:fs';
import {
    mkdtemp,
    rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    dirname,
    join,
    resolve,
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
import {cleanupWorkingCopy} from '@electron/file-access/workingCopyCleanup';
import {clearWorkingCopyQuarantinesForTests} from '@electron/file-access/workingCopyQuarantine';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';
import {
    resetMainOperationLifecycleForTests,
    snapshotMainOperations,
} from '@electron/operation-lifecycle/mainOperationLifecycle';
import {getErrorMessage} from '@contracts/getErrorMessage';

interface IWorkingCopyEntry {
    backingState: 'eager';
    originalPath: string;
    ownerWebContentsId: number;
    registeredAtMs: number;
    registrationId: number;
    role: 'current';
}

const state = vi.hoisted(() => ({
    // Every main-process logger in the close path writes here, so a test can
    // ask what the renderer's runtime-report stream would have been handed.
    logs: [] as Array<{
        level: 'debug' | 'info' | 'warn' | 'error';
        source: string;
        message: string;
    }>,
    tempRoot: '',
    workingCopyMap: new Map<string, unknown>(),
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
        acquire: vi.fn(async (_request: {signal?: AbortSignal}) => ({release: vi.fn()})),
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
    return {
        ...actual,
        mainJobBroker: {
            acquire: mocks.acquire,
            getSnapshot: () => ({capacity: actual.resolveMainJobBrokerCapacity(mocks.hostProfile())}),
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
    isNativePageOpsDisabled: () => false,
    resolveNativePageOpsPath: () => '/page-ops',
}));
vi.mock('@electron/features/scan-cleanup/public/generatedOutputs', () => ({
    createScanCleanupGeneratedOutputPath: async () => join(mocks.outputRoot, 'run', 'cleaned.pdf'),
    pruneScanCleanupGeneratedOutputs: async () => 0,
}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({
    allowOpenPath: () => '/managed/cleaned.pdf',
    MAX_ALLOWED_OPEN_PATHS: 8,
    OPEN_PATH_CAPABILITY_TTL_MS: 60_000,
}));

vi.mock('@electron/file-access/workingCopyStore', async (importOriginal_2) => ({
    ...(await importOriginal_2<typeof TViMockOriginalModule2>()),
    clearRetiredWorkingCopyOriginals: vi.fn(),
    forgetRetiredWorkingCopyOriginal: vi.fn(),
    forgetWorkingCopyOriginalPath: (path: string) => state.workingCopyMap.delete(path),
    getWorkingCopyBackingEntry: (path: string) => state.workingCopyMap.get(path) ?? null,
    getWorkingCopyOwnerWebContentsId: (path: string) => (
        (state.workingCopyMap.get(path) as IWorkingCopyEntry | undefined)?.ownerWebContentsId
    ),
    isWorkingCopyOriginalPathRegistered: () => false,
    normalizePathForLookup: (path: string) => {
        const resolvedPath = resolve(path.trim());
        try {
            return realpathSync.native(resolvedPath);
        } catch {
            return resolvedPath;
        }
    },
    rememberRetiredWorkingCopyOriginal: vi.fn(),
    runWithWorkingCopyRegistrationFence: async (
        path: string,
        registrationId: number,
        operation: (entry: unknown) => unknown,
    ) => {
        const entry = state.workingCopyMap.get(path) as IWorkingCopyEntry | undefined;
        if (!entry || entry.registrationId !== registrationId) {
            return {matched: false as const};
        }
        return {
            matched: true as const,
            value: await operation(entry),
        };
    },
    workingCopyMap: state.workingCopyMap,
}));
vi.mock('@electron/file-access/workingCopyMaterialization', () => ({
    cancelWorkingCopyMaterialization: vi.fn(() => false),
    ensureWorkingCopyMaterialized: mocks.ensureMaterialized,
}));
vi.mock('@electron/file-access/workingCopyDirectory', () => ({
    isWorkingCopyDirectoryName: (name: string) => name.startsWith('pdf-work-'),
    safeRemoveDirectory: vi.fn(async () => false),
}));
vi.mock('@electron/utils/appTempDir', () => ({
    getAppTempDir: () => state.tempRoot,
    getLegacyAppTempDirPath: () => join(dirname(state.tempRoot), 'evb-viewer-legacy'),
}));
vi.mock('@electron/file-access/workingCopyMutationQueue', () => ({drainWorkingCopyMutations: vi.fn(async () => undefined)}));
vi.mock('@electron/file-access/documentRevisionStore', () => ({
    clearWorkingCopyRevisionInitializations: vi.fn(),
    forgetWorkingCopyRevisionInitialization: vi.fn(),
    hasWorkingCopySyncRequired: () => false,
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

function registerWorkingCopy(workingPath: string, originalPath: string, registrationId = 91) {
    state.workingCopyMap.set(workingPath, {
        backingState: 'eager',
        originalPath,
        ownerWebContentsId: OWNER_WEB_CONTENTS_ID,
        registeredAtMs: Date.now(),
        registrationId,
        role: 'current',
    } satisfies IWorkingCopyEntry);
}

async function createManagedWorkingCopy(name: string) {
    const originalPath = join(state.tempRoot, `${name}-original.pdf`);
    const workingPath = join(state.tempRoot, `pdf-work-${name}`, 'working.pdf');
    mkdirSync(dirname(workingPath), {recursive: true});
    writeFileSync(originalPath, 'original');
    writeFileSync(workingPath, 'managed');
    registerWorkingCopy(workingPath, originalPath);
    return {
        originalPath,
        workingPath,
    };
}

describe('closing a source document during scan cleanup', () => {
    beforeEach(async () => {
        state.tempRoot = await mkdtemp(join(tmpdir(), 'evb-scan-cleanup-close-'));
        mocks.outputRoot = state.tempRoot;
        state.workingCopyMap.clear();
        mocks.acquire.mockClear();
        mocks.acquire.mockImplementation(async () => ({release: vi.fn()}));
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
        await rm(state.tempRoot, {
            force: true,
            recursive: true,
        });
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
            mocks.acquire.mockImplementation(async (request: {signal?: AbortSignal}) => {
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

    it('deletes nothing when the same path is re-registered while the run is stopping', async () => {
        const {workingPath} = await createManagedWorkingCopy('reopened');
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
                    // The user reopened the document on this path while the
                    // close was still waiting for the old run to stop. The bytes
                    // now belong to a registration nobody asked to close.
                    registerWorkingCopy(workingPath, join(state.tempRoot, 'reopened-original.pdf'), 92);
                    setTimeout(() => reject(toAbortError(signal)), 5);
                }, {once: true});
            });
        });

        const service = createScanCleanupService();
        const webContents = sender();
        const started = await service.start(webContents, startRequest(workingPath));
        if (!started.started) throw new Error('Expected scan cleanup to start');
        await observed.promise;

        await cleanupWorkingCopy(workingPath, OWNER_WEB_CONTENTS_ID);

        expect((state.workingCopyMap.get(workingPath) as IWorkingCopyEntry).registrationId).toBe(92);
        expect(existsSync(workingPath)).toBe(true);
        expect(existsSync(dirname(workingPath))).toBe(true);
        expect(service.getState(webContents, started.jobId, owner)).toMatchObject({status: 'canceled'});
    });

    it('retains the source bytes when the run could not prove its native tree died', async () => {
        const {workingPath} = await createManagedWorkingCopy('unproven');
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
                    // The worker asked its Poppler tree to die and never got an
                    // answer. A surviving child would still be reading the
                    // source, so the run reports the stop as unproven.
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
        expect(state.workingCopyMap.has(workingPath)).toBe(false);
        expect(existsSync(workingPath)).toBe(true);
        expect(service.getState(webContents, started.jobId, owner)).toMatchObject({status: 'canceled'});
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
            // `clearForTests` cancels and awaits every record it holds, so
            // releasing the parked run first is all it needs to drain.
            release.resolve({ok: true});
            await jobs.clearForTests();
        }
    });
});
