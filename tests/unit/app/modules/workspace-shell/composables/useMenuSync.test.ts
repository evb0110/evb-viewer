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
import { useMenuSync } from '@app/modules/workspace-shell/composables/useMenuSync';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { TWorkspaceDocumentPhase } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentSnapshot';
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
    phase: TWorkspaceDocumentPhase;
    tab: {fileName: string | null};
    toolbarSnapshot: IWorkspaceToolbarSnapshot;
}

function createWorkspaceDocumentRecord(options: {
    tab?: {fileName: string | null};
    toolbarSnapshot?: Partial<IWorkspaceToolbarSnapshot>;
    phase?: TWorkspaceDocumentPhase;
} = {}): IActiveDocumentState {
    const toolbarSnapshot = {
        ...createDefaultWorkspaceToolbarSnapshot(),
        ...options.toolbarSnapshot,
    };
    const phase = options.phase ?? (toolbarSnapshot.hasPdf ? 'presented' : 'empty');
    if (phase === 'presented' && toolbarSnapshot.hasPdf && options.toolbarSnapshot?.initialVisualReady === undefined) {
        toolbarSnapshot.initialVisualReady = true;
    }
    if (toolbarSnapshot.hasPdf) {
        toolbarSnapshot.totalPages = Math.max(toolbarSnapshot.totalPages, toolbarSnapshot.currentPage);
    }
    return {
        phase,
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
        if (state.value.phase === 'opening') {
            void session.runOpen({
                kind: 'open',
                target: null,
            }, () => Promise.resolve(true));
        } else if (state.value.phase === 'presented') {
            const settled = session.runOpen({
                kind: 'open',
                target: null,
            }, () => Promise.resolve(true));
            session.markPresented();
            void settled;
        }
        session.getView('tab-1')?.publishToolbarSnapshot(state.value.toolbarSnapshot);
        return session;
    });
}

function activeDocumentOf(state: Ref<IActiveDocumentState>) {
    const activeDocumentSession = sessionOf(state);
    return {
        activeDocumentSession,
        activeDocumentView: computed(() => activeDocumentSession.value.getView('tab-1')),
    };
}

describe('useMenuSync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([
        {name: 'document presence and tab count', initial: {}, next: {hasPdf: true, initialVisualReady: true}, before: {}, after: {hasDocument: true, interactive: true}, addTab: true},
        {name: 'save availability separately from document presence', initial: {hasPdf: true, canRepairSave: true, canOptimizePdf: true}, next: {canSave: true}, before: {hasDocument: true, interactive: true, canRepairSave: true, canOptimizePdf: true}, after: {canSave: true}},
        {name: 'save-as viewer capability', initial: {hasPdf: true, viewerCapabilities: {...createDefaultWorkspaceViewerCapabilities(), saveAs: true}}, next: {viewerCapabilities: createDefaultWorkspaceViewerCapabilities()}, before: {hasDocument: true, interactive: true, canSaveAs: true}, after: {canSaveAs: false}},
        {name: 'optimize independently from repair', initial: {hasPdf: true, canSave: true, canRepairSave: true}, next: {canOptimizePdf: true}, before: {hasDocument: true, interactive: true, canSave: true, canRepairSave: true}, after: {canOptimizePdf: true}},
    ])('syncs $name as shell state changes', async ({initial, next, before, after, ...scenario}) => {
        const activeDocumentRecord = ref(createWorkspaceDocumentRecord({toolbarSnapshot: initial}));
        const tabs = ref([{id: 'tab-1'}]);
        useMenuSync({...activeDocumentOf(activeDocumentRecord), tabs});
        await nextTick();

        const expected = {
            hasDocument: false, canSave: false, canSaveAs: false,
            canRepairSave: false, canOptimizePdf: false, canPrint: false,
            interactive: false, canContinuousScroll: false, continuousScroll: true,
            ...before,
        };
        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith(expect.objectContaining(expected));
        expect(mocks.setMenuTabCount).toHaveBeenLastCalledWith(1);

        activeDocumentRecord.value = createWorkspaceDocumentRecord({toolbarSnapshot: {
            ...activeDocumentRecord.value.toolbarSnapshot, ...next,
        }});
        if ('addTab' in scenario && scenario.addTab) tabs.value.push({id: 'tab-2'});
        await nextTick();
        expect(mocks.setMenuDocumentState).toHaveBeenLastCalledWith(expect.objectContaining({...expected, ...after}));
        expect(mocks.setMenuTabCount).toHaveBeenLastCalledWith(tabs.value.length);
    });

    it('uses the document phase for readiness and keeps continuous-scroll capability independent', async () => {
        const activeDocumentRecord = ref(createWorkspaceDocumentRecord({
            toolbarSnapshot: {
                hasPdf: true,
                continuousScroll: true,
                viewerCapabilities: {
                    ...createDefaultWorkspaceViewerCapabilities(),
                    continuousScroll: true,
                },
            },
            phase: 'opening',
        }));

        useMenuSync({
            ...activeDocumentOf(activeDocumentRecord),
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

        activeDocumentRecord.value = createWorkspaceDocumentRecord({
            toolbarSnapshot: {
                ...activeDocumentRecord.value.toolbarSnapshot,
                initialVisualReady: true,
                totalPages: 4,
            },
            phase: 'presented',
        });
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
            ...activeDocumentOf(activeDocumentRecord),
            tabs: ref([{id: 'tab-1'}]),
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
            ...activeDocumentOf(activeDocumentRecord),
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
