// @vitest-environment happy-dom

import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import {build} from 'esbuild';
import {FULL_SCAN_CLEANUP_SUPPORT} from '@contracts/scan-cleanup/scanCleanupPlatformFeature';
import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import {
    computed,
    createApp,
    nextTick,
    ref,
} from 'vue';
import type {TJobId} from '@contracts/shared';
import {requireJobId} from '@contracts/shared';
import {requirePageNumber} from '@contracts/pageNumbers';
import {requireEpochMs} from '@contracts/timestamps';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import type {
    IScanCleanupCapability,
    IScanCleanupOptions,
    TScanCleanupJobState,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import type {IFailureToastTarget} from '@app/composables/useFailureToast';
import type {TScanCleanupJobClosure} from '@contracts/scan-cleanup/ipc';
import type {TTranslateFn} from '@i18n-app';
import {
    toastDescription,
    toastDescriptionContaining,
} from '@tests/helpers/toastDescription';

const capability = vi.hoisted(() => ({value: null as IScanCleanupCapability | null}));
const diagnosticMocks = vi.hoisted(() => ({
    failure: {
        eventId: '0123456789abcdef0123456789abcdef',
        code: 'UNCLASSIFIED_RENDERER_ERROR',
        occurredAt: 1,
        severity: 'error',
    } as FailureReceipt,
    debug: vi.fn<(section: string, message: string, data?: unknown) => void>(),
    error: vi.fn(),
}));

vi.mock('@app/utils/browserLogger', () => ({
    BrowserLogger: {
        debug: diagnosticMocks.debug,
        error: diagnosticMocks.error,
    },
}));

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

type TCompletedState = Extract<TScanCleanupJobState, {status: 'completed'}>;

function completedState(
    jobId: string,
    outputPdfPath = `/managed/${jobId}.pdf`,
    summary: Partial<TCompletedState['summary']> = {},
): TCompletedState {
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
            ...summary,
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

function stubCapability<TState extends TScanCleanupJobState | TScanCleanupJobClosure = TScanCleanupJobState>(
    onListener: (listener: (state: TState) => void) => void,
    nextJobId: () => string,
): IScanCleanupCapability {
    return {
        getSupport: () => FULL_SCAN_CLEANUP_SUPPORT,
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
        // A started job answers its subscription with its queued snapshot;
        // null would mean the record is already retired.
        subscribeJob: vi.fn(async (jobId: TJobId) => ({
            ...runningJobState(jobId),
            status: 'queued' as const,
            updatedAtMs: requireEpochMs(0),
        })),
        reconnectJob: vi.fn(async () => null),
        pruneGeneratedOutputs: vi.fn(async () => 0),
        onPreviewRaw: vi.fn(() => () => undefined),
        onJobState: vi.fn((listener) => {
            onListener(listener);
            return () => undefined;
        }),
        onDetectionJobState: vi.fn(() => () => undefined),
        onSettingsChanged: vi.fn(() => () => undefined),
    };
}

function coordinatorDeps(
    overrides: Partial<Parameters<(typeof import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator'))['installScanCleanupRunCoordinator']>[0]> = {},
) {
    return {
        openGeneratedPdf: vi.fn(async () => true),
        createCompletedOutputSaveAs: vi.fn(() => async () => undefined),
        t: translate,
        locale: () => 'en',
        toast: {add: vi.fn()},
        ...overrides,
    };
}

function completedOutputJournal(initial: readonly TDocumentRef[]) {
    const pending = new Set(initial);
    const acknowledged: TDocumentRef[] = [];
    return {
        pending,
        acknowledged,
        getPendingCompletedOutputs: async () => [...pending],
        acknowledgeCompletedOutputs: async (paths: readonly TDocumentRef[]) => {
            acknowledged.push(...paths);
            for (const path of paths) pending.delete(path);
        },
    };
}

async function loadClientCoordinator() {
    // Nuxt defines import.meta.client in the renderer build. The unit project
    // leaves it undefined, bypassing the sessionStorage recovery path.
    const {outputFiles} = await build({
        entryPoints: ['app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator.ts'],
        tsconfig: 'tsconfig.base.json',
        bundle: true,
        write: false,
        platform: 'node',
        packages: 'external',
        external: [
            '@app/utils/getScanCleanupCapability',
            '@app/utils/browserLogger',
            '@app/utils/platform',
        ],
        define: {'import.meta.client': 'true'},
        banner: {js: 'const { computed, reactive, effectScope, toRaw, watch } = require("vue");'},
    });
    const nodeRequire = createRequire(import.meta.url);
    const dependencies = new Map<string, unknown>([
        ['@app/utils/getScanCleanupCapability', {getScanCleanupCapability: () => capability.value}],
        ['@app/utils/browserLogger', {BrowserLogger: {
            debug: diagnosticMocks.debug,
            error: diagnosticMocks.error,
        }}],
        ['@app/utils/platform', {isDesktopPlatformActive: () => false}],
    ]);
    const module = {exports: {}};
    const load = runInThisContext(`(function (module, require) { ${outputFiles[0]!.text}\n })`);
    load(module, (id: string) => dependencies.get(id) ?? nodeRequire(id));
    return module.exports as typeof import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
}

function stubSessionStorage(initial: [string, string][] = []) {
    const storage = new Map(initial);
    vi.stubGlobal('sessionStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => storage.set(key, value),
    });
    onTestFinished(() => { vi.unstubAllGlobals(); });
    return storage;
}

describe('scan cleanup run coordinator', () => {
    beforeEach(() => {
        vi.resetModules();
        diagnosticMocks.debug.mockClear();
        diagnosticMocks.error.mockReset();
        diagnosticMocks.error.mockReturnValue(diagnosticMocks.failure);
    });

    it('opens a run that finished before its start subscription without polling', async () => {
        const bridge = stubCapability(() => undefined, () => 'finished-before-subscribe');
        vi.mocked(bridge.getJobState).mockRejectedValue(new Error('Direct job-state read unavailable'));
        let retained: TScanCleanupJobState | null = null;
        vi.mocked(bridge.start).mockImplementation(async () => {
            retained = completedState('finished-before-subscribe');
            return startResult(retained.jobId);
        });
        // Browser conversion uses a window listener and returns retained state
        // from subscribeJob. The original terminal event never arrives here.
        vi.mocked(bridge.subscribeJob).mockImplementation(async jobId => retained?.jobId === jobId ? retained : null);
        capability.value = bridge;
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const opened: string[] = [];
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']});
        const dispose = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({
            openGeneratedPdf: async (path) => {
                opened.push(path);
                return true;
            },
        }));
        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/book.pdf',
                options: createScanCleanupOptions(),
            });
            await new Promise<void>(resolve => setImmediate(resolve));

            expect(coordinator.scanCleanupRun.jobState?.status).toBe('completed');
            expect(opened).toEqual(['/managed/finished-before-subscribe.pdf']);
            expect(coordinator.isScanCleanupRunning.value).toBe(false);
        } finally {
            dispose();
            vi.useRealTimers();
        }
    });

    it.each(['completed', 'retired'] as const)('settles a stored run whose record is already %s on reconnect without polling', async outcome => {
        const jobId = 'stored-before-reconnect';
        const bridge = stubCapability(() => undefined, () => 'unused-job');
        vi.mocked(bridge.getJobState).mockRejectedValue(new Error('Direct job-state read unavailable'));
        vi.mocked(bridge.reconnectJob).mockResolvedValue(outcome === 'completed' ? completedState(jobId) : null);
        capability.value = bridge;
        const coordinator = await loadClientCoordinator();
        const storage = new Map([
            ['evb.scanCleanup.activeJobId', jobId],
            ['evb.scanCleanup.activeOwnerId', ownerContext.ownerId],
            ['evb.scanCleanup.activeDocumentRevision', ownerContext.documentRevision],
        ]);
        vi.stubGlobal('sessionStorage', {
            getItem: (key: string) => storage.get(key) ?? null,
            removeItem: (key: string) => storage.delete(key),
        });
        const opened: string[] = [];
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']});
        const dispose = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({
            openGeneratedPdf: async (path) => {
                opened.push(path);
                return true;
            },
        }));
        try {
            expect(coordinator.scanCleanupRun.activeJobId).toBe(jobId);
            await new Promise<void>(resolve => setImmediate(resolve));

            if (outcome === 'completed') {
                expect(coordinator.scanCleanupRun.jobState?.status).toBe('completed');
                expect(opened).toEqual(['/managed/stored-before-reconnect.pdf']);
            } else {
                expect({
                    running: coordinator.isScanCleanupRunning.value,
                    error: coordinator.getScanCleanupRunError(ownerContext.ownerId),
                }).toEqual({
                    running: false,
                    error: 'scanCleanup.errors.runRecoveryFailed',
                });
            }
            expect(coordinator.isScanCleanupRunning.value).toBe(false);
            expect(storage.has('evb.scanCleanup.activeJobId')).toBe(false);
        } finally {
            dispose();
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });

    it.each(['retired', 'disconnected'] as const)('releases the active run when its channel reports %s', async status => {
        const jobId = requireJobId(`run-${status}`);
        let emit: (state: TScanCleanupJobClosure) => void = () => undefined;
        capability.value = stubCapability<TScanCleanupJobClosure>(listener => { emit = listener; }, () => jobId);
        const coordinator = await loadClientCoordinator();
        const storage = new Map<string, string>();
        vi.stubGlobal('sessionStorage', {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        });
        const dispose = coordinator.installScanCleanupRunCoordinator(coordinatorDeps());
        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/book.pdf',
                options: createScanCleanupOptions(),
            });
            expect(coordinator.isScanCleanupRunning.value).toBe(true);
            expect(coordinator.scanCleanupRun.activeJobId).toBe(jobId);
            expect(Object.fromEntries(storage)).toEqual({
                'evb.scanCleanup.activeJobId': jobId,
                'evb.scanCleanup.activeOwnerId': ownerContext.ownerId,
                'evb.scanCleanup.activeDocumentRevision': ownerContext.documentRevision,
                'evb.scanCleanup.activeDocumentRef': '/source/book.pdf',
            });
            const savedRun = Object.fromEntries(storage);

            emit({jobId, status});

            expect(coordinator.isScanCleanupRunning.value).toBe(false);
            expect(coordinator.scanCleanupRun.activeJobId).toBeNull();
            expect(coordinator.getScanCleanupRunError(ownerContext.ownerId)).toBe('scanCleanup.errors.runRecoveryFailed');
            expect(Object.fromEntries(storage)).toEqual(status === 'retired' ? {} : savedRun);
        } finally {
            dispose();
            vi.unstubAllGlobals();
        }
    });

    it.each(['retired', 'disconnected'] as const)('preserves the completed run and its file handoff after a %s closure', async status => {
        const terminal = completedState('run-completed-before-closure');
        let emit: (state: TScanCleanupJobState | TScanCleanupJobClosure) => void = () => undefined;
        capability.value = stubCapability<TScanCleanupJobState | TScanCleanupJobClosure>(listener => { emit = listener; }, () => terminal.jobId);
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const opened = Promise.withResolvers<boolean>();
        const openStarted = Promise.withResolvers<string>();
        const dispose = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf: path => {
            openStarted.resolve(path);
            return opened.promise;
        }}));
        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/book.pdf',
                options: createScanCleanupOptions(),
            });
            emit(terminal);
            await expect(openStarted.promise).resolves.toBe(terminal.outputPdfPath);
            expect(coordinator.isScanCleanupRunning.value).toBe(true);

            emit({jobId: terminal.jobId, status});

            expect(coordinator.scanCleanupRun.jobState).toEqual(terminal);
            expect(coordinator.scanCleanupRun.activeJobId).toBe(terminal.jobId);
            expect(coordinator.isScanCleanupRunning.value).toBe(true);
            expect(coordinator.getScanCleanupRunError(ownerContext.ownerId)).toBe('');

            opened.resolve(true);
            await vi.waitFor(() => expect(coordinator.isScanCleanupRunning.value).toBe(false));
            expect(coordinator.scanCleanupRun.jobState).toEqual(terminal);
            expect(coordinator.getScanCleanupRunError(ownerContext.ownerId)).toBe('');
        } finally {
            opened.resolve(true);
            dispose();
        }
    });

    it('keeps newer streamed progress when an older subscription snapshot arrives later', async () => {
        const replay = Promise.withResolvers<TScanCleanupJobState | null>();
        const subscribed = Promise.withResolvers<undefined>();
        let emit: (state: TScanCleanupJobState) => void = () => undefined;
        const bridge = stubCapability(listener => { emit = listener; }, () => 'reordered-run');
        vi.mocked(bridge.subscribeJob).mockImplementation(() => {
            subscribed.resolve(undefined);
            return replay.promise;
        });
        capability.value = bridge;
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const dispose = coordinator.installScanCleanupRunCoordinator(coordinatorDeps());
        try {
            const run = coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/reordered.pdf',
                options: createScanCleanupOptions(),
            });
            await subscribed.promise;
            const newer: TScanCleanupJobState = {
                ...runningJobState(requireJobId('reordered-run')),
                progress: progress(3, 4),
                updatedAtMs: requireEpochMs(2_000),
            };
            emit(newer);
            expect(coordinator.scanCleanupRun.jobState?.progress.percent).toBe(75);

            replay.resolve({
                ...newer,
                progress: progress(0, 4),
                updatedAtMs: requireEpochMs(1_000),
            });
            await run;

            expect(coordinator.scanCleanupRun.jobState).toMatchObject({
                progress: {
                    percent: 75,
                    completedPageNumbers: [
                        1,
                        2,
                        3,
                    ],
                },
                updatedAtMs: 2_000,
            });
        } finally {
            dispose();
        }
    });

    it('keeps a pending start single-flight across rapid callers', async () => {
        const pendingStart = Promise.withResolvers<{
            started: true;
            jobId: TJobId;
            outputPdfPath: string;
        }>();
        capability.value = {
            ...stubCapability(() => undefined, () => 'unused-job'),
            start: vi.fn(() => pendingStart.promise),
            subscribeJob: vi.fn(async (jobId: TJobId) => runningJobState(jobId)),
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
            getPendingCompletedOutputs: vi.fn(async () => ['/managed/recovered.pdf' as TDocumentRef]),
            acknowledgeCompletedOutputs,
        } satisfies IScanCleanupCapability;
        capability.value = pendingCapability;
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf}));
        try {
            await vi.waitFor(() => expect(acknowledgeCompletedOutputs).toHaveBeenCalledWith(['/managed/recovered.pdf']));
        } finally {
            cleanup();
            storage.clear();
            vi.unstubAllGlobals();
        }
    });

    it('acknowledges an opened recovery and disposes queued and active handoffs exactly once', async () => {
        const storage = stubSessionStorage();
        const openedPath = requireDocumentRef('/managed/opened-recovery.pdf');
        const blockedPath = requireDocumentRef('/managed/blocked-recovery.pdf');
        const completed = completedState('queued-live-completion');
        const queuedPath = requireDocumentRef(completed.outputPdfPath);
        const journal = completedOutputJournal([openedPath, blockedPath]);
        const blockedOpen = Promise.withResolvers<boolean>();
        const reconnect = Promise.withResolvers<TScanCleanupJobState>();
        let emit: (state: TScanCleanupJobState) => void = () => undefined;
        const bridge = stubCapability(listener => { emit = listener; }, () => completed.jobId);
        vi.mocked(bridge.reconnectJob).mockReturnValue(reconnect.promise);
        capability.value = {
            ...bridge,
            getPendingCompletedOutputs: journal.getPendingCompletedOutputs,
            acknowledgeCompletedOutputs: journal.acknowledgeCompletedOutputs,
        };
        const coordinator = await loadClientCoordinator();
        const oldOpens = new Map<string, AbortSignal>();
        const oldToast = vi.fn();
        const dispose = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({
            openGeneratedPdf: (path, signal) => {
                oldOpens.set(path, signal);
                return path === blockedPath ? blockedOpen.promise : Promise.resolve(true);
            },
            toast: {add: oldToast},
        }));
        const replacementOpen = Promise.withResolvers<boolean>();
        const newViewer = vi.fn(() => replacementOpen.promise);
        const newToast = vi.fn();
        let disposeReplacement: (() => void) | undefined;
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(new Set(oldOpens.keys())).toEqual(new Set([openedPath, blockedPath]));
            expect.soft(journal.acknowledged).toEqual([openedPath]);

            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/queued.pdf',
                options: createScanCleanupOptions(),
            });
            journal.pending.add(queuedPath);
            emit(completed);

            dispose();
            disposeReplacement = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({
                openGeneratedPdf: newViewer,
                toast: {add: newToast},
            }));
            // A terminal event can precede the reconnect snapshot. Only the
            // replacement may act on it, even while the old viewer is blocked.
            emit(completed);
            await new Promise<void>(resolve => setImmediate(resolve));

            expect.soft(oldOpens.get(blockedPath)?.reason).toBe('disposed');
            expect.soft(oldOpens.has(queuedPath)).toBe(false);
            expect.soft(journal.pending).toEqual(new Set([blockedPath, queuedPath]));
            expect.soft(storage.get('evb.scanCleanup.activeJobId')).toBe(completed.jobId);
            expect.soft(newViewer).toHaveBeenCalledWith(queuedPath, expect.any(AbortSignal), true);

            function expectOneDisposal(path: TDocumentRef) {
                const reasons = diagnosticMocks.debug.mock.calls
                    .flatMap(([section, , data]) => (
                        section === 'scan-cleanup' && typeof data === 'object' && data !== null
                        && 'outputPdfPath' in data && data.outputPdfPath === path && 'reason' in data
                            ? [data.reason]
                            : []
                    ));
                expect.soft(reasons, path).toEqual(['disposed']);
            }

            expectOneDisposal(blockedPath);
            expectOneDisposal(queuedPath);

            blockedOpen.resolve(true);
            await new Promise<void>(resolve => setImmediate(resolve));

            expectOneDisposal(blockedPath);
            expectOneDisposal(queuedPath);
            expect.soft(oldOpens.has(queuedPath)).toBe(false);
            expect.soft(journal.acknowledged).toEqual([openedPath]);
            expect.soft(oldToast).not.toHaveBeenCalled();
            expect.soft(newToast).not.toHaveBeenCalled();

            replacementOpen.resolve(true);
            await new Promise<void>(resolve => setImmediate(resolve));

            expect(journal.acknowledged).toEqual([openedPath, queuedPath]);
            expect(journal.pending).toEqual(new Set([blockedPath]));
        } finally {
            disposeReplacement?.();
            dispose();
            reconnect.resolve(completed);
            blockedOpen.resolve(false);
            replacementOpen.resolve(false);
            await new Promise<void>(resolve => setImmediate(resolve));
        }
    });

    it('keeps an accepted journal acknowledgement from presenting through a disposed installation', async () => {
        const completed = completedState('completion-with-delayed-receipt');
        const path = requireDocumentRef(completed.outputPdfPath);
        const journal = completedOutputJournal([]);
        const acknowledgement = Promise.withResolvers<void>();
        const receipt = Promise.withResolvers<void>();
        let emit: (state: TScanCleanupJobState) => void = () => undefined;
        capability.value = {
            ...stubCapability(listener => { emit = listener; }, () => completed.jobId),
            getPendingCompletedOutputs: journal.getPendingCompletedOutputs,
            acknowledgeCompletedOutputs: async (paths) => {
                await journal.acknowledgeCompletedOutputs(paths);
                acknowledgement.resolve();
                await receipt.promise;
            },
        };
        const oldToast = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const dispose = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({toast: {add: oldToast}}));
        const newToast = vi.fn();
        const newViewer = vi.fn(async () => true);
        let disposeReplacement: (() => void) | undefined;
        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/delayed-receipt.pdf',
                options: createScanCleanupOptions(),
            });
            journal.pending.add(path);
            emit(completed);
            await acknowledgement.promise;
            expect(journal.pending.size).toBe(0);
            expect(oldToast).not.toHaveBeenCalled();

            dispose();
            disposeReplacement = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({
                openGeneratedPdf: newViewer,
                toast: {add: newToast},
            }));
            receipt.resolve();
            await new Promise<void>(resolve => setImmediate(resolve));

            expect(journal.acknowledged).toEqual([path]);
            expect(newViewer).not.toHaveBeenCalled();
            expect(newToast).not.toHaveBeenCalled();
            expect(oldToast).not.toHaveBeenCalled();
        } finally {
            disposeReplacement?.();
            dispose();
            receipt.resolve();
            await new Promise<void>(resolve => setImmediate(resolve));
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
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf}));
        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/terminal.pdf',
                options: createScanCleanupOptions(),
            });
            listener(completedState('job-terminal', terminalPath));

            pendingOutputs.resolve([recoveredPath]);
            await Promise.resolve();
            expect(openGeneratedPdf).toHaveBeenCalledOnce();
            expect(coordinator.scanCleanupRun.activeJobId).toBe('job-terminal');
            expect(coordinator.scanCleanupRun.inFlight).toBe(true);

            terminalOpen.resolve(true);
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
            getPendingCompletedOutputs: vi.fn(async () => [
                firstPath,
                secondPath,
            ]),
            acknowledgeCompletedOutputs,
        } satisfies IScanCleanupCapability;
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf}));
        try {
            await vi.advanceTimersByTimeAsync(30_000);
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

    it('recovers a dropped terminal state through the liveness probe', async () => {
        vi.useFakeTimers();
        const running = runningJobState(requireJobId('liveness-terminal-job'));
        const getJobState = vi.fn(async () => completedState('liveness-terminal-job'));
        const value = stubCapability(() => undefined, () => 'liveness-terminal-job');
        vi.mocked(value.getJobState).mockImplementation(getJobState);
        vi.mocked(value.subscribeJob).mockResolvedValue(running);
        capability.value = value;
        const openGeneratedPdf = vi.fn(async () => true);
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf, toast: {add: toastAdd}}));

        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/liveness-terminal.pdf',
                options: createScanCleanupOptions(),
            });

            await vi.advanceTimersByTimeAsync(coordinator.SCAN_CLEANUP_RUN_LIVENESS_CHECK_MS);

            expect(getJobState).toHaveBeenCalledWith('liveness-terminal-job', ownerContext);
            expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({color: 'success'}));
            expect(coordinator.scanCleanupRun.activeJobId).toBeNull();
            expect(coordinator.isScanCleanupRunning.value).toBe(false);
        } finally {
            cleanup();
            vi.useRealTimers();
        }
    });

    it('keeps a slow live job guarded until the liveness probe finds no record', async () => {
        vi.useFakeTimers();
        const running = runningJobState(requireJobId('liveness-slow-job'));
        const responses: Array<TScanCleanupJobState | null> = [
            running,
            running,
            null,
        ];
        const getJobState = vi.fn(async () => responses.shift() ?? null);
        const value = stubCapability(() => undefined, () => 'liveness-slow-job');
        vi.mocked(value.getJobState).mockImplementation(getJobState);
        vi.mocked(value.subscribeJob).mockResolvedValue(running);
        capability.value = value;
        const cancel = vi.mocked(value.cancel);
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps());

        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/liveness-slow.pdf',
                options: createScanCleanupOptions(),
            });

            await vi.advanceTimersByTimeAsync(coordinator.SCAN_CLEANUP_RUN_LIVENESS_CHECK_MS * 2);

            expect(getJobState).toHaveBeenCalledTimes(2);
            expect(coordinator.scanCleanupRun.activeJobId).toBe('liveness-slow-job');
            expect(coordinator.isScanCleanupRunning.value).toBe(true);
            expect(cancel).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(coordinator.SCAN_CLEANUP_RUN_LIVENESS_CHECK_MS);

            expect(getJobState).toHaveBeenCalledTimes(3);
            expect(cancel).toHaveBeenCalledWith('liveness-slow-job', ownerContext);
            expect(coordinator.scanCleanupRun.activeJobId).toBeNull();
            expect(coordinator.isScanCleanupRunning.value).toBe(false);
        } finally {
            cleanup();
            vi.useRealTimers();
        }
    });

    it.each(['completed', 'missing'] as const)('keeps a disconnected start until liveness finds the job %s', async outcome => {
        const storage = stubSessionStorage();
        const jobId = 'disconnected-start';
        const bridge = stubCapability(() => undefined, () => jobId);
        vi.mocked(bridge.subscribeJob).mockRejectedValue(new Error('subscription transport failed'));
        let state = outcome === 'completed' ? completedState(jobId) : null;
        vi.mocked(bridge.getJobState).mockImplementation(async () => state);
        vi.mocked(bridge.cancel).mockImplementation(async () => {
            state = null;
            return true;
        });
        capability.value = bridge;
        const coordinator = await loadClientCoordinator();
        const opened: string[] = [];
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']});
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf: async path => {
            opened.push(path);
            return true;
        }}));
        try {
            await expect(coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/book.pdf',
                options: createScanCleanupOptions(),
            })).resolves.toMatchObject({started: true, jobId});
            expect(coordinator.scanCleanupRun.activeJobId).toBe(jobId);
            expect(coordinator.isScanCleanupRunning.value).toBe(true);
            expect(storage.get('evb.scanCleanup.activeJobId')).toBe(jobId);
            expect(opened).toEqual([]);

            await vi.advanceTimersByTimeAsync(coordinator.SCAN_CLEANUP_RUN_LIVENESS_CHECK_MS);

            expect(coordinator.scanCleanupRun.activeJobId).toBeNull();
            expect(coordinator.isScanCleanupRunning.value).toBe(false);
            expect(storage.size).toBe(0);
            expect(opened).toEqual(outcome === 'completed' ? ['/managed/disconnected-start.pdf'] : []);
            expect(coordinator.scanCleanupRun.lastError?.error)
                .toBe(outcome === 'missing' ? 'scanCleanup.errors.runRecoveryFailed' : undefined);
        } finally {
            cleanup();
            vi.useRealTimers();
        }
    });

    it('releases and forgets a retired start and reports the subscription error', async () => {
        const storage = stubSessionStorage();
        const bridge = stubCapability(() => undefined, () => 'retired-start');
        vi.mocked(bridge.subscribeJob).mockResolvedValue(null);
        capability.value = bridge;
        const coordinator = await loadClientCoordinator();

        await expect(coordinator.startScanCleanup({
            ...ownerContext,
            sourcePdfPath: '/source/book.pdf',
            options: createScanCleanupOptions(),
        })).rejects.toMatchObject({
            name: 'ScanCleanupRunReconciliationError',
            errorCode: 'internal',
            failure: 'subscription',
            technicalDetail: '',
        });

        expect(coordinator.scanCleanupRun.activeJobId).toBeNull();
        expect(coordinator.scanCleanupRun.inFlight).toBe(false);
        expect(coordinator.scanCleanupRun.jobState).toBeNull();
        expect(coordinator.isScanCleanupRunning.value).toBe(false);
        expect(storage.size).toBe(0);
    });

    it('hands off the PDF when completion arrives during cancellation after a null reply', async () => {
        const terminal = completedState('terminal-during-abandon');
        let emit: (state: TScanCleanupJobState) => void = () => undefined;
        const bridge = stubCapability(listener => { emit = listener; }, () => terminal.jobId);
        vi.mocked(bridge.subscribeJob).mockResolvedValue(null);
        vi.mocked(bridge.cancel).mockImplementation(async () => {
            emit(terminal);
            return false;
        });
        capability.value = bridge;
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const opened = Promise.withResolvers<string>();
        const finishOpen = Promise.withResolvers<boolean>();
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf: path => {
            opened.resolve(path);
            return finishOpen.promise;
        }}));

        try {
            await expect(coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/terminal-during-abandon.pdf',
                options: createScanCleanupOptions(),
            })).resolves.toMatchObject({
                started: true,
                jobId: 'terminal-during-abandon',
            });

            expect(await opened.promise).toBe(terminal.outputPdfPath);
            expect(coordinator.isScanCleanupRunning.value).toBe(true);
            finishOpen.resolve(true);
            await vi.waitFor(() => expect(coordinator.isScanCleanupRunning.value).toBe(false));
        } finally {
            finishOpen.resolve(true);
            cleanup();
        }
    });

    it('ignores a late start subscription reply while the next document starts', async () => {
        let emit: (state: TScanCleanupJobState | TScanCleanupJobClosure) => void = () => undefined;
        const bridge = stubCapability<TScanCleanupJobState | TScanCleanupJobClosure>(listener => { emit = listener; }, () => 'unused');
        const subscribing = Promise.withResolvers<void>();
        const firstReply = Promise.withResolvers<TScanCleanupJobState>();
        const secondStart = Promise.withResolvers<ReturnType<typeof startResult>>();
        vi.mocked(bridge.subscribeJob).mockImplementationOnce(() => {
            subscribing.resolve();
            return firstReply.promise;
        });
        vi.mocked(bridge.start)
            .mockResolvedValueOnce(startResult('first-job'))
            .mockImplementationOnce(() => secondStart.promise);
        capability.value = bridge;
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps());
        const request = {...ownerContext, options: createScanCleanupOptions()};
        try {
            const first = coordinator.startScanCleanup({...request, sourcePdfPath: '/source/first.pdf'});
            await subscribing.promise;
            emit({jobId: requireJobId('first-job'), status: 'retired'});
            const second = coordinator.startScanCleanup({...request, sourcePdfPath: '/source/second.pdf'});

            firstReply.resolve(runningJobState(requireJobId('first-job')));
            await first;
            const activeDuringSecondStart = coordinator.scanCleanupRun.activeJobId;
            secondStart.resolve(startResult('second-job'));
            await second;

            expect(activeDuringSecondStart).toBeNull();
            expect(coordinator.scanCleanupRun.activeJobId).toBe('second-job');
            expect(coordinator.scanCleanupRun.ownerDocumentRef).toBe('/source/second.pdf');
        } finally {
            cleanup();
        }
    });

    it('keeps a disconnected stored run for liveness without replaying the output journal', async () => {
        const storage = stubSessionStorage([
            ['evb.scanCleanup.activeJobId', 'stored-job'],
            ['evb.scanCleanup.activeOwnerId', ownerContext.ownerId],
            ['evb.scanCleanup.activeDocumentRevision', ownerContext.documentRevision],
        ]);
        const bridge = {
            ...stubCapability(() => undefined, () => 'unused'),
            getPendingCompletedOutputs: async () => ['/managed/recovered.pdf' as TDocumentRef],
        } satisfies IScanCleanupCapability;
        vi.mocked(bridge.reconnectJob).mockRejectedValue(new Error('reconnect transport failed'));
        vi.mocked(bridge.getJobState).mockResolvedValue(runningJobState(requireJobId('stored-job')));
        capability.value = bridge;
        const coordinator = await loadClientCoordinator();
        const opened: string[] = [];
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']});
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf: async path => {
            opened.push(path);
            return true;
        }}));
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(storage.get('evb.scanCleanup.activeJobId')).toBe('stored-job');
            expect(coordinator.scanCleanupRun.activeJobId).toBe('stored-job');
            expect(coordinator.scanCleanupRun.lastError).toBeNull();

            await vi.advanceTimersByTimeAsync(coordinator.SCAN_CLEANUP_RUN_LIVENESS_CHECK_MS);

            expect(coordinator.scanCleanupRun.jobState?.status).toBe('running');
            expect(opened).toEqual([]);
        } finally {
            cleanup();
            vi.useRealTimers();
        }
    });

    it('disposes an installed coordinator and clears the guard when a start rejects', async () => {
        const onJobState = vi.fn(() => () => undefined);
        const toastAdd = vi.fn();
        capability.value = {
            ...stubCapability(() => undefined, () => 'unused-job'),
            start: vi.fn(async () => {
                throw new Error('scan cleanup bridge failed');
            }),
            onJobState,
        };
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const dependencies = coordinatorDeps({toast: {add: toastAdd}});
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
            ...stubCapability(() => undefined, () => 'unused-job'),
            start: vi.fn(),
        };
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf: vi.fn(), openScanCleanupForDocument: vi.fn(), toast: {add: toastAdd}}));
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
                description: toastDescriptionContaining('scan-cleanup IPC codec failed\nerrors.runtime.errorId: 01234567'),
            }));
            expect(coordinator.scanCleanupRun.lastError?.failure).toEqual(diagnosticMocks.failure);
        } finally {
            cleanup();
        }
    });

    it.each(['failed', 'canceled'] as const)('routes a %s run using the workspace visibility at the time of the toast', async status => {
        const toastAdd = vi.fn<IFailureToastTarget['add']>();
        let emit: (state: TScanCleanupJobState) => void = () => undefined;
        let nextJob = 0;
        capability.value = stubCapability(listener => { emit = listener; }, () => `visibility-${++nextJob}`);
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const {useScanCleanupRunSession} = await import('@app/modules/scan-cleanup/composables/useScanCleanupRunSession');
        const sourcePath = requireDocumentRef('/source/book.pdf');
        const active = ref(true);
        const app = createApp({
            setup() {
                useScanCleanupRunSession({
                    active: () => active.value,
                    authoritativeLayoutByPage: computed(() => new Map()),
                    beforeRun: () => undefined,
                    detectionError: ref(''),
                    detectionErrorCode: ref(null),
                    detectionPending: computed(() => false),
                    detectionRecords: ref(new Map()),
                    detectionStatus: computed(() => 'completed'),
                    documentRevision: computed(() => ownerContext.documentRevision),
                    documentSettingsReady: computed(() => true),
                    onCompleted: () => undefined,
                    ownerId: ownerContext.ownerId,
                    placementAnchorsByPage: computed(() => new Map()),
                    previewTotalPages: () => 1,
                    refreshDetection: async () => undefined,
                    resolvePagePlanEvidence: () => new Map(),
                    settings: createScanCleanupOptions(),
                    sourcePageNumbers: computed(() => null),
                    sourcePath: computed(() => sourcePath),
                    totalPages: computed(() => 1),
                    waitForDetectionBeforeRun: async () => undefined,
                });
                return () => null;
            },
        });
        app.mount(document.createElement('div'));
        let mounted = true;
        const unmount = () => {
            mounted = false;
            app.unmount();
        };
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({toast: {add: toastAdd}}));
        try {
            const expectRouting = async (where: string, visible: boolean, changeVisibility?: () => void) => {
                const {jobId} = await coordinator.startScanCleanup({
                    ...ownerContext,
                    sourcePdfPath: sourcePath,
                    options: createScanCleanupOptions(),
                });
                const terminal = {
                    jobId,
                    progress: progress(),
                    updatedAtMs: requireEpochMs(Date.now()),
                };
                toastAdd.mockClear();
                changeVisibility?.();
                emit(status === 'failed'
                    ? {...terminal, status, error: 'page 17 has invalid geometry', errorCode: 'internal'}
                    : {...terminal, status});

                expect.soft(toastAdd, where).toHaveBeenCalledTimes(status === 'canceled' && visible ? 0 : 1);
                const toast = toastAdd.mock.lastCall?.[0];
                if (status === 'failed') {
                    expect.soft(toast, where).toMatchObject({
                        color: 'error',
                        title: 'scanCleanup.failed',
                        description: toastDescriptionContaining('page 17 has invalid geometry'),
                    });
                    expect.soft(toast?.actions?.some(action => action.label === 'scanCleanup.details'), where).toBe(!visible);
                } else if (!visible) {
                    expect.soft(toast, where).toMatchObject({color: 'info', title: 'scanCleanup.canceled'});
                }
            };

            await expectRouting('visible workspace', true);
            await expectRouting('same turn after hiding', false, () => { active.value = false; });
            await expectRouting('same turn after showing', true, () => { active.value = true; });
            await nextTick();
            await expectRouting('after unmount while the active getter still returns true', false, unmount);
        } finally {
            if (mounted) unmount();
            cleanup();
        }
    });

    it('localizes typed scratch figures on a failed run', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        capability.value = stubCapability(
            next => { listener = next; },
            () => 'scratch-job',
        );
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const toastAdd = vi.fn();
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({createCompletedOutputSaveAs: vi.fn(() => async () => true), toast: {add: toastAdd}}));
        try {
            await expect(coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/book.pdf',
                options: createScanCleanupOptions(),
            })).resolves.toMatchObject({started: true});
            listener({
                jobId: requireJobId('scratch-job'),
                status: 'failed',
                error: 'raw ENOSPC detail must not be shown',
                errorCode: 'insufficient-scratch',
                scratchShortfall: {
                    availableBytes: 520 * 1024 * 1024,
                    requiredBytes: 1_100 * 1024 * 1024,
                },
                progress: progress(1),
                updatedAtMs: requireEpochMs(Date.now()),
            });
            await vi.waitFor(() => expect(coordinator.getScanCleanupRunError(ownerContext.ownerId))
                .toContain('scanCleanup.errors.insufficientScratch'));
            const error = coordinator.getScanCleanupRunError(ownerContext.ownerId);
            expect(error).toContain('scanCleanup.errors.insufficientScratchSpace');
            expect(error).toContain('"available":"520.0 common.unitMegabyte"');
            expect(error).toContain('"required":"1.07 common.unitGigabyte"');
            expect(error).not.toContain('raw ENOSPC detail');
        } finally {
            cleanup();
        }
    });

    it.each([
        {
            spreadsSplit: 0,
            offcutsDiscarded: 0,
            blankPagesSkipped: 0,
            excludedPages: 0,
        },
        {
            spreadsSplit: 2,
            offcutsDiscarded: 0,
            blankPagesSkipped: 3,
            excludedPages: 0,
        },
        {
            spreadsSplit: 0,
            offcutsDiscarded: 4,
            blankPagesSkipped: 0,
            excludedPages: 5,
        },
    ])('lists only nonzero completion facts for %j', async (facts) => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        capability.value = stubCapability(callback => { listener = callback; }, () => 'summary-job');
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({toast: {add: toastAdd}}));
        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/book.pdf',
                options: createScanCleanupOptions(),
            });
            const state = completedState('summary-job');
            Object.assign(state.summary, facts);
            listener(state);
            const details = [
                [
                    'spreads',
                    facts.spreadsSplit,
                ],
                [
                    'offcuts',
                    facts.offcutsDiscarded,
                ],
                [
                    'blank',
                    facts.blankPagesSkipped,
                ],
                [
                    'excluded',
                    facts.excludedPages,
                ],
            ] as const;
            const expected = [
                'scanCleanup.summary:{"input":1,"output":1}',
                ...details.filter(([
                    , count,
                ]) => count > 0)
                    .map(([
                        fact,
                        count,
                    ]) => `scanCleanup.summaryDetails.${fact}:{"count":${count}}`),
            ].join(' ');
            await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({
                color: 'success',
                description: toastDescription(expected),
            })));
        } finally {
            cleanup();
        }
    });

    it('keeps runs global and routes completed, failed, and canceled terminal states', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        let nextJob = 0;
        capability.value = {
            ...stubCapability(() => undefined, () => 'unused-job'),
            start: vi.fn(async () => startResult(`job-${++nextJob}`, '/managed/book — cleaned.pdf')),
            subscribeJob: vi.fn(async (jobId: TJobId) => runningJobState(jobId)),
            onJobState: vi.fn(callback => {
                listener = callback;
                return () => { listener = () => undefined; };
            }),
        };
        const openGeneratedPdf = vi.fn(async () => true);
        let savedOutput: string | null = null;
        const openScanCleanupForDocument = vi.fn(async () => true);
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf, createCompletedOutputSaveAs: outputPath => async () => { savedOutput = outputPath; return true; }, openScanCleanupForDocument, toast: {add: toastAdd}}));
        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/book.pdf',
                options: createScanCleanupOptions(),
            });
            expect(capability.value!.start).toHaveBeenCalledWith(expect.not.objectContaining({outputPdfPath: expect.anything()}));
            listener({...completedState('job-1', '/managed/book — cleaned.pdf', {inputPages: 4, outputPages: 8, spreadsSplit: 4}), progress: progress(4)});
            await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({color: 'success'})));
            const completeToast = toastAdd.mock.calls.at(-1)?.[0];
            expect(savedOutput).toBeNull();
            const replacementCleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf, createCompletedOutputSaveAs: () => async () => { savedOutput = '/replacement.pdf'; return true; }, toast: {add: toastAdd}}));
            try {
                completeToast.actions[0].onClick();
                expect(savedOutput).toBe('/managed/book — cleaned.pdf');
            } finally {
                replacementCleanup();
            }

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
                .toBe('scanCleanup.errors.nativeFailure (sidecar failed)');
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
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf, toast: {add: toastAdd}}));
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
        const dispose = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf: firstOpen, toast: {add: firstToast}}));
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
            reinstall = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf: secondOpen, toast: {add: secondToast}}));
            listener(completedState('job-disposed'));
            expect(secondOpen).toHaveBeenCalledOnce();

            await vi.waitFor(() => expect(secondToast).toHaveBeenCalledWith(expect.objectContaining({color: 'success'})));
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
        expect([...resolveScanCleanupProcessedPages({
            ...runningState,
            status: 'canceling',
        }, '/source/book.pdf', '/source/book.pdf', 6)]).toEqual([
            5,
            2,
            4,
        ]);
        expect([...resolveScanCleanupProcessedPages({
            ...runningState,
            status: 'committing',
        }, '/source/book.pdf', '/source/book.pdf', 6)]).toEqual([
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

    it('returns a distinct commit-window cancellation outcome', async () => {
        const committing: TScanCleanupJobState = {
            ...runningJobState(requireJobId('job-committing')),
            status: 'committing',
        };
        const value = stubCapability(() => undefined, () => 'job-committing');
        vi.mocked(value.start).mockResolvedValue(startResult('job-committing'));
        vi.mocked(value.cancel).mockResolvedValue(false);
        vi.mocked(value.getJobState).mockResolvedValue(committing);
        vi.mocked(value.subscribeJob).mockResolvedValue(committing);
        capability.value = value;
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');

        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/committing.pdf',
                options: createScanCleanupOptions(),
            });

            await expect(coordinator.cancelScanCleanup()).resolves.toBe('committing');
            expect(coordinator.scanCleanupRun.jobState?.status).toBe('committing');
            expect(coordinator.isScanCleanupRunning.value).toBe(true);
            expect(value.getJobState).toHaveBeenCalledWith('job-committing', ownerContext);
        } finally {
            coordinator.scanCleanupRun.activeJobId = null;
            coordinator.scanCleanupRun.jobState = null;
            coordinator.scanCleanupRun.inFlight = false;
        }
    });

    it('answers a cancellation transport rejection from the authoritative state', async () => {
        const canceling: TScanCleanupJobState = {
            ...runningJobState(requireJobId('job-transport-rejection')),
            status: 'canceling',
        };
        const value = stubCapability(() => undefined, () => 'job-transport-rejection');
        vi.mocked(value.start).mockResolvedValue(startResult('job-transport-rejection'));
        vi.mocked(value.cancel).mockRejectedValue(new Error('bridge disconnected'));
        vi.mocked(value.getJobState).mockResolvedValue(canceling);
        capability.value = value;
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');

        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/transport-rejection.pdf',
                options: createScanCleanupOptions(),
            });

            await expect(coordinator.cancelScanCleanup()).resolves.toBe('accepted');
            expect(coordinator.scanCleanupRun.jobState?.status).toBe('canceling');
            expect(value.getJobState).toHaveBeenCalledWith('job-transport-rejection', ownerContext);
        } finally {
            coordinator.scanCleanupRun.activeJobId = null;
            coordinator.scanCleanupRun.jobState = null;
            coordinator.scanCleanupRun.inFlight = false;
        }
    });

    it('does not apply a reconciled cancellation state to a replacement job', async () => {
        const cancellationState = Promise.withResolvers<TScanCleanupJobState>();
        const canceling: TScanCleanupJobState = {
            ...runningJobState(requireJobId('job-stale-cancel')),
            status: 'canceling',
        };
        const replacement = runningJobState(requireJobId('job-replacement'));
        const value = stubCapability(() => undefined, () => 'job-stale-cancel');
        vi.mocked(value.start).mockResolvedValue(startResult('job-stale-cancel'));
        vi.mocked(value.cancel).mockRejectedValue(new Error('bridge disconnected'));
        vi.mocked(value.getJobState).mockReturnValue(cancellationState.promise);
        capability.value = value;
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');

        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/stale-cancel.pdf',
                options: createScanCleanupOptions(),
            });
            const cancellation = coordinator.cancelScanCleanup();
            await vi.waitFor(() => expect(value.getJobState).toHaveBeenCalledOnce());

            coordinator.scanCleanupRun.activeJobId = replacement.jobId;
            coordinator.scanCleanupRun.jobState = replacement;
            cancellationState.resolve(canceling);

            await expect(cancellation).resolves.toBe('accepted');
            expect(coordinator.scanCleanupRun.jobState).toMatchObject(replacement);
        } finally {
            coordinator.scanCleanupRun.activeJobId = null;
            coordinator.scanCleanupRun.jobState = null;
            coordinator.scanCleanupRun.inFlight = false;
        }
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

    it.each([
        {name: 'partial-scope completion', partial: true, summary: {}, color: 'success', title: 'scanCleanup.completedPartialTitle', description: []},
        {name: 'counted source omissions', partial: false, summary: {sourceTextOmission: {
            count: 25, pages: Array.from({length: 20}, (_, index) => requirePageNumber(index + 1)),
        }}, color: 'warning', title: 'scanCleanup.completedTitle', description: ['scanCleanup.sourceTextOmitted:', 'sourceTextOmittedMorePages', 'remaining', '25']},
        {name: 'removed accessibility tags', partial: false, summary: {accessibilityTagsRemoved: true}, color: 'warning', title: 'scanCleanup.completedTitle', description: ['scanCleanup.accessibilityTagsRemoved']},
    ])('localizes $name in the completion toast', async ({partial, summary, color, title, description}) => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        capability.value = {
            ...stubCapability(next => { listener = next; }, () => 'completion-message'),
            subscribeJob: vi.fn(async (jobId: TJobId) => runningJobState(jobId)),
        };
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({toast: {add: toastAdd}}));
        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/book.pdf',
                options: createScanCleanupOptions(),
                ...(partial ? {sourcePageNumbers: [3]} : {}),
            });
            listener({...completedState('completion-message', '/managed/book-cleaned.pdf', summary), partial});
            await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({color, title})));
            for (const text of description) {
                expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({description: toastDescriptionContaining(text)}));
            }
        } finally {
            cleanup();
        }
    });

    it('holds the run guard and active job until the generated PDF finishes opening', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        const openGate = Promise.withResolvers<boolean>();
        capability.value = {
            ...stubCapability(next => { listener = next; }, () => 'unused-job'),
            start: vi.fn(async () => startResult('job-open-gate', '/managed/job-open-gate.pdf')),
            subscribeJob: vi.fn(async (jobId: TJobId) => runningJobState(jobId)),
        };
        const openGeneratedPdf = vi.fn(() => openGate.promise);
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf, toast: {add: toastAdd}}));
        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/book.pdf',
                options: createScanCleanupOptions(),
            });
            const completed: TScanCleanupJobState = completedState('job-open-gate', '/managed/job-open-gate.pdf');
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
            ...stubCapability(next => { listener = next; }, () => 'unused-job'),
            start: vi.fn(async () => startResult('job-open-failure', '/managed/job-open-failure.pdf')),
            subscribeJob: vi.fn(async (jobId: TJobId) => runningJobState(jobId)),
        };
        const openGeneratedPdf = vi.fn(async () => {
            throw new Error('Invalid or non-existent file');
        });
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf, toast: {add: toastAdd}}));
        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/book.pdf',
                options: createScanCleanupOptions(),
            });
            listener(completedState('job-open-failure', '/managed/missing.pdf'));

            await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({
                color: 'error',
                title: 'scanCleanup.openResultFailed',
            })));
        } finally {
            cleanup();
        }
    });

    it('does not restore a stale active id when a terminal event beats start resolution', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        const completed: TScanCleanupJobState = completedState('job-instant', '/managed/instant.pdf');
        const subscribeJob = vi.fn(async () => completed);
        capability.value = {
            ...stubCapability(next => { listener = next; }, () => 'unused-job'),
            start: vi.fn(async () => {
                listener(completed);
                return startResult('job-instant', '/managed/instant.pdf');
            }),
            subscribeJob,
        };
        const openGeneratedPdf = vi.fn(async () => true);
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf}));
        try {
            await coordinator.startScanCleanup({
                ...ownerContext,
                sourcePdfPath: '/source/instant.pdf',
                options: createScanCleanupOptions(),
            });
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
            ...stubCapability(next => { listener = next; }, () => 'unused-job'),
            start: vi.fn(async () => startResult(nextJobId)),
        };
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf}));
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
        const dependencies = coordinatorDeps();
        const firstCleanup = coordinator.installScanCleanupRunCoordinator(dependencies);
        let secondCleanup: (() => void) | null = null;
        const onJobState = vi.fn(() => () => undefined);
        capability.value = {
            ...stubCapability(() => undefined, () => 'unused-job'),
            start: vi.fn(),
            onJobState,
        };
        try {
            secondCleanup = coordinator.installScanCleanupRunCoordinator(dependencies);

            expect(onJobState).toHaveBeenCalledOnce();
        } finally {
            secondCleanup?.();
            firstCleanup();
        }
    });

    it('keeps the live coordinator subscription until the last installation disposes', async () => {
        const unsubscribe = vi.fn();
        const pruneGeneratedOutputs = vi.fn(async () => 3);
        capability.value = {
            ...stubCapability(() => undefined, () => 'unused-job'),
            start: vi.fn(),
            pruneGeneratedOutputs,
            onJobState: vi.fn(() => unsubscribe),
        };
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const firstCleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf: vi.fn()}));
        const secondCleanup = coordinator.installScanCleanupRunCoordinator(coordinatorDeps({openGeneratedPdf: vi.fn()}));

        firstCleanup();
        expect(unsubscribe).not.toHaveBeenCalled();
        await expect(coordinator.pruneScanCleanupOutputs()).resolves.toBe(3);

        secondCleanup();
        expect(unsubscribe).toHaveBeenCalledOnce();
        firstCleanup();
    });
});
