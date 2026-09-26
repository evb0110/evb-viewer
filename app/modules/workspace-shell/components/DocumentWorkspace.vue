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
                can-use-djvu
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
                @repair-save="runToolbarAction(save.handleRepairSave)"
                @optimize-pdf-for-interaction="runToolbarAction(openOptimizePdfForInteractionDialog)"
                @save-as="runToolbarAction(handleSaveAs)"
                @print="print.handlePrint"
                @print-current-page="print.handlePrintCurrentPage"
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
                    :shows-pdf-sidebar="showsPdfSidebar"
                    :is-open="isSidebarPresented"
                    :is-active="isDocumentSidebarActive"
                    :is-source-resizing="isSourceSidebarResizing"
                    :page-labels="toolbarPageLabels"
                    :document-opening="isOpeningDocumentForDisplay"
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
                :zoom-label="statusZoomLabel"
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
import { BrowserLogger } from '@app/utils/browserLogger';
import type { TPdfViewMode } from '@contracts/shared';
import {
    useDocumentWorkspaceAgent,
    type IOcrPopupAgentExpose,
} from '@app/modules/workspace-shell/agent/useDocumentWorkspaceAgent';
import {
    createDocumentContext,
    provideDocumentContext,
} from '@app/modules/workspace-shell/documentContext';
import { useWorkspacePresentation } from '@app/modules/workspace-shell/composables/useWorkspacePresentation';
import { useWorkspaceHostTeleportAvailability } from '@app/modules/workspace-shell/composables/useWorkspaceHostTeleportAvailability';
import { createDefaultWorkspaceViewerCapabilities } from '@app/types/workspaceExpose';
import {
    DESKTOP_EDITOR_READER_COMMAND_SURFACE,
    EMPTY_STATE_READER_COMMAND_SURFACE,
} from '@app/utils/readerCommandSurface';
import { createDocumentWorkspaceAutomationHandlers } from '@app/modules/workspace-shell/automation/createDocumentWorkspaceAutomationHandlers';
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
const emit = defineEmits<{
    'open-in-new-tab': [result: TDocumentRef | TOpenFileResult];
    'request-close-tab': [];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
}>();
const { t } = useTypedI18n();
const {
    canTeleportStatus,
    canTeleportToolbar,
} = useWorkspaceHostTeleportAvailability({
    toolbarHostId: 'editor-global-toolbar-host',
    statusHostId: 'editor-global-status-host',
});
const { isDesktopRuntime } = useRuntimeEnvironment();
const canUseOcr = computed(() => isDesktopRuntime.value);
const ocrPopupRef = ref<IOcrPopupAgentExpose | null>(null);
// The tab's retained view (page, zoom, sidebar) seeds this mount; a cold tab
// comes back where it was.
const initialViewState = documentSession.viewState.value;
const preserveInitialStateForFirstSource = documentSession.snapshot.value.phase === 'presented'
    && documentSession.toolbarSnapshot.value.initialVisualReady;
