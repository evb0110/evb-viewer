<template>
    <PdfToolbar
        :has-pdf="toolbarHasPdf"
        :can-save="snapshot.canSave"
        :can-save-as="snapshot.viewerCapabilities.saveAs"
        :can-print="snapshot.viewerCapabilities.print"
        :can-toggle-continuous-scroll="snapshot.viewerCapabilities.continuousScroll"
        :can-undo="snapshot.canUndo"
        :can-redo="snapshot.canRedo"
        :can-export-docx="snapshot.canExportDocx"
        :is-saving="snapshot.isSaving"
        :is-saving-as="snapshot.isSavingAs"
        :is-any-saving="snapshot.isAnySaving"
        :is-history-busy="snapshot.isHistoryBusy"
        :is-exporting-docx="snapshot.isExportingDocx"
        :is-opening-document="snapshot.isOpeningDocument"
        :is-preparing-print="snapshot.isPreparingPrint"
        :is-preparing-current-page-print="snapshot.isPreparingCurrentPagePrint"
        :is-fit-width-active="snapshot.isFitWidthActive"
        :is-fit-height-active="snapshot.isFitHeightActive"
        :show-sidebar="snapshot.showSidebar"
        :can-toggle-sidebar="toolbarCanToggleSidebar"
        :drag-mode="snapshot.dragMode"
        :continuous-scroll="snapshot.continuousScroll"
        :is-djvu-mode="snapshot.isDjvuMode"
        :is-capturing-region="snapshot.isCapturingRegion"
        :is-crop-selecting="snapshot.isCropSelecting"
        :is-placing-page-note="snapshot.isPlacingPageNote"
        :document-busy="toolbarDocumentBusy"
        :viewing-ready="viewingReady"
        :has-ocr-action="canUseOcr"
        :has-scan-cleanup-action="canUseOcr && isDesktopRuntime"
        :surface="surface"
        :is-fullscreen="isFullscreen"
        :fullscreen-supported="fullscreenSupported"
        @open-file="handleOpenFile"
        @open-settings="handleOpenSettings"
        @save="handleSave"
        @save-as="handleSaveAs"
        @print="handlePrint"
        @print-current-page="handlePrintCurrentPage"
        @export-docx="handleExportDocx"
        @undo="handleUndo"
        @redo="handleRedo"
        @toggle-sidebar="handleToggleSidebar"
        @fit-width="handleFitWidth"
        @fit-height="handleFitHeight"
        @toggle-continuous-scroll="handleToggleContinuousScroll"
        @enable-drag="handleEnableDrag"
        @disable-drag="handleDisableDrag"
        @capture-region="handleCaptureRegion"
        @crop="handleCrop"
        @quick-note="handleQuickNote"
        @toggle-fullscreen="handleToggleFullscreen"
    >
        <template #app-menu>
            <ToolbarAppMenu
                :open="appMenuOpen"
                :has-pdf="toolbarHasPdf"
                :can-print="snapshot.viewerCapabilities.print"
                :can-save="snapshot.canSave"
                :can-save-as="snapshot.viewerCapabilities.saveAs"
                :can-repair-save="snapshot.canRepairSave"
                :can-optimize-pdf="snapshot.canOptimizePdf"
                :can-undo="snapshot.canUndo"
                :can-redo="snapshot.canRedo"
                :can-export-docx="snapshot.canExportDocx"
                :is-any-saving="snapshot.isAnySaving"
                :is-history-busy="snapshot.isHistoryBusy"
                :is-exporting-docx="snapshot.isExportingDocx"
                :is-preparing-print="snapshot.isPreparingPrint"
                :is-preparing-current-page-print="snapshot.isPreparingCurrentPagePrint"
                :is-djvu-mode="snapshot.isDjvuMode"
                :can-use-djvu="canUseDjvu"
                :document-busy="toolbarDocumentBusy"
                @update:open="handleAppMenuOpenUpdate"
                @open-file="handleOpenFile"
                @save="handleSave"
                @repair-save="handleRepairSave"
                @optimize-pdf-for-interaction="handleOptimizePdfForInteraction"
                @save-as="handleSaveAs"
                @print="handlePrint"
                @print-current-page="handlePrintCurrentPage"
                @combine-files="handleCombineImages"
                @export-docx="handleExportDocx"
                @export-images="handleExportImages"
                @export-multi-page-tiff="handleExportMultiPageTiff"
                @convert-to-pdf="handleConvertToPdf"
                @undo="handleUndo"
                @redo="handleRedo"
                @insert-image-from-file="handleInsertImageFromFile"
                @paste-image-from-clipboard="handlePasteImageFromClipboard"
                @delete-pages="handleDeletePages"
                @extract-pages="handleExtractPages"
                @rotate-cw="handleRotateCw"
                @rotate-ccw="handleRotateCcw"
                @insert-pages="handleInsertPages"
            />
        </template>
        <template v-if="canUseOcr && isDesktopRuntime" #scan-cleanup="{ isCollapsed }">
            <AppTooltip :text="scanCleanupTriggerTooltip" :delay-duration="1200">
                <span v-if="!isCollapsed(1)" class="scan-cleanup-trigger-wrap">
                    <UButton
                        class="scan-cleanup-trigger"
                        :class="{'is-active': isScanCleanupRunning}"
                        color="neutral"
                        variant="ghost"
                        size="md"
                        square
                        type="button"
                        :aria-label="scanCleanupTriggerTooltip"
                        :aria-pressed="isScanCleanupRunning"
                        :disabled="scanCleanupActionDisabled"
                        @click="handleOpenScanCleanup"
                    >
                        <ScanCleanupScissorsIcon class="size-5" />
                    </UButton>
                    <span v-if="isScanCleanupRunning" class="scan-cleanup-running-dot" aria-hidden="true" />
                </span>
                <span v-else class="hidden-trigger" aria-hidden="true" />
            </AppTooltip>
        </template>
        <template v-if="canUseOcr" #ocr="{ isCollapsed }">
            <OcrPopup
                ref="ocrPopupRef"
                :pdf-document="ocrPdfDocument"
                :current-page="snapshot.currentPage"
                :total-pages="snapshot.totalPages"
                :working-copy-path="ocrWorkingCopyPath"
                :open="ocrPopupOpen"
                :is-exporting-docx="ocrIsExportingDocx"
                :external-error="ocrExternalError"
                :disabled="ocrActionDisabled"
                :hide-trigger="isCollapsed(1)"
                @update:open="handleOcrPopupOpenUpdate"
                @update:running="handleOcrRunningUpdate"
                @export-docx="handleOcrExportDocx"
                @cancel-docx-export="handleOcrCancelDocxExport"
                @ocr-complete="handleOcrComplete"
            />
        </template>
        <template #zoom-dropdown="{ compactLevel }">
            <PdfZoomDropdown
                v-model:zoom="zoom"
                v-model:zoom-mode="zoomMode"
                v-model:fit-mode="fitMode"
                v-model:view-mode="viewMode"
                :effective-zoom="effectiveZoom"
                :open="zoomDropdownOpen"
                :disabled="toolbarControlsDisabled"
                :can-use-view-modes="snapshot.viewerCapabilities.viewMode && !snapshot.openingPreviewReady"
                :compact-level="compactLevel"
                @update:effective-zoom="handleEffectiveZoomUpdate"
                @update:open="handleZoomDropdownOpenUpdate"
                @fit-width="handleFitWidth"
                @fit-height="handleFitHeight"
            />
        </template>
        <template #page-dropdown="{ compactLevel }">
            <PdfPageDropdown
                :model-value="currentPage"
                :open="pageDropdownOpen"
                :total-pages="pageDropdownTotalPages"
                :view-mode="snapshot.viewMode"
                :page-labels="pageLabels"
                :navigation-page="navigationPage"
                :disabled="pageNavigationDisabled"
                :compact-level="compactLevel"
                @go-to-page="handleGoToPage"
                @update:open="handlePageDropdownOpenUpdate"
            />
        </template>
        <template #overflow-menu="{ collapseTier, hasOverflowItems }">
            <ToolbarOverflowMenu
                v-if="hasOverflowItems"
                :open="overflowMenuOpen"
                :collapse-tier="collapseTier"
                :can-toggle-sidebar="toolbarCanToggleSidebar"
                :can-capture-region="canCaptureRegion"
                :can-crop="canCrop"
                :can-quick-note="canQuickNote"
                :has-pdf="toolbarHasPdf"
                :can-use-ocr="canUseOcr"
                :can-use-scan-cleanup="canUseOcr && isDesktopRuntime"
                :scan-cleanup-disabled="scanCleanupActionDisabled"
                :scan-cleanup-running="isScanCleanupRunning"
                :scan-cleanup-label="scanCleanupTriggerTooltip"
                :ocr-disabled="ocrActionDisabled"
                :can-export-docx="snapshot.canExportDocx"
                :is-exporting-docx="snapshot.isExportingDocx"
                :can-use-assistant="assistantPanelEnabled"
                :assistant-available="assistantPanelAvailable"
                :assistant-open="assistantPanelOpen"
                :assistant-label="t('assistant.toggle')"
                :can-toggle-continuous-scroll="snapshot.viewerCapabilities.continuousScroll"
                :can-use-view-modes="snapshot.viewerCapabilities.viewMode && !snapshot.openingPreviewReady"
                :show-sidebar="snapshot.showSidebar"
                :drag-mode="snapshot.dragMode"
                :continuous-scroll="snapshot.continuousScroll"
                :view-mode="snapshot.viewMode"
                :is-djvu-mode="snapshot.isDjvuMode"
                :is-fit-width-active="snapshot.isFitWidthActive"
                :is-fit-height-active="snapshot.isFitHeightActive"
                :is-capturing-region="snapshot.isCapturingRegion"
                :is-crop-selecting="snapshot.isCropSelecting"
                :is-placing-page-note="snapshot.isPlacingPageNote"
                :document-busy="toolbarDocumentBusy"
                :viewing-ready="viewingReady"
                :surface="surface"
                :show-document-section="isDesktopRuntime"
                can-combine-files
                :can-print="snapshot.viewerCapabilities.print"
                :can-save="snapshot.canSave"
                :can-save-as="snapshot.viewerCapabilities.saveAs"
                :can-undo="snapshot.canUndo"
                :can-redo="snapshot.canRedo"
                can-print-current-page
                :can-convert-to-pdf="canUseDjvu && snapshot.viewerCapabilities.conversionDialog"
                :is-preparing-print="snapshot.isPreparingPrint"
                :is-preparing-current-page-print="snapshot.isPreparingCurrentPagePrint"
                :is-any-saving="snapshot.isAnySaving"
                :is-history-busy="snapshot.isHistoryBusy"
                :is-saving="snapshot.isSaving"
                :is-saving-as="snapshot.isSavingAs"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                trigger-icon="i-ph-dots-three"
                @update:open="handleOverflowMenuOpenUpdate"
                @open-file="handleOpenFile"
                @save="handleSave"
                @save-as="handleSaveAs"
                @print="handlePrint"
                @undo="handleUndo"
                @redo="handleRedo"
                @capture-region="handleCaptureRegion"
                @crop="handleCrop"
                @open-ocr="handleOpenOcr"
                @open-scan-cleanup="handleOpenScanCleanup"
                @export-docx="handleExportDocx"
                @toggle-assistant="toggleAssistantPanel"
                @toggle-sidebar="handleToggleSidebar"
                @fit-width="handleFitWidth"
                @fit-height="handleFitHeight"
                @enable-drag="handleEnableDrag"
                @disable-drag="handleDisableDrag"
                @set-view-mode="handleSetViewMode"
                @toggle-continuous-scroll="handleToggleContinuousScroll"
                @quick-note="handleQuickNote"
                @open-settings="handleOpenSettings"
                @combine-files="handleCombineImages"
                @print-current-page="handlePrintCurrentPage"
                @convert-to-pdf="handleConvertToPdf"
                @toggle-fullscreen="handleToggleFullscreen"
            />
        </template>
    </PdfToolbar>
