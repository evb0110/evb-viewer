import type { Ref } from 'vue';
import type { TFitMode } from '@app/types/shared';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';

interface ICreateWorkspaceExposeDeps {
    handleSave: () => Promise<void>;
    handleSaveAs: () => Promise<void>;
    handleUndo: () => void;
    handleRedo: () => void;
    handleOpenFileFromUi: () => Promise<void>;
    handleOpenFileDirectWithPersist: (path: string) => Promise<void>;
    handleOpenFileDirectBatchWithPersist: (paths: string[]) => Promise<void>;
    handleCloseFileFromUi: () => Promise<void>;
    handleExportDocx: () => Promise<void>;
    handleExportImages: () => Promise<void>;
    handleExportMultiPageTiff: () => Promise<void>;
    hasPdf: Ref<boolean>;
    closeAllDropdowns: () => void;
    zoom: Ref<number>;
    handleFitMode: (mode: TFitMode) => void;
    sidebarRef: Ref<{ selectedThumbnailPages: number[] } | null>;
    pageOpsDelete: (pages: number[], totalPages: number) => Promise<boolean>;
    pageOpsExtract: (pages: number[]) => Promise<boolean>;
    handlePageRotate: (pages: number[], angle: 90 | 270) => Promise<boolean>;
    pageOpsInsert: (totalPages: number, afterPage: number) => Promise<boolean>;
    totalPages: Ref<number>;
    isDjvuMode: Ref<boolean>;
    openConvertDialog: () => void;
}

function getSelectedPages(sidebarRef: Ref<{ selectedThumbnailPages: number[] } | null>) {
    return sidebarRef.value?.selectedThumbnailPages ?? [];
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
        handleDeletePages: () => {
            const pages = getSelectedPages(deps.sidebarRef);
            if (pages.length > 0) {
                void deps.pageOpsDelete(pages, deps.totalPages.value);
            }
        },
        handleExtractPages: () => {
            const pages = getSelectedPages(deps.sidebarRef);
            if (pages.length > 0) {
                void deps.pageOpsExtract(pages);
            }
        },
        handleRotateCw: () => {
            const pages = getSelectedPages(deps.sidebarRef);
            if (pages.length > 0) {
                void deps.handlePageRotate(pages, 90);
            }
        },
        handleRotateCcw: () => {
            const pages = getSelectedPages(deps.sidebarRef);
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
        closeAllDropdowns: deps.closeAllDropdowns,
    };
}
