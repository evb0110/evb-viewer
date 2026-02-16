import type { Ref } from 'vue';
import type { TOpenFileResult } from '@app/types/electron-api';
import type {
    TFitMode,
    TPdfViewMode,
} from '@app/types/shared';
import type {
    ICloseFileFromUiOptions,
    IWorkspaceExpose,
} from '@app/types/workspace-expose';

interface ICreateWorkspaceExposeDeps {
    handleSave: () => Promise<void>;
    handleSaveAs: () => Promise<void>;
    handleUndo: () => void;
    handleRedo: () => void;
    handleOpenFileFromUi: () => Promise<void>;
    handleOpenFileDirectWithPersist: (path: string) => Promise<void>;
    handleOpenFileDirectBatchWithPersist: (paths: string[]) => Promise<void>;
    handleOpenFileWithResult: (result: TOpenFileResult) => Promise<void>;
    handleCloseFileFromUi: (options?: ICloseFileFromUiOptions) => Promise<void>;
    handleExportDocx: () => Promise<void>;
    handleExportImages: () => Promise<void>;
    handleExportMultiPageTiff: () => Promise<void>;
    hasPdf: Ref<boolean>;
    closeAllDropdowns: () => void;
    zoom: Ref<number>;
    viewMode: Ref<TPdfViewMode>;
    handleFitMode: (mode: TFitMode) => void;
    selectedThumbnailPages: Ref<number[]>;
    pageOpsDelete: (pages: number[], totalPages: number) => Promise<boolean>;
    pageOpsExtract: (pages: number[]) => Promise<boolean>;
    handlePageRotate: (pages: number[], angle: 90 | 270) => Promise<boolean>;
    pageOpsInsert: (totalPages: number, afterPage: number) => Promise<boolean>;
    totalPages: Ref<number>;
    isDjvuMode: Ref<boolean>;
    openConvertDialog: () => void;
    captureSplitPayload: IWorkspaceExpose['captureSplitPayload'];
    restoreSplitPayload: IWorkspaceExpose['restoreSplitPayload'];
}

function getSelectedPages(selectedThumbnailPages: Ref<number[]>) {
    return selectedThumbnailPages.value;
}

/**
 * Builds the public workspace command surface exposed to parent tabs/menu bindings.
 * Keeping this mapping centralized avoids duplicating command wiring in component files.
 */
export function createWorkspaceExpose(deps: ICreateWorkspaceExposeDeps): IWorkspaceExpose {
    return {
        handleSave: deps.handleSave,
        handleSaveAs: deps.handleSaveAs,
        handleUndo: deps.handleUndo,
        handleRedo: deps.handleRedo,
        handleOpenFileFromUi: deps.handleOpenFileFromUi,
        handleOpenFileDirectWithPersist: deps.handleOpenFileDirectWithPersist,
        handleOpenFileDirectBatchWithPersist: deps.handleOpenFileDirectBatchWithPersist,
        handleOpenFileWithResult: deps.handleOpenFileWithResult,
        handleCloseFileFromUi: deps.handleCloseFileFromUi,
        handleExportDocx: deps.handleExportDocx,
        handleExportImages: deps.handleExportImages,
        handleExportMultiPageTiff: deps.handleExportMultiPageTiff,
        hasPdf: deps.hasPdf,
        handleZoomIn: () => {
            deps.zoom.value = Math.min(deps.zoom.value + 0.25, 5);
        },
        handleZoomOut: () => {
            deps.zoom.value = Math.max(deps.zoom.value - 0.25, 0.25);
        },
        handleFitWidth: () => {
            deps.handleFitMode('width');
        },
        handleFitHeight: () => {
            deps.handleFitMode('height');
        },
        handleActualSize: () => {
            deps.zoom.value = 1;
        },
        handleViewModeSingle: () => {
            deps.viewMode.value = 'single';
        },
        handleViewModeFacing: () => {
            deps.viewMode.value = 'facing';
        },
        handleViewModeFacingFirstSingle: () => {
            deps.viewMode.value = 'facing-first-single';
        },
        handleDeletePages: () => {
            const pages = getSelectedPages(deps.selectedThumbnailPages);
            if (pages.length > 0) {
                void deps.pageOpsDelete(pages, deps.totalPages.value);
            }
        },
        handleExtractPages: () => {
            const pages = getSelectedPages(deps.selectedThumbnailPages);
            if (pages.length > 0) {
                void deps.pageOpsExtract(pages);
            }
        },
        handleRotateCw: () => {
            const pages = getSelectedPages(deps.selectedThumbnailPages);
            if (pages.length > 0) {
                void deps.handlePageRotate(pages, 90);
            }
        },
        handleRotateCcw: () => {
            const pages = getSelectedPages(deps.selectedThumbnailPages);
            if (pages.length > 0) {
                void deps.handlePageRotate(pages, 270);
            }
        },
        handleInsertPages: () => {
            void deps.pageOpsInsert(deps.totalPages.value, deps.totalPages.value);
        },
        handleConvertToPdf: () => {
            if (deps.isDjvuMode.value) {
                deps.openConvertDialog();
                return;
            }
            void deps.handleOpenFileFromUi();
        },
        captureSplitPayload: deps.captureSplitPayload,
        restoreSplitPayload: deps.restoreSplitPayload,
        closeAllDropdowns: deps.closeAllDropdowns,
    };
}
