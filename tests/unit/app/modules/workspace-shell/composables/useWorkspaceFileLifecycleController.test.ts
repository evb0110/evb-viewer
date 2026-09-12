import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
} from 'vue';
import { requireDocumentRef } from '@contracts/documentRef';

const mocks = vi.hoisted(() => ({
    convertToPdf: vi.fn(),
    openDjvuFile: vi.fn(),
    openFileDirect: vi.fn(),
    ensurePdfProjectionForAction: vi.fn(),
    cancelActiveJobs: vi.fn(),
    cleanupDjvuTemp: vi.fn(),
    closeFile: vi.fn(),
    exitDjvuMode: vi.fn(),
}));

const state = vi.hoisted(() => ({
    activeDjvuActivation: null as {
        generation: number;
        kind: 'djvu';
        documentRef: string;
    } | null,
    djvuSourcePath: {value: null as string | null},
    isDjvuMode: {value: false},
    originalPath: {value: null as string | null},
    pdfError: {value: null as string | null},
    pendingDjvu: {value: null as string | null},
    workingCopyPath: {value: null as string | null},
}));

vi.mock('@app/modules/workspace-shell/composables/usePdfFile', () => ({usePdfFile: () => ({
    pdfSrc: ref(null),
    pdfReloadSrc: ref(null),
    pdfData: ref(null),
    pdfRasterDisplayProfile: ref(null),
    workingCopyPath: state.workingCopyPath,
    originalPath: state.originalPath,
    fileName: ref(null),
    isDirty: ref(false),
    pdfConformanceProfile: ref(null),
    lastSaveMode: ref(null),
    error: state.pdfError,
    isElectron: ref(true),
    pendingDjvu: state.pendingDjvu,
    openBatchProgress: ref(null),
    pickFileToOpen: vi.fn(),
    openFile: vi.fn(),
    openFileDirect: mocks.openFileDirect,
    openFileDirectBatch: vi.fn(),
    loadPdfFromPath: vi.fn(),
    ensureHistoryBaselineForMutation: vi.fn(),
    reloadWorkingCopyIntoHistory: vi.fn(),
    loadPdfFromData: vi.fn(),
    persistPdfDataSilently: vi.fn(),
    closeFile: mocks.closeFile,
    saveFile: vi.fn(),
    repairWorkingCopy: vi.fn(),
    optimizeWorkingCopy: vi.fn(),
    optimizeWorkingCopyAsCopy: vi.fn(),
    saveWorkingCopy: vi.fn(),
    trySavePdfNativeMutations: vi.fn(),
    trySaveEmbeddedNoteTextUpdates: vi.fn(),
    saveWorkingCopyAs: vi.fn(),
    markDirty: vi.fn(),
    canUndo: ref(false),
    canRedo: ref(false),
    fileHistoryMutationVersion: ref(0),
    fileHistorySessionVersion: ref(0),
    setWorkspaceCommandSink: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
})}));

vi.mock('@app/composables/useDjvu', () => ({useDjvu: () => ({
    isDjvuMode: state.isDjvuMode,
    djvuSourcePath: state.djvuSourcePath,
    conversionState: ref({
        isConverting: false,
        phase: null,
        percent: 0,
    }),
    isLoadingPages: ref(false),
    loadingProgress: ref({
        current: 0,
        total: 0,
    }),
    showBanner: ref(true),
    showConvertDialog: ref(false),
    sourceError: ref(null),
    openingPath: ref(null),
    openDjvuFile: mocks.openDjvuFile,
    invalidatePendingDjvuOpen: vi.fn(),
    convertToPdf: mocks.convertToPdf,
    ensurePdfProjectionForAction: mocks.ensurePdfProjectionForAction,
    cancelActiveJobs: mocks.cancelActiveJobs,
    cleanupDjvuTemp: mocks.cleanupDjvuTemp,
    captureDjvuActivation: () => state.activeDjvuActivation,
    exitDjvuMode: mocks.exitDjvuMode,
    openConvertDialog: vi.fn(),
    dismissBanner: vi.fn(),
})}));

vi.mock('@app/composables/useRecentFiles', () => ({useRecentFiles: () => ({
    recentFiles: ref([]),
    loadRecentFiles: vi.fn(),
    removeRecentFile: vi.fn(),
    clearRecentFiles: vi.fn(),
})}));

const { useWorkspaceFileLifecycleController } =
    await import('@app/modules/workspace-shell/composables/useWorkspaceFileLifecycleController');

function createDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return {
        promise,
        resolve,
    };
}

