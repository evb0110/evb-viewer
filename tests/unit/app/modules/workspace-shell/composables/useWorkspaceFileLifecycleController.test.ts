import {beforeEach, describe, expect, it, vi} from 'vitest';
import {computed, effectScope, ref} from 'vue';
import {requireDocumentRef} from '@contracts/documentRef';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {SerializableError} from '@contracts/serializableError';
import {requireEpochMs} from '@contracts/timestamps';
import {createWorkspaceDocumentController} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import {createPdfSourceJob} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSessionSlot';
import type {IWorkspaceViewerLifecycleHooks} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes';

const mocks = vi.hoisted(() => ({
    convertToPdf: vi.fn(),
    openDjvuFile: vi.fn(),
    openFileDirect: vi.fn(),
    ensurePdfProjectionForAction: vi.fn(),
    cancelActiveJobs: vi.fn(),
    supersedePendingOpen: vi.fn(),
    releaseActiveSource: vi.fn(),
    closeFile: vi.fn(),
}));

const state = vi.hoisted(() => ({
    originalPath: {value: null as string | null},
    pdfError: {value: null as string | null},
    pdfFailurePresentation: {value: null as unknown},
    pendingDjvu: {value: null as string | null},
    workingCopyPath: {value: null as string | null},
}));

const djvuState = {
    sourcePath: ref<string | null>(null),
    isDjvuMode: ref(false),
};

vi.mock('@app/modules/workspace-shell/composables/usePdfFile', () => ({
    usePdfFile: () => ({
        pdfSrc: ref(null),
        pdfReloadSrc: ref(null),
        pdfData: ref(null),
        pdfRasterDisplayProfile: ref(null),
        workingCopyPath: state.workingCopyPath,
        openedWorkingCopyPath: ref(null),
        originalPath: state.originalPath,
        documentRevisionInfo: ref(null),
        documentRevisionToken: ref(null),
        fileName: ref(null),
        isDirty: ref(false),
        requiresSaveAsOnFirstSave: ref(false),
        recoveryDirtyBaseline: ref(false),
        wasEncrypted: ref(false),
        pdfConformanceProfile: ref(null),
        lastSaveMode: ref(null),
        error: state.pdfError,
        failurePresentation: state.pdfFailurePresentation,
        isElectron: ref(true),
        pendingDjvu: state.pendingDjvu,
        publishPdfSource: vi.fn(),
        notifyPdfInitialVisualReady: vi.fn(),
        pickFileToOpen: vi.fn(),
        openFile: vi.fn(),
        openFileDirect: mocks.openFileDirect,
        openFileDirectBatch: vi.fn(),
        ensureHistoryBaselineForMutation: vi.fn(),
        reloadWorkingCopyRevision: vi.fn(),
        reloadWorkingCopyIntoHistory: vi.fn(),
        mapHistoryPage: vi.fn(),
        closeFile: mocks.closeFile,
        repairWorkingCopy: vi.fn(),
        optimizeWorkingCopy: vi.fn(),
        optimizeWorkingCopyAsCopy: vi.fn(),
        saveWorkingCopy: vi.fn(),
        trySavePdfNativeMutations: vi.fn(),
        saveWorkingCopyAs: vi.fn(),
        markDirty: vi.fn(),
        setWorkspaceCommandSink: vi.fn(),
        resetForClose: vi.fn(),
    }),
}));

vi.mock('@app/composables/useDjvu', () => ({
    useDjvu: () => ({
        source: computed(() => ({
            isDjvuMode: djvuState.isDjvuMode.value,
            sourcePath: djvuState.sourcePath.value,
            openingPath: null,
            sourceError: null,
            sourceSizeBytes: null,
        })),
        conversionState: computed(() => ({
            isConverting: false,
            phase: null,
            percent: 0,
        })),
        openDjvuFile: mocks.openDjvuFile,
        convertToPdf: mocks.convertToPdf,
        ensurePdfProjectionForAction: mocks.ensurePdfProjectionForAction,
        cancelActiveJobs: mocks.cancelActiveJobs,
        supersedePendingOpen: mocks.supersedePendingOpen,
        releaseActiveSource: mocks.releaseActiveSource,
    }),
}));

