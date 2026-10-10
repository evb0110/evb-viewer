import { until } from '@vueuse/core';
import {resolveVisiblePageLabelsDuringMetadataRefresh} from '@app/modules/pdf-viewer/public';
import type { TDocumentPageLabelLookup } from '@app/modules/document-viewer/public';
import type { TDocumentContext } from '@app/modules/workspace-shell/documentContext';
import type { TDocumentViewContext } from '@app/modules/workspace-shell/documentViewContext';
import { useDocumentOpenedAutomationEvent } from '@app/modules/workspace-shell/automation/useDocumentOpenedAutomationEvent';
import { useDocumentOpenVisualSettle } from '@app/modules/workspace-shell/composables/useDocumentOpenVisualSettle';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { useDocumentWorkspaceRestoreState } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceRestoreState';
import { useWorkspaceRestoreTracker } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';
import { useWorkspaceSidebarOpenGeneration } from '@app/modules/workspace-shell/composables/useWorkspaceSidebarOpenGeneration';
import { useWorkspaceStartupReadiness } from '@app/modules/workspace-shell/composables/useWorkspaceStartupReadiness';

/**
 * What the workspace shows while a document opens, restores or converts:
 * which surface is visible, which controls are live, and when the open has
 * settled for the tab controller and automation.
 */
