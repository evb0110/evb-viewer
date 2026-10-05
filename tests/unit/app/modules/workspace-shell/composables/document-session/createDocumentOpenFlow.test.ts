import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    watch,
} from 'vue';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import { IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES } from '@contracts/electronApiDocuments';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireEpochMs } from '@contracts/timestamps';
import { requirePageNumber } from '@contracts/pageNumbers';
import type { FailureReceipt } from '@contracts/diagnostics/failureReceipt';
import type { TTranslateFn } from '@i18n-app';
import {
    clearRegisteredPdfRasterDisplayProfilesForTests,
    getRegisteredPdfRasterDisplayProfileCountForTests,
    registerPdfRasterDisplayProfile,
} from '@app/types/pdfRasterDisplayProfile';
import {
    createDocumentSessionState,
    createEpochGuard,
} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import { createDocumentOpenFlow } from '@app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow';
import { createDocumentOpenSurfaceSession } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import {
    beginOpenSurfaceWithPageShape,
    readPdfPageShape,
} from '@app/modules/workspace-shell/composables/document-session/resolvePdfOpeningGeometry';
import {BrowserFilePickerSetupDeniedError} from '@app/platform/browser-api/browserFilePickerAdapter';
import {clearPdfValidationRevisionCacheForTests} from '@app/modules/workspace-shell/composables/document-session/pdfValidationRevisionCache';
import {useDocumentPasswordPrompt} from '@app/modules/workspace-shell/composables/useDocumentPasswordPrompt';
import { BrowserLogger } from '@app/utils/browserLogger';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

const mocks = vi.hoisted(() => ({
    documentFiles: {
        readFile: vi.fn(),
        readFileRange: vi.fn(),
        statFile: vi.fn(),
        writeFile: vi.fn(),
        getDocumentRevision: vi.fn(),
        getPdfOpeningGeometry: vi.fn(),
    },
    documentOpen: {
        onOpenDocumentDirectBatchProgress: vi.fn(() => vi.fn()),
        openDocumentDirect: vi.fn(),
        openDocumentDirectBatch: vi.fn(),
    },
    documentPdf: {validatePdfPath: vi.fn()},
    documentPicker: { openDocumentDialog: vi.fn() },
    documentRecentFiles: {recentFiles: {get: vi.fn()}},
    performanceProfile: {
        tier: 'medium',
        lowCpu: false,
        lowMemory: false,
        maxCachedPdfPages: 48,
    },
}));

const platformApi = createElectronPlatformApiFixture({
    documentFiles: mocks.documentFiles,
    documentOpen: mocks.documentOpen,
    documentPdf: mocks.documentPdf,
    documentPicker: mocks.documentPicker,
    documentRecentFiles: mocks.documentRecentFiles,
});
vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => platformApi}));
vi.mock('@app/utils/performanceProfile', () => ({
    getPerformanceProfile: () => mocks.performanceProfile,
    resolvePerformanceProfile: () => mocks.performanceProfile,
}));

const PDF_BYTES = Uint8Array.from([
    37,
    80,
    68,
    70,
]);

interface IResetHistoryTestOptions {
    reuseSnapshot?: boolean;
    isCurrent?: (() => boolean) | undefined;
}

function createOpenFlowHarness() {
    const state = createDocumentSessionState({ isDesktopRuntime: ref(true) });
    const deps = {
        cleanupAbandonedWorkingCopy: vi.fn(async () => undefined),
        clearPdfConformanceProfile: vi.fn(),
        cleanupPreviousWorkingCopy: vi.fn(async () => undefined),
        deferPdfConformanceProfile: vi.fn(),
        ensureHistoryBaselineForMutation: vi.fn(async () => true),
        incrementSessionVersion: vi.fn(),
        loadEpoch: createEpochGuard(),
        openEpoch: createEpochGuard(),
        pushHistorySnapshot: vi.fn(async () => true),
        resetHistory: vi.fn(async (_snapshot, options?: IResetHistoryTestOptions) => options?.isCurrent?.() !== false),
        syncDirtyFromHistory: vi.fn(),
        t: ((key: string) => key) as TTranslateFn,
    };

    return {
        deps,
        openFlow: createDocumentOpenFlow(state, deps),
        state,
    };
}

