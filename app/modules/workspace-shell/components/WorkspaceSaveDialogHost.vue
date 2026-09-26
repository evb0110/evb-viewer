<template>
    <div v-show="visible" class="workspace-save-dialog-host-root">
        <PdfExportScopeDialog
            :open="visible && exportWorkflow.exportScopeDialogOpen.value"
            :mode="exportWorkflow.exportScopeDialogMode.value"
            :total-pages="totalPages"
            :current-page="currentPage"
            :selected-pages="exportWorkflow.exportScopeDialogSelectedPages.value"
            :selected-page-selection="exportWorkflow.exportScopeDialogPageSelection.value"
            @submit="exportWorkflow.handleExportScopeDialogSubmit"
            @update:open="exportWorkflow.handleExportScopeDialogOpenChange"
        />

        <PdfPrintDialog
            :open="visible && print.printDialogOpen.value"
            :total-pages="totalPages"
            :current-page="currentPage"
            :selected-pages="print.printDialogSelectedPages.value"
            :selected-page-selection="print.printDialogPageSelection.value"
            :default-view-mode="viewMode"
            :supports-advanced-print-options="print.supportsAdvancedPrintOptions.value"
            :supports-first-page-single-print-layout="print.supportsFirstPageSinglePrintLayout.value"
            :is-preparing="print.isPreparingPrint.value"
            :status="print.printStatus.value"
            :error="print.printError.value"
            @submit="print.handlePrintDialogSubmit"
            @update:open="print.handlePrintDialogOpenChange"
        />

        <PdfOptimizeDialog
            :open="visible && optimize.optimizeDialogOpen.value"
            :is-running="optimize.isOptimizeDialogRunning.value"
            :progress="optimize.optimizeProgress.value"
            :error="optimize.optimizeDialogError.value"
            @submit="optimize.handleOptimizeDialogSubmit"
            @update:open="optimize.handleOptimizeDialogOpenChange"
        />

        <PdfCropDialog
            :open="visible && crop.cropDialogOpen.value"
            :loading="crop.cropDialogLoading.value"
            :total-pages="totalPages"
            :current-page="crop.cropDialogPageNumber.value"
            :selected-pages="selectedThumbnailPages"
            :selected-page-selection="selectedPageSelection"
            :initial-margins="crop.cropDialogMargins.value"
            :media-box="crop.cropDialogMediaBox.value"
            :current-visible-box="crop.cropDialogCurrentBox.value"
            :rotation="crop.cropDialogRotation.value"
            @apply="void pageOps.handleCropPages($event.pageSelection ?? $event.pages, $event.margins)"
            @remove="void pageOps.handleRemoveCrop($event.pageSelection ?? $event.pages)"
            @update:open="crop.cropDialogOpen.value = $event"
        />

        <DjvuConvertDialog
            v-if="showDjvuConversionUi"
            :open="visible && file.showConvertDialog.value"
            :djvu-path="file.djvuSourcePath.value"
            @convert="file.handleDjvuConvert"
            @update:open="file.showConvertDialog.value = $event"
        />
    </div>
</template>

<script setup lang="ts">
import { PdfCropDialog } from '@app/modules/pdf-viewer/public/component-exports/pdfCropDialog';
import { PdfExportScopeDialog } from '@app/modules/pdf-viewer/public/component-exports/pdfExportScopeDialog';
import { PdfOptimizeDialog } from '@app/modules/pdf-viewer/public/component-exports/pdfOptimizeDialog';
import { PdfPrintDialog } from '@app/modules/pdf-viewer/public/component-exports/pdfPrintDialog';
import { useDocumentContext } from '@app/modules/workspace-shell/documentContext';

const DjvuConvertDialog = defineAsyncComponent(
    () => import('@app/modules/djvu-viewer/public')
        .then(componentModule => componentModule.DjvuConvertDialog),
);

defineProps<{
    visible: boolean;
    showDjvuConversionUi: boolean;
}>();

const {
    view,
    exportWorkflow,
    print,
    crop,
    pageOps,
    file,
    save: {optimizeDialog: optimize},
} = useDocumentContext();
const {
    totalPages,
    currentPage,
    viewMode,
    selectedThumbnailPages,
    selectedPageSelection,
} = view;
</script>

<style scoped>
.workspace-save-dialog-host-root {
    display: contents;
}
</style>