export const useWorkspacePresentation = (
    document: TDocumentContext,
    viewContext: TDocumentViewContext,
) => {
    const {
        file,
        save,
        history,
        isOpeningDocument,
    } = document;
    const {
        tabId,
        openSurface,
        view,
        search,
    } = viewContext;
    const { t } = useTypedI18n();
    const {isExternallyRestoring} = useDocumentWorkspaceRestoreState({
        tabId,
        workspaceRestoreTracker: useWorkspaceRestoreTracker(),
        currentPage: view.currentPage,
        totalPages: view.totalPages,
        showSidebar: view.showSidebar,
        sidebarTab: view.sidebarTab,
        isResizingSidebar: search.isResizingSidebar,
        isLoading: view.isLoading,
        continuousScroll: view.continuousScroll,
        fitMode: view.fitMode,
        viewMode: view.viewMode,
        zoom: view.zoom,
        documentViewerRef: view.documentViewerRef,
        initFromStorage: file.initFromStorage,
        cleanupSidebarResizeListeners: search.cleanupSidebarResizeListeners,
        currentPageTransitionHistory: ref([]),
    });

    const capabilities = document.viewerCapabilities;
    const driverView = computed(() => document.driver.activeDocumentDriver.value?.view);
    const showsPdfSidebar = computed(() => driverView.value?.showPdfSidebar === true);
    const showsDjvuSource = computed(() => driverView.value?.showDjvuSource === true);
    const isDjvuOpening = computed(() => Boolean(file.djvuOpeningPath.value) && !showsDjvuSource.value);
    const isRestoring = isExternallyRestoring;
    const isOpeningForToolbar = computed(() => (
        isOpeningDocument.value || isDjvuOpening.value || isRestoring.value
    ));
    const toolbarDocumentBusy = computed(() => (
        file.conversionState.value.isConverting || document.ocr.progress.value.isRunning || isOpeningForToolbar.value
    ));
    const toolbarHasPdf = computed(() => (
        file.hasPdf.value
        || isOpeningDocument.value
        || showsDjvuSource.value
        || isDjvuOpening.value
        || isRestoring.value
    ));
    // Whether a sidebar may exist at all: the user's persisted preference and
    // the active driver's capability. Which document generation is allowed to
    // present one is decided by `useWorkspaceSidebarOpenGeneration`.
    const sidebarPresentationEnabled = computed(() => (
        view.showSidebar.value && capabilities.value?.sidebar === true
    ));
    const canToggleSidebar = computed(() => (
        toolbarHasPdf.value && capabilities.value?.sidebar === true && !toolbarDocumentBusy.value
    ));

    watch(document.driver.activeDocumentDriver, (adapter) => {
        if (!adapter) {
            logPdfRenderTrace('workspace-page-session-adapter-reset', {currentPageBefore: view.currentPage.value});
            view.currentPage.value = 1;
            view.totalPages.value = 0;
            view.isLoading.value = false;
        }
    });
    const {
        scheduleStartupOpenVisualReady,
        dispatchStartupOpenVisualReady,
    } = useWorkspaceStartupReadiness(view.documentViewerRef);
    const {
        documentOpenAccepted,
        documentOpenSettled,
        initialDocumentVisualReady,
    } = useDocumentOpenVisualSettle({
        pdfSrc: file.pdfSrc,
        pdfDocument: view.pdfDocument,
        totalPages: view.totalPages,
        isLoading: view.isLoading,
        pdfError: file.pdfError,
        djvuError: file.djvuError,
        showDjvuSource: showsDjvuSource,
        openSurface,
    });
    const hasOpenError = computed(() => Boolean(file.pdfError.value) || Boolean(file.djvuError.value));
    const { toolbarShowSidebarForDisplay } = useWorkspaceSidebarOpenGeneration({
        sidebarPresentationEnabled,
        isOpeningDocumentForToolbar: isOpeningForToolbar,
        initialDocumentVisualReady,
        hasDocumentOpenError: hasOpenError,
        openSurfaceSnapshot: openSurface.snapshot,
    });

    // Until the first page paints, the document is still opening for every
    // control, even after its source has loaded.
    const initialVisualPending = computed(() => (
        toolbarHasPdf.value
        && view.isLoading.value
        && !initialDocumentVisualReady.value
        && !hasOpenError.value
    ));
    const isOpeningDocumentForDisplay = computed(() => isOpeningForToolbar.value || initialVisualPending.value);
    const toolbarDocumentBusyForDisplay = computed(() => toolbarDocumentBusy.value || initialVisualPending.value);
    const canRepairSave = computed(() => (
        file.hasPdf.value
        && !toolbarDocumentBusy.value
        && !save.isAnySaving.value
        && !history.isHistoryBusy.value
        && capabilities.value?.repairSave === true
        && !initialVisualPending.value
    ));
    const statusZoomLabel = computed(() => (
        initialVisualPending.value ? t('status.zoomUnknown') : viewContext.statusBar.statusZoomLabel.value
    ));
    const documentMetadataReady = computed(() => (
        toolbarHasPdf.value && view.totalPages.value > 0 && !isOpeningDocumentForDisplay.value
    ));
    const {pageLabelState} = document.metadata;
    const toolbarPageLabels = computed<TDocumentPageLabelLookup>(() => {
        if (!documentMetadataReady.value) {
            return null;
        }
        // The label state resets its model for another document, so a model
        // of the right size stays valid while a new revision's labels reread.
        const model = pageLabelState.pageLabelModel.value;
        return model?.totalPages === view.totalPages.value
            ? model
            : resolveVisiblePageLabelsDuringMetadataRefresh({
                pageLabels: pageLabelState.pageLabels.value,
                pageLabelsResolved: pageLabelState.pageLabelsResolved.value,
                isSaving: save.isAnySaving.value,
                totalPages: view.totalPages.value,
            });
    });
    const toolbarControlsDisabled = computed(() => !documentMetadataReady.value || toolbarDocumentBusyForDisplay.value);

    const showDjvuConversionUi = computed(() => (
        capabilities.value?.conversionBanner === true
        || capabilities.value?.conversionDialog === true
        || document.pendingDjvuDocumentOpen.value
        || Boolean(file.djvuOpeningPath.value)
        || file.conversionState.value.isConverting
    ));
    const showDjvuConversionBanner = computed(() => (
        showDjvuConversionUi.value
        && openSurface.snapshot.value.phase === 'ready'
        && showsDjvuSource.value
        && initialDocumentVisualReady.value
        && file.djvuShowBanner.value
    ));
    // The document chassis stays laid out while Start covers it, so an open
    // presents its first frame at the final geometry.
    const showWorkspaceViewerDocument = computed(() => {
        const phase = openSurface.snapshot.value.phase;
        return (
            capabilities.value?.closeableDocument === true
            && (showsPdfSidebar.value || showsDjvuSource.value)
        )
            || phase === 'pending'
            || phase === 'geometry-committed'
            || phase === 'canvas-committed'
            || phase === 'viewport-committed';
    });

    const navigationFeedbackPage = ref<number | null>(null);
    watch(file.pdfSrc, (src) => {
        navigationFeedbackPage.value = null;
        if (src) {
            scheduleStartupOpenVisualReady('pdf-src');
        }
    });
    watch(() => driverView.value?.startupVisualSource ?? null, (source) => {
        if (source) {
            navigationFeedbackPage.value = null;
            scheduleStartupOpenVisualReady(source);
        }
    });
    const documentOpenIdle = computed(() => (
        !isOpeningDocument.value && (documentOpenSettled.value || !toolbarHasPdf.value)
    ));
    /** Resolves once no open is in flight and any document shows its first page. */
    async function waitForDocumentOpenSettled() {
        await until(documentOpenIdle).toBe(true);
    }
    useDocumentOpenedAutomationEvent({
        currentPage: view.currentPage,
        originalPath: file.originalPath,
        tabId,
        totalPages: view.totalPages,
        waitForDocumentOpenSettled,
        workingCopyPath: file.workingCopyPath,
    });
    watch(hasOpenError, (failed) => {
        if (failed) {
            dispatchStartupOpenVisualReady('document-error', true);
        }
    });

    return {
        showsPdfSidebar,
        toolbarHasPdf,
        canToggleSidebar,
        toolbarShowSidebarForDisplay,
        documentOpenAccepted,
        documentOpenSettled,
        initialDocumentVisualReady,
        isOpeningDocumentForDisplay,
        toolbarDocumentBusyForDisplay,
        canRepairSave,
        // Optimizing needs exactly what repair needs: a settled, idle PDF.
        canOptimizePdf: canRepairSave,
        statusZoomLabel,
        documentMetadataReady,
        toolbarPageLabels,
        toolbarControlsDisabled,
        showDjvuConversionUi,
        showDjvuConversionBanner,
        showWorkspaceViewerDocument,
        navigationFeedbackPage,
        waitForDocumentOpenSettled,
    };
};