vi.mock('@app/composables/useRecentFiles', () => ({
    useRecentFiles: () => ({
        recentFiles: ref([]),
        loadRecentFiles: vi.fn(),
        removeRecentFile: vi.fn(),
        clearRecentFiles: vi.fn(),
    }),
}));

const {useWorkspaceFileLifecycleController} = await import('@app/modules/workspace-shell/composables/useWorkspaceFileLifecycleController');

function createController(hooks?: () => IWorkspaceViewerLifecycleHooks[]) {
    const document = createWorkspaceDocumentController({tabId: 'tab-1'});
    return Object.assign(
        useWorkspaceFileLifecycleController({
            ...(hooks ? {createViewerLifecycleHooks: hooks} : {}),
            runDocumentOpen: async (_request, run) => (await run()).status === 'opened',
            document,
            admitPdfSource: (intent) => createPdfSourceJob(intent, {}),
            resetDocumentPresentation: vi.fn(),
        }),
        {document},
    );
}

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
        djvuState.sourcePath.value = null;
        djvuState.isDjvuMode.value = false;
        state.originalPath.value = null;
        state.pdfError.value = null;
        state.pdfFailurePresentation.value = null;
        state.pendingDjvu.value = null;
        state.workingCopyPath.value = null;
        mocks.ensurePdfProjectionForAction.mockResolvedValue(true);
        mocks.cancelActiveJobs.mockResolvedValue(false);
        mocks.releaseActiveSource.mockImplementation(() => {
            if (!djvuState.isDjvuMode.value) {
                return false;
            }
            djvuState.sourcePath.value = null;
            djvuState.isDjvuMode.value = false;
            return true;
        });
    });

    it('narrows the outward file lifecycle surface while keeping transfer closeFile', () => {
        const controller = createController();
        expect(controller).not.toHaveProperty('openFile');
        expect(controller).not.toHaveProperty('openFileDirect');
        expect(controller).not.toHaveProperty('openFileDirectBatch');
        expect(controller).not.toHaveProperty('pendingDjvu');
        expect(controller).not.toHaveProperty('openDjvuFile');
        expect(controller).not.toHaveProperty('resetForClose');
        expect(controller).not.toHaveProperty('lastSaveMode');
        expect(controller.closeFile).toBe(mocks.closeFile);
    });

    it('gates DjVu convert dialog state on DjVu mode and closes it on release', async () => {
        const controller = createController();
        controller.openConvertDialog();
        expect(controller.showConvertDialog.value).toBe(false);

        djvuState.isDjvuMode.value = true;
        djvuState.sourcePath.value = '/docs/scan.djvu';
        controller.openConvertDialog();
        expect(controller.showConvertDialog.value).toBe(true);

        controller.setConvertDialogOpen(false);
        expect(controller.showConvertDialog.value).toBe(false);

        controller.setConvertDialogOpen(true);
        expect(controller.showConvertDialog.value).toBe(true);

        await controller.closeFileWithViewerLifecycle();
        expect(controller.showConvertDialog.value).toBe(false);

        controller.setConvertDialogOpen(true);
        expect(controller.showConvertDialog.value).toBe(false);
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

        const controller = createController();
        await controller.handleDjvuConvert(2, true, 'compact-djvu-aware');

        expect(mocks.convertToPdf).toHaveBeenCalledWith(2, true, 'compact-djvu-aware', expect.any(Function));
        expect(mocks.openFileDirect).toHaveBeenCalledWith('/tmp/output.pdf', undefined);
    });

    it("stops the document's conversion before a close releases its source", async () => {
        const cancelled = createDeferred();
        mocks.cancelActiveJobs.mockImplementation(async () => {
            await cancelled.promise;
            return true;
        });
        djvuState.sourcePath.value = '/docs/scan.djvu';
        djvuState.isDjvuMode.value = true;

        const closing = createController().closeFileWithViewerLifecycle();
        await Promise.resolve();
        // The conversion has not stopped yet: the source is still the document's.
        expect(djvuState.sourcePath.value).toBe('/docs/scan.djvu');

        cancelled.resolve();
        await closing;
        expect(djvuState.sourcePath.value).toBeNull();
        expect(mocks.releaseActiveSource).toHaveBeenCalledOnce();
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
            djvuState.isDjvuMode.value = true;
            djvuState.sourcePath.value = path;
            return true;
        });

        const controller = createController();
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
        expect(mocks.releaseActiveSource).not.toHaveBeenCalled();
    });

    it('releases the active DjVu source when a PDF opens into the tab', async () => {
        const djvuPath = requireDocumentRef('/docs/scan.djvu');
        const pdfPath = requireDocumentRef('/docs/book.pdf');
        const pdfWorkingPath = requireDocumentRef('/tmp/book-working.pdf');
        djvuState.sourcePath.value = djvuPath;
        djvuState.isDjvuMode.value = true;
        mocks.openFileDirect.mockImplementation(async () => {
            state.workingCopyPath.value = pdfWorkingPath;
            return {
                status: 'opened',
                result: {
                    kind: 'pdf',
                    originalPath: pdfPath,
                    workingPath: pdfWorkingPath,
                },
            };
        });

        const controller = createController();
        await expect(controller.openFileDirectWithViewerLifecycle(pdfPath)).resolves.toMatchObject({status: 'opened'});

        expect(mocks.supersedePendingOpen).toHaveBeenCalledOnce();
        expect(mocks.releaseActiveSource).toHaveBeenCalledOnce();
        expect(djvuState.isDjvuMode.value).toBe(false);
        expect(djvuState.sourcePath.value).toBeNull();
    });

    it("explains a damaged DjVu in the user's words and keeps the native cause for Copy details", async () => {
        const path = requireDocumentRef('/docs/corrupt.djvu');
        const nativeCause = 'djvused failed with exit code 10. *** (DjVuDocEditor.cpp:178) file://localhost/docs/corrupt.djvu';
        const receipt: FailureReceipt = {
            code: 'MAIN_DJVU_VIEWING_FAILED',
            eventId: 'e'.repeat(32),
            occurredAt: requireEpochMs(1),
            severity: 'error',
        };
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
        mocks.openDjvuFile.mockRejectedValue(
            Object.assign(
                new SerializableError({
                    code: 'invalid-djvu',
                    message: nativeCause,
                }),
                {failure: receipt},
            ),
        );

        const outcome = await createController().openFileDirectWithViewerLifecycle(path);

        expect(outcome).toEqual({
            status: 'failed',
            error: 'errors.file.invalidDjvu',
        });
        expect(state.pdfError.value).toBe('errors.file.invalidDjvu');
        expect(state.pdfFailurePresentation.value).toMatchObject({
            failure: receipt,
            description: 'errors.file.invalidDjvu',
            technicalDetails: nativeCause,
        });
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
            djvuState.isDjvuMode.value = true;
            djvuState.sourcePath.value = path;
            return false;
        });

        const controller = createController();

        await expect(controller.openFileDirectWithViewerLifecycle(path)).resolves.toMatchObject({status: 'stale'});
    });

    it('does not let a delayed close clear a newer activation of the same DjVu path', async () => {
        const path = requireDocumentRef('/docs/same.djvu');
        const cancelGate = createDeferred();
        djvuState.sourcePath.value = path;
        djvuState.isDjvuMode.value = true;
        mocks.cancelActiveJobs.mockImplementationOnce(async () => {
            await cancelGate.promise;
            return true;
        });

        const controller = createController();
        const closing = controller.closeFileWithViewerLifecycle();
        await vi.waitFor(() => expect(mocks.cancelActiveJobs).toHaveBeenCalledOnce());

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
        // The activation commits the reopened document under its open, which starts a new instance.
        mocks.openDjvuFile.mockImplementation(
            async (_path: unknown, activation: {setOriginalPath: (documentPath: typeof path) => void}) => {
                activation.setOriginalPath(path);
                djvuState.isDjvuMode.value = true;
                djvuState.sourcePath.value = path;
                return true;
            },
        );
        // The reopen claims the document's open transaction, as every shell open does.
        controller.document.claimOpen({kind: 'open', target: null});
        const reopening = controller.openFileDirectWithViewerLifecycle(path);
        await reopening;
        cancelGate.resolve();
        await closing;

        expect(mocks.releaseActiveSource).not.toHaveBeenCalled();
        expect(mocks.closeFile).not.toHaveBeenCalled();
        expect(djvuState.sourcePath.value).toBe(path);
        expect(djvuState.isDjvuMode.value).toBe(true);
    });

    it('invalidates a still-probing DjVu open that started while Close awaited cancellation', async () => {
        const cancelGate = createDeferred();
        djvuState.sourcePath.value = '/docs/a.djvu';
        djvuState.isDjvuMode.value = true;
        mocks.cancelActiveJobs.mockImplementationOnce(async () => {
            await cancelGate.promise;
            return true;
        });

        const controller = createController();
        const closing = controller.closeFileWithViewerLifecycle();
        await vi.waitFor(() => expect(mocks.cancelActiveJobs).toHaveBeenCalledOnce());
        expect(mocks.supersedePendingOpen).toHaveBeenCalledTimes(1);

        cancelGate.resolve();
        await closing;

        expect(mocks.supersedePendingOpen).toHaveBeenCalledTimes(2);
        expect(mocks.releaseActiveSource).toHaveBeenCalledOnce();
        expect(mocks.closeFile).toHaveBeenCalledOnce();
    });

    it('does not invalidate a newer claimed DjVu open that starts while Close awaits cancellation', async () => {
        const cancelGate = createDeferred();
        djvuState.sourcePath.value = '/docs/a.djvu';
        djvuState.isDjvuMode.value = true;
        mocks.cancelActiveJobs.mockImplementationOnce(async () => {
            await cancelGate.promise;
            return true;
        });

        const controller = createController();
        const closing = controller.closeFileWithViewerLifecycle();
        await vi.waitFor(() => expect(mocks.cancelActiveJobs).toHaveBeenCalledOnce());
        expect(mocks.supersedePendingOpen).toHaveBeenCalledTimes(1);

        controller.document.claimOpen({
            kind: 'open',
            target: null,
        });
        cancelGate.resolve();
        await closing;

        expect(mocks.supersedePendingOpen).toHaveBeenCalledTimes(1);
        expect(mocks.releaseActiveSource).toHaveBeenCalledOnce();
        expect(mocks.closeFile).toHaveBeenCalledOnce();
    });

    it('keeps B when a close of A resumes after B presents', async () => {
        const cancelStarted = createDeferred();
        const resumeCancel = createDeferred();
        const aPath = requireDocumentRef('/docs/a.djvu');
        const bPath = requireDocumentRef('/docs/b.pdf');
        const bWorkingPath = requireDocumentRef('/tmp/b-working.pdf');
        djvuState.sourcePath.value = aPath;
        djvuState.isDjvuMode.value = true;
        mocks.cancelActiveJobs
            .mockImplementationOnce(async () => {
                cancelStarted.resolve();
                await resumeCancel.promise;
                return true;
            })
            .mockResolvedValue(false);
        mocks.closeFile.mockImplementation(async () => {
            state.workingCopyPath.value = null;
        });

        const controller = createController();
        mocks.openFileDirect.mockImplementation(async () => {
            state.workingCopyPath.value = bWorkingPath;
            controller.document.commitFile({originalPath: bPath, workingCopyPath: bWorkingPath, isDjvu: false});
            return {status: 'opened', result: {kind: 'pdf', originalPath: bPath, workingPath: bWorkingPath}};
        });

        const closing = controller.closeFileWithViewerLifecycle();
        try {
            await cancelStarted.promise;
            const newer = controller.document.runOpen({kind: 'open', target: null}, async () => {
                const result = await controller.openFileDirectWithViewerLifecycle(bPath);
                return result.status === 'opened' ? {presentation: Promise.resolve({status: 'presented'})} : null;
            });
            await expect(newer.finished).resolves.toEqual({status: 'presented'});
            expect(state.workingCopyPath.value).toBe(bWorkingPath);
            resumeCancel.resolve();
            await closing;
            expect(state.workingCopyPath.value).toBe(bWorkingPath);
            expect(mocks.closeFile).not.toHaveBeenCalled();
        } finally {
            resumeCancel.resolve();
            await closing;
        }
    });

    it('aborts an active projection when the user cancels DjVu work', async () => {
        const projection = createDeferred();
        let projectionSignal: AbortSignal | undefined;
        mocks.ensurePdfProjectionForAction.mockImplementation(async (_reason, _openConvertedPdf, signal: AbortSignal) => {
            projectionSignal = signal;
            await projection.promise;
        });
        djvuState.sourcePath.value = '/docs/scan.djvu';
        djvuState.isDjvuMode.value = true;

        const controller = createController();
        const ensurePromise = controller.ensureDjvuPdfProjection('edit');
        await vi.waitFor(() => expect(projectionSignal).toBeInstanceOf(AbortSignal));

        void controller.handleDjvuCancel();

        expect(projectionSignal?.aborted).toBe(true);
        expect(mocks.cancelActiveJobs).toHaveBeenCalledOnce();

        projection.resolve();
        await expect(ensurePromise).resolves.toBeUndefined();

        let replacementSignal: AbortSignal | undefined;
        mocks.ensurePdfProjectionForAction.mockImplementation(async (_reason, _openConvertedPdf, signal: AbortSignal) => {
            replacementSignal = signal;
        });
        await expect(controller.ensureDjvuPdfProjection('ocr')).resolves.toBeUndefined();
        expect(replacementSignal).not.toBe(projectionSignal);
        expect(replacementSignal?.aborted).toBe(false);
    });

    it('aborts an active projection before closing the document', async () => {
        const projection = createDeferred();
        let projectionSignal: AbortSignal | undefined;
        mocks.ensurePdfProjectionForAction.mockImplementation(async (_reason, _openConvertedPdf, signal: AbortSignal) => {
            projectionSignal = signal;
            await projection.promise;
        });
        djvuState.sourcePath.value = '/docs/scan.djvu';
        djvuState.isDjvuMode.value = true;

        const controller = createController();
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
        mocks.ensurePdfProjectionForAction.mockImplementation(async (_reason, _openConvertedPdf, signal: AbortSignal) => {
            projectionSignal = signal;
            await projection.promise;
        });
        djvuState.sourcePath.value = '/docs/scan.djvu';
        djvuState.isDjvuMode.value = true;

        const scope = effectScope();
        let ensurePromise: Promise<unknown> | undefined;
        scope.run(() => {
            const controller = createController();
            ensurePromise = controller.ensureDjvuPdfProjection('edit');
        });
        await vi.waitFor(() => expect(projectionSignal).toBeInstanceOf(AbortSignal));

        scope.stop();

        expect(projectionSignal?.aborted).toBe(true);
        projection.resolve();
        await expect(ensurePromise).resolves.toBeUndefined();
    });
});
