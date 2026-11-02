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
        :is-opening-document="isOpeningDocument"
        :is-preparing-print="snapshot.isPreparingPrint"
        :is-preparing-current-page-print="snapshot.isPreparingCurrentPagePrint"
        :is-fit-width-active="snapshot.isFitWidthActive"
        :is-fit-height-active="snapshot.isFitHeightActive"
        :show-sidebar="snapshot.showSidebar"
        :can-toggle-sidebar="toolbarCanToggleSidebar"
        :drag-mode="snapshot.dragMode"
        :continuous-scroll="snapshot.continuousScroll"
        :is-djvu-mode="snapshot.viewerCapabilities.conversionBanner"
        :is-capturing-region="snapshot.isCapturingRegion"
        :is-crop-selecting="snapshot.isCropSelecting"
        :is-placing-page-note="snapshot.isPlacingPageNote"
        :document-busy="toolbarDocumentBusy"
        :surface="toolbarSurface"
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
        <!-- Every slot is passed unconditionally: a conditional slot makes PdfToolbar
             re-render slotted components on each of its own updates. -->
        <template #scan-cleanup>
            <AppTooltip
                :text="scanCleanupTrigger.label"
                :delay-duration="1200"
            >
                <span class="scan-cleanup-trigger-wrap">
                    <UButton
                        class="scan-cleanup-trigger"
                        :class="{'is-active': scanCleanupTrigger.running}"
                        color="neutral"
                        variant="ghost"
                        size="md"
                        square
                        type="button"
                        :aria-label="scanCleanupTrigger.label"
                        :aria-pressed="scanCleanupTrigger.running"
                        :disabled="snapshot.scanCleanupDisabled"
                        @click="handleOpenScanCleanup"
                    >
                        <ScanCleanupScissorsIcon class="size-5" />
                    </UButton>
                    <span v-if="scanCleanupTrigger.running" class="scan-cleanup-running-dot" aria-hidden="true" />
                </span>
            </AppTooltip>
        </template>
        <template #ocr>
            <ToolbarButton
                :icon="getReaderCommandToolbarIcon('ocr')"
                :active="ocrPopupOpen"
                :tooltip="t('ocr.button')"
                :disabled="snapshot.ocrTriggerDisabled"
                @click="handleOpenOcr"
            />
        </template>
        <template #zoom-dropdown>
            <PdfZoomDropdown
                v-model:zoom="zoom"
                v-model:zoom-mode="zoomMode"
                v-model:fit-mode="fitMode"
                v-model:view-mode="viewMode"
                :effective-zoom="effectiveZoom"
                :open="zoomDropdownOpen"
                :disabled="toolbarControlsDisabled"
                :has-zoom="toolbarHasPdf && snapshot.totalPages > 0 && !isOpeningDocument"
                :can-use-view-modes="snapshot.viewerCapabilities.viewMode"
                @update:open="handleZoomDropdownOpenUpdate"
                @fit-width="handleFitWidth"
                @fit-height="handleFitHeight"
            />
        </template>
        <template #page-dropdown>
            <PdfPageDropdown
                :model-value="currentPage"
                :open="pageDropdownOpen"
                :total-pages="pageDropdownTotalPages"
                :view-mode="effectiveViewMode"
                :page-labels="pageLabels"
                :navigation-page="navigationPage"
                :disabled="pageNavigationDisabled"
                @go-to-page="handleGoToPage"
                @update:open="handlePageDropdownOpenUpdate"
            />
        </template>
        <template #persistent-actions>
            <!-- The dialog for the document's OCR run; the toolbar slot above is its trigger. -->
            <OcrPopup
                v-if="canUseOcr && ocr"
                :presenter="ocr"
                :current-page="snapshot.currentPage"
                :total-pages="snapshot.totalPages"
                :working-copy-path="ocrWorkingCopyPath"
                :open="ocrPopupOpen"
                :is-exporting-docx="ocrIsExportingDocx"
                :external-error="ocrExternalError"
                :disabled="snapshot.ocrActionDisabled"
                hide-trigger
                @update:open="handleOcrPopupOpenUpdate"
                @export-docx="handleOcrExportDocx"
                @cancel-docx-export="handleOcrCancelDocxExport"
            />
        </template>
    </PdfToolbar>
</template>

<script setup lang="ts">
import { useCanUseScanCleanup } from '@app/composables/useCanUseScanCleanup';