describe('useWorkspaceFileLifecycleController', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.djvuSourcePath.value = null;
        state.activeDjvuActivation = null;
        state.isDjvuMode.value = false;
        state.originalPath.value = null;
        state.pdfError.value = null;
        state.pendingDjvu.value = null;
        state.workingCopyPath.value = null;
        mocks.cleanupDjvuTemp.mockResolvedValue(true);
        mocks.ensurePdfProjectionForAction.mockResolvedValue(true);
        mocks.cancelActiveJobs.mockResolvedValue(false);
        mocks.exitDjvuMode.mockImplementation((expected) => {
            if (state.activeDjvuActivation?.generation !== expected.generation) {
                return false;
            }
            state.activeDjvuActivation = null;
            state.djvuSourcePath.value = null;
            state.isDjvuMode.value = false;
            return true;
        });
    });

    it('opens converted DjVu PDFs through the same workspace direct-open handler', async () => {
        mocks.openFileDirect.mockResolvedValue({
            status: 'opened',
            result: {
                kind: 'pdf',
                originalPath: '/tmp/output.pdf',
                workingPath: '/tmp/output-working.pdf',
            },
        });
        mocks.convertToPdf.mockImplementation(async (_subsample, _preserveBookmarks, _pdfStrategy, openConvertedPdf) => {
            await openConvertedPdf(requireDocumentRef('/tmp/output.pdf'));
        });

        const controller = useWorkspaceFileLifecycleController();
        await controller.handleDjvuConvert(2, true, 'compact-djvu-aware');

        expect(mocks.convertToPdf).toHaveBeenCalledWith(2, true, 'compact-djvu-aware', expect.any(Function));
        expect(mocks.openFileDirect).toHaveBeenCalledWith('/tmp/output.pdf', undefined);
    });

    it('keeps the lifecycle transaction pending until its DjVu source is activated exactly once', async () => {
        const path = requireDocumentRef('/docs/scan.djvu');
        const activation = createDeferred();
        state.workingCopyPath.value = '/tmp/previous.pdf';
        mocks.openFileDirect.mockImplementation(async () => {
            state.pendingDjvu.value = path;
            return {
                status: 'prepared',
                result: {
                    kind: 'djvu',
                    originalPath: path,
                },
            };
        });
        mocks.openDjvuFile.mockImplementation(async () => {
            await activation.promise;
            state.isDjvuMode.value = true;
            state.djvuSourcePath.value = path;
            return true;
        });

        const controller = useWorkspaceFileLifecycleController();
        let settled = false;
        const openPromise = controller.openFileDirectWithViewerLifecycle(path).finally(() => {
            settled = true;
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(settled).toBe(false);
        expect(state.pendingDjvu.value).toBeNull();
        expect(mocks.openDjvuFile).toHaveBeenCalledTimes(1);

        activation.resolve();
        await expect(openPromise).resolves.toMatchObject({status: 'opened'});
        expect(settled).toBe(true);
        expect(mocks.openDjvuFile).toHaveBeenCalledTimes(1);
        expect(mocks.cleanupDjvuTemp).not.toHaveBeenCalled();
        expect(mocks.exitDjvuMode).not.toHaveBeenCalled();
    });

    it('reports a superseded DjVu activation as stale even when the path matches newer state', async () => {
        const path = requireDocumentRef('/docs/same.djvu');
        mocks.openFileDirect.mockImplementation(async () => {
            state.pendingDjvu.value = path;
            return {
                status: 'prepared',
                result: {
                    kind: 'djvu',
                    originalPath: path,
                },
            };
        });
        mocks.openDjvuFile.mockImplementation(async () => {
            state.isDjvuMode.value = true;
            state.djvuSourcePath.value = path;
            return false;
        });

        const controller = useWorkspaceFileLifecycleController();

        await expect(controller.openFileDirectWithViewerLifecycle(path)).resolves.toMatchObject({status: 'stale'});
    });

    it('does not let a delayed close clear a newer activation of the same DjVu path', async () => {
        const path = requireDocumentRef('/docs/same.djvu');
        const cleanup = createDeferred();
        const olderActivation = {
            generation: 1,
            kind: 'djvu' as const,
            documentRef: path,
        };
        state.activeDjvuActivation = olderActivation;
        state.djvuSourcePath.value = path;
        state.isDjvuMode.value = true;
        mocks.cleanupDjvuTemp.mockImplementation(async () => cleanup.promise);

        const controller = useWorkspaceFileLifecycleController();
        const closing = controller.closeFileWithViewerLifecycle();
        await vi.waitFor(() => expect(mocks.cleanupDjvuTemp).toHaveBeenCalledWith(olderActivation));

        const newerActivation = {
            generation: 2,
            kind: 'djvu' as const,
            documentRef: path,
        };
        state.activeDjvuActivation = newerActivation;
        mocks.openFileDirect.mockImplementation(async () => {
            state.pendingDjvu.value = path;
            return {
                status: 'prepared',
                result: {
                    kind: 'djvu',
                    originalPath: path,
                },
            };
        });
        mocks.openDjvuFile.mockImplementation(async () => {
            state.isDjvuMode.value = true;
            state.djvuSourcePath.value = path;
            return true;
        });
        const reopening = controller.openFileDirectWithViewerLifecycle(path);
        cleanup.resolve();
        await Promise.all([
            closing,
            reopening,
        ]);

        expect(mocks.exitDjvuMode).toHaveBeenCalledWith(olderActivation);
        expect(mocks.closeFile).not.toHaveBeenCalled();
        expect(state.activeDjvuActivation).toEqual(newerActivation);
        expect(state.djvuSourcePath.value).toBe(path);
        expect(state.isDjvuMode.value).toBe(true);
    });

    it('aborts an active projection when the user cancels DjVu work', async () => {
        const projection = createDeferred();
        let projectionSignal: AbortSignal | undefined;
        mocks.ensurePdfProjectionForAction.mockImplementation(async (
            _reason,
            _openConvertedPdf,
            signal: AbortSignal,
        ) => {
            projectionSignal = signal;
            await projection.promise;
        });
        state.djvuSourcePath.value = '/docs/scan.djvu';
        state.isDjvuMode.value = true;

        const controller = useWorkspaceFileLifecycleController();
        const ensurePromise = controller.ensureDjvuPdfProjection('edit');
        await vi.waitFor(() => expect(projectionSignal).toBeInstanceOf(AbortSignal));

        controller.handleDjvuCancel();

        expect(projectionSignal?.aborted).toBe(true);
        expect(mocks.cancelActiveJobs).toHaveBeenCalledOnce();

        projection.resolve();
        await expect(ensurePromise).resolves.toBeUndefined();

        let replacementSignal: AbortSignal | undefined;
        mocks.ensurePdfProjectionForAction.mockImplementation(async (
            _reason,
            _openConvertedPdf,
            signal: AbortSignal,
        ) => {
            replacementSignal = signal;
        });
        await expect(controller.ensureDjvuPdfProjection('ocr')).resolves.toBeUndefined();
        expect(replacementSignal).not.toBe(projectionSignal);
        expect(replacementSignal?.aborted).toBe(false);
    });

    it('aborts an active projection before closing the document', async () => {
        const projection = createDeferred();
        let projectionSignal: AbortSignal | undefined;
        mocks.ensurePdfProjectionForAction.mockImplementation(async (
            _reason,
            _openConvertedPdf,
            signal: AbortSignal,
        ) => {
            projectionSignal = signal;
            await projection.promise;
        });
        state.djvuSourcePath.value = '/docs/scan.djvu';
        state.isDjvuMode.value = true;

        const controller = useWorkspaceFileLifecycleController();
        const ensurePromise = controller.ensureDjvuPdfProjection('save-as-pdf');
        await vi.waitFor(() => expect(projectionSignal).toBeInstanceOf(AbortSignal));

        const closePromise = controller.closeFileWithViewerLifecycle();

        expect(projectionSignal?.aborted).toBe(true);
        projection.resolve();
        await expect(ensurePromise).resolves.toBeUndefined();
        await closePromise;
        expect(mocks.closeFile).toHaveBeenCalledOnce();
    });

    it('aborts an active projection when the workspace scope is disposed', async () => {
        const projection = createDeferred();
        let projectionSignal: AbortSignal | undefined;
        mocks.ensurePdfProjectionForAction.mockImplementation(async (
            _reason,
            _openConvertedPdf,
            signal: AbortSignal,
        ) => {
            projectionSignal = signal;
            await projection.promise;
        });
        state.djvuSourcePath.value = '/docs/scan.djvu';
        state.isDjvuMode.value = true;

        const scope = effectScope();
        let ensurePromise: Promise<unknown> | undefined;
        scope.run(() => {
            const controller = useWorkspaceFileLifecycleController();
            ensurePromise = controller.ensureDjvuPdfProjection('edit');
        });
        await vi.waitFor(() => expect(projectionSignal).toBeInstanceOf(AbortSignal));

        scope.stop();

        expect(projectionSignal?.aborted).toBe(true);
        projection.resolve();
        await expect(ensurePromise).resolves.toBeUndefined();
    });
});
