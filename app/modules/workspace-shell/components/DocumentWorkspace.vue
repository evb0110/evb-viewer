<template>
    <WorkspaceShell>
        <WorkspaceToolbarHost
            :is-active="isActive && surfaceMode === 'reader'"
            :can-teleport="canTeleportToolbar"
        >
            <WorkspacePdfToolbarView
                ref="ocrPopupRef"
                :snapshot="workspaceToolbarSnapshot"
                :has-pdf="toolbarHasPdf"
                :can-toggle-sidebar="canToggleSidebar"
                :can-use-ocr="canUseOcr"
                :can-use-djvu="canUseDjvu"
                :is-desktop-runtime="isDesktopRuntime"
                :surface="toolbarSurface"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                :document-busy="toolbarDocumentBusyForDisplay"
                :controls-disabled="toolbarControlsDisabled"
                :page-dropdown-total-pages="documentMetadataReady ? totalPages : 0"
                :page-labels="toolbarPageLabels"
                :navigation-ticket="documentOpenSurface.navigationTicket.value"
                :physical-page="physicalToolbarPage"
                :ocr-pdf-document="pdfDocument"
                :ocr-working-copy-path="workingCopyPath"
                :ocr-document-revision="documentRevisionToken"
                :ocr-external-error="docxExportError"
                :ocr-is-exporting-docx="isExportingDocx"
                :ocr-popup-open="ocrPopupOpen"
                :zoom-dropdown-open="zoomDropdownOpen"
                :page-dropdown-open="pageDropdownOpen"
                :overflow-menu-open="overflowMenuOpen"
                :app-menu-open="appMenuOpen"
                @update:ocr-popup-open="handleDropdownOpen('ocr', $event)"
                @update:zoom-dropdown-open="handleDropdownOpen('zoom', $event)"
                @update:page-dropdown-open="handleDropdownOpen('page', $event)"
                @update:overflow-menu-open="handleDropdownOpen('overflow', $event)"
                @update:app-menu-open="handleDropdownOpen('appMenu', $event)"
                @update:zoom="zoom = $event"
                @update:effective-zoom="effectiveZoom = $event"
                @update:zoom-mode="zoomMode = $event"
                @update:fit-mode="fitMode = $event"
                @update:view-mode="viewMode = $event"
                @update:ocr-running="isOcrRunning = $event"
                @open-file="fileOps.handleOpenFileFromUi"
                @open-settings="emit('open-settings')"
                @open-scan-cleanup="scanCleanup.openScanCleanup"
                @save="runToolbarAction(handleSaveWithAutomationEvent)"
                @repair-save="runToolbarAction(handleRepairSave)"
                @optimize-pdf-for-interaction="runToolbarAction(openOptimizePdfForInteractionDialog)"
                @save-as="runToolbarAction(handleSaveAs)"
                @print="handlePrint"
                @print-current-page="handlePrintCurrentPage"
                @combine-files="emit('open-combine')"
                @export-docx="runToolbarAction(handleExportDocx)"
                @ocr-export-docx="handleExportDocx"
                @ocr-cancel-docx-export="cancelDocxExportDirect"
                @export-images="handleExportImages()"
                @export-multi-page-tiff="handleExportMultiPageTiff()"
                @convert-to-pdf="openConvertDialog"
                @undo="runToolbarAction(handleUndo)"
                @redo="runToolbarAction(handleRedo)"
                @insert-image-from-file="handleInsertImageFromFile"
                @paste-image-from-clipboard="handlePasteImageFromClipboard"
                @delete-pages="workspaceExpose.handleDeletePages()"
                @extract-pages="workspaceExpose.handleExtractPages()"
                @rotate-cw="workspaceExpose.handleRotateCw()"
                @rotate-ccw="workspaceExpose.handleRotateCcw()"
                @insert-pages="workspaceExpose.handleInsertPages()"
                @toggle-sidebar="runToolbarAction(workspaceExpose.handleToggleSidebar)"
                @fit-width="runToolbarAction(workspaceExpose.handleFitWidth)"
                @fit-height="runToolbarAction(workspaceExpose.handleFitHeight)"
                @toggle-continuous-scroll="runToolbarAction(toggleContinuousScroll)"
                @enable-drag="runToolbarAction(enableDragMode)"
                @disable-drag="runToolbarAction(workspaceExpose.handleDisableDragMode)"
                @capture-region="runToolbarAction(handleCaptureRegion)"
                @crop="runToolbarAction(handleCropAction)"
                @quick-note="runToolbarAction(handleQuickNoteAction)"
                @toggle-fullscreen="emit('toggle-fullscreen')"
                @set-view-mode="runToolbarAction(() => setViewMode($event))"
                @go-to-page="handleGoToPage"
                @ocr-complete="handleOcrComplete"
            />
        </WorkspaceToolbarHost>
        <WorkspaceDocumentAlerts
            :visible="surfaceMode === 'reader'"
            :pdf-error="pdfError"
            :pdf-failure-presentation="pdfFailurePresentation"
            :show-djvu-conversion-ui="showDjvuConversionUi"
            :djvu-error="djvuError"
            :show-djvu-banner="showDjvuConversionBanner"
            :djvu-converting="conversionState.isConverting"
            @convert="openConvertDialog"
            @dismiss="djvuDismissBanner"
        />
        <WorkspaceSidebarHost
            v-show="surfaceMode === 'reader' || !scanCleanup.workspaceMounted.value"
            :show-sidebar="toolbarShowSidebarForDisplay"
            :sidebar-wrapper-style="sidebarWrapperStyle"
            :sidebar-content-width="sidebarWidth"
            :is-resizing-sidebar="isPointerResizingSidebar"
            :resize-aria-label="t('sidebar.resize')"
            @resize-start="startSidebarResize"
            @container-resize="setSidebarContainerWidth"
            @slide-start="isSlidingSidebar = true"
            @slide-end="isSlidingSidebar = false"
        >
            <template #sidebar>
                <WorkspaceDocumentSidebar
                    :shows-pdf-sidebar="driverShowsPdfSidebar"
                    :is-open="isSidebarPresented"
                    :is-active="isDocumentSidebarActive"
                    :is-source-resizing="isSourceSidebarResizing"
                    :page-labels="toolbarPageLabels"
                    :document-opening="isOpeningDocumentForToolbarDisplay"
                />
            </template>
            <!-- The document chassis stays laid out while Start covers it, so an
            open presents its first frame at the final geometry. -->
            <div class="workspace-viewer-host" :aria-hidden="!showWorkspaceViewerDocument ? 'true' : undefined">
                <component
                    :is="activeViewerComponent"
                    v-if="mountedDocumentDriver"
                    :ref="bindActiveViewerRef"
                    v-bind="activeViewerProps"
                    v-on="activeViewerListeners"
                />
            </div>
        </WorkspaceSidebarHost>
        <WorkspaceScanCleanupSurface :can-teleport-toolbar="canTeleportToolbar" />
        <WorkspacePageOpProgressOverlay v-show="surfaceMode === 'reader'" :has-document="toolbarHasPdf" />
        <WorkspaceExportProgressOverlay v-show="surfaceMode === 'reader'" />
        <Teleport v-if="isActive && canTeleportStatus" to="#editor-global-status-host">
            <PdfStatusBar
                :file-path="statusBar.statusFilePath.value"
                :file-size-label="statusBar.statusFileSizeLabel.value"
                :zoom-label="statusZoomLabelForDisplay"
                :materialization-label="statusBar.statusMaterializationLabel.value"
                :can-show-in-folder="statusBar.statusCanShowInFolder.value"
                :show-in-folder-tooltip="statusBar.statusShowInFolderTooltip.value"
                :show-in-folder-aria-label="statusBar.statusShowInFolderAriaLabel.value"
                :save-dot-class="statusBar.statusSaveDotClass.value"
                :save-dot-tooltip="statusBar.statusSaveDotTooltip.value"
                :save-dot-aria-label="statusBar.statusSaveDotAriaLabel.value"
                :can-save="statusBar.statusSaveDotCanSave.value"
                @show-in-folder="statusBar.handleStatusShowInFolderClick"
                @save="statusBar.handleStatusSaveClick"
            />
        </Teleport>
        <WorkspaceAnnotationOverlays :visible="surfaceMode === 'reader'" />
        <DjvuConversionOverlay
            :is-converting="conversionState.isConverting"
            :phase="conversionState.phase"
            :percent="conversionState.percent"
            @cancel="handleDjvuCancel"
        />
        <WorkspaceSaveDialogHost
            :visible="surfaceMode === 'reader'"
            :show-djvu-conversion-ui="showDjvuConversionUi"
        />
    </WorkspaceShell>
