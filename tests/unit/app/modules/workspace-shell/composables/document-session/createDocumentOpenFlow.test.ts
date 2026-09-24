import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
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
import {BrowserFilePickerSetupDeniedError} from '@app/platform/browser-api/browserFilePickerAdapter';
import { createDocumentOpenSurfaceSession } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
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
        getPdfOpeningGeometry: vi.fn(),
        getDocumentRevision: vi.fn(),
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

function createOpenFlowHarness(options: {
    openSurface?: IDocumentOpenSurfaceSession;
    reportOpenFailure?: (
        operationId: string,
        reason: 'unsupported-encryption',
        detail?: string | null,
    ) => boolean;
} = {}) {
    const state = createDocumentSessionState({ isDesktopRuntime: ref(true) });
    const deps = {
        cleanupAbandonedWorkingCopy: vi.fn(async () => undefined),
        clearPdfConformanceProfile: vi.fn(),
        cleanupPreviousWorkingCopy: vi.fn(async () => undefined),
        deferPdfConformanceProfile: vi.fn(),
        ensureHistoryBaselineForMutation: vi.fn(async () => true),
        incrementSessionVersion: vi.fn(),
        loadEpoch: createEpochGuard(),
        ...(options.openSurface === undefined ? {} : {openSurface: options.openSurface}),
        openEpoch: createEpochGuard(),
        pushHistorySnapshot: vi.fn(async () => true),
        ...(options.reportOpenFailure === undefined ? {} : {reportOpenFailure: options.reportOpenFailure}),
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
        mocks.documentFiles.getPdfOpeningGeometry.mockResolvedValue({
            pageNumber: requirePageNumber(1),
            pageCount: 1,
            width: 612,
            height: 792,
            rotation: 0,
            size: PDF_BYTES.byteLength,
            modifiedAt: requireEpochMs(1),
        });
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
        const reportOpenFailure = vi.fn(() => true);
        const {
            openFlow,
            state,
        } = createOpenFlowHarness({reportOpenFailure});
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
        expect(reportOpenFailure).toHaveBeenCalledWith(
            expect.stringMatching(/^open:\d+$/u),
            'unsupported-encryption',
        );
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

    it('sizes the opening skeleton from native geometry on a constrained profile', async () => {
        mocks.performanceProfile.lowCpu = true;
        const originalPath = requireDocumentRef('/documents/constrained.pdf');
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: originalPath,
            documentRevision: 'open-intent:1',
        });
        const geometry = Promise.withResolvers<unknown>();
        mocks.documentFiles.getPdfOpeningGeometry.mockReturnValue(geometry.promise);
        const { openFlow } = createOpenFlowHarness({openSurface});

        const opening = openFlow.openFile({
            kind: 'pdf',
            originalPath,
            workingPath: requireDocumentRef('/tmp/constrained-working.pdf'),
        });
        geometry.resolve({
            pageNumber: requirePageNumber(1),
            pageCount: 12,
            width: 612,
            height: 792,
            rotation: 0,
            widestPageWidth: 792,
            size: PDF_BYTES.byteLength,
            modifiedAt: requireEpochMs(1),
        });

        await vi.waitFor(() => expect(openSurface.snapshot.value.openingPageGeometry).toMatchObject({
            documentId: originalPath,
            pageCount: 12,
            widestPageWidth: 792,
        }));
        await expect(opening).resolves.toMatchObject({status: 'opened'});
    });

});
