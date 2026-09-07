import {
    computed,
    defineComponent,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type {TDocumentRef} from '@contracts/documentRef';
import {
    createDefaultWorkspaceViewerCapabilities,
    type IWorkspaceViewerCapabilities,
} from '@app/types/workspaceExpose';
import type {
    IWorkspaceDocumentDriver,
    IWorkspaceDocumentDriverView,
} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import {useWorkspaceViewerVisibility} from '@app/modules/workspace-shell/composables/useWorkspaceViewerVisibility';

const ViewerStub = defineComponent({setup: () => () => null});

function createDriver(
    viewOverrides: Partial<IWorkspaceDocumentDriverView> = {},
    capabilityOverrides: Partial<IWorkspaceViewerCapabilities> = {},
) {
    const capabilities = {
        ...createDefaultWorkspaceViewerCapabilities(),
        closeableDocument: true,
        ...capabilityOverrides,
    };
    const view = {
        component: ViewerStub,
        sourcePath: null,
        defaultSourceCapabilities: null,
        showDjvuSource: false,
        showNativePdf: false,
        showPdfSidebar: true,
        startupVisualSource: null,
        ...viewOverrides,
    };
    return {
        id: 'pdfjs',
        capabilities,
        canPreparePrint: false,
        source: {
            kind: 'pdf',
            path: null as TDocumentRef | null,
        },
        view,
        run: async () => ({
            status: 'unavailable' as const,
            capability: 'print' as const,
        }),
    } satisfies IWorkspaceDocumentDriver;
}

function createVisibility(driver: IWorkspaceDocumentDriver) {
    return useWorkspaceViewerVisibility({
        activeDocumentDriver: computed(() => driver),
        conversionState: ref({isConverting: false}),
        djvuOpeningPath: ref<TDocumentRef | null>(null),
        hasPdf: ref(true),
        hasQueuedSplitRestore: ref(false),
        isAnySaving: ref(false),
        isExternallyRestoring: ref(false),
        isHistoryBusy: ref(false),
        isOcrRunning: ref(false),
        isRestoringSplitPayload: ref(false),
        openingPreviewReady: ref(false),
        pendingDocumentOpen: ref(false),
        showSidebar: ref(true),
    });
}

describe('useWorkspaceViewerVisibility', () => {
    it('reads viewer presentation and toolbar guards from the active driver', () => {
        const visibility = createVisibility(createDriver({
            showNativePdf: true,
            showPdfSidebar: false,
            startupVisualSource: 'native-pdf-src',
        }, {
            repairSave: true,
            sidebar: false,
        }));

        expect(visibility.driverShowsNativePdf.value).toBe(true);
        expect(visibility.driverShowsPdfSidebar.value).toBe(false);
        expect(visibility.driverStartupVisualSource.value).toBe('native-pdf-src');
        expect(visibility.toolbarHasPdf.value).toBe(true);
        expect(visibility.sidebarPresentationEnabled.value).toBe(false);
        expect(visibility.canToggleSidebar.value).toBe(false);
        expect(visibility.canRepairSave.value).toBe(true);
    });
});