</template>

<script setup lang="ts">
import { until } from '@vueuse/core';
import '@app/assets/css/pdfjs-overrides.scss';
import '@app/assets/css/pdf-comment-markers.scss';
import '@app/assets/css/pdf-comment-ui.scss';
import '@app/assets/css/pdf-search-highlights.scss';
import '@app/assets/css/pdf-animations.scss';
import '@app/assets/css/pdf-debug-overlays.scss';
import { PdfStatusBar } from '@app/modules/pdf-viewer/public/component-exports/pdfStatusBar';
import { createWorkspaceExpose } from '@app/modules/workspace-shell/expose/createWorkspaceExpose';
import WorkspaceAnnotationOverlays from '@app/modules/workspace-shell/components/WorkspaceAnnotationOverlays.vue';
import WorkspaceDocumentAlerts from '@app/modules/workspace-shell/components/WorkspaceDocumentAlerts.vue';
import WorkspaceExportProgressOverlay from '@app/modules/workspace-shell/components/WorkspaceExportProgressOverlay.vue';
import WorkspacePageOpProgressOverlay from '@app/modules/workspace-shell/components/WorkspacePageOpProgressOverlay.vue';
import WorkspacePdfToolbarView from '@app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue';
import WorkspaceSaveDialogHost from '@app/modules/workspace-shell/components/WorkspaceSaveDialogHost.vue';
import WorkspaceShell from '@app/modules/workspace-shell/components/layout/WorkspaceShell.vue';
import WorkspaceSidebarHost from '@app/modules/workspace-shell/components/layout/WorkspaceSidebarHost.vue';
import WorkspaceDocumentSidebar from '@app/modules/workspace-shell/components/WorkspaceDocumentSidebar.vue';
import WorkspaceScanCleanupSurface from '@app/modules/workspace-shell/components/WorkspaceScanCleanupSurface.vue';
import WorkspaceToolbarHost from '@app/modules/workspace-shell/components/layout/WorkspaceToolbarHost.vue';
import { useDocumentWorkspaceSplitRestore } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceSplitRestore';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { TPdfViewMode } from '@contracts/shared';
import { useDocumentOpenVisualSettle } from '@app/modules/workspace-shell/composables/useDocumentOpenVisualSettle';
import {
    useDocumentWorkspaceAgent,
    type IOcrPopupAgentExpose,
} from '@app/modules/workspace-shell/agent/useDocumentWorkspaceAgent';
import { useWorkspaceStartupReadiness } from '@app/modules/workspace-shell/composables/useWorkspaceStartupReadiness';
import {
    createDocumentContext,
    provideDocumentContext,
} from '@app/modules/workspace-shell/documentContext';
import { useWorkspaceRestoreTracker } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import { useWorkspaceViewerVisibility } from '@app/modules/workspace-shell/composables/useWorkspaceViewerVisibility';
import { useWorkspaceSidebarOpenGeneration } from '@app/modules/workspace-shell/composables/useWorkspaceSidebarOpenGeneration';
import { useDocumentWorkspacePageSessionRestore } from '@app/modules/workspace-shell/composables/useDocumentWorkspacePageSessionRestore';
import { useDocumentWorkspaceViewerPresentation } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceViewerPresentation';
import { useDocumentWorkspaceVisualOpeningState } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceVisualOpeningState';
import { useWorkspaceHostTeleportAvailability } from '@app/modules/workspace-shell/composables/useWorkspaceHostTeleportAvailability';
import { createDefaultWorkspaceViewerCapabilities } from '@app/types/workspaceExpose';
import {
    DESKTOP_EDITOR_READER_COMMAND_SURFACE,
    EMPTY_STATE_READER_COMMAND_SURFACE,
} from '@app/utils/readerCommandSurface';
import { createDocumentWorkspaceAutomationHandlers } from '@app/modules/workspace-shell/automation/createDocumentWorkspaceAutomationHandlers';
import { useDocumentOpenedAutomationEvent } from '@app/modules/workspace-shell/automation/useDocumentOpenedAutomationEvent';
import { useWorkspaceDocumentLifecycle } from '@app/modules/workspace-shell/composables/useWorkspaceDocumentLifecycle';
import { createTabViewSessionState } from '@app/modules/workspace-shell/tabs/createTabViewSessionState';
import { DjvuConversionOverlay } from '@app/modules/djvu-viewer/public';
import {
    createDocumentOpenSurfaceSession,
    documentOpenSurfaceSessionKey,
} from '@app/modules/document-viewer/public';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { IWorkspaceSplitCacheSessionState } from '@app/modules/workspace-shell/composables/workspaceSplitTypes';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
const documentOpenSurface = createDocumentOpenSurfaceSession();
provide(documentOpenSurfaceSessionKey, documentOpenSurface);
const physicalToolbarPage = computed(() => (
    documentOpenSurface.viewportSession.value.observedPage
    ?? documentOpenSurface.viewportSession.value.committedPage
    ?? 1
));
const {
    fullscreenSupported,
    isActive,
    isFullscreen,
    isWorkspaceLayoutResizing: isExternalWorkspaceLayoutResizing = false,
    isRenderActive = isActive,
    isTabTransitionBusy,
    documentSession,
    splitCacheSession = null,
    tabId,
} = defineProps<{
    tabId: string;
    isActive: boolean;
    isRenderActive?: boolean | undefined;
    isTabTransitionBusy: boolean;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
    isWorkspaceLayoutResizing?: boolean | undefined;
    documentSession: IWorkspaceDocumentController;
    splitCacheSession?: IWorkspaceSplitCacheSessionState | null | undefined;
}>();
// The tab's retained view (page, zoom, sidebar) seeds this mount; a cold tab
// comes back where it was.
const initialViewState = documentSession.viewState.value;
const {
    canTeleportStatus,
    canTeleportToolbar,
} = useWorkspaceHostTeleportAvailability({
    toolbarHostId: 'editor-global-toolbar-host',
    statusHostId: 'editor-global-status-host',
});
const { isDesktopRuntime } = useRuntimeEnvironment();
const hasDesktopRuntime = computed(() => isDesktopRuntime.value);
const canUseOcr = hasDesktopRuntime;
const canUseDjvu = true;
const isOcrRunning = ref(false);
const ocrPopupRef = ref<IOcrPopupAgentExpose | null>(null);
const emit = defineEmits<{
    'open-in-new-tab': [result: TDocumentRef | TOpenFileResult];
    'request-close-tab': [];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
}>();
const { t } = useTypedI18n();
const workspaceSplitCache = useWorkspaceSplitCache();
const workspaceRestoreTracker = useWorkspaceRestoreTracker();
const isRestoringSplitPayload = ref(false);
const currentPageTransitionHistory = ref<Array<{
    page: number;
    at: number 
}>>([]);
const navigationFeedbackPage = ref<number | null>(null);
const documentSnapshot = computed(() => documentSession.snapshot.value);
const openingTransaction = computed(() => {
    const transaction = documentSnapshot.value.activeTransaction;
    return transaction && transaction.kind !== 'close' ? transaction : null;
});
const isOpeningDocument = computed(() => openingTransaction.value !== null);
const pendingDocumentPath = computed(() => (
    isOpeningDocument.value ? openingTransaction.value?.target?.originalPath ?? null : null
));
const pendingDjvuDocumentOpen = computed(() => openingTransaction.value?.target?.isDjvu === true);
const isActiveRef = computed(() => isActive);
const preserveInitialStateForFirstSource = documentSession.snapshot.value.phase === 'presented'
    && documentSession.toolbarSnapshot.value.initialVisualReady;
