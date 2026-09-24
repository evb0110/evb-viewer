import { isEqual } from 'es-toolkit/predicate';
import { guardAsync } from '@app/utils/asyncGuard';
import type {
    IUseWorkspaceShellStateOptions,
    IWorkspaceShellState,
} from '@app/modules/workspace-shell/composables/useWorkspaceShellState';
import { useWorkspaceShellState } from '@app/modules/workspace-shell/composables/useWorkspaceShellState';
import { getDocumentMenuCapability } from '@app/utils/platformDocuments';
import type { IApplicationMenuDocumentState } from '@contracts/electronApiDocuments';
import type { Ref } from 'vue';
import type { ITabContextAvailability } from '@app/types/tabContextMenu';

interface IMenuSyncShellContext {
    canCloseTab: boolean;
    canCreatePane: boolean;
    canTransferActiveTab: boolean;
    canToggleAssistant: boolean;
}

interface IUseMenuSyncDeps extends IUseWorkspaceShellStateOptions {
    shellState?: IWorkspaceShellState;
    menuContext?: Readonly<Ref<IMenuSyncShellContext>>;
}

interface IUseAppShellMenuSyncDeps extends IUseWorkspaceShellStateOptions {
    activePaneId: Ref<string | null>;
    assistantPanelEnabled: Readonly<Ref<boolean>>;
    shellState: IWorkspaceShellState;
    tabContextAvailabilityByPane: Readonly<Ref<Record<string, ITabContextAvailability>>>;
}

export const useMenuSync = (deps: IUseMenuSyncDeps) => {
    const shellState = deps.shellState ?? useWorkspaceShellState(deps);
    let lastSyncedMenuDocumentState: IApplicationMenuDocumentState | null = null;
    let lastSyncedMenuTabCount: number | null = null;

    function syncMenuDocumentState() {
        const toolbar = deps.activeDocumentSession.value?.toolbarSnapshot.value;
        const capabilities = toolbar?.viewerCapabilities;
        const context = deps.menuContext?.value;
        const hasDocument = shellState.hasDocument.value;
        const documentInteractive = shellState.activeWorkspaceInteractive.value;
        const isAnySaving = toolbar?.isAnySaving === true;
        const isHistoryBusy = toolbar?.isHistoryBusy === true;
        const isDocumentBusy = !documentInteractive || isAnySaving || isHistoryBusy;
        const supportsPdfMutation = capabilities?.pdfMutationActions === true;
        const canMutatePages = supportsPdfMutation
            && !isDocumentBusy
            && toolbar?.isPageOperationInProgress !== true;
        const isActualSizeActive = toolbar?.zoomMode === 'custom'
            && Math.abs(toolbar.effectiveZoom - 1) < 0.0001;
        const state: IApplicationMenuDocumentState = {
            hasDocument,
            interactive: documentInteractive,
            canSave: shellState.activeWorkspaceCanSave.value && !isDocumentBusy,
            supportsSaveAs: capabilities?.saveAs === true,
            canSaveAs: shellState.activeWorkspaceCanSaveAs.value && !isDocumentBusy,
            supportsRepairSave: capabilities?.repairSave === true,
            canRepairSave: shellState.activeWorkspaceCanRepairSave.value && !isDocumentBusy,
            supportsOptimizePdf: capabilities?.optimizePdf === true,
            canOptimizePdf: shellState.activeWorkspaceCanOptimizePdf.value && !isDocumentBusy,
            supportsPrint: capabilities?.print === true,
            canPrint: shellState.activeWorkspaceCanPrint.value
                && !isDocumentBusy
                && toolbar?.isPreparingPrint !== true,
            supportsExportDocx: capabilities?.pdfDocument === true,
            canExportDocx: (documentInteractive
                && toolbar?.canExportDocx === true
                && !isAnySaving
                && !isHistoryBusy)
                || toolbar?.isExportingDocx === true,
            isExportingDocx: toolbar?.isExportingDocx === true,
            supportsRasterExport: hasDocument,
            canExportRaster: documentInteractive && !isAnySaving && !isHistoryBusy,
            canUndo: documentInteractive
                && toolbar?.canUndo === true
                && !isAnySaving
                && !isHistoryBusy,
            canRedo: documentInteractive
                && toolbar?.canRedo === true
                && !isAnySaving
                && !isHistoryBusy,
            supportsPdfMutation,
            canMutatePages,
            selectedPageCount: toolbar?.selectedPageCount ?? 0,
            totalPages: toolbar?.totalPages ?? 0,
            supportsContinuousScroll: capabilities?.continuousScroll === true,
            canContinuousScroll: documentInteractive && capabilities?.continuousScroll === true,
            continuousScroll: toolbar?.continuousScroll ?? false,
            supportsViewMode: capabilities?.viewMode === true,
            viewMode: toolbar?.viewMode ?? 'single',
            supportsViewRotation: capabilities?.viewRotation === true,
            viewRotation: toolbar?.viewRotation ?? 0,
            isActualSizeActive,
            isFitWidthActive: toolbar?.isFitWidthActive ?? false,
            isFitHeightActive: toolbar?.isFitHeightActive ?? false,
            canToggleAssistant: documentInteractive && context?.canToggleAssistant === true,
            canCreatePane: context?.canCreatePane ?? true,
            canCloseTab: context?.canCloseTab ?? false,
            canTransferActiveTab: context?.canTransferActiveTab ?? false,
        };
        if (lastSyncedMenuDocumentState && isEqual(lastSyncedMenuDocumentState, state)) {
            return;
        }
        lastSyncedMenuDocumentState = state;
        const setMenuDocumentState = getDocumentMenuCapability().setMenuDocumentState;
        guardAsync(setMenuDocumentState(state), {
            category: 'background-diagnostic',
            scope: 'menu-sync',
            message: 'Failed to sync menu document state',
        });
    }

    function syncMenuTabCount() {
        const tabCount = shellState.tabCount.value;
        if (lastSyncedMenuTabCount === tabCount) {
            return;
        }

        lastSyncedMenuTabCount = tabCount;
        const setMenuTabCount = getDocumentMenuCapability().setMenuTabCount;
        guardAsync(setMenuTabCount(tabCount), {
            category: 'background-diagnostic',
            scope: 'menu-sync',
            message: 'Failed to sync menu tab count',
        });
    }

    watchEffect(() => {
        syncMenuDocumentState();
        syncMenuTabCount();
    });

    return {shellState};
};

export const useAppShellMenuSync = (deps: IUseAppShellMenuSyncDeps) => {
    const menuContext = computed<IMenuSyncShellContext>(() => {
        const availability = deps.activePaneId.value
            ? deps.tabContextAvailabilityByPane.value[deps.activePaneId.value]
            : undefined;
        return {
            canCloseTab: availability?.canClose === true,
            canCreatePane: availability?.splitEmpty.right === true
                || availability?.splitEmpty.down === true,
            canTransferActiveTab: availability?.canMoveToWindow === true,
            canToggleAssistant: deps.assistantPanelEnabled.value,
        };
    });
    return useMenuSync({
        activeDocumentSession: deps.activeDocumentSession,
        tabs: deps.tabs,
        shellState: deps.shellState,
        menuContext,
    });
};
