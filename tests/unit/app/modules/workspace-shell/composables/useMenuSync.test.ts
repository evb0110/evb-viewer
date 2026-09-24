import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    nextTick,
    ref,
    type Ref,
} from 'vue';
import type { ITab } from '@app/types/tabs';
import { useMenuSync } from '@app/modules/workspace-shell/composables/useMenuSync';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import {
    createDefaultWorkspaceToolbarSnapshot,
    createDefaultWorkspaceViewerCapabilities,
    type IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

const mocks = vi.hoisted(() => ({
    setMenuDocumentState: vi.fn(async () => {}),
    setMenuTabCount: vi.fn(async () => {}),
}));
const mockPlatformApi = createElectronPlatformApiFixture({documentMenu: {
    setMenuDocumentState: mocks.setMenuDocumentState,
    setMenuTabCount: mocks.setMenuTabCount,
}});

vi.mock('@app/utils/platform', () => ({ getPlatformAPI: () => mockPlatformApi }));

interface IActiveDocumentState {
    tab: {fileName: string | null};
    toolbarSnapshot: IWorkspaceToolbarSnapshot;
}

function createWorkspaceDocumentRecord(options: {
    tab?: {fileName: string | null};
    toolbarSnapshot?: Partial<IWorkspaceToolbarSnapshot>;
} = {}): IActiveDocumentState {
    const toolbarSnapshot = {
        ...createDefaultWorkspaceToolbarSnapshot(),
        ...options.toolbarSnapshot,
    };
    if (toolbarSnapshot.hasPdf) {
        toolbarSnapshot.totalPages = Math.max(toolbarSnapshot.totalPages, toolbarSnapshot.currentPage);
    }
    return {
        tab: {fileName: options.tab?.fileName ?? null},
        toolbarSnapshot,
    };
}

// The active tab's controller, rebuilt from the document state the test sets.
function sessionOf(state: Ref<IActiveDocumentState>) {
    return computed(() => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            assignment: {
                fileName: state.value.tab.fileName ?? (state.value.toolbarSnapshot.hasPdf ? 'document.pdf' : null),
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            },
        });
        session.publishToolbarSnapshot(state.value.toolbarSnapshot);
        return session;
    });
}

describe('useMenuSync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('syncs menu state when workspace or tabs change', async () => {
        const activeDocumentRecord = ref(createWorkspaceDocumentRecord());
        const tabs = ref([{id: 'tab-1'}]);

        useMenuSync({
            activeDocumentSession: sessionOf(activeDocumentRecord),
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
        tabs.value.push({id: 'tab-2'});
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
            activeDocumentSession: sessionOf(activeDocumentRecord),
            tabs: ref([{id: 'tab-1'}]),
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
            activeDocumentSession: sessionOf(activeDocumentRecord),
            tabs: ref([{id: 'tab-1'}]),
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
            activeDocumentSession: sessionOf(activeDocumentRecord),
            tabs: ref([{id: 'tab-1'}]),
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
            activeDocumentSession: sessionOf(activeDocumentRecord),
            tabs: ref([{id: 'tab-1'}]),
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
            tab: {fileName: 'dictionary.pdf'},
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
            activeDocumentSession: sessionOf(activeDocumentRecord),
            tabs: ref<ITab[]>([{id: 'tab-1'}]),
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
            activeDocumentSession: sessionOf(activeDocumentRecord),
            tabs: ref([{id: 'tab-1'}]),
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
});