</template>

<script setup lang="ts">
import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';

import type { TDocumentRef } from '@contracts/documentRef';
import type {
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
import { PdfPageDropdown } from '@app/modules/pdf-viewer/public/component-exports/pdfPageDropdown';
import { PdfToolbar } from '@app/modules/pdf-viewer/public/component-exports/pdfToolbar';
import { PdfZoomDropdown } from '@app/modules/pdf-viewer/public/component-exports/pdfZoomDropdown';
import ToolbarAppMenu from '@app/components/toolbar/ToolbarAppMenu.vue';
import ToolbarOverflowMenu from '@app/components/toolbar/ToolbarOverflowMenu.vue';
import { useWorkspaceToolbarPageModel } from '@app/modules/workspace-shell/composables/useWorkspaceToolbarPageModel';
import type {IAgentOcrRunOptions} from '@contracts/agentOcr';
import type {IOcrPopupAgentExpose} from '@app/types/ocrPopupAgentExpose';
import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type { IReaderCommandSurface } from '@app/utils/readerCommandSurface';
import type { TDocumentPageLabelLookup } from '@app/utils/document-viewer/pageLabels';
import {
    formatScanCleanupProgress,
    isScanCleanupRunning,
    ScanCleanupScissorsIcon,
    scanCleanupRun,
} from '@app/modules/scan-cleanup/public/runtime';

const OcrPopup = defineAsyncComponent(
    () => import('@app/modules/ocr-panel/public')
        .then(componentModule => componentModule.OcrPopup),
);
const { t } = useTypedI18n();

const {
    appMenuOpen,
    canCaptureRegion = true,
    canCrop = true,
    canQuickNote = true,
    canToggleSidebar = undefined,
    canUseDjvu = true,
    canUseOcr,
    controlsDisabled = undefined,
    documentBusy = undefined,
    viewingReady = false,
    fullscreenSupported,
    hasPdf = undefined,
    isDesktopRuntime,
    isFullscreen,
    ocrExternalError = null,
    ocrIsExportingDocx: ocrIsExportingDocxProp = undefined,
    ocrPdfDocument = null,
    ocrPopupOpen,
    ocrWorkingCopyPath = null,
    overflowMenuOpen,
    pageDropdownOpen,
    pageDropdownTotalPages: pageDropdownTotalPagesProp = undefined,
    pageLabels = null,
    navigationFeedbackPage = null,
    navigationCommand = null,
    snapshot,
    surface,
    zoomDropdownOpen,
} = defineProps<{
    snapshot: IWorkspaceToolbarSnapshot;
    hasPdf?: boolean | undefined;
    canToggleSidebar?: boolean | undefined;
    canCaptureRegion?: boolean | undefined;
    canCrop?: boolean | undefined;
    canQuickNote?: boolean | undefined;
    canUseOcr: boolean;
    canUseDjvu?: boolean | undefined;
    isDesktopRuntime: boolean;
    surface: IReaderCommandSurface;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
    documentBusy?: boolean | undefined;
    viewingReady?: boolean | undefined;
    controlsDisabled?: boolean | undefined;
    pageDropdownTotalPages?: number | undefined;
    pageLabels?: TDocumentPageLabelLookup | undefined;
    navigationFeedbackPage?: number | null | undefined;
    navigationCommand?: {
        page: number;
        revision: number
    } | null | undefined;
    ocrPdfDocument?: IPdfDocument | null | undefined;
    ocrWorkingCopyPath?: TDocumentRef | null | undefined;
    ocrExternalError?: string | null | undefined;
    ocrIsExportingDocx?: boolean | undefined;
    ocrPopupOpen: boolean;
    zoomDropdownOpen: boolean;
    pageDropdownOpen: boolean;
    overflowMenuOpen: boolean;
    appMenuOpen: boolean;
}>();

const emit = defineEmits<{
    'update:ocrPopupOpen': [open: boolean];
    'update:zoomDropdownOpen': [open: boolean];
    'update:pageDropdownOpen': [open: boolean];
    'update:overflowMenuOpen': [open: boolean];
    'update:appMenuOpen': [open: boolean];
    'update:zoom': [zoom: number];
    'update:effectiveZoom': [zoom: number];
    'update:zoomMode': [mode: TZoomMode];
    'update:fitMode': [mode: TFitMode];
    'update:viewMode': [mode: TPdfViewMode];
    'update:ocrRunning': [running: boolean];
    'open-file': [];
    'open-settings': [];
    'open-scan-cleanup': [];
    'save': [];
    'repair-save': [];
    'optimize-pdf-for-interaction': [];
    'save-as': [];
    'print': [];
    'print-current-page': [];
    'combine-files': [];
    'export-docx': [];
    'ocr-export-docx': [selectedLanguages: string[]];
    'ocr-cancel-docx-export': [];
    'export-images': [];
    'export-multi-page-tiff': [];
    'convert-to-pdf': [];
    'undo': [];
    'redo': [];
    'insert-image-from-file': [];
    'paste-image-from-clipboard': [];
    'delete-pages': [];
    'extract-pages': [];
    'rotate-cw': [];
    'rotate-ccw': [];
    'insert-pages': [];
    'toggle-sidebar': [];
    'fit-width': [];
    'fit-height': [];
    'toggle-continuous-scroll': [];
    'enable-drag': [];
    'disable-drag': [];
    'capture-region': [];
    'crop': [];
    'quick-note': [];
    'toggle-fullscreen': [];
    'set-view-mode': [mode: TPdfViewMode];
    'go-to-page': [page: number];
    'ocr-complete': [payload: unknown];
}>();

const ocrPopupRef = ref<IOcrPopupAgentExpose | null>(null);
const {
    isAvailable: assistantPanelAvailable,
    isEnabled: assistantPanelEnabled,
    isOpen: assistantPanelOpen,
    toggle: toggleAssistantPanel,
} = useAssistantPanel();
const toolbarHasPdf = computed(() => hasPdf ?? snapshot.hasPdf);
const toolbarDocumentBusy = computed(() => documentBusy ?? snapshot.isOpeningDocument);
const toolbarCanToggleSidebar = computed(() => canToggleSidebar ?? true);
const toolbarControlsDisabled = computed(() => (
    controlsDisabled
    ?? (!toolbarHasPdf.value || toolbarDocumentBusy.value || snapshot.totalPages <= 0)
));
const ocrActionDisabled = computed(() => (
    toolbarDocumentBusy.value
    || toolbarControlsDisabled.value
    || snapshot.isAnySaving
    || snapshot.isHistoryBusy
));
const scanCleanupActionDisabled = computed(() => (
    ocrActionDisabled.value || !ocrWorkingCopyPath
));
const pageNavigationDisabled = computed(() => (
    toolbarDocumentBusy.value ? false : toolbarControlsDisabled.value
));
const pageDropdownTotalPages = computed(() => pageDropdownTotalPagesProp ?? snapshot.totalPages);
const ocrIsExportingDocx = computed(() => ocrIsExportingDocxProp ?? snapshot.isExportingDocx);
const scanCleanupJobProgress = computed(() => scanCleanupRun.jobState?.progress ?? {
    stage: 'queued' as const,
    completedUnits: 0,
    totalUnits: Math.max(1, snapshot.totalPages),
});
const scanCleanupTriggerTooltip = computed(() => {
    if (!ocrWorkingCopyPath) {
        return t('scanCleanup.noDocument');
    }
    if (!isScanCleanupRunning.value) {
        return t('scanCleanup.button');
    }
    return formatScanCleanupProgress(scanCleanupJobProgress.value, t).text;
});

const zoom = computed({
    get: () => snapshot.zoom,
    set: value => emit('update:zoom', value),
});
const effectiveZoom = computed({
    get: () => snapshot.effectiveZoom,
    set: value => emit('update:effectiveZoom', value),
});
const zoomMode = computed({
    get: () => snapshot.zoomMode,
    set: value => emit('update:zoomMode', value),
});
const fitMode = computed({
    get: () => snapshot.fitMode,
    set: value => emit('update:fitMode', value),
});
const viewMode = computed({
    get: () => snapshot.viewMode,
    set: value => emit('update:viewMode', value),
});
const {
    currentPage,
    navigationPage,
    handleGoToPage: handleToolbarGoToPage,
} = useWorkspaceToolbarPageModel({
    sourcePage: () => snapshot.currentPage,
    feedbackPage: () => navigationFeedbackPage,
    authoritativeCommand: () => navigationCommand,
    sessionActive: () => toolbarHasPdf.value || toolbarDocumentBusy.value,
    goToPage: page => emit('go-to-page', page),
});

function handleOcrPopupOpenUpdate(open: boolean) {
    emit('update:ocrPopupOpen', open);
}

function handleZoomDropdownOpenUpdate(open: boolean) {
    emit('update:zoomDropdownOpen', open);
}

function handlePageDropdownOpenUpdate(open: boolean) {
    emit('update:pageDropdownOpen', open);
}

function handleOverflowMenuOpenUpdate(open: boolean) {
    emit('update:overflowMenuOpen', open);
}

function handleAppMenuOpenUpdate(open: boolean) {
    emit('update:appMenuOpen', open);
}

function handleEffectiveZoomUpdate(zoom: number) {
    emit('update:effectiveZoom', zoom);
}

function handleOcrRunningUpdate(running: boolean) {
    emit('update:ocrRunning', running);
}

function handleOpenFile() {
    emit('open-file');
}

function handleOpenSettings() {
    emit('open-settings');
}

function handleOpenScanCleanup() {
    emit('open-scan-cleanup');
}

function handleSave() {
    emit('save');
}

function handleRepairSave() {
    emit('repair-save');
}

function handleOptimizePdfForInteraction() {
    emit('optimize-pdf-for-interaction');
}

function handleSaveAs() {
    emit('save-as');
}

function handlePrint() {
    emit('print');
}

function handlePrintCurrentPage() {
    emit('print-current-page');
}

function handleCombineImages() {
    emit('combine-files');
}

function handleExportDocx() {
    emit('export-docx');
}

function handleOcrExportDocx(selectedLanguages: string[]) {
    emit('ocr-export-docx', selectedLanguages);
}

function handleOcrCancelDocxExport() {
    emit('ocr-cancel-docx-export');
}

function handleExportImages() {
    emit('export-images');
}

function handleExportMultiPageTiff() {
    emit('export-multi-page-tiff');
}

function handleConvertToPdf() {
    emit('convert-to-pdf');
}

function handleUndo() {
    emit('undo');
}

function handleRedo() {
    emit('redo');
}

function handleInsertImageFromFile() {
    emit('insert-image-from-file');
}

function handlePasteImageFromClipboard() {
    emit('paste-image-from-clipboard');
}

function handleDeletePages() {
    emit('delete-pages');
}

function handleExtractPages() {
    emit('extract-pages');
}

function handleRotateCw() {
    emit('rotate-cw');
}

function handleRotateCcw() {
    emit('rotate-ccw');
}

function handleInsertPages() {
    emit('insert-pages');
}

function handleToggleSidebar() {
    emit('toggle-sidebar');
}

function handleFitWidth() {
    emit('fit-width');
}

function handleFitHeight() {
    emit('fit-height');
}

function handleToggleContinuousScroll() {
    emit('toggle-continuous-scroll');
}

function handleEnableDrag() {
    emit('enable-drag');
}

function handleDisableDrag() {
    emit('disable-drag');
}

function handleCaptureRegion() {
    emit('capture-region');
}

function handleCrop() {
    emit('crop');
}

function handleQuickNote() {
    emit('quick-note');
}

function handleToggleFullscreen() {
    emit('toggle-fullscreen');
}

function handleSetViewMode(mode: TPdfViewMode) {
    emit('set-view-mode', mode);
}

function handleGoToPage(page: number) {
    handleToolbarGoToPage(page);
}

function handleOpenOcr() {
    emit('update:ocrPopupOpen', true);
}

function handleOcrComplete(payload: unknown) {
    emit('ocr-complete', payload);
}

function runOcrForAgent(options?: IAgentOcrRunOptions) {
    return ocrPopupRef.value?.runOcrForAgent(options) ?? Promise.resolve({
        ok: false,
        error: 'OCR popup is not mounted.',
    });
}

function cancelOcrForAgent() {
    return ocrPopupRef.value?.cancelOcrForAgent() ?? Promise.resolve({
        ok: false,
        error: 'OCR popup is not mounted.',
    });
}

function getAgentOcrSnapshot() {
    return ocrPopupRef.value?.getAgentOcrSnapshot() ?? {
        ok: false,
        error: 'OCR popup is not mounted.',
    };
}

defineExpose<IOcrPopupAgentExpose>({
    runOcrForAgent,
    cancelOcrForAgent,
    getAgentOcrSnapshot,
});
</script>

<style scoped>
.scan-cleanup-trigger-wrap {
    position: relative;
    display: inline-flex;
}

.scan-cleanup-trigger.is-active {
    background: var(--ui-bg-elevated);
}

.scan-cleanup-trigger:disabled {
    color: var(--app-toolbar-control-disabled-fg);
    opacity: var(--app-toolbar-control-disabled-opacity);
}

.scan-cleanup-running-dot {
    position: absolute;
    inset-inline-end: var(--app-space-xs);
    inset-block-end: var(--app-space-xs);
    width: var(--app-space-3xl);
    height: var(--app-space-3xl);
    border: 1px solid var(--ui-bg);
    border-radius: var(--app-radius-full);
    background: var(--ui-primary);
    animation: scan-cleanup-pulse 1.4s ease-in-out infinite;
    pointer-events: none;
}

.hidden-trigger {
    display: none;
}

@keyframes scan-cleanup-pulse {
    50% {
        opacity: 0.45;
        transform: scale(0.8);
    }
}
</style>
