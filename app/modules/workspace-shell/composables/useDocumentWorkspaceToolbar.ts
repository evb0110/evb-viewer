import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { ICropMargins } from '@app/types/crop';
import type { TPdfViewMode } from '@contracts/shared';
import type { TPageSelection } from '@contracts/pageNumbers';

interface IUseDocumentWorkspaceToolbarOptions {
    tabId: string;
    emitOpenSettings: () => void;
    closeAllDropdowns: () => void;
    handleSave: () => unknown;
    handleRepairSave: () => unknown;
    handleOptimizePdfForInteraction: () => unknown;
    handleSaveAs: () => unknown;
    handleExportDocx: () => unknown;
    handleUndo: () => unknown;
    handleRedo: () => unknown;
    handleCaptureRegion: () => unknown;
    handleCrop: () => unknown;
    handleQuickNoteAction: () => unknown;
    handleFitMode: (mode: 'width' | 'height') => void;
    handleAnnotationToolChange: (tool: 'none') => void;
    enableDragMode: () => void;
    handleRemoveCrop: (pages: number[] | TPageSelection) => unknown;
    handleCropPages: (pages: number[] | TPageSelection, margins: ICropMargins) => unknown;
    workingCopyPath: Ref<TDocumentRef | null | undefined>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
    isExportingDocx: Ref<boolean>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<unknown>;
    currentPage: Ref<number>;
    totalPages: Ref<number>;
    isLoading: Ref<boolean>;
    continuousScroll: Ref<boolean>;
    fitMode: Ref<unknown>;
    viewMode: Ref<TPdfViewMode>;
    zoom: Ref<number>;
    pdfViewerRef: Ref<{ getViewerContainer?: () => HTMLElement | null; } | null>;
    isResizingSidebar: Ref<boolean>;
}

export const useDocumentWorkspaceToolbar = (options: IUseDocumentWorkspaceToolbarOptions) => {
    const canExportDocx = computed(() => (
        Boolean(options.workingCopyPath.value)
        && !options.isAnySaving.value
        && !options.isHistoryBusy.value
    ));

    function runToolbarAction(action: () => unknown) {
        const result = action();
        if (result instanceof Promise) {
            void result.catch((error: unknown) => {
                BrowserLogger.error('workspace', 'Toolbar action failed', {
                    tabId: options.tabId,
                    error,
                }, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'});
            });
        }
        options.closeAllDropdowns();
    }

    function handleToolbarToggleSidebar() {
        const beforePage = options.currentPage.value;
        const beforeSidebar = options.showSidebar.value;
        const viewer = options.pdfViewerRef.value?.getViewerContainer?.() ?? null;
        const beforeViewerScrollTop = viewer ? Math.round(viewer.scrollTop) : null;
        BrowserLogger.diagnostic('pdf-nav', 'Toolbar sidebar toggle requested', {
            beforeSidebar,
            beforePage,
            sidebarTab: options.sidebarTab.value,
            totalPages: options.totalPages.value,
            isLoading: options.isLoading.value,
            continuousScroll: options.continuousScroll.value,
            fitMode: options.fitMode.value,
            viewMode: options.viewMode.value,
            zoom: options.zoom.value,
            viewerScrollTop: beforeViewerScrollTop,
        });
        runToolbarAction(() => {
            options.showSidebar.value = !options.showSidebar.value;
            BrowserLogger.diagnostic('pdf-nav', 'Toolbar sidebar toggle applied', {
                afterSidebar: options.showSidebar.value,
                pageAfterToggleWrite: options.currentPage.value,
            });
        });
    }

    return {
        canExportDocx,
        handleCropApply(payload: {
            margins: ICropMargins;
            pages: number[];
            pageSelection?: TPageSelection;
        }) {
            void options.handleCropPages(payload.pageSelection ?? payload.pages, payload.margins);
        },
        handleCropRemove(payload: {
            pages: number[];
            pageSelection?: TPageSelection;
        }) {
            void options.handleRemoveCrop(payload.pageSelection ?? payload.pages);
        },
        handleOverflowOpenSettings() {
            runToolbarAction(() => {
                options.emitOpenSettings();
            });
        },
        handleOverflowSetViewMode(mode: TPdfViewMode) {
            runToolbarAction(() => {
                options.viewMode.value = mode;
            });
        },
        handleToolbarCaptureRegion() {
            runToolbarAction(options.handleCaptureRegion);
        },
        handleToolbarCrop() {
            runToolbarAction(options.handleCrop);
        },
        handleToolbarDisableDrag() {
            runToolbarAction(() => {
                options.handleAnnotationToolChange('none');
            });
        },
        handleToolbarEnableDrag() {
            runToolbarAction(() => {
                options.enableDragMode();
            });
        },
        handleToolbarExportDocx() {
            runToolbarAction(options.handleExportDocx);
        },
        handleToolbarFitHeight() {
            runToolbarAction(() => {
                options.handleFitMode('height');
            });
        },
        handleToolbarFitWidth() {
            runToolbarAction(() => {
                options.handleFitMode('width');
            });
        },
        handleToolbarQuickNote() {
            runToolbarAction(options.handleQuickNoteAction);
        },
        handleToolbarRedo() {
            runToolbarAction(options.handleRedo);
        },
        handleToolbarSave() {
            runToolbarAction(options.handleSave);
        },
        handleToolbarRepairSave() {
            runToolbarAction(options.handleRepairSave);
        },
        handleToolbarOptimizePdfForInteraction() {
            runToolbarAction(options.handleOptimizePdfForInteraction);
        },
        handleToolbarSaveAs() {
            runToolbarAction(options.handleSaveAs);
        },
        handleToolbarToggleContinuousScroll() {
            runToolbarAction(() => {
                options.continuousScroll.value = !options.continuousScroll.value;
            });
        },
        handleToolbarToggleSidebar,
        handleToolbarUndo() {
            runToolbarAction(options.handleUndo);
        },
    };
};