const context = createDocumentContext({
    tabId,
    isActive: isActiveRef,
    initialViewState,
    preserveInitialStateForFirstSource,
    controller: documentSession,
    openSurface: documentOpenSurface,
    pendingDocumentPath,
    pendingDocumentSize: computed(() => (
        documentOpenSurface.snapshot.value.openingPageGeometry?.size ?? null
    )),
    runDocumentOpen: (request, run) => documentLifecycle.runOpen(request, run),
    emitOpenInNewTab: result => emit('open-in-new-tab', result),
    emitOpenSettings: () => emit('open-settings'),
});
provideDocumentContext(context);
const {
    scanCleanup,
    scanCleanup: {surfaceMode},
} = context;
const {
    file: fileLifecycle,
    driver: documentDriver,
    view: viewerShell,
    search: searchSidebar,
    annotations: annotationSession,
    annotationActions,
    pageOps,
    fileOps,
    statusBar,
    exportWorkflow,
    metadata: {
        pageLabelState, bookmarkState,
    },
    navigation,
    history,
    save,
    print: printWorkflow,
    crop,
    splitPayload,
    docxExport,
} = context;
const {
    activeDocumentDriver,
    mountedDocumentDriver,
} = documentDriver;
const {
    pdfSrc,
    pdfError,
    pdfFailurePresentation,
    workingCopyPath,
    originalPath,
    documentRevisionToken,
    notifyPdfInitialVisualReady,
    isDjvuMode,
    djvuSourcePath,
    conversionState,
    djvuShowBanner,
    djvuError,
    djvuOpeningPath,
    showConvertDialog,
    openConvertDialog,
    djvuDismissBanner,
    handleDjvuCancel,
    openBatchProgress,
    hasPdf,
    initFromStorage,
} = fileLifecycle;
const {
    pdfViewerRef,
    documentViewerRef,
    zoomDropdownOpen,
    pageDropdownOpen,
    ocrPopupOpen,
    overflowMenuOpen,
    appMenuOpen,
    selectedThumbnailPages,
    selectedPageSelection,
    closeAllDropdowns,
    zoom,
    effectiveZoom,
    zoomMode,
    fitMode,
    viewMode,
    currentPage,
    totalPages,
    pdfDocument,
    isLoading,
    continuousScroll,
    showSidebar,
    sidebarTab,
} = viewerShell;
const {
    sidebarWidth,
    sidebarWrapperStyle,
    isResizingSidebar,
    isPointerResizingSidebar,
    isSlidingSidebar,
    startSidebarResize,
    setSidebarContainerWidth,
    cleanupSidebarResizeListeners,
} = searchSidebar;
const isExternalWorkspaceLayoutResizingRef = toRef(() => isExternalWorkspaceLayoutResizing === true);
const isActiveViewerLayoutResizing = computed(() => (
    isResizingSidebar.value || isExternalWorkspaceLayoutResizingRef.value || isTabTransitionBusy
));
const isDocumentSidebarActive = computed(() => (
    surfaceMode.value === 'reader'
    && (isActive || isRenderActive || isActiveViewerLayoutResizing.value)
));
// The panel stays painted through the closing slide so the wrapper covers real
// content instead of an empty strip; the opening slide reveals it the same way.
const isSidebarPresented = computed(() => showSidebar.value || isSlidingSidebar.value);
// The sidebar panels keep their width through the slide. Only a pointer drag or
// a host-level layout change can reflow them.
const isSourceSidebarResizing = computed(() => (
    isPointerResizingSidebar.value
    || isExternalWorkspaceLayoutResizingRef.value
    || isTabTransitionBusy
    || (isRenderActive && !isActive)
));
// Keep the PDF feature pack mounted so its document session and page source stay
// durable for scan cleanup. Its reader presentation is separate and can be
// removed while the cleanup surface owns the visible page work.
const isDocumentViewerPresentationMounted = computed(() => surfaceMode.value === 'reader');
const isDocumentViewerRenderActive = computed(() => (
    isRenderActive && surfaceMode.value === 'reader'
));
const {
    handleExportImages,
    handleExportMultiPageTiff,
} = exportWorkflow;
const {
    pageLabels,
    pageLabelModel,
    pageLabelsResolved,
} = pageLabelState;
const {markAnnotationCommentsLoading} = annotationSession;
const {
    handleSave,
    handleRepairSave,
    isAnySaving,
} = save;
const {
    error: docxExportError,
    isExporting: isExportingDocx,
    cancel: cancelDocxExportDirect,
} = docxExport;
const {handleOcrComplete} = context;
const {isHistoryBusy} = history;
const {
    handlePrint,
    handlePrintCurrentPage,
} = printWorkflow;
const {
    handleUndo,
    handleRedo,
} = history;
const {
    handleFitMode,
    enableDragMode,
    handleGoToPage,
} = navigation;
const {handleCrop} = crop;
const {handleCaptureRegion} = context;
const {
    captureSplitPayload,
    restoreSplitPayload,
} = splitPayload;
const {
    hasQueuedSplitRestore,
    isExternallyRestoring,
} = useDocumentWorkspaceSplitRestore({
    tabId: tabId,
    pendingDocumentOpen: isOpeningDocument,
    isTabTransitionBusy: computed(() => isTabTransitionBusy === true),
    workspaceSplitCache,
    workspaceRestoreTracker,
    splitCacheSession: computed(() => splitCacheSession),
    hasPdf,
    currentPage,
    totalPages,
    showSidebar,
    sidebarTab,
    isResizingSidebar,
    isLoading,
    continuousScroll,
    fitMode,
    viewMode,
    zoom,
    documentViewerRef,
    initFromStorage,
    cleanupSidebarResizeListeners,
    captureSplitPayload,
    restoreSplitPayload,
    isRestoringSplitPayload,
    currentPageTransitionHistory,
});

