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
                @open-scan-cleanup="openScanCleanup"
                @save="handleToolbarSave"
                @repair-save="handleToolbarRepairSave"
                @optimize-pdf-for-interaction="handleToolbarOptimizePdfForInteraction"
                @save-as="handleToolbarSaveAs"
                @print="handlePrint"
                @print-current-page="handlePrintCurrentPage"
                @combine-files="emit('open-combine')"
                @export-docx="handleToolbarExportDocx"
                @ocr-export-docx="handleExportDocx"
                @ocr-cancel-docx-export="cancelDocxExportDirect"
                @export-images="handleExportImages()"
                @export-multi-page-tiff="handleExportMultiPageTiff()"
                @convert-to-pdf="openConvertDialog"
                @undo="handleToolbarUndo"
                @redo="handleToolbarRedo"
                @insert-image-from-file="handleInsertImageFromFile"
                @paste-image-from-clipboard="handlePasteImageFromClipboard"
                @delete-pages="handleDeletePages"
                @extract-pages="handleExtractPages"
                @rotate-cw="handleRotateCw"
                @rotate-ccw="handleRotateCcw"
                @insert-pages="handleInsertPages"
                @toggle-sidebar="handleToolbarToggleSidebar"
                @fit-width="handleToolbarFitWidth"
                @fit-height="handleToolbarFitHeight"
                @toggle-continuous-scroll="handleToolbarToggleContinuousScroll"
                @enable-drag="handleToolbarEnableDrag"
                @disable-drag="handleToolbarDisableDrag"
                @capture-region="handleToolbarCaptureRegion"
                @crop="handleToolbarCrop"
                @quick-note="handleToolbarQuickNote"
                @toggle-fullscreen="emit('toggle-fullscreen')"
                @set-view-mode="handleOverflowSetViewMode"
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
            v-show="surfaceMode === 'reader' || !scanCleanupWorkspaceMounted"
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
                <PdfSidebar
                    v-if="surfaceMode === 'reader' && driverShowsPdfSidebar"
                    v-model:active-tab="sidebarTab"
                    v-model:search-query="searchQuery"
                    :submitted-search-query="submittedSearchQuery"
                    :search-options="searchOptions"
                    :is-open="isSidebarPresented"
                    :is-active="isDocumentSidebarActive"
                    :is-resizing="isPointerResizingSidebar"
                    :pdf-document="pdfDocument"
                    :raster-scheduler="pdfRasterScheduler"
                    :page-geometry="thumbnailPageGeometry"
                    :current-page="currentPage"
                    :total-pages="totalPages"
                    :page-labels="toolbarPageLabels"
                    :page-label-ranges="pageLabelRanges"
                    :search-results="results"
                    :current-result-index="currentResultIndex"
                    :current-result-navigation-id="currentResultNavigationId"
                    :is-searching="isSearching"
                    :search-error="searchError"
                    :search-focus-request="searchFocusRequest"
                    :search-progress="searchProgress"
                    :is-truncated="isTruncated"
                    :min-query-length="minQueryLength"
                    :width="sidebarWidth"
                    :annotation-tool="annotationTool"
                    :annotation-keep-active="annotationKeepActive"
                    :annotation-settings="annotationSettings"
                    :annotation-comments="annotationComments"
                    :annotation-comments-status="annotationCommentsStatus"
                    :annotation-inventory="annotationInventory"
                    :annotation-enrichment-state="annotationEnrichmentState"
                    :selected-annotations="annotationSession.selectedAnnotations.value"
                    :can-rotate-annotations="pdfViewerRef?.canRotateSelectedAnnotations"
                    :bookmark-edit-mode="bookmarkEditMode"
                    :bookmark-items="bookmarkItems"
                    :bookmarks-dirty="bookmarksDirty"
                    :bookmark-navigation-intent-version="bookmarkNavigationIntentVersion"
                    :is-page-operation-in-progress="isPageOperationInProgress"
                    :is-djvu-mode="isDjvuMode"
                    :selected-thumbnail-pages="selectedThumbnailPages"
                    :selected-page-selection="selectedPageSelection"
                    :thumbnail-invalidation-request="thumbnailInvalidationRequest"
                    :thumbnail-hidden-annotation-ids="thumbnailHiddenAnnotationIds"
                    @update:available-tabs="setAvailableSidebarTabs"
                    @search="handleSearchWhenDocumentReady"
                    @cancel-search="cancelSearch"
                    @next="handleSearchNext"
                    @previous="handleSearchPrevious"
                    @update:search-options="searchOptions = $event"
                    @go-to-page="handleGoToPage"
                    @go-to-result="handleGoToResult"
                    @update:page-label-ranges="handlePageLabelRangesUpdate"
                    @update:annotation-tool="handleAnnotationToolChange"
                    @update:annotation-keep-active="annotationKeepActive = $event"
                    @annotation-setting="handleAnnotationSettingChange"
                    @annotation-edit-text-box="handleAnnotationToolChange('select'); pdfViewerRef?.editAnnotationTextBox?.($event)"
                    @annotation-properties="pdfViewerRef?.updateSelectedAnnotationProperties?.($event)"
                    @update:selected-thumbnail-pages="handleSelectedThumbnailPagesUpdate"
                    @update:selected-page-selection="setSelectedPageSelection"
                    @annotation-focus-comment="annotationActions.handleAnnotationFocusComment"
                    @annotation-open-note="annotationActions.handleOpenAnnotationNote"
                    @annotation-delete-comment="annotationActions.handleDeleteAnnotationComment"
                    @annotation-retry-enrichment="requestAnnotationEnrichment"
                    @bookmarks-change="handleBookmarksChange"
                    @update:bookmark-edit-mode="bookmarkEditMode = $event"
                    @page-context-menu="showPageContextMenu"
                    @page-rotate-cw="handlePageRotateCw"
                    @page-rotate-ccw="handlePageRotateCcw"
                    @page-extract="handlePageExtract"
                    @page-export="handlePageExport"
                    @page-delete="handlePageDelete"
                    @page-reorder="handlePageReorder"
                    @page-move="handlePageMove"
                    @page-file-drop="pageOps.handlePageFileDrop"
                />
                <DocumentSourceSidebar
                    v-else-if="surfaceMode === 'reader'"
                    v-model:active-tab="sidebarTab"
                    :is-active="isDocumentSidebarActive"
                    :source="documentSourceSidebar.source.value"
                    :current-page="currentPage"
                    :is-resizing="isSourceSidebarResizing"
                    :search-session="documentSourceSidebar.searchSession"
                    :search-focus-request="searchFocusRequest"
                    @go-to-page="handleSourceSidebarGoToPage"
                    @update:available-tabs="setAvailableSidebarTabs"
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
        <div
            v-if="surfaceMode === 'scan-cleanup'"
            class="scan-cleanup-workspace-boundary"
        >
            <ScanCleanupWorkspace
                :source-path="workingCopyPath"
                :page-source="documentPageSource"
                :page-source-pending="documentPageSource === null && isLoading"
                :document-key="documentKey"
                :document-revision="documentRevisionToken"
                :source-sha256="scanCleanupSourceSha256"
                :current-page="currentPage"
                :total-pages="totalPages"
                :session-state="scanCleanupSessionState"
                :toolbar-active="isActive"
                :can-teleport-toolbar="canTeleportToolbar"
                @done="closeScanCleanup"
                @ready="scanCleanupWorkspaceMounted = true"
                @update:session-state="updateScanCleanupSessionState"
            />
        </div>
        <WorkspacePageOpProgressOverlay v-show="surfaceMode === 'reader'" :has-document="toolbarHasPdf" />
        <WorkspaceExportProgressOverlay v-show="surfaceMode === 'reader'" />
        <Teleport v-if="isActive && canTeleportStatus" to="#editor-global-status-host">
            <PdfStatusBar
                :file-path="statusFilePath"
                :file-size-label="statusFileSizeLabel"
                :zoom-label="statusZoomLabelForDisplay"
                :materialization-label="statusMaterializationLabel"
                :can-show-in-folder="statusCanShowInFolder"
                :show-in-folder-tooltip="statusShowInFolderTooltip"
                :show-in-folder-aria-label="statusShowInFolderAriaLabel"
                :save-dot-class="statusSaveDotClass"
                :save-dot-tooltip="statusSaveDotTooltip"
                :save-dot-aria-label="statusSaveDotAriaLabel"
                :can-save="statusSaveDotCanSave"
                @show-in-folder="handleStatusShowInFolderClick"
                @save="handleStatusSaveClick"
            />
        </Teleport>
        <WorkspaceAnnotationOverlays
            :visible="surfaceMode === 'reader'"
            :sorted-annotation-note-windows="sortedAnnotationNoteWindows"
            :annotation-note-positions="annotationNotePositions"
            :annotation-viewport-root="pdfViewerRef?.getViewerContainer?.() ?? null"
            :annotation-zoom="effectiveZoom"
            :annotation-context-menu="annotationContextMenu"
            :annotation-context-menu-style="annotationContextMenuStyle"
            :annotation-context-menu-can-copy="annotationContextMenuCanCopy"
            :annotation-context-menu-can-copy-selection="annotationContextMenuCanCopySelection"
            :annotation-context-menu-can-create-free="annotationContextMenuCanCreateFree"
            :annotation-context-menu-can-insert-image="annotationContextMenuCanInsertImage"
            :annotation-context-menu-is-image="annotationContextMenuIsImage"
            :context-menu-annotation-label="contextMenuAnnotationLabel"
            :context-menu-delete-action-label="contextMenuDeleteActionLabel"
            :page-context-menu="pageContextMenu"
            :page-context-menu-style="pageContextMenuStyle"
            :is-page-operation-in-progress="isPageOperationInProgress"
            :is-djvu-mode="isDjvuMode"
            @update-note-text="updateAnnotationNoteText"
            @update-note-position="updateAnnotationNotePosition"
            @minimize-note="minimizeAnnotationNote"
            @return-note-focus="annotationSession.focusAnnotationNote"
            @restore-note="restoreAnnotationNote"
            @delete-annotation="annotationActions.handleDeleteAnnotationById"
            @focus-note="bringAnnotationNoteToFront"
            @context-open-note="annotationActions.openContextMenuNote"
            @context-copy-text="annotationActions.copyContextMenuNoteText"
            @context-copy-selection-text="annotationActions.copyContextMenuSelectionText"
            @context-delete="annotationActions.deleteContextMenuComment"
            @context-update-color="annotationActions.handleContextTextMarkupColorUpdate"
            @context-markup="annotationActions.createContextMenuMarkup"
            @context-create-free-note="annotationActions.createContextMenuFreeNote"
            @context-create-selection-note="annotationActions.createContextMenuSelectionNote"
            @context-insert-image-from-file="annotationActions.insertContextMenuImageFromFile"
            @context-paste-image-from-clipboard="annotationActions.pasteContextMenuImageFromClipboard"
            @page-delete="pageOps.handlePageContextMenuDelete"
            @page-extract="pageOps.handlePageContextMenuExtract"
            @page-export="pageOps.handlePageContextMenuExport"
            @page-rotate-cw="pageOps.handlePageContextMenuRotateCw"
            @page-rotate-ccw="pageOps.handlePageContextMenuRotateCcw"
            @page-insert-before="pageOps.handlePageContextMenuInsertBefore"
            @page-insert-after="pageOps.handlePageContextMenuInsertAfter"
            @page-select-all="pageOps.handlePageContextMenuSelectAll"
            @page-invert-selection="pageOps.handlePageContextMenuInvertSelection"
        />
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
import { PdfSidebar } from '@app/modules/pdf-viewer/public/component-exports/pdfSidebar';
import { PdfStatusBar } from '@app/modules/pdf-viewer/public/component-exports/pdfStatusBar';
import { createWorkspaceExpose } from '@app/modules/workspace-shell/expose/createWorkspaceExpose';
import WorkspaceAnnotationOverlays from '@app/modules/workspace-shell/components/WorkspaceAnnotationOverlays.vue';
import WorkspaceDocumentAlerts from '@app/modules/workspace-shell/components/WorkspaceDocumentAlerts.vue';
import DocumentSourceSidebar from '@app/modules/workspace-shell/components/DocumentSourceSidebar.vue';
import WorkspaceExportProgressOverlay from '@app/modules/workspace-shell/components/WorkspaceExportProgressOverlay.vue';
import WorkspacePageOpProgressOverlay from '@app/modules/workspace-shell/components/WorkspacePageOpProgressOverlay.vue';
import WorkspacePdfToolbarView from '@app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue';
import WorkspaceSaveDialogHost from '@app/modules/workspace-shell/components/WorkspaceSaveDialogHost.vue';
import WorkspaceShell from '@app/modules/workspace-shell/components/layout/WorkspaceShell.vue';
import WorkspaceSidebarHost from '@app/modules/workspace-shell/components/layout/WorkspaceSidebarHost.vue';
import ScanCleanupWorkspaceLoading from '@app/modules/workspace-shell/components/ScanCleanupWorkspaceLoading.vue';
import WorkspaceToolbarHost from '@app/modules/workspace-shell/components/layout/WorkspaceToolbarHost.vue';
import { useDocumentWorkspaceScanCleanupSurface } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceScanCleanupSurface';
import { useScanCleanupSourceSha256 } from '@app/modules/scan-cleanup/public/workspace';
import { useDocumentWorkspaceSplitRestore } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceSplitRestore';
import { useDocumentWorkspaceToolbar } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceToolbar';
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
import { ZOOM } from '@app/constants/pdfLayout';
import { useWorkspaceRestoreTracker } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import { useWorkspaceViewerVisibility } from '@app/modules/workspace-shell/composables/useWorkspaceViewerVisibility';
import { useWorkspaceSidebarOpenGeneration } from '@app/modules/workspace-shell/composables/useWorkspaceSidebarOpenGeneration';
import { useDocumentWorkspacePageSessionRestore } from '@app/modules/workspace-shell/composables/useDocumentWorkspacePageSessionRestore';
import { useDocumentWorkspaceViewerPresentation } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceViewerPresentation';
import { useDocumentWorkspaceVisualOpeningState } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceVisualOpeningState';
import { useDocumentWorkspacePageOperationHandlers } from '@app/modules/workspace-shell/composables/useDocumentWorkspacePageOperationHandlers';
import { useWorkspaceHostTeleportAvailability } from '@app/modules/workspace-shell/composables/useWorkspaceHostTeleportAvailability';
import { useDocumentSourceSidebarSession } from '@app/modules/workspace-shell/composables/useDocumentSourceSidebarSession';
import { createWorkspacePdfSearchResultNavigation } from '@app/modules/workspace-shell/composables/createWorkspacePdfSearchResultNavigation';
import { createDefaultWorkspaceViewerCapabilities } from '@app/types/workspaceExpose';
import {
    DESKTOP_EDITOR_READER_COMMAND_SURFACE,
    EMPTY_STATE_READER_COMMAND_SURFACE,
} from '@app/utils/readerCommandSurface';
import type { IDocumentPageSource } from '@app/modules/document-viewer/public';
import { createDocumentWorkspaceAutomationHandlers } from '@app/modules/workspace-shell/automation/createDocumentWorkspaceAutomationHandlers';
import { useDocumentOpenedAutomationEvent } from '@app/modules/workspace-shell/automation/useDocumentOpenedAutomationEvent';
import { useWorkspaceDocumentLifecycle } from '@app/modules/workspace-shell/composables/useWorkspaceDocumentLifecycle';
import { createTabViewSessionState } from '@app/modules/workspace-shell/tabs/createTabViewSessionState';
import { useDjvuProjectionActions } from '@app/modules/workspace-shell/composables/useDjvuProjectionActions';
import { DjvuConversionOverlay } from '@app/modules/djvu-viewer/public';
import type { IPdfThumbnailPageGeometry } from '@app/modules/pdf-viewer/public';
import {
    createDocumentOpenSurfaceSession,
    documentOpenSurfaceSessionKey,
} from '@app/modules/document-viewer/public';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { IWorkspaceSplitCacheSessionState } from '@app/modules/workspace-shell/composables/workspaceSplitTypes';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
const ScanCleanupWorkspace = defineAsyncComponent({
    loader: () => import('@app/modules/scan-cleanup/public/workspace')
        .then(module => module.ScanCleanupWorkspace),
    loadingComponent: ScanCleanupWorkspaceLoading,
    delay: 0,
});
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
const {
    closeScanCleanup: closeScanCleanupSurface,
    discardScanCleanupState: discardScanCleanupSurfaceState,
    openScanCleanup: openScanCleanupSurface,
    scanCleanupSessionState,
    surfaceMode,
    updateScanCleanupSessionState,
} = useDocumentWorkspaceScanCleanupSurface({
    closeAllDropdowns: () => closeAllDropdowns(),
    documentSession,
    initialViewState,
    readDocumentKey: () => documentKey.value,
    readSourceSha256: () => scanCleanupSourceSha256.value,
});
const scanCleanupWorkspaceMounted = ref(false);
function openScanCleanup() {
    scanCleanupWorkspaceMounted.value = false;
    openScanCleanupSurface();
}
function closeScanCleanup() {
    scanCleanupWorkspaceMounted.value = false;
    closeScanCleanupSurface();
}
watch(surfaceMode, mode => {
    if (mode === 'reader') {
        scanCleanupWorkspaceMounted.value = false;
    }
});
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
function discardScanCleanupState() {
    discardScanCleanupSurfaceState();
}
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
    documentKey,
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
    ensureDjvuPdfProjection,
    handleDjvuCancel,
    openBatchProgress,
    hasPdf,
    initFromStorage,
} = fileLifecycle;
const scanCleanupSourceSha256 = useScanCleanupSourceSha256({
    enabled: computed(() => isActiveRef.value && surfaceMode.value === 'scan-cleanup'),
    sourcePath: workingCopyPath,
    documentRevision: documentRevisionToken,
});
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
    thumbnailInvalidationRequest,
    setSelectedPageSelection,
    handleSelectedThumbnailPagesUpdate,
    closeAllDropdowns,
    zoom,
    effectiveZoom,
    zoomMode,
    fitMode,
    viewMode,
    currentPage,
    totalPages,
    pdfDocument,
    pdfRasterScheduler,
    isLoading,
    continuousScroll,
    showSidebar,
    sidebarTab,
} = viewerShell;
const {
    searchQuery,
    submittedSearchQuery,
    searchOptions,
    results,
    currentResultIndex,
    currentResultNavigationId,
    isSearching,
    searchError,
    searchProgress,
    isTruncated,
    minQueryLength,
    cancelSearch,
    setAvailableSidebarTabs,
    handleSearch,
    handleSearchNext,
    handleSearchPrevious,
    handleGoToResult: selectPdfSearchResult,
    searchFocusRequest,
    sidebarWidth,
    sidebarWrapperStyle,
    isResizingSidebar,
    isPointerResizingSidebar,
    isSlidingSidebar,
    startSidebarResize,
    setSidebarContainerWidth,
    cleanupSidebarResizeListeners,
} = searchSidebar;
const thumbnailPageGeometry = computed<IPdfThumbnailPageGeometry | null>(() => {
    const viewer = pdfViewerRef.value;
    if (!viewer?.pageMetrics || !viewer.ensurePageMetricsInRange) {
        return null;
    }
    return {
        ensureRange: viewer.ensurePageMetricsInRange,
        metrics: toRaw(viewer.pageMetrics),
        version: viewer.pageMetricsVersion ?? 0,
    };
});
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
function requestAnnotationEnrichment() {
    void pdfViewerRef.value?.ensurePdfAnnotationNameReconciliation?.('annotations-ui-open');
}
watch(
    () => showSidebar.value && sidebarTab.value === 'annotations',
    (annotationsVisible) => {
        if (annotationsVisible) {
            requestAnnotationEnrichment();
        }
    },
    {flush: 'post'},
);
const {
    handleExportImages,
    handleExportMultiPageTiff,
} = exportWorkflow;
const {
    pageLabels,
    pageLabelModel,
    pageLabelRanges,
    pageLabelsDirty,
    pageLabelsResolved,
    handlePageLabelRangesUpdate,
} = pageLabelState;
const {
    bookmarkEditMode,
    bookmarkItems,
    bookmarksDirty,
    handleBookmarksChange,
} = bookmarkState;
const {bookmarkNavigationIntentVersion} = context;
const {
    annotationContextMenu,
    annotationContextMenuStyle,
    annotationContextMenuCanCopy,
    annotationContextMenuCanCopySelection,
    annotationContextMenuCanCreateFree,
    annotationContextMenuCanInsertImage,
    annotationContextMenuIsImage,
    contextMenuAnnotationLabel,
    contextMenuDeleteActionLabel,
    annotationTool,
    annotationKeepActive,
    annotationSettings,
    annotationComments,
    annotationCommentsStatus,
    annotationInventory,
    annotationEnrichmentState,
    thumbnailHiddenAnnotationIds,
    markAnnotationCommentsLoading,
    annotationDirty,
    markAnnotationDirty,
    handleAnnotationToolChange,
    handleAnnotationSettingChange,
    annotationNotePositions,
    sortedAnnotationNoteWindows,
    updateAnnotationNoteText,
    updateAnnotationNotePosition,
    minimizeAnnotationNote,
    restoreAnnotationNote,
    bringAnnotationNoteToFront,
    isSameAnnotationComment,
} = annotationSession;
const {
    pageContextMenu,
    pageContextMenuStyle,
    showPageContextMenu,
} = context.pageContextMenu;
const {
    handleSave,
    handleRepairSave,
    isAnySaving,
    canSave,
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
    canUndo,
    canRedo,
    handleUndo,
    handleRedo,
} = history;
const {
    handleFitMode,
    enableDragMode,
    handleGoToPage,
} = navigation;
const handleGoToResult = createWorkspacePdfSearchResultNavigation({
    results,
    select: selectPdfSearchResult,
});
const {handleCrop} = crop;
const {
    handleCaptureRegion,
    handleDropdownOpen: handleDropdownOpenDirect,
} = context;
const {
    captureSplitPayload,
    restoreSplitPayload,
} = splitPayload;
const {
    setCustomZoomFromDisplay,
    resolveDisplayZoom,
} = context.viewerDefaults;
const handleZoomIn = () => setCustomZoomFromDisplay(resolveDisplayZoom() + ZOOM.STEP);
const handleZoomOut = () => {
    const displayZoom = resolveDisplayZoom();
    if (displayZoom > ZOOM.MIN) {
        setCustomZoomFromDisplay(displayZoom - ZOOM.STEP);
    }
};
const handleActualSize = () => setCustomZoomFromDisplay(1);
const {
    statusFilePath,
    statusFileSizeLabel,
    statusZoomLabel,
    statusMaterializationLabel,
    statusCanShowInFolder,
    statusShowInFolderTooltip,
    statusShowInFolderAriaLabel,
    statusSaveDotClass,
    statusSaveDotCanSave,
    statusSaveDotTooltip,
    statusSaveDotAriaLabel,
    handleStatusSaveClick,
    handleStatusShowInFolderClick,
} = statusBar;
const {isPageOperationInProgress} = pageOps;
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
} = useWorkspaceStartupReadiness({documentViewerRef});
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
const documentSourceSidebar = useDocumentSourceSidebarSession({
    documentRevision: documentRevisionToken,
    onNavigate: pageIndex => handleGoToPage(pageIndex + 1, {navigationSource: 'search'}),
});
/**
 * The source sidebar also reports the click a thumbnail row was activated
 * with, for consumers that resolve multi-select intent from its modifiers.
 * This one only navigates, so the event is dropped here rather than reaching
 * navigation as scroll options.
 */
