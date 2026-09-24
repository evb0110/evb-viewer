import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import type { ITab } from '@app/types/tabs';
import { useMenuSync } from '@app/modules/workspace-shell/composables/useMenuSync';
import { workspaceHasPdf } from '@app/modules/workspace-shell/state/workspaceHasPdf';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { createDefaultWorkspaceViewerCapabilities } from '@app/types/workspaceExpose';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import { requireDocumentRef } from '@contracts/documentRef';

const mocks = vi.hoisted(() => ({
    setMenuDocumentState: vi.fn(async () => {}),
    setMenuTabCount: vi.fn(async () => {}),
}));
const mockPlatformApi = createElectronPlatformApiFixture({documentMenu: {
    setMenuDocumentState: mocks.setMenuDocumentState,
    setMenuTabCount: mocks.setMenuTabCount,
}});

vi.mock('@app/utils/platform', () => ({ getPlatformAPI: () => mockPlatformApi }));

describe('useMenuSync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('syncs menu state when workspace or tabs change', async () => {
        const activeDocumentRecord = ref(createWorkspaceDocumentRecord());
        const tabs = ref([{
            id: 'tab-1',
            fileName: null,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        }]);

        useMenuSync({
            activeDocumentRecord,
            activeTabId: ref<string | null>('tab-1'),
            tabs,
        });
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenCalledWith(expect.objectContaining({
            hasDocument: false,
            canSave: false,
            canSaveAs: false,
            canRepairSave: false,
            canOptimizePdf: false,
            canPrint: false,
            interactive: false,
            canContinuousScroll: false,
            continuousScroll: true,
        }));
        expect(mocks.setMenuTabCount).toHaveBeenCalledWith(1);

        activeDocumentRecord.value = createWorkspaceDocumentRecord({toolbarSnapshot: { hasPdf: true }});
        tabs.value.push({
            id: 'tab-2',
            fileName: null,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        });
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith(expect.objectContaining({
            hasDocument: true,
            canSave: false,
            canSaveAs: false,
            canRepairSave: false,
            canOptimizePdf: false,
            canPrint: false,
            interactive: true,
            canContinuousScroll: false,
            continuousScroll: true,
        }));
        expect(mocks.setMenuTabCount).toHaveBeenLastCalledWith(2);
    });

    it('syncs save availability separately from document presence', async () => {
        const activeDocumentRecord = ref(createWorkspaceDocumentRecord({toolbarSnapshot: {
            hasPdf: true,
            canSave: false,
            canRepairSave: true,
            canOptimizePdf: true,
        }}));

        useMenuSync({
            activeDocumentRecord,
            activeTabId: ref<string | null>('tab-1'),
            tabs: ref([{
                id: 'tab-1',
                fileName: 'example.pdf',
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            }]),
        });
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith(expect.objectContaining({
            hasDocument: true,
            canSave: false,
            canSaveAs: false,
            canRepairSave: true,
            canOptimizePdf: true,
            canPrint: false,
            interactive: true,
            canContinuousScroll: false,
            continuousScroll: true,
        }));

        activeDocumentRecord.value = createWorkspaceDocumentRecord({
            ...activeDocumentRecord.value,
            toolbarSnapshot: {
                ...activeDocumentRecord.value.toolbarSnapshot,
                canSave: true,
            },
        });
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith(expect.objectContaining({
            hasDocument: true,
            canSave: true,
            canSaveAs: false,
            canRepairSave: true,
            canOptimizePdf: true,
            canPrint: false,
            interactive: true,
            canContinuousScroll: false,
            continuousScroll: true,
        }));
    });

    it('syncs save-as availability from viewer capabilities', async () => {
        const activeDocumentRecord = ref(createWorkspaceDocumentRecord({toolbarSnapshot: {
            hasPdf: true,
            canSave: false,
            viewerCapabilities: {
                ...createDefaultWorkspaceViewerCapabilities(),
                saveAs: true,
            },
        }}));

        useMenuSync({
            activeDocumentRecord,
            activeTabId: ref<string | null>('tab-1'),
            tabs: ref([{
                id: 'tab-1',
                fileName: 'example.pdf',
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            }]),
        });
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith(expect.objectContaining({
            hasDocument: true,
            canSave: false,
            canSaveAs: true,
            canRepairSave: false,
            canOptimizePdf: false,
            canPrint: false,
            interactive: true,
            canContinuousScroll: false,
            continuousScroll: true,
        }));

        activeDocumentRecord.value = createWorkspaceDocumentRecord({
            ...activeDocumentRecord.value,
            toolbarSnapshot: {
                ...activeDocumentRecord.value.toolbarSnapshot,
                viewerCapabilities: {
                    ...activeDocumentRecord.value.toolbarSnapshot.viewerCapabilities,
                    saveAs: false,
                },
            },
        });
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith(expect.objectContaining({
            hasDocument: true,
            canSave: false,
            canSaveAs: false,
            canRepairSave: false,
            canOptimizePdf: false,
            canPrint: false,
            interactive: true,
            canContinuousScroll: false,
            continuousScroll: true,
        }));
    });

    it('syncs optimize availability independently from repair availability', async () => {
        const activeDocumentRecord = ref(createWorkspaceDocumentRecord({toolbarSnapshot: {
            hasPdf: true,
            canSave: true,
            canRepairSave: true,
            canOptimizePdf: false,
        }}));

        useMenuSync({
            activeDocumentRecord,
            activeTabId: ref<string | null>('tab-1'),
            tabs: ref([{
                id: 'tab-1',
                fileName: 'example.pdf',
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            }]),
        });
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith(expect.objectContaining({
            hasDocument: true,
            canSave: true,
            canSaveAs: false,
            canRepairSave: true,
            canOptimizePdf: false,
            canPrint: false,
            interactive: true,
            canContinuousScroll: false,
            continuousScroll: true,
        }));

        activeDocumentRecord.value = createWorkspaceDocumentRecord({
            ...activeDocumentRecord.value,
            toolbarSnapshot: {
                ...activeDocumentRecord.value.toolbarSnapshot,
                canOptimizePdf: true,
            },
        });
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith(expect.objectContaining({
            hasDocument: true,
            canSave: true,
            canSaveAs: false,
            canRepairSave: true,
            canOptimizePdf: true,
            canPrint: false,
            interactive: true,
            canContinuousScroll: false,
            continuousScroll: true,
        }));
    });

    it('syncs document readiness and continuous-scroll capability independently from the tab hint', async () => {
        const activeDocumentRecord = ref(createWorkspaceDocumentRecord({toolbarSnapshot: {
            hasPdf: true,
            isOpeningDocument: true,
            continuousScroll: true,
            viewerCapabilities: {
                ...createDefaultWorkspaceViewerCapabilities(),
                continuousScroll: true,
            },
        }}));

        useMenuSync({
            activeDocumentRecord,
            activeTabId: ref<string | null>('tab-1'),
            tabs: ref([{
                id: 'tab-1',
                fileName: 'example.pdf',
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            }]),
        });
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith(expect.objectContaining({
            hasDocument: true,
            interactive: false,
            supportsContinuousScroll: true,
            canContinuousScroll: false,
            continuousScroll: true,
        }));

        activeDocumentRecord.value = createWorkspaceDocumentRecord({toolbarSnapshot: {
            ...activeDocumentRecord.value.toolbarSnapshot,
            isOpeningDocument: false,
            totalPages: 4,
        }});
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith(expect.objectContaining({interactive: true}));
    });

    it('keeps the DOCX menu command available as a cancellation action while exporting', async () => {
        const activeDocumentRecord = ref(createWorkspaceDocumentRecord({
            tab: {
                fileName: 'dictionary.pdf',
                originalPath: requireDocumentRef('/documents/dictionary.pdf'),
                isDirty: false,
                isDjvu: false,
            },
            toolbarSnapshot: {
                hasPdf: true,
                totalPages: 1,
                canExportDocx: false,
                isExportingDocx: true,
                viewerCapabilities: {
                    ...createDefaultWorkspaceViewerCapabilities(),
                    pdfDocument: true,
                },
            },
        }));

        useMenuSync({
            activeDocumentRecord,
            activeTabId: ref<string | null>('tab-1'),
            tabs: ref<ITab[]>([{
                id: 'tab-1',
                fileName: 'dictionary.pdf',
                originalPath: requireDocumentRef('/documents/dictionary.pdf'),
                isDirty: false,
                isDjvu: false,
            }]),
        });
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith(expect.objectContaining({
            canExportDocx: true,
            isExportingDocx: true,
        }));
    });

    it('syncs selection, view, feature, and tab applicability from authoritative shell state', async () => {
        const activeDocumentRecord = ref(createWorkspaceDocumentRecord({toolbarSnapshot: {
            hasPdf: true,
            canUndo: true,
            canRedo: false,
            selectedPageCount: 2,
            totalPages: 5,
            viewMode: 'facing-first-single',
            isFitHeightActive: true,
            viewerCapabilities: {
                ...createDefaultWorkspaceViewerCapabilities(),
                pdfDocument: true,
                pdfMutationActions: true,
                continuousScroll: true,
                viewMode: true,
            },
        }}));
        const menuContext = ref({
            canCloseTab: true,
            canCreatePane: false,
            canTransferActiveTab: true,
            canToggleAssistant: true,
        });

        useMenuSync({
            activeDocumentRecord,
            activeTabId: ref<string | null>('tab-1'),
            tabs: ref([{
                id: 'tab-1',
                fileName: 'example.pdf',
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            }]),
            menuContext,
        });
        await nextTick();

        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith(expect.objectContaining({
            supportsPdfMutation: true,
            canMutatePages: true,
            selectedPageCount: 2,
            totalPages: 5,
            canUndo: true,
            canRedo: false,
            supportsViewMode: true,
            viewMode: 'facing-first-single',
            isFitHeightActive: true,
            canCloseTab: true,
            canCreatePane: false,
            canTransferActiveTab: true,
            canToggleAssistant: true,
        }));
    });

    it('resolves hasPdf from boolean, ref, or null workspace', () => {
        expect(workspaceHasPdf(null)).toBe(false);
        expect(workspaceHasPdf({ hasPdf: true })).toBe(true);
        expect(workspaceHasPdf({ hasPdf: ref(false) })).toBe(false);
    });
});