const {
    activeDriverCapabilities,
    driverShowsPdfSidebar,
    driverShowsDjvuSource,
    driverStartupVisualSource,
    isOpeningDocumentForToolbar,
    toolbarDocumentBusy,
    toolbarHasPdf,
    sidebarPresentationEnabled,
    canToggleSidebar,
    canRepairSave,
    canOptimizePdf,
} = useWorkspaceViewerVisibility({
    activeDocumentDriver,
    conversionState,
    djvuOpeningPath,
    hasPdf,
    hasQueuedSplitRestore,
    isAnySaving,
    isExternallyRestoring,
    isHistoryBusy,
    isOcrRunning,
    isRestoringSplitPayload,
    pendingDocumentOpen: isOpeningDocument,
    showSidebar,
});
useDocumentWorkspacePageSessionRestore({
    activeViewerAdapter: activeDocumentDriver,
    currentPage,
    documentViewerRef,
    initialPage: initialViewState?.currentPage,
    preserveInitialPage: preserveInitialStateForFirstSource,
    isLoading,
    onRestore: handleGoToPage,
    totalPages,
});

const {
    scheduleStartupOpenVisualReady,
    dispatchStartupOpenVisualReady,
} = useWorkspaceStartupReadiness(documentViewerRef);
const {
    documentOpenAccepted,
    documentOpenSettled,
    initialDocumentVisualReady,
} = useDocumentOpenVisualSettle({
    pdfSrc,
    pdfDocument,
    totalPages,
    isLoading,
    pdfError,
    djvuError,
    showDjvuSource: driverShowsDjvuSource,
    openSurface: documentOpenSurface,
});
const { toolbarShowSidebarForDisplay } = useWorkspaceSidebarOpenGeneration({
    sidebarPresentationEnabled,
    isOpeningDocumentForToolbar,
    initialDocumentVisualReady,
    hasDocumentOpenError: computed(() => Boolean(pdfError.value) || Boolean(djvuError.value)),
    openSurfaceSnapshot: documentOpenSurface.snapshot,
});
const {
    handleInitialVisualReady: handleDocumentInitialVisualReadyWithAutomationEventBase,
    handleSave: handleSaveWithAutomationEvent,
} = createDocumentWorkspaceAutomationHandlers({
    getContext: () => ({
        currentPage: currentPage.value,
        documentRevisionToken: documentRevisionToken.value,
        path: originalPath.value ?? workingCopyPath.value,
        tabId,
        totalPages: totalPages.value,
    }),
    handleSave,
});
function handleDocumentInitialVisualReadyWithAutomationEvent() {
    notifyPdfInitialVisualReady();
    return handleDocumentInitialVisualReadyWithAutomationEventBase();
}
const {
    activeViewerComponent,
    activeViewerProps,
    activeViewerListeners,
    bindActiveViewerRef,
} = context.bindDocumentView({
    mountPresentation: isDocumentViewerPresentationMounted,
    isRenderActive: isDocumentViewerRenderActive,
    isWorkspaceLayoutResizing: isActiveViewerLayoutResizing,
    navigationFeedbackPage,
    onInitialVisualPending: markAnnotationCommentsLoading,
    onInitialVisualReady: handleDocumentInitialVisualReadyWithAutomationEvent,
});