function handleSourceSidebarGoToPage(pageNumber: number, _event?: MouseEvent) {
    handleGoToPage(pageNumber);
}
const documentPageSource = shallowRef<IDocumentPageSource | null>(null);
function handlePageSourceUpdate(source: IDocumentPageSource | null) {
    documentPageSource.value = source;
    documentSourceSidebar.publishSource(source);
}
const {
    activeViewerComponent,
    activeViewerProps,
    activeViewerListeners,
    bindActiveViewerRef,
} = context.bindDocumentView({
    documentSourceCurrentResultIndex: computed(() => isActiveRef.value && showSidebar.value ? documentSourceSidebar.searchSession.currentResultIndex.value : -1),
    documentSourceSearchResults: computed(() => isActiveRef.value && showSidebar.value ? documentSourceSidebar.searchSession.results.value : []),
    mountPresentation: isDocumentViewerPresentationMounted,
    isRenderActive: isDocumentViewerRenderActive,
    isWorkspaceLayoutResizing: isActiveViewerLayoutResizing,
    navigationFeedbackPage,
    onInitialVisualPending: markAnnotationCommentsLoading,
    onInitialVisualReady: handleDocumentInitialVisualReadyWithAutomationEvent,
    onPageSourceUpdate: handlePageSourceUpdate,
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
    statusZoomLabel,
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
} = useDjvuProjectionActions({
    isDjvuMode,
    currentPage,
    documentViewerRef,
    ensureProjection: ensureDjvuPdfProjection,
    saveAs: save.handleSaveAs,
    saveAsThroughDriver: save.handleSaveAs,
    exportDocx: docxExport.handleExportDocx,
    isExportingDocx,
    cancelExportDocx: cancelDocxExportDirect,
    handleDropdownOpen: handleDropdownOpenDirect,
    insertImageFromFile: annotationActions.insertImageFromFile,
    pasteImageFromClipboard: annotationActions.pasteImageFromClipboard,
    createQuickNote: annotationActions.handleQuickNoteAction,
});

const {
    canExportDocx,
    handleOverflowSetViewMode,
    handleToolbarCaptureRegion,
    handleToolbarCrop,
    handleToolbarDisableDrag,
    handleToolbarEnableDrag,
    handleToolbarExportDocx,
    handleToolbarFitHeight,
    handleToolbarFitWidth,
    handleToolbarQuickNote,
    handleToolbarRedo,
    handleToolbarSave,
    handleToolbarRepairSave,
    handleToolbarOptimizePdfForInteraction,
    handleToolbarSaveAs,
    handleToolbarToggleContinuousScroll,
    handleToolbarToggleSidebar,
    handleToolbarUndo,
} = useDocumentWorkspaceToolbar({
    tabId: tabId,
    emitOpenSettings: () => emit('open-settings'),
    closeAllDropdowns,
    handleSave: handleSaveWithAutomationEvent,
    handleRepairSave,
    handleOptimizePdfForInteraction: openOptimizePdfForInteractionDialog,
    handleSaveAs,
    handleExportDocx,
    handleUndo,
    handleRedo,
    handleCaptureRegion,
    handleCrop: () => runPdfEditAction(handleCrop),
    handleQuickNoteAction,
    handleFitMode,
    handleAnnotationToolChange,
    enableDragMode,
    handleRemoveCrop: pageOps.handleRemoveCrop,
    handleCropPages: pageOps.handleCropPages,
    workingCopyPath,
    isAnySaving,
    isHistoryBusy,
    isExportingDocx,
    showSidebar,
    sidebarTab,
    currentPage,
    totalPages,
    isLoading,
    continuousScroll,
    fitMode,
    viewMode,
    zoom,
    pdfViewerRef,
    isResizingSidebar,
});
const {
    handleDeletePages,
    handleExtractPages,
    handleInsertPages,
    handlePageDelete,
    handlePageExport,
    handlePageExtract,
    handlePageMove,
    handlePageReorder,
    handlePageRotateCcw,
    handlePageRotateCw,
    handleRotateCcw,
    handleRotateCw,
} = useDocumentWorkspacePageOperationHandlers({
    documentControls: pageOps,
    handleExportImages,
    selectedThumbnailPages,
    selectedPageSelection,
    totalPages,
});
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
const searchDocumentReady = computed(() => Boolean(
    workingCopyPath.value
    && pdfDocument.value
    && totalPages.value > 0
    && !isLoading.value
    && !isOpeningDocumentForToolbarDisplay.value,
));
let latestSearchRequest = 0;
// A search typed while the document opens runs once it is searchable.
async function handleSearchWhenDocumentReady() {
    const request = ++latestSearchRequest;
    const identity = [
        workingCopyPath.value,
        documentRevisionToken.value,
    ];
    const query = searchQuery.value;
    const options = {...searchOptions.value};
    await until(searchDocumentReady).toBe(true);
    if (
        request !== latestSearchRequest
        || identity[0] !== workingCopyPath.value
        || identity[1] !== documentRevisionToken.value
    ) {
        return;
    }
    if (!searchQuery.value && query) {
        searchQuery.value = query;
        searchOptions.value = options;
    }
    await handleSearch();
}
const {
    runAgentAction,
    readAgentResource,
} = useDocumentWorkspaceAgent({
    annotationComments,
    annotationCommentsStatus,
    annotationInventory,
    annotationDirty,
    annotationTool,
    bookmarkItems,
    bookmarksDirty,
    canSave,
    canUndo,
    canRedo,
    closeAllDropdowns,
    continuousScroll,
    viewerCapabilities: computed(() => activeDriverCapabilities.value ?? createDefaultWorkspaceViewerCapabilities()),
    currentPage,
    documentIdentity: fileLifecycle.documentRevisionInfo,
    fitMode,
    handleActualSize,
    handleAnnotationFocusComment: annotationActions.handleAnnotationFocusComment,
    handleAnnotationToolChange,
    handleBookmarksChange,
    updateTextMarkupColorWithHistory: annotationActions.updateTextMarkupColorWithHistory,
    handleDeleteAnnotationComment: annotationActions.handleDeleteAnnotationComment,
    handleDropdownOpen: (dropdown, isOpen) => {
        handleDropdownOpen(dropdown, isOpen);
    },
    handleExportDocx,
    handleExportImages,
    handleExportMultiPageTiff,
    handleFitMode,
    handleGoToPage,
    handleOpenAnnotationNote: annotationActions.handleOpenAnnotationNote,
    handleOpenFileFromUi: fileOps.handleOpenFileFromUi,
    handleRepairSave,
    handleOptimizePdfForInteraction: save.handleOptimizePdfForInteraction,
    handleUndo,
    handleRedo,
    handlePageLabelRangesUpdate,
    handlePageRotate: pageOps.handlePageRotate,
    handlePrint,
    handlePrintCurrentPage,
    handleQuickNoteAction,
    handleSave,
    handleSaveAs,
    handleZoomIn,
    handleZoomOut,
    hasPdf,
    isAnySaving,
    isDjvuMode,
    isSameAnnotationComment,
    markAnnotationDirty,
    ocrPopupOpen,
    ocrPopupRef,
    openConvertDialog,
    originalPath,
    pageLabelRanges,
    pageLabels,
    pageLabelModel,
    pageLabelsResolved,
    pageLabelsDirty,
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
    sortedAnnotationNoteWindows,
    t,
    tabId,
    totalPages,
    updateAnnotationNoteText,
    viewMode,
    waitForDocumentOpenSettled,
    workingCopyPath,
    zoom,
});
const workspaceExpose = createWorkspaceExpose(context, {
    ensurePdfProjectionForEdit: ensureEditProjection,
    handlePageDelete,
    handlePageReorder,
    handlePageMove,
    handleSave: handleSaveWithAutomationEvent,
    handleOptimizePdfForInteraction: () => Promise.resolve(openOptimizePdfForInteractionDialog()),
    handleSaveAs,
    handleExportDocx,
    handleGoToPage: (page, options) => documentLifecycle.goToPage(page, options),
    handleCrop: () => { void handleToolbarCrop(); },
    handleInsertImageFromFile,
    handlePasteImageFromClipboard,
    initialVisualReady: initialDocumentVisualReady,
    isOpeningDocument: isOpeningDocumentForToolbarDisplay,
    canRepairSave: canRepairSaveForDisplay,
    canOptimizePdf: canOptimizePdfForDisplay,
    canExportDocx,
    viewerCapabilities: computed(() => activeDriverCapabilities.value ?? createDefaultWorkspaceViewerCapabilities()),
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
        discardScanCleanupState();
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

.scan-cleanup-workspace-boundary {
    position: absolute;
    z-index: var(--app-z-local-overlay);
    inset: 0;
    display: grid;
    min-width: 0;
    min-height: 0;
}

.scan-cleanup-workspace-boundary :deep(.scan-cleanup-loading-surface),
.scan-cleanup-workspace-boundary :deep(.scan-cleanup-surface) {
    min-width: 0;
    min-height: 0;
    grid-area: 1 / 1;
}
</style>
