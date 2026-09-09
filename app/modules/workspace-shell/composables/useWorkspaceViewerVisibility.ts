import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IWorkspaceDocumentDriver } from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';

interface IWorkspaceViewerVisibilityOptions {
    activeDocumentDriver: ComputedRef<IWorkspaceDocumentDriver | null>;
    djvuOpeningPath: Ref<TDocumentRef | null>;
    hasPdf: ComputedRef<boolean> | Ref<boolean>;
    hasQueuedSplitRestore: ComputedRef<boolean> | Ref<boolean>;
    isAnySaving: ComputedRef<boolean> | Ref<boolean>;
    isExternallyRestoring: Ref<boolean>;
    isHistoryBusy: ComputedRef<boolean> | Ref<boolean>;
    isOcrRunning: Ref<boolean>;
    isRestoringSplitPayload: Ref<boolean>;
    pendingDocumentOpen: ComputedRef<boolean> | Ref<boolean>;
    openingPreviewReady: ComputedRef<boolean> | Ref<boolean>;
    showSidebar: Ref<boolean>;
    conversionState: Ref<{isConverting: boolean;}>;
}

export const useWorkspaceViewerVisibility = (options: IWorkspaceViewerVisibilityOptions) => {
    const activeDriverCapabilities = computed(() => options.activeDocumentDriver.value?.capabilities);
    const activeDriverView = computed(() => options.activeDocumentDriver.value?.view);
    const driverShowsNativePdf = computed(() => activeDriverView.value?.showNativePdf === true);
    const driverShowsPdfSidebar = computed(() => activeDriverView.value?.showPdfSidebar === true);
    const driverShowsDjvuSource = computed(() => activeDriverView.value?.showDjvuSource === true);
    const driverStartupVisualSource = computed(() => activeDriverView.value?.startupVisualSource ?? null);
    const isDjvuOpening = computed(() => (
        Boolean(options.djvuOpeningPath.value)
        && !driverShowsDjvuSource.value
    ));
    const isDocumentOpenPlaceholderVisible = computed(() => (
        options.pendingDocumentOpen.value
        || isDjvuOpening.value
    ));
    const isOpeningDocumentForToolbar = computed(() => (
        isDocumentOpenPlaceholderVisible.value
        || options.isRestoringSplitPayload.value
        || options.isExternallyRestoring.value
    ));
    const isConversionBusy = computed(() => options.conversionState.value.isConverting);
    const isDocumentBusy = computed(() => isConversionBusy.value || options.isOcrRunning.value);
    const toolbarDocumentBusy = computed(() => isDocumentBusy.value || isOpeningDocumentForToolbar.value);
    const toolbarHasPdf = computed(() => (
        options.hasPdf.value
        || options.pendingDocumentOpen.value
        || driverShowsNativePdf.value
        || driverShowsDjvuSource.value
        || isDjvuOpening.value
        || options.hasQueuedSplitRestore.value
        || options.isRestoringSplitPayload.value
        || options.isExternallyRestoring.value
    ));
    // Whether a sidebar may exist at all: the user's persisted preference and
    // the active driver's capability. Which document generation is allowed to
    // present one is decided by `useWorkspaceSidebarOpenGeneration`.
    const sidebarPresentationEnabled = computed(() => (
        options.showSidebar.value
        && activeDriverCapabilities.value?.sidebar === true
    ));
    const canToggleSidebar = computed(() => (
        toolbarHasPdf.value
        && activeDriverCapabilities.value?.sidebar === true
        && (
            !toolbarDocumentBusy.value
            || options.openingPreviewReady.value
        )
    ));
    const canRepairSave = computed(() => (
        options.hasPdf.value
        && !toolbarDocumentBusy.value
        && !options.isAnySaving.value
        && !options.isHistoryBusy.value
        && activeDriverCapabilities.value?.repairSave === true
    ));

    return {
        activeDriverCapabilities,
        driverShowsNativePdf,
        driverShowsPdfSidebar,
        driverShowsDjvuSource,
        driverStartupVisualSource,
        isDjvuOpening,
        isDocumentOpenPlaceholderVisible,
        isOpeningDocumentForToolbar,
        isConversionBusy,
        isDocumentBusy,
        toolbarDocumentBusy,
        toolbarHasPdf,
        sidebarPresentationEnabled,
        canToggleSidebar,
        canRepairSave,
        canOptimizePdf: canRepairSave,
    };
};