const {
    canOptimizePdfForDisplay,
    canRepairSaveForDisplay,
    documentMetadataReady,
    isOpeningDocumentForToolbarDisplay,
    statusZoomLabelForDisplay,
    toolbarControlsDisabled,
    toolbarDocumentBusyForDisplay,
    toolbarPageLabels,
} = useDocumentWorkspaceVisualOpeningState({
    toolbarHasPdf,
    isLoading,
    initialDocumentVisualReady,
    pdfError,
    djvuError,
    isOpeningDocumentForToolbar,
    toolbarDocumentBusy,
    canRepairSave,
    canOptimizePdf,
    statusZoomLabel: statusBar.statusZoomLabel,
    totalPages,
    pageLabels,
    pageLabelModel,
    pageLabelsResolved,
    isAnySaving,
    t,
});
// Start shows only the shell's own actions; document commands arrive with a document.
const toolbarSurface = computed(() => (
    toolbarHasPdf.value ? DESKTOP_EDITOR_READER_COMMAND_SURFACE : EMPTY_STATE_READER_COMMAND_SURFACE
));
const {
    showDjvuConversionBanner,
    showDjvuConversionUi,
    showWorkspaceViewerDocument: showWorkspaceViewerDocumentFromAdapter,
} = useDocumentWorkspaceViewerPresentation({
    activeViewerCapabilities: computed(() => activeDriverCapabilities.value ?? null),
    canUseDjvu,
    conversionState,
    documentOpenReady: computed(() => documentOpenSurface.snapshot.value.phase === 'ready'),
    djvuOpeningPath,
    djvuShowBanner,
    initialDocumentVisualReady,
    pendingDjvuDocumentOpen,
    showDjvuSource: driverShowsDjvuSource,
    showStandardPdfViewer: driverShowsPdfSidebar,
});
const showWorkspaceViewerDocument = computed(() => {
    const phase = documentOpenSurface.snapshot.value.phase;
    return showWorkspaceViewerDocumentFromAdapter.value
        || phase === 'pending'
        || phase === 'geometry-committed'
        || phase === 'canvas-committed'
        || phase === 'viewport-committed';
});
const {openOptimizePdfForInteractionDialog} = save.optimizeDialog;