import type { TDocumentRef } from '@contracts/documentRef';
import type {
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
import { PdfPageDropdown } from '@app/modules/pdf-viewer/public/component-exports/pdfPageDropdown';
import { PdfToolbar } from '@app/modules/pdf-viewer/public/component-exports/pdfToolbar';
import { PdfZoomDropdown } from '@app/modules/pdf-viewer/public/component-exports/pdfZoomDropdown';
import ToolbarButton from '@app/components/ToolbarButton.vue';
import { useWorkspaceToolbarPageModel } from '@app/modules/workspace-shell/composables/useWorkspaceToolbarPageModel';
import type { TOcrPopupPresenter } from '@app/modules/ocr-panel/public/runtime';
import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type {
    IDocumentNavigationTicket,
    TDocumentPageLabelLookup,
} from '@app/modules/document-viewer/public';
import {
    describeScanCleanupTrigger,
    ScanCleanupScissorsIcon,
} from '@app/modules/scan-cleanup/public/runtime';
import { getReaderCommandToolbarIcon } from '@app/utils/readerCommandIcons';
import { createReaderToolbarSurface } from '@app/utils/readerCommandSurface';
import { resolveWorkspaceViewerViewMode } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';

const OcrPopup = defineAsyncComponent(
    () => import('@app/modules/ocr-panel/public')
        .then(componentModule => componentModule.OcrPopup),
);
const { t } = useTypedI18n();

const {
    canToggleSidebar = undefined,
    canUseOcr,
    controlsDisabled = undefined,
    documentBusy = undefined,
    fullscreenSupported,
    hasPdf = undefined,
    isOpeningDocument,
    isFullscreen,
    ocrExternalError = null,
    ocrIsExportingDocx: ocrIsExportingDocxProp = undefined,
    ocr = undefined,
    ocrPopupOpen,
    ocrWorkingCopyPath = null,
    pageDropdownOpen,
    pageDropdownTotalPages: pageDropdownTotalPagesProp = undefined,
    pageLabels = null,
    navigationTicket = null,
    physicalPage = undefined,
    snapshot,
    zoomDropdownOpen,
} = defineProps<{
    snapshot: IWorkspaceToolbarSnapshot;
    hasPdf?: boolean | undefined;
    canToggleSidebar?: boolean | undefined;
    canUseOcr: boolean;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
    documentBusy?: boolean | undefined;
    /**
     * The owning workspace's opening state. A document accepted before its
     * first page paints, such as a generated cleanup output, is not opening.
     */
    isOpeningDocument: boolean;
    controlsDisabled?: boolean | undefined;
    pageDropdownTotalPages?: number | undefined;
    pageLabels?: TDocumentPageLabelLookup | undefined;
    navigationTicket?: IDocumentNavigationTicket | null | undefined;
    physicalPage?: number | undefined;
    ocrWorkingCopyPath?: TDocumentRef | null | undefined;
    ocrExternalError?: string | null | undefined;
    ocrIsExportingDocx?: boolean | undefined;
    /** The document's OCR run; absent where no document is open. */
    ocr?: TOcrPopupPresenter | undefined;
    ocrPopupOpen: boolean;
    zoomDropdownOpen: boolean;
    pageDropdownOpen: boolean;
}>();

const emit = defineEmits<{
    'update:ocrPopupOpen': [open: boolean];
    'update:zoomDropdownOpen': [open: boolean];
    'update:pageDropdownOpen': [open: boolean];
    'update:zoom': [zoom: number];
    'update:zoomMode': [mode: TZoomMode];
    'update:fitMode': [mode: TFitMode];
    'update:viewMode': [mode: TPdfViewMode];
    'open-file': [];
    'open-settings': [];
    'open-scan-cleanup': [];
    'save': [];
    'save-as': [];
    'print': [];
    'print-current-page': [];
    'export-docx': [];
    'ocr-export-docx': [selectedLanguages: string[]];
    'ocr-cancel-docx-export': [];
    'undo': [];
    'redo': [];
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
    'go-to-page': [page: number];
}>();

const toolbarHasPdf = computed(() => hasPdf ?? snapshot.hasPdf);
const canUseScanCleanup = useCanUseScanCleanup();
const toolbarSurface = computed(() => createReaderToolbarSurface({
    ocr: canUseOcr,
    scanCleanup: canUseScanCleanup.value,
}));
const toolbarDocumentBusy = computed(() => documentBusy ?? isOpeningDocument);
const toolbarCanToggleSidebar = computed(() => canToggleSidebar ?? true);
const toolbarControlsDisabled = computed(() => (
    controlsDisabled
    ?? (!toolbarHasPdf.value || toolbarDocumentBusy.value || snapshot.totalPages <= 0)
));
const pageNavigationDisabled = computed(() => (
    toolbarDocumentBusy.value ? false : toolbarControlsDisabled.value
));
const pageDropdownTotalPages = computed(() => pageDropdownTotalPagesProp ?? snapshot.totalPages);
const ocrIsExportingDocx = computed(() => ocrIsExportingDocxProp ?? snapshot.isExportingDocx);
const scanCleanupTrigger = computed(() => describeScanCleanupTrigger(ocrWorkingCopyPath, snapshot.totalPages, t));

const zoom = computed({
    get: () => snapshot.zoom,
    set: value => emit('update:zoom', value),
});
const effectiveZoom = computed(() => snapshot.effectiveZoom);
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
const effectiveViewMode = computed(() => resolveWorkspaceViewerViewMode(
    snapshot.viewerCapabilities,
    snapshot.viewMode,
));
const {
    currentPage,
    navigationPage,
    handleGoToPage: handleToolbarGoToPage,
} = useWorkspaceToolbarPageModel({
    sourcePage: () => snapshot.currentPage,
    physicalPage: () => physicalPage ?? snapshot.currentPage,
    navigationTicket: () => navigationTicket,
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

function handleSaveAs() {
    emit('save-as');
}

function handlePrint() {
    emit('print');
}

function handlePrintCurrentPage() {
    emit('print-current-page');
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

function handleUndo() {
    emit('undo');
}

function handleRedo() {
    emit('redo');
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

function handleGoToPage(page: number) {
    handleToolbarGoToPage(page);
}

function handleOpenOcr() {
    emit('update:ocrPopupOpen', true);
}

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

@keyframes scan-cleanup-pulse {
    50% {
        opacity: 0.45;
        transform: scale(0.8);
    }
}
</style>
