import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ref} from 'vue';
import type {TOpenFileResult} from '@contracts/electronApiDocuments';
import {requireDocumentRef} from '@contracts/documentRef';
import type {TTranslateFn} from '@i18n-app';
import {createDocumentSessionState} from '@app/modules/workspace-shell/composables/document-session/documentSessionState';
import {createDocumentOpenFlow} from '@app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow';
import {retainDocumentOpenWorkingCopyForRetry} from '@app/modules/workspace-shell/document-sessions/retainDocumentOpenWorkingCopyForRetry';
import {createElectronPlatformApiFixture} from '@tests/helpers/createElectronPlatformApiFixture';
import {createWorkspaceDocumentController} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import {createPdfSourceJob} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSessionSlot';

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
    documentPicker: {openDocumentDialog: vi.fn()},
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
vi.mock('@app/composables/useFailureToast', () => ({
    useFailureToast: () => ({
        presentNoticeToast: vi.fn(),
        presentFailureToast: vi.fn(),
    }),
}));
vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => platformApi}));
vi.mock('@app/utils/performanceProfile', () => ({
    getPerformanceProfile: () => mocks.performanceProfile,
    resolvePerformanceProfile: () => mocks.performanceProfile,
}));

/** Every open the shell starts runs under its own controller claim; a newer claim makes the older open stale. */
function claimEachOpen(
    controller: ReturnType<typeof createWorkspaceDocumentController>,
    flow: ReturnType<typeof createDocumentOpenFlow>,
): ReturnType<typeof createDocumentOpenFlow> {
    const claim = () => controller.claimOpen({kind: 'open', target: null});
    return {
        ...flow,
        openFile: (...args: Parameters<typeof flow.openFile>) => (claim(), flow.openFile(...args)),
        openFileDirect: (...args: Parameters<typeof flow.openFileDirect>) => (claim(), flow.openFileDirect(...args)),
        openFileDirectBatch: (...args: Parameters<typeof flow.openFileDirectBatch>) => (claim(), flow.openFileDirectBatch(...args)),
    };
}

interface IResetHistoryTestOptions {
    isCurrent?: (() => boolean) | undefined;
}

function createOpenFlowHarness() {
    const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
    const state = createDocumentSessionState({
        isDesktopRuntime: ref(true),
        document: controller,
        admitPdfSource: (intent) => createPdfSourceJob(intent, {}),
    });
    const deps = {
        cleanupAbandonedWorkingCopy: vi.fn(async () => undefined),
        clearPdfConformanceProfile: vi.fn(),
        cleanupPreviousWorkingCopy: vi.fn(async () => undefined),
        deferPdfConformanceProfile: vi.fn(),
        resetCommandSink: vi.fn(),
        readOpenTransactionId: () => controller.snapshot.value.activeTransaction?.id ?? null,
        resetDocumentPresentation: vi.fn(),
        resetHistory: vi.fn(async (options?: IResetHistoryTestOptions) => options?.isCurrent?.() !== false),
        setOpeningLabel: vi.fn((label: string | null) => controller.setOpeningLabel(label)),
        syncDirtyFromHistory: vi.fn(),
        t: ((key: string) => key) as TTranslateFn,
    };
    return {
        deps,
        openFlow: claimEachOpen(controller, createDocumentOpenFlow(state, deps)),
    };
}

describe('createDocumentOpenFlow restore ownership', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.documentFiles.readFile.mockResolvedValue(Uint8Array.from([37, 80, 68, 70]));
        mocks.documentFiles.statFile.mockResolvedValue({size: 4});
        mocks.documentFiles.readFileRange.mockResolvedValue(new Uint8Array());
        mocks.documentFiles.writeFile.mockResolvedValue(true);
        mocks.documentPdf.validatePdfPath.mockResolvedValue({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        mocks.documentRecentFiles.recentFiles.get.mockResolvedValue([]);
        mocks.documentFiles.getPdfOpeningGeometry.mockResolvedValue(undefined);
        mocks.documentFiles.getDocumentRevision.mockResolvedValue(undefined);
    });

    it('retains a retryable restore snapshot through failure and releases it after retry success', async () => {
        const {deps, openFlow} = createOpenFlowHarness();
        const retryableResult: TOpenFileResult = {
            kind: 'pdf',
            originalPath: requireDocumentRef('/documents/retry.pdf'),
            workingPath: requireDocumentRef('/tmp/retry-snapshot.pdf'),
        };
        retainDocumentOpenWorkingCopyForRetry(retryableResult);
        mocks.documentFiles.readFile.mockRejectedValueOnce(new Error('restore read failed'));

        await expect(openFlow.openFile(retryableResult)).resolves.toMatchObject({status: 'failed'});
        expect(deps.cleanupAbandonedWorkingCopy).not.toHaveBeenCalledWith('/tmp/retry-snapshot.pdf');
        await expect(openFlow.openFile(retryableResult)).resolves.toMatchObject({
            status: 'opened',
            result: retryableResult,
        });
        expect(deps.cleanupAbandonedWorkingCopy).not.toHaveBeenCalledWith('/tmp/retry-snapshot.pdf');
    });
});