const {
    ensureEditProjection,
    handleDropdownOpen,
    handleExportDocx,
    handleInsertImageFromFile,
    handlePasteImageFromClipboard,
    handleQuickNoteAction,
    handleSaveAs,
    runEdit: runPdfEditAction,
} = context.djvuProjection;


const canExportDocx = computed(() => Boolean(workingCopyPath.value) && !isAnySaving.value && !isHistoryBusy.value);
const handleCropAction = () => runPdfEditAction(handleCrop);
// A toolbar action closes the open menus and logs its failure.
function runToolbarAction(action: () => unknown) {
    const result = action();
    if (result instanceof Promise) {
        void result.catch((error: unknown) => {
            BrowserLogger.error('workspace', 'Toolbar action failed', {
                tabId,
                error,
            }, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'});
        });
    }
    closeAllDropdowns();
}
function toggleContinuousScroll() {
    continuousScroll.value = !continuousScroll.value;
}
function setViewMode(mode: TPdfViewMode) {
    viewMode.value = mode;
}


watch(pdfSrc, (src) => {
    navigationFeedbackPage.value = null;
    if (src) {
        scheduleStartupOpenVisualReady('pdf-src');
    }
});
watch(driverStartupVisualSource, (source) => {
    if (source) {
        navigationFeedbackPage.value = null;
        scheduleStartupOpenVisualReady(source);
    }
});
useDocumentOpenedAutomationEvent({
    currentPage,
    originalPath,
    tabId,
    totalPages,
    waitForDocumentOpenSettled,
    workingCopyPath,
});
watch([
    pdfError,
    djvuError,
], ([
    nextPdfError,
    nextDjvuError,
]) => {
    if (nextPdfError || nextDjvuError) {
        dispatchStartupOpenVisualReady('document-error', true);
    }
});
const documentOpenIdle = computed(() => (
    !isOpeningDocument.value && (documentOpenSettled.value || !toolbarHasPdf.value)
));
/** Resolves once no open is in flight and any document shows its first page. */
async function waitForDocumentOpenSettled() {
    await until(documentOpenIdle).toBe(true);
}
const viewerCapabilities = computed(() => activeDriverCapabilities.value ?? createDefaultWorkspaceViewerCapabilities());
const {
    runAgentAction,
    readAgentResource,
} = useDocumentWorkspaceAgent({
    annotationComments: annotationSession.annotationComments,
    annotationCommentsStatus: annotationSession.annotationCommentsStatus,
    annotationInventory: annotationSession.annotationInventory,
    annotationDirty: annotationSession.annotationDirty,
    annotationTool: annotationSession.annotationTool,
    bookmarkItems: bookmarkState.bookmarkItems,
    bookmarksDirty: bookmarkState.bookmarksDirty,
    canSave: save.canSave,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    closeAllDropdowns,
    continuousScroll,
    viewerCapabilities,
    currentPage,
    documentIdentity: fileLifecycle.documentRevisionInfo,
    fitMode,
    handleActualSize: context.viewerDefaults.handleActualSize,
    handleAnnotationFocusComment: annotationActions.handleAnnotationFocusComment,
    handleAnnotationToolChange: annotationSession.handleAnnotationToolChange,
    handleBookmarksChange: bookmarkState.handleBookmarksChange,
    updateTextMarkupColorWithHistory: annotationActions.updateTextMarkupColorWithHistory,
    handleDeleteAnnotationComment: annotationActions.handleDeleteAnnotationComment,
    handleDropdownOpen,
    handleExportDocx,
    handleExportImages: exportWorkflow.handleExportImages,
    handleExportMultiPageTiff: exportWorkflow.handleExportMultiPageTiff,
    handleFitMode,
    handleGoToPage,
    handleOpenAnnotationNote: annotationActions.handleOpenAnnotationNote,
    handleOpenFileFromUi: fileOps.handleOpenFileFromUi,
    handleRepairSave: save.handleRepairSave,
    handleOptimizePdfForInteraction: save.handleOptimizePdfForInteraction,
    handleUndo: history.handleUndo,
    handleRedo: history.handleRedo,
    handlePageLabelRangesUpdate: pageLabelState.handlePageLabelRangesUpdate,
    handlePageRotate: pageOps.handlePageRotate,
    handlePrint: printWorkflow.handlePrint,
    handlePrintCurrentPage: printWorkflow.handlePrintCurrentPage,
    handleQuickNoteAction,
    handleSave: save.handleSave,
    handleSaveAs,
    handleZoomIn: context.viewerDefaults.handleZoomIn,
    handleZoomOut: context.viewerDefaults.handleZoomOut,
    hasPdf,
    isAnySaving: save.isAnySaving,
    isDjvuMode,
    isSameAnnotationComment: annotationSession.isSameAnnotationComment,
    markAnnotationDirty: annotationSession.markAnnotationDirty,
    ocrPopupOpen,
    ocrPopupRef,
    openConvertDialog,
    originalPath,
    pageLabelRanges: pageLabelState.pageLabelRanges,
    pageLabels: pageLabelState.pageLabels,
    pageLabelModel: pageLabelState.pageLabelModel,
    pageLabelsResolved: pageLabelState.pageLabelsResolved,
    pageLabelsDirty: pageLabelState.pageLabelsDirty,
    pageOpsDelete: pageOps.pageOpsDelete,
    pageOpsExtract: pageOps.pageOpsExtract,
    pageOpsInsert: pageOps.pageOpsInsert,
    handleCropPages: pageOps.handleCropPages,
    handleRemoveCrop: pageOps.handleRemoveCrop,
    pdfViewerRef,
    selectedPageSelection,
    selectedThumbnailPages,
    showConvertDialog,
    showSidebar,
    sidebarTab,
    sortedAnnotationNoteWindows: annotationSession.sortedAnnotationNoteWindows,
    t,
    tabId,
    totalPages,
    updateAnnotationNoteText: annotationSession.updateAnnotationNoteText,
    viewMode,
    waitForDocumentOpenSettled,
    workingCopyPath,
    zoom,
});


const workspaceExpose = createWorkspaceExpose(context, {
    ensurePdfProjectionForEdit: ensureEditProjection,
    handleSave: handleSaveWithAutomationEvent,
    handleOptimizePdfForInteraction: () => Promise.resolve(openOptimizePdfForInteractionDialog()),
    handleSaveAs,
    handleExportDocx,
    handleGoToPage: (page, options) => documentLifecycle.goToPage(page, options),
    handleCrop: () => { void handleCropAction(); },
    handleInsertImageFromFile,
    handlePasteImageFromClipboard,
    initialVisualReady: initialDocumentVisualReady,
    isOpeningDocument: isOpeningDocumentForToolbarDisplay,
    canRepairSave: canRepairSaveForDisplay,
    canOptimizePdf: canOptimizePdfForDisplay,
    canExportDocx,
    viewerCapabilities,
    captureSplitPayload,
    restoreSplitPayload,
    waitForDocumentOpenSettled,
    runAgentAction,
    readAgentResource,
});
const workspaceToolbarSnapshot = computed(workspaceExpose.getToolbarSnapshot);
const documentLifecycle = useWorkspaceDocumentLifecycle({
    documentSession,
    openSurface: documentOpenSurface,
    isShown: () => isActive || isRenderActive,
    fileName: fileLifecycle.fileName,
    originalPath,
    isDjvuMode,
    djvuSourcePath,
    documentRevisionInfo: fileLifecycle.documentRevisionInfo,
    isDirty: save.hasPendingUnsavedChanges,
    openBatchProgress,
    documentOpenSettled,
    documentOpenAccepted,
    readOpenFailure: workspaceExpose.getOpenFailure,
    toolbarSnapshot: workspaceToolbarSnapshot,
    readViewState: () => createTabViewSessionState(workspaceToolbarSnapshot.value, documentSession.viewState.value),
    openPath: path => fileOps.handleOpenFileDirectWithPersist(path),
    closeFailedDocument: () => fileOps.handleCloseFileFromUi({persist: false}),
    hasWorkingCopy: () => workingCopyPath.value !== null,
    goToPage: handleGoToPage,
    formatBatchLabel: values => t('tabs.preparingBatch', values),
});
watch(() => isActive || isRenderActive, (shown, wasShown) => {
    if (wasShown && !shown) {
        documentLifecycle.captureViewState();
    }
}, {flush: 'sync'});
onMounted(() => {
    documentSession.attachWorkspace(workspaceExpose);
});
onBeforeUnmount(() => {
    if (surfaceMode.value === 'scan-cleanup') {
        scanCleanup.discardScanCleanupState();
    }
    // A cold tab can unmount in the same render that hides it; capture
    // while the workspace is still live.
    documentLifecycle.captureViewState();
    documentSession.detachWorkspace(workspaceExpose);
});
defineExpose(workspaceExpose);
</script>

<style scoped>
.workspace-viewer-host {
    position: relative;
    width: 100%;
    height: 100%;
}
</style>