const context = createDocumentContext({
    tabId,
    isActive: computed(() => isActive),
    initialViewState,
    preserveInitialStateForFirstSource,
    controller: documentSession,
    openSurface: documentOpenSurface,
    runDocumentOpen: (request, run) => documentLifecycle.runOpen(request, run),
    emitOpenInNewTab: result => emit('open-in-new-tab', result),
    emitOpenSettings: () => emit('open-settings'),
});
provideDocumentContext(context);
const {
    scanCleanup,
    scanCleanup: {surfaceMode},
    file,
    view,
    search,
    fileOps,
    statusBar,
    exportWorkflow,
    navigation,
    history,
    save,
    print,
    splitPayload,
    docxExport,
    handleCaptureRegion,
    handleOcrComplete,
} = context;
const {
    pdfError,
    pdfFailurePresentation,
    workingCopyPath,
    documentRevisionToken,
    conversionState,
    djvuError,
    openConvertDialog,
    djvuDismissBanner,
    handleDjvuCancel,
} = file;
const {
    zoomDropdownOpen,
    pageDropdownOpen,
    ocrPopupOpen,
    overflowMenuOpen,
    appMenuOpen,
    closeAllDropdowns,
    zoom,
    effectiveZoom,
    zoomMode,
    fitMode,
    viewMode,
    totalPages,
    pdfDocument,
    continuousScroll,
    showSidebar,
} = view;
const {
    sidebarWidth,
    sidebarWrapperStyle,
    isResizingSidebar,
    isPointerResizingSidebar,
    isSlidingSidebar,
    startSidebarResize,
    setSidebarContainerWidth,
} = search;
const {
    handleExportImages,
    handleExportMultiPageTiff,
} = exportWorkflow;
const {
    error: docxExportError,
    isExporting: isExportingDocx,
    cancel: cancelDocxExportDirect,
} = docxExport;
const {
    handleUndo,
    handleRedo,
} = history;
const {
    enableDragMode,
    handleGoToPage,
} = navigation;
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
const {openOptimizePdfForInteractionDialog} = save.optimizeDialog;
const presentation = useWorkspacePresentation(context, {
    splitCacheSession: computed(() => splitCacheSession),
    isTabTransitionBusy: computed(() => isTabTransitionBusy === true),
    initialPage: initialViewState?.currentPage,
    preserveInitialPage: preserveInitialStateForFirstSource,
});
const {
    isOcrRunning,
    showsPdfSidebar,
    toolbarHasPdf,
    canToggleSidebar,
    toolbarShowSidebarForDisplay,
    isOpeningDocumentForDisplay,
    toolbarDocumentBusyForDisplay,
    statusZoomLabel,
    documentMetadataReady,
    toolbarPageLabels,
    toolbarControlsDisabled,
    showDjvuConversionUi,
    showDjvuConversionBanner,
    showWorkspaceViewerDocument,
    waitForDocumentOpenSettled,
} = presentation;

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
const {
    handleInitialVisualReady: emitFirstPageRendered,
    handleSave: handleSaveWithAutomationEvent,
} = createDocumentWorkspaceAutomationHandlers({
    getContext: () => ({
        currentPage: view.currentPage.value,
        documentRevisionToken: documentRevisionToken.value,
        path: file.originalPath.value ?? workingCopyPath.value,
        tabId,
        totalPages: totalPages.value,
    }),
    handleSave: save.handleSave,
});
// Keep the PDF feature pack mounted so its document session and page source stay
// durable for scan cleanup. Its reader presentation is separate and can be
// removed while the cleanup surface owns the visible page work.
const {
    activeViewerComponent,
    activeViewerProps,
    activeViewerListeners,
    bindActiveViewerRef,
} = context.bindDocumentView({
    mountPresentation: computed(() => surfaceMode.value === 'reader'),
    isRenderActive: computed(() => isRenderActive && surfaceMode.value === 'reader'),
    isWorkspaceLayoutResizing: isActiveViewerLayoutResizing,
    navigationFeedbackPage: presentation.navigationFeedbackPage,
    onInitialVisualPending: context.annotations.markAnnotationCommentsLoading,
    onInitialVisualReady: () => {
        file.notifyPdfInitialVisualReady();
        emitFirstPageRendered();
    },
});
const {mountedDocumentDriver} = context.driver;
// Start shows only the shell's own actions; document commands arrive with a document.
const toolbarSurface = computed(() => (
    toolbarHasPdf.value ? DESKTOP_EDITOR_READER_COMMAND_SURFACE : EMPTY_STATE_READER_COMMAND_SURFACE
));
const canExportDocx = computed(() => (
    Boolean(workingCopyPath.value) && !save.isAnySaving.value && !history.isHistoryBusy.value
));
const handleCropAction = () => runPdfEditAction(context.crop.handleCrop);
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
const viewerCapabilities = computed(() => context.viewerCapabilities.value ?? createDefaultWorkspaceViewerCapabilities());
const {
    runAgentAction,
    readAgentResource,
} = useDocumentWorkspaceAgent({
    annotationComments: context.annotations.annotationComments,
    annotationCommentsStatus: context.annotations.annotationCommentsStatus,
    annotationInventory: context.annotations.annotationInventory,
    annotationDirty: context.annotations.annotationDirty,
    annotationTool: context.annotations.annotationTool,
    bookmarkItems: context.metadata.bookmarkState.bookmarkItems,
    bookmarksDirty: context.metadata.bookmarkState.bookmarksDirty,
    canSave: save.canSave,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    closeAllDropdowns,
    continuousScroll,
    viewerCapabilities,
    currentPage: view.currentPage,
    documentIdentity: file.documentRevisionInfo,
    fitMode,
    handleActualSize: context.viewerDefaults.handleActualSize,
    handleAnnotationFocusComment: context.annotationActions.handleAnnotationFocusComment,
    handleAnnotationToolChange: context.annotations.handleAnnotationToolChange,
    handleBookmarksChange: context.metadata.bookmarkState.handleBookmarksChange,
    updateTextMarkupColorWithHistory: context.annotationActions.updateTextMarkupColorWithHistory,
    handleDeleteAnnotationComment: context.annotationActions.handleDeleteAnnotationComment,
    handleDropdownOpen,
    handleExportDocx,
    handleExportImages: exportWorkflow.handleExportImages,
    handleExportMultiPageTiff: exportWorkflow.handleExportMultiPageTiff,
    handleFitMode: navigation.handleFitMode,
    handleGoToPage,
    handleOpenAnnotationNote: context.annotationActions.handleOpenAnnotationNote,
    handleOpenFileFromUi: fileOps.handleOpenFileFromUi,
    handleRepairSave: save.handleRepairSave,
    handleOptimizePdfForInteraction: save.handleOptimizePdfForInteraction,
    handleUndo: history.handleUndo,
    handleRedo: history.handleRedo,
    handlePageLabelRangesUpdate: context.metadata.pageLabelState.handlePageLabelRangesUpdate,
    handlePageRotate: context.pageOps.handlePageRotate,
    handlePrint: print.handlePrint,
    handlePrintCurrentPage: print.handlePrintCurrentPage,
    handleQuickNoteAction,
    handleSave: save.handleSave,
    handleSaveAs,
    handleZoomIn: context.viewerDefaults.handleZoomIn,
    handleZoomOut: context.viewerDefaults.handleZoomOut,
    hasPdf: file.hasPdf,
    isAnySaving: save.isAnySaving,
    isDjvuMode: file.isDjvuMode,
    isSameAnnotationComment: context.annotations.isSameAnnotationComment,
    markAnnotationDirty: context.annotations.markAnnotationDirty,
    ocrPopupOpen,
    ocrPopupRef,
    openConvertDialog,
    originalPath: file.originalPath,
    pageLabelRanges: context.metadata.pageLabelState.pageLabelRanges,
    pageLabels: context.metadata.pageLabelState.pageLabels,
    pageLabelModel: context.metadata.pageLabelState.pageLabelModel,
    pageLabelsResolved: context.metadata.pageLabelState.pageLabelsResolved,
    pageLabelsDirty: context.metadata.pageLabelState.pageLabelsDirty,
    pageOpsDelete: context.pageOps.pageOpsDelete,
    pageOpsExtract: context.pageOps.pageOpsExtract,
    pageOpsInsert: context.pageOps.pageOpsInsert,
    handleCropPages: context.pageOps.handleCropPages,
    handleRemoveCrop: context.pageOps.handleRemoveCrop,
    pdfViewerRef: view.pdfViewerRef,
    selectedPageSelection: view.selectedPageSelection,
    selectedThumbnailPages: view.selectedThumbnailPages,
    showConvertDialog: file.showConvertDialog,
    showSidebar,
    sidebarTab: view.sidebarTab,
    sortedAnnotationNoteWindows: context.annotations.sortedAnnotationNoteWindows,
    t,
    tabId,
    totalPages,
    updateAnnotationNoteText: context.annotations.updateAnnotationNoteText,
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
    initialVisualReady: presentation.initialDocumentVisualReady,
    isOpeningDocument: isOpeningDocumentForDisplay,
    canRepairSave: presentation.canRepairSave,
    canOptimizePdf: presentation.canOptimizePdf,
    canExportDocx,
    viewerCapabilities,
    captureSplitPayload: splitPayload.captureSplitPayload,
    restoreSplitPayload: splitPayload.restoreSplitPayload,
    waitForDocumentOpenSettled,
    runAgentAction,
    readAgentResource,
});
const workspaceToolbarSnapshot = computed(workspaceExpose.getToolbarSnapshot);
const documentLifecycle = useWorkspaceDocumentLifecycle({
    documentSession,
    openSurface: documentOpenSurface,
    isShown: () => isActive || isRenderActive,
    fileName: file.fileName,
    originalPath: file.originalPath,
    isDjvuMode: file.isDjvuMode,
    djvuSourcePath: file.djvuSourcePath,
    documentRevisionInfo: file.documentRevisionInfo,
    isDirty: save.hasPendingUnsavedChanges,
    openBatchProgress: file.openBatchProgress,
    documentOpenSettled: presentation.documentOpenSettled,
    documentOpenAccepted: presentation.documentOpenAccepted,
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
