import type * as TViMockOriginalModule2 from '@app/platform/browser-api/createNativePdfPreviewSourceFromPath';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import { requireDocumentRef } from '@contracts/documentRef';
import type { TTranslateFn } from '@i18n-app';
import {
    createDocumentSessionState,
    createEpochGuard,
} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import { createDocumentOpenFlow } from '@app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow';
import { retainDocumentOpenWorkingCopyForRetry } from '@app/modules/workspace-shell/document-sessions/retainDocumentOpenWorkingCopyForRetry';
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
    documentPicker: {openDocumentDialog: vi.fn()},
    documentRecentFiles: {recentFiles: {get: vi.fn()}},
    performanceProfile: {
        tier: 'medium',
        lowCpu: false,
        lowMemory: false,
        maxCachedPdfPages: 48,
    },
    nativePreview: {createSource: vi.fn()},
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
vi.mock('@app/platform/browser-api/createNativePdfPreviewSourceFromPath', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    createNativePdfPreviewSourceFromPath: mocks.nativePreview.createSource,
}));

interface IResetHistoryTestOptions {isCurrent?: (() => boolean) | undefined;}

function createOpenFlowHarness() {
    const state = createDocumentSessionState({isDesktopRuntime: ref(true)});
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
        resetHistory: vi.fn(async (_snapshot: unknown, options?: IResetHistoryTestOptions) => options?.isCurrent?.() !== false),
        syncDirtyFromHistory: vi.fn(),
        t: ((key: string) => key) as TTranslateFn,
    };
    return {
        deps,
        openFlow: createDocumentOpenFlow(state, deps),
    };
}

describe('createDocumentOpenFlow restore ownership', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.documentFiles.readFile.mockResolvedValue(Uint8Array.from([
            37,
            80,
            68,
            70,
        ]));
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
        const {
            deps,
            openFlow,
        } = createOpenFlowHarness();
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