describe('createDocumentOpenFlow', () => {
    it('clears the encryption witness when a document session closes', () => {
        const state = createDocumentSessionState({ isDesktopRuntime: ref(true) });
        state.wasEncrypted.value = true;

        state.resetForClose();

        expect(state.wasEncrypted.value).toBe(false);
    });

    afterEach(() => {
        useDocumentPasswordPrompt().cancelPasswordPrompt();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        clearPdfValidationRevisionCacheForTests();
        clearRegisteredPdfRasterDisplayProfilesForTests();
        mocks.documentFiles.statFile.mockResolvedValue({ size: PDF_BYTES.byteLength });
        mocks.documentFiles.readFile.mockResolvedValue(PDF_BYTES);
        mocks.documentFiles.readFileRange.mockResolvedValue(new Uint8Array());
        mocks.documentFiles.writeFile.mockResolvedValue(true);
        mocks.documentPdf.validatePdfPath.mockResolvedValue({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        mocks.documentRecentFiles.recentFiles.get.mockResolvedValue([]);
        mocks.documentFiles.getDocumentRevision.mockImplementation(async (path: string) => ({
            version: 1,
            token: `revision:${path}`,
            documentRef: path,
            authority: 'electron-working-copy',
            contentRevision: 0,
            mintedAt: 1,
        }));
        mocks.performanceProfile.lowCpu = false;
        mocks.performanceProfile.lowMemory = false;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reuses successful validation only for the same immutable source revision', async () => {
        const {openFlow} = createOpenFlowHarness();
        const result = {
            kind: 'pdf' as const,
            originalPath: requireDocumentRef('/documents/reopened.pdf'),
            workingPath: requireDocumentRef('/tmp/reopened-working.pdf'),
        };
        let sourceModifiedAt = 100;
        mocks.documentFiles.statFile.mockImplementation(async (path: string) => path === result.originalPath
            ? {
                size: PDF_BYTES.byteLength,
                modifiedAt: requireEpochMs(sourceModifiedAt),
            }
            : {size: PDF_BYTES.byteLength});

        await expect(openFlow.openFile(result)).resolves.toMatchObject({status: 'opened'});
        await expect(openFlow.openFile(result)).resolves.toMatchObject({status: 'opened'});
        sourceModifiedAt = 101;
        await expect(openFlow.openFile(result)).resolves.toMatchObject({status: 'opened'});

        expect(mocks.documentPdf.validatePdfPath).toHaveBeenCalledTimes(2);
    });

    it('reads PDF state with the split document files stat capability', async () => {
        const { openFlow } = createOpenFlowHarness();

        const nextState = await openFlow.readPdfStateFromPath(requireDocumentRef('/tmp/work.pdf'));

        expect(nextState.pdfData).toEqual(PDF_BYTES);
        expect(mocks.documentFiles.statFile).toHaveBeenCalledWith('/tmp/work.pdf');
        expect(mocks.documentFiles.readFile).toHaveBeenCalledWith('/tmp/work.pdf');
    });

    it('localizes browser picker setup denial without exposing its transport code', async () => {
        const receipt = {
            code: 'UNCLASSIFIED_RENDERER_ERROR',
            eventId: 'open-failure-123456789',
            occurredAt: 1,
            severity: 'error',
        } as FailureReceipt;
        const capture = vi.spyOn(BrowserLogger, 'error').mockReturnValue(receipt);
        mocks.documentPicker.openDocumentDialog.mockRejectedValueOnce(
            new BrowserFilePickerSetupDeniedError(),
        );
        const {
            openFlow,
            state,
        } = createOpenFlowHarness();

        await expect(openFlow.openFile()).resolves.toEqual({
            status: 'failed',
            error: 'errors.browser.filePickerSetupDenied',
        });
        expect(state.error.value).toBe('errors.browser.filePickerSetupDenied');
        expect(capture).toHaveBeenCalledOnce();
        expect(state.failurePresentation.value?.failure).toBe(receipt);
    });

    it('retries typed password failures until the writer-backed open succeeds', async () => {
        const {
            openFlow,
            state,
        } = createOpenFlowHarness();
        const prompt = useDocumentPasswordPrompt();
        const protectedPath = requireDocumentRef('/documents/protected.pdf');
        const needsPassword: TOpenFileResult = {
            kind: 'pdf-needs-password',
            originalPath: protectedPath,
        };
        const openedPdf: TOpenFileResult = {
            kind: 'pdf',
            originalPath: protectedPath,
            workingPath: requireDocumentRef('/tmp/protected-working.pdf'),
            wasEncrypted: true,
        };
        mocks.documentOpen.openDocumentDirect
            .mockResolvedValueOnce(needsPassword)
            .mockResolvedValueOnce(needsPassword)
            .mockResolvedValueOnce(openedPdf);

        const opening = openFlow.openFileDirect(protectedPath);
        await vi.waitFor(() => {
            expect(prompt.open.value).toBe(true);
        });
        expect(prompt.fileName.value).toBe('protected.pdf');
        prompt.submitPassword('wrong-password');

        await vi.waitFor(() => {
            expect(prompt.open.value).toBe(true);
            expect(prompt.errorMessage.value).toBe('errors.file.passwordPromptIncorrect');
        });
        prompt.submitPassword('correct-password');

        await expect(opening).resolves.toMatchObject({
            status: 'opened',
            result: openedPdf,
        });
        expect(prompt.open.value).toBe(false);
        expect(mocks.documentOpen.openDocumentDirect).toHaveBeenNthCalledWith(
            1,
            protectedPath,
        );
        expect(mocks.documentOpen.openDocumentDirect).toHaveBeenNthCalledWith(
            2,
            protectedPath,
            'wrong-password',
        );
        expect(mocks.documentOpen.openDocumentDirect).toHaveBeenNthCalledWith(
            3,
            protectedPath,
            'correct-password',
        );
        expect(state.originalPath.value).toBe(protectedPath);
        expect(state.wasEncrypted.value).toBe(true);
    });

    it('cancels a password open without retaining or persisting the password', async () => {
        const {
            openFlow,
            state,
        } = createOpenFlowHarness();
        const prompt = useDocumentPasswordPrompt();
        const protectedPath = requireDocumentRef('/documents/protected.pdf');
        mocks.documentOpen.openDocumentDirect.mockResolvedValueOnce({
            kind: 'pdf-needs-password',
            originalPath: protectedPath,
        });

        const opening = openFlow.openFileDirect(protectedPath);
        await vi.waitFor(() => {
            expect(prompt.open.value).toBe(true);
        });
        prompt.cancelPasswordPrompt();

        await expect(opening).resolves.toEqual({status: 'cancelled'});
        expect(mocks.documentOpen.openDocumentDirect).toHaveBeenCalledOnce();
        expect(state.workingCopyPath.value).toBeNull();
        expect(prompt.open.value).toBe(false);
        expect(prompt.fileName.value).toBe('');
        expect(prompt.errorMessage.value).toBeNull();
    });

    it('returns a stale outcome when a second open supersedes a password prompt', async () => {
        const {openFlow} = createOpenFlowHarness();
        const prompt = useDocumentPasswordPrompt();
        const firstPath = requireDocumentRef('/documents/first-protected.pdf');
        const secondPath = requireDocumentRef('/documents/second.pdf');
        const secondResult: TOpenFileResult = {
            kind: 'pdf',
            originalPath: secondPath,
            workingPath: requireDocumentRef('/tmp/second-working.pdf'),
        };
        mocks.documentOpen.openDocumentDirect.mockImplementation(async (path: string) => (
            path === firstPath
                ? {
                    kind: 'pdf-needs-password',
                    originalPath: firstPath,
                }
                : secondResult
        ));

        const firstOpening = openFlow.openFileDirect(firstPath);
        await vi.waitFor(() => {
            expect(prompt.open.value).toBe(true);
        });
        const secondOpening = openFlow.openFileDirect(secondPath);

        await expect(secondOpening).resolves.toMatchObject({
            status: 'opened',
            result: secondResult,
        });
        await expect(firstOpening).resolves.toMatchObject({status: 'stale'});
    });

    it('reports unsupported encryption without opening a password prompt', async () => {
        const {
            openFlow,
            state,
        } = createOpenFlowHarness();
        const prompt = useDocumentPasswordPrompt();
        const protectedPath = requireDocumentRef('/documents/unsupported.pdf');
        mocks.documentOpen.openDocumentDirect.mockResolvedValueOnce({
            kind: 'pdf-unsupported-encryption',
            originalPath: protectedPath,
        });

        await expect(openFlow.openFileDirect(protectedPath)).resolves.toEqual({
            status: 'failed',
            error: 'errors.file.unsupportedEncryption',
        });
        expect(prompt.open.value).toBe(false);
        expect(state.error.value).toBe('errors.file.unsupportedEncryption');
    });

    it('retains the active PDF when a staged replacement fails parser validation', async () => {
        const {
            deps,
            openFlow,
            state,
        } = createOpenFlowHarness();
        const activeData = Uint8Array.of(1, 2, 3);
        const activeSource = new Blob([activeData], {type: 'application/pdf'});
        state.originalPath.value = requireDocumentRef('/documents/active.pdf');
        state.workingCopyPath.value = requireDocumentRef('/tmp/active-working.pdf');
        state.pdfData.value = activeData;
        state.pdfSrc.value = activeSource;
        state.pdfReloadSrc.value = activeSource;
        state.isDirty.value = true;
        const corruptCandidate: TOpenFileResult = {
            kind: 'pdf',
            originalPath: requireDocumentRef('/documents/corrupt.pdf'),
            workingPath: requireDocumentRef('/tmp/corrupt-working.pdf'),
        };
        mocks.documentPdf.validatePdfPath.mockResolvedValueOnce({
            isValid: false,
            tool: 'qpdf',
            errors: ['damaged xref table'],
            warnings: [],
        });

        await expect(openFlow.openFile(corruptCandidate)).resolves.toMatchObject({
            status: 'failed',
            error: 'errors.file.invalid',
        });

        expect(mocks.documentPdf.validatePdfPath).toHaveBeenCalledWith(
            '/tmp/corrupt-working.pdf',
            {purpose: 'opening'},
        );
        expect(state.originalPath.value).toBe('/documents/active.pdf');
        expect(state.workingCopyPath.value).toBe('/tmp/active-working.pdf');
        expect(state.pdfData.value).toBe(activeData);
        expect(state.pdfSrc.value).toBe(activeSource);
        expect(state.pdfReloadSrc.value).toBe(activeSource);
        expect(state.isDirty.value).toBe(true);
        expect(deps.resetHistory).not.toHaveBeenCalled();
        expect(deps.cleanupPreviousWorkingCopy).not.toHaveBeenCalled();
        expect(deps.cleanupAbandonedWorkingCopy).toHaveBeenCalledWith('/tmp/corrupt-working.pdf');
    });

    it('keeps the opened document\'s source through a history step that moves to a new copy', async () => {
        const {
            openFlow,
            state,
        } = createOpenFlowHarness();
        // The document as an open left it.
        state.openedWorkingCopyPath.value = requireDocumentRef('/tmp/edited-working.pdf');

        await openFlow.applyLoadedPdfState(requireDocumentRef('/tmp/edited-history-copy.pdf'), {
            pdfData: null,
            pdfSrc: new Blob([], {type: 'application/pdf'}),
        }, {preserveHistory: true});

        expect(state.workingCopyPath.value).toBe('/tmp/edited-history-copy.pdf');
        expect(state.openedWorkingCopyPath.value).toBe('/tmp/edited-working.pdf');
    });

    it('keeps a recovered ordinary PDF dirty without requiring Save As', async () => {
        const {
            deps,
            openFlow,
            state,
        } = createOpenFlowHarness();
        const recoveryBaselineDuringHistoryReset: boolean[] = [];
        deps.resetHistory.mockImplementation(async (_snapshot, options?: IResetHistoryTestOptions) => {
            recoveryBaselineDuringHistoryReset.push(state.recoveryDirtyBaseline.value);
            return options?.isCurrent?.() !== false;
        });
        const recoveredResult: TOpenFileResult = {
            kind: 'pdf',
            originalPath: requireDocumentRef('/documents/recovered.pdf'),
            workingPath: requireDocumentRef('/tmp/recovered-working.pdf'),
            isGenerated: false,
            recoveryDirtyBaseline: true,
        };

        await expect(openFlow.openFile(recoveredResult)).resolves.toMatchObject({status: 'opened'});

        expect(state.isDirty.value).toBe(true);
        expect(recoveryBaselineDuringHistoryReset).toEqual([true]);
        expect(state.requiresSaveAsOnFirstSave.value).toBe(false);
    });

    it('shows an opening working copy only once its admission ends, changing the shown source once', async () => {
        const harness = createOpenFlowHarness();
        const admissionReached = Promise.withResolvers<undefined>();
        const admission = Promise.withResolvers<undefined>();
        mocks.documentFiles.getPdfOpeningGeometry.mockResolvedValue({
            pageNumber: 1,
            pageCount: 40,
            width: 612,
            height: 792,
            rotation: 0,
            widestPageWidth: 612,
            size: 1,
            modifiedAt: 1,
        });
        const openFlow = createDocumentOpenFlow(harness.state, {
            ...harness.deps,
            // Admission is held, as a slow Recent read holds it.
            admitOpeningSource: async () => {
                admissionReached.resolve(undefined);
                await admission.promise;
            },
        });
        const result: TOpenFileResult = {
            kind: 'pdf',
            originalPath: requireDocumentRef('/documents/remembered.pdf'),
            workingPath: requireDocumentRef('/tmp/remembered-working.pdf'),
            isGenerated: false,
        };

        const opening = openFlow.openFile(result);
        await admissionReached.promise;
        await Promise.resolve();
        // While admission is held, no source is shown yet.
        expect(harness.state.pdfSrc.value).toBeNull();

        // The source a view shows changes once, to the admitted copy, through
        // the commit's awaits: its view defaults run against that one source.
        const shownSources: unknown[] = [];
        watch(() => harness.state.openedWorkingCopyPath.value ?? harness.state.pdfSrc.value, (shown) => {
            shownSources.push(shown);
        }, {flush: 'sync'});
        admission.resolve(undefined);
        await expect(opening).resolves.toMatchObject({status: 'opened'});
        expect(harness.state.pdfSrc.value).not.toBeNull();
        expect(shownSources).toEqual([result.workingPath]);
    });

    it('does not request cleanup when a recovered PDF fails before adoption', async () => {
        const {
            deps,
            openFlow,
        } = createOpenFlowHarness();
        deps.resetHistory.mockRejectedValue(new Error('injected recovered read failure'));
        const recoveredResult: TOpenFileResult = {
            kind: 'pdf',
            originalPath: requireDocumentRef('/documents/recovered-failure.pdf'),
            workingPath: requireDocumentRef('/tmp/recovered-failure-working.pdf'),
            recoveryDirtyBaseline: true,
        };

        await expect(openFlow.openFile(recoveredResult)).resolves.toMatchObject({status: 'failed'});
        expect(deps.cleanupAbandonedWorkingCopy).not.toHaveBeenCalled();
    });

    it('keeps a normal source reopen clean after a recovered dirty PDF', async () => {
        const {
            openFlow,
            state,
        } = createOpenFlowHarness();
        await openFlow.openFile({
            kind: 'pdf',
            originalPath: requireDocumentRef('/documents/recovered.pdf'),
            workingPath: requireDocumentRef('/tmp/recovered-working.pdf'),
            recoveryDirtyBaseline: true,
        });

        const cleanResult: TOpenFileResult = {
            kind: 'pdf',
            originalPath: requireDocumentRef('/documents/source.pdf'),
            workingPath: requireDocumentRef('/tmp/source-working.pdf'),
            recoveryDirtyBaseline: false,
        };
        await expect(openFlow.openFile(cleanResult)).resolves.toMatchObject({status: 'opened'});

        expect(state.isDirty.value).toBe(false);
        expect(state.requiresSaveAsOnFirstSave.value).toBe(false);
    });

    it('keeps generated PDFs dirty and requires their first Save As', async () => {
        const {
            openFlow,
            state,
        } = createOpenFlowHarness();
        const generatedResult: TOpenFileResult = {
            kind: 'pdf',
            originalPath: requireDocumentRef('/documents/generated.pdf'),
            workingPath: requireDocumentRef('/tmp/generated-working.pdf'),
            isGenerated: true,
            recoveryDirtyBaseline: false,
        };

        await expect(openFlow.openFile(generatedResult)).resolves.toMatchObject({status: 'opened'});

        expect(state.isDirty.value).toBe(true);
        expect(state.requiresSaveAsOnFirstSave.value).toBe(true);
    });

    it('keeps PDFs above the direct IPC ceiling path-backed', async () => {
        const { openFlow } = createOpenFlowHarness();
        const size = IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES + 1;
        mocks.documentFiles.statFile.mockResolvedValue({ size });

        const nextState = await openFlow.readPdfStateFromPath(requireDocumentRef('/tmp/large-work.pdf'));

        expect(nextState).toEqual({
            pdfData: null,
            pdfSrc: {
                kind: 'path',
                path: '/tmp/large-work.pdf',
                size,
            },
        });
        expect(mocks.documentFiles.readFile).not.toHaveBeenCalled();
        expect(mocks.documentFiles.readFileRange).not.toHaveBeenCalled();
    });

    it('keeps the inclusive 4 MiB low-memory boundary in memory', async () => {
        mocks.performanceProfile.lowMemory = true;
        const size = 4 * 1024 * 1024;
        const data = new Uint8Array(size);
        mocks.documentFiles.statFile.mockResolvedValue({size});
        mocks.documentFiles.readFile.mockResolvedValue(data);
        const {openFlow} = createOpenFlowHarness();

        const nextState = await openFlow.readPdfStateFromPath(requireDocumentRef('/tmp/boundary.pdf'));

        expect(nextState.pdfData).toBe(data);
        expect(nextState.pdfSrc).toBeInstanceOf(Blob);
        expect(mocks.documentFiles.readFile).toHaveBeenCalledWith('/tmp/boundary.pdf');
    });

    it('keeps a low-memory PDF one byte above 4 MiB path-backed', async () => {
        mocks.performanceProfile.lowMemory = true;
        const size = (4 * 1024 * 1024) + 1;
        mocks.documentFiles.statFile.mockResolvedValue({size});
        const {openFlow} = createOpenFlowHarness();

        await expect(openFlow.readPdfStateFromPath(requireDocumentRef('/tmp/above-boundary.pdf'))).resolves.toEqual({
            pdfData: null,
            pdfSrc: {
                kind: 'path',
                path: '/tmp/above-boundary.pdf',
                size,
            },
        });
        expect(mocks.documentFiles.readFile).not.toHaveBeenCalled();
        expect(mocks.documentFiles.readFileRange).not.toHaveBeenCalled();
    });

    it('opens an 8 MiB plus one low-memory PDF with empty clean file history', async () => {
        mocks.performanceProfile.lowMemory = true;
        const size = (8 * 1024 * 1024) + 1;
        mocks.documentFiles.statFile.mockResolvedValue({size});
        const {
            deps,
            openFlow,
        } = createOpenFlowHarness();

        await expect(openFlow.openFile({
            kind: 'pdf',
            originalPath: requireDocumentRef('/tmp/medium.pdf'),
            workingPath: requireDocumentRef('/tmp/medium-working.pdf'),
        })).resolves.toMatchObject({status: 'opened'});

        expect(deps.resetHistory).toHaveBeenCalledWith(null, {isCurrent: expect.any(Function)});
        expect(deps.pushHistorySnapshot).not.toHaveBeenCalled();
        expect(mocks.documentFiles.readFile).not.toHaveBeenCalled();
        expect(mocks.documentFiles.readFileRange).not.toHaveBeenCalled();
    });

    it('preserves the eager normal-profile baseline above 8 MiB', async () => {
        const size = (8 * 1024 * 1024) + 1;
        mocks.documentFiles.statFile.mockResolvedValue({size});
        mocks.documentFiles.readFileRange.mockImplementation(async (
            _path: string,
            _offset: number,
            length: number,
        ) => new Uint8Array(length));
        const {
            deps,
            openFlow,
        } = createOpenFlowHarness();

        await expect(openFlow.openFile({
            kind: 'pdf',
            originalPath: requireDocumentRef('/tmp/normal-medium.pdf'),
            workingPath: requireDocumentRef('/tmp/normal-medium-working.pdf'),
        })).resolves.toMatchObject({status: 'opened'});

        expect(deps.resetHistory).toHaveBeenCalledWith(
            expect.objectContaining({byteLength: size}),
            {
                reuseSnapshot: true,
                isCurrent: expect.any(Function),
            },
        );
    });

    it('persists in-memory PDF snapshots with the split document files write capability', async () => {
        const {
            openFlow,
            state,
        } = createOpenFlowHarness();
        state.workingCopyPath.value = requireDocumentRef('/tmp/work.pdf');
        const snapshot = Uint8Array.from([
            37,
            80,
            68,
            70,
            45,
        ]);

        await openFlow.loadPdfFromData(snapshot, { persistWorkingCopy: true });

        expect(mocks.documentFiles.writeFile).toHaveBeenCalledWith('/tmp/work.pdf', snapshot, undefined);
    });

    it('does not apply or persist PDF data when mutation baseline staging fails', async () => {
        const {
            deps,
            openFlow,
            state,
        } = createOpenFlowHarness();
        const before = new Uint8Array([1]);
        state.workingCopyPath.value = requireDocumentRef('/tmp/work.pdf');
        state.pdfData.value = before;
        deps.ensureHistoryBaselineForMutation.mockResolvedValue(false);

        await expect(openFlow.loadPdfFromData(
            new Uint8Array([2]),
            {persistWorkingCopy: true},
        )).resolves.toBeUndefined();

        expect(mocks.documentFiles.writeFile).not.toHaveBeenCalled();
        expect(deps.pushHistorySnapshot).not.toHaveBeenCalled();
        expect(state.pdfData.value).toBe(before);
    });

    it('cleans up a stale direct PDF working copy that was superseded before adoption', async () => {
        const {
            deps,
            openFlow,
            state,
        } = createOpenFlowHarness();
        const staleResult: TOpenFileResult = {
            kind: 'pdf',
            originalPath: requireDocumentRef('/stale.pdf'),
            workingPath: requireDocumentRef('/tmp/stale-working.pdf'),
            isGenerated: false,
            wasEncrypted: true,
        };
        const freshResult: TOpenFileResult = {
            kind: 'pdf',
            originalPath: requireDocumentRef('/fresh.pdf'),
            workingPath: requireDocumentRef('/tmp/fresh-working.pdf'),
            isGenerated: false,
        };
        const staleGate = Promise.withResolvers<TOpenFileResult>();
        mocks.documentOpen.openDocumentDirect.mockImplementation(async (path: string) => {
            if (path === '/stale.pdf') {
                return staleGate.promise;
            }
            return freshResult;
        });
        mocks.documentFiles.statFile.mockResolvedValue({ size: PDF_BYTES.byteLength });
        mocks.documentFiles.readFile.mockResolvedValue(PDF_BYTES);

        const staleOpen = openFlow.openFileDirect(requireDocumentRef('/stale.pdf'));
        await expect(openFlow.openFileDirect(requireDocumentRef('/fresh.pdf'))).resolves.toMatchObject({
            status: 'opened',
            result: freshResult,
        });

        staleGate.resolve(staleResult);
        await expect(staleOpen).resolves.toMatchObject({
            status: 'stale',
            result: staleResult,
        });

        expect(state.workingCopyPath.value).toBe('/tmp/fresh-working.pdf');
        expect(state.wasEncrypted.value).toBe(false);
        expect(deps.cleanupAbandonedWorkingCopy).toHaveBeenCalledWith('/tmp/stale-working.pdf');
        expect(deps.cleanupAbandonedWorkingCopy).not.toHaveBeenCalledWith('/tmp/fresh-working.pdf');
    });

    it('adopts direct-open raster display profiles for the opened PDF only', async () => {
        const {
            openFlow,
            state,
        } = createOpenFlowHarness();
        const profile = {
            kind: 'trusted-raster-djvu' as const,
            sourcePagePixels: [{
                width: 1293,
                height: 1966,
            }],
        };
        mocks.documentOpen.openDocumentDirect.mockImplementation(async (path: string) => ({
            kind: 'pdf',
            originalPath: path,
            workingPath: `/tmp/${path.replaceAll('/', '')}`,
        }));

        await expect(openFlow.openFileDirect(requireDocumentRef('/scan.pdf'), {rasterDisplayProfile: profile})).resolves.toMatchObject({status: 'opened'});

        expect(state.pdfRasterDisplayProfile.value).toStrictEqual(profile);

        await expect(openFlow.openFileDirect(requireDocumentRef('/ordinary.pdf'))).resolves.toMatchObject({status: 'opened'});

        expect(state.pdfRasterDisplayProfile.value).toBeNull();
    });

    it('adopts registered raster display profiles when reopening a generated PDF path', async () => {
        const {
            openFlow,
            state,
        } = createOpenFlowHarness();
        const profile = {
            kind: 'trusted-raster-djvu' as const,
            sourcePagePixels: [{
                width: 1293,
                height: 1966,
            }],
        };
        registerPdfRasterDisplayProfile(requireDocumentRef('/tmp/generated.pdf'), profile);
        mocks.documentOpen.openDocumentDirect.mockResolvedValue({
            kind: 'pdf',
            originalPath: requireDocumentRef('/tmp/generated.pdf'),
            workingPath: requireDocumentRef('/tmp/generated-working.pdf'),
        });

        await expect(openFlow.openFileDirect(requireDocumentRef('/tmp/generated.pdf'))).resolves.toMatchObject({status: 'opened'});

        expect(state.pdfRasterDisplayProfile.value).toStrictEqual(profile);
        expect(getRegisteredPdfRasterDisplayProfileCountForTests()).toBe(0);
        expect(mocks.documentFiles.statFile).toHaveBeenCalledWith('/tmp/generated.pdf');
        expect(mocks.documentFiles.statFile).toHaveBeenCalledWith('/tmp/generated-working.pdf');

        await expect(openFlow.openFileDirect(requireDocumentRef('/tmp/generated.pdf'))).resolves.toMatchObject({status: 'opened'});

        expect(state.pdfRasterDisplayProfile.value).toBeNull();
    });

    it('bounds pending raster display profile handoffs', () => {
        const profile = {
            kind: 'trusted-raster-djvu' as const,
            sourcePagePixels: [{
                width: 100,
                height: 200,
            }],
        };

        for (let index = 0; index < 100; index += 1) {
            registerPdfRasterDisplayProfile(requireDocumentRef(`/tmp/generated-${index}.pdf`), profile);
        }

        expect(getRegisteredPdfRasterDisplayProfileCountForTests()).toBe(64);
    });

    it('consumes a raster display profile handoff even when the target open fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const {
            openFlow,
            state,
        } = createOpenFlowHarness();
        const result: TOpenFileResult = {
            kind: 'pdf',
            originalPath: requireDocumentRef('/tmp/reused.pdf'),
            workingPath: requireDocumentRef('/tmp/reused-working.pdf'),
        };
        mocks.documentOpen.openDocumentDirect.mockResolvedValue(result);
        registerPdfRasterDisplayProfile(requireDocumentRef('/tmp/reused.pdf'), {
            kind: 'trusted-raster-djvu',
            sourcePagePixels: [{
                width: 100,
                height: 200,
            }],
        });
        mocks.documentFiles.readFile
            .mockRejectedValueOnce(new Error('load failed'))
            .mockResolvedValue(PDF_BYTES);

        await expect(openFlow.openFileDirect(requireDocumentRef('/tmp/reused.pdf'))).resolves.toMatchObject({status: 'failed'});
        expect(getRegisteredPdfRasterDisplayProfileCountForTests()).toBe(0);

        await expect(openFlow.openFileDirect(requireDocumentRef('/tmp/reused.pdf'))).resolves.toMatchObject({status: 'opened'});
        expect(state.pdfRasterDisplayProfile.value).toBeNull();
    });

    it('does not let a stale PDF open clobber dirty state or conformance after history reset', async () => {
        const {
            deps,
            openFlow,
            state,
        } = createOpenFlowHarness();
        const firstResult: TOpenFileResult = {
            kind: 'pdf',
            originalPath: requireDocumentRef('/first.pdf'),
            workingPath: requireDocumentRef('/tmp/first-working.pdf'),
            recoveryDirtyBaseline: true,
        };
        const secondResult: TOpenFileResult = {
            kind: 'pdf',
            originalPath: requireDocumentRef('/second.pdf'),
            workingPath: requireDocumentRef('/tmp/second-working.pdf'),
            isGenerated: false,
        };
        const firstHistoryResetGate = Promise.withResolvers<undefined>();
        let resetHistoryCalls = 0;
        deps.resetHistory.mockImplementation(async (_snapshot, options?: IResetHistoryTestOptions) => {
            resetHistoryCalls += 1;
            if (resetHistoryCalls === 1) {
                await firstHistoryResetGate.promise;
            }
            return options?.isCurrent?.() !== false;
        });
        mocks.documentFiles.statFile.mockResolvedValue({ size: PDF_BYTES.byteLength });
        mocks.documentFiles.readFile.mockResolvedValue(PDF_BYTES);

        const firstOpen = openFlow.openFile(firstResult);
        await vi.waitFor(() => {
            expect(deps.resetHistory).toHaveBeenCalledTimes(1);
        });

        await expect(openFlow.openFile(secondResult)).resolves.toMatchObject({
            status: 'opened',
            result: secondResult,
        });

        firstHistoryResetGate.resolve(undefined);
        await expect(firstOpen).resolves.toMatchObject({
            status: 'stale',
            result: firstResult,
        });

        expect(state.workingCopyPath.value).toBe('/tmp/second-working.pdf');
        expect(state.originalPath.value).toBe('/second.pdf');
        expect(state.isDirty.value).toBe(false);
        expect(deps.deferPdfConformanceProfile).toHaveBeenCalledTimes(1);
        expect(deps.deferPdfConformanceProfile).toHaveBeenCalledWith('/tmp/second-working.pdf', { fileSize: PDF_BYTES.byteLength });
        expect(deps.cleanupPreviousWorkingCopy).toHaveBeenCalledWith('/tmp/first-working.pdf', '/tmp/second-working.pdf');
    });

});

const shapedPath = requireDocumentRef('/books/grammar.pdf');
const pageShape = {
    pageNumber: requirePageNumber(1),
    pageCount: 116,
    width: 420,
    height: 640,
    rotation: 0 as const,
    widestPageWidth: 420,
    size: 12_000_000,
    modifiedAt: requireEpochMs(1),
};

function claim(transactionId: string) {
    return {
        documentId: shapedPath,
        documentRevision: `open-intent:${transactionId}`,
        provisional: true,
    };
}

describe('the opening surface takes the page shape at its claim', () => {
    it('claims with the page shape main already answered, so the first frame has it', async () => {
        mocks.documentFiles.getPdfOpeningGeometry.mockResolvedValue(pageShape);
        const read = readPdfPageShape(shapedPath);
        await read?.answer;
        const openSurface = createDocumentOpenSurfaceSession();

        beginOpenSurfaceWithPageShape(openSurface, claim('1'), 1, read);

        expect(openSurface.snapshot.value.openingPageGeometry).toMatchObject({
            documentId: shapedPath,
            width: 420,
            height: 640,
        });
    });

    it('commits a page shape still on its way when it arrives', async () => {
        const answer = Promise.withResolvers<typeof pageShape>();
        mocks.documentFiles.getPdfOpeningGeometry.mockReturnValue(answer.promise);
        const read = readPdfPageShape(shapedPath);
        const openSurface = createDocumentOpenSurfaceSession();

        beginOpenSurfaceWithPageShape(openSurface, claim('1'), 1, read);
        expect(openSurface.snapshot.value.openingPageGeometry).toBeNull();
        answer.resolve(pageShape);

        await vi.waitFor(() => expect(openSurface.snapshot.value.openingPageGeometry).toMatchObject({width: 420}));
    });

    it('drops a page shape that arrives after another open took the surface', async () => {
        const answer = Promise.withResolvers<typeof pageShape>();
        mocks.documentFiles.getPdfOpeningGeometry.mockReturnValue(answer.promise);
        const read = readPdfPageShape(shapedPath);
        const openSurface = createDocumentOpenSurfaceSession();

        beginOpenSurfaceWithPageShape(openSurface, claim('1'), 1, read);
        beginOpenSurfaceWithPageShape(openSurface, claim('2'), 1, null);
        answer.resolve(pageShape);
        await read?.answer;
        await Promise.resolve();

        expect(openSurface.snapshot.value.openingPageGeometry).toBeNull();
    });

    it('gives an open at another page no first-page shape', async () => {
        mocks.documentFiles.getPdfOpeningGeometry.mockResolvedValue(pageShape);
        const read = readPdfPageShape(shapedPath);
        await read?.answer;
        const openSurface = createDocumentOpenSurfaceSession();

        beginOpenSurfaceWithPageShape(openSurface, claim('1'), 5, read);

        expect(openSurface.snapshot.value.openingPageGeometry).toBeNull();
    });
});
