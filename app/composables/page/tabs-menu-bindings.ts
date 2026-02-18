import type { IElectronAPI } from '@app/types/electron-api';
import type { Ref } from 'vue';
import type { TGroupDirection } from '@app/types/editor-groups';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import type { TWindowTabsAction } from '@app/types/window-tab-transfer';

interface ITabsMenuBindingDeps {
    activeWorkspace: Ref<IWorkspaceExpose | null>;
    activeTabId: Ref<string | null>;
    createTab: () => { id: string };
    handleCloseTab: (tabId: string) => Promise<void>;
    openPathInAppropriateTab: (path: string) => Promise<void>;
    openPathsInAppropriateTab: (paths: string[]) => Promise<void>;
    clearRecentFiles: () => Promise<void>;
    loadRecentFiles: () => Promise<void>;
    openSettings: () => void;
    checkForUpdates: () => Promise<void> | void;
    splitEditor: (direction: TGroupDirection) => Promise<void> | void;
    focusGroup: (direction: TGroupDirection) => void;
    moveActiveTab: (direction: TGroupDirection) => Promise<void> | void;
    copyActiveTab: (direction: TGroupDirection) => Promise<void> | void;
    handleWindowTabsAction: (action: TWindowTabsAction) => Promise<void> | void;
}

/**
 * Registers menu->renderer event handlers and returns unsubscribe callbacks.
 */
export function registerTabsMenuBindings(
    electronApi: IElectronAPI,
    deps: ITabsMenuBindingDeps,
) {
    return [
        electronApi.onMenuOpenPdf(() => {
            void deps.activeWorkspace.value?.handleOpenFileFromUi();
        }),
        electronApi.onMenuSave(() => {
            void deps.activeWorkspace.value?.handleSave();
        }),
        electronApi.onMenuSaveAs(() => {
            void deps.activeWorkspace.value?.handleSaveAs();
        }),
        electronApi.onMenuExportDocx(() => {
            void deps.activeWorkspace.value?.handleExportDocx();
        }),
        electronApi.onMenuExportImages(() => {
            void deps.activeWorkspace.value?.handleExportImages();
        }),
        electronApi.onMenuExportMultiPageTiff(() => {
            void deps.activeWorkspace.value?.handleExportMultiPageTiff();
        }),
        electronApi.onMenuUndo(() => {
            deps.activeWorkspace.value?.handleUndo();
        }),
        electronApi.onMenuRedo(() => {
            deps.activeWorkspace.value?.handleRedo();
        }),
        electronApi.onMenuZoomIn(() => {
            deps.activeWorkspace.value?.handleZoomIn();
        }),
        electronApi.onMenuZoomOut(() => {
            deps.activeWorkspace.value?.handleZoomOut();
        }),
        electronApi.onMenuActualSize(() => {
            deps.activeWorkspace.value?.handleActualSize();
        }),
        electronApi.onMenuFitWidth(() => {
            deps.activeWorkspace.value?.handleFitWidth();
        }),
        electronApi.onMenuFitHeight(() => {
            deps.activeWorkspace.value?.handleFitHeight();
        }),
        electronApi.onMenuViewModeSingle(() => {
            deps.activeWorkspace.value?.handleViewModeSingle();
        }),
        electronApi.onMenuViewModeFacing(() => {
            deps.activeWorkspace.value?.handleViewModeFacing();
        }),
        electronApi.onMenuViewModeFacingFirstSingle(() => {
            deps.activeWorkspace.value?.handleViewModeFacingFirstSingle();
        }),
        electronApi.onMenuOpenRecentFile((path: string) => {
            void deps.openPathInAppropriateTab(path);
        }),
        electronApi.onMenuOpenExternalPaths((paths: string[]) => {
            void deps.openPathsInAppropriateTab(paths);
        }),
        electronApi.onMenuClearRecentFiles(() => {
            void deps.clearRecentFiles();
            void deps.loadRecentFiles();
        }),
        electronApi.onMenuOpenSettings(() => {
            deps.openSettings();
        }),
        electronApi.onMenuCheckForUpdates(() => {
            void deps.checkForUpdates();
        }),
        electronApi.onMenuDeletePages(() => {
            deps.activeWorkspace.value?.handleDeletePages();
        }),
        electronApi.onMenuExtractPages(() => {
            deps.activeWorkspace.value?.handleExtractPages();
        }),
        electronApi.onMenuRotateCw(() => {
            deps.activeWorkspace.value?.handleRotateCw();
        }),
        electronApi.onMenuRotateCcw(() => {
            deps.activeWorkspace.value?.handleRotateCcw();
        }),
        electronApi.onMenuInsertPages(() => {
            deps.activeWorkspace.value?.handleInsertPages();
        }),
        electronApi.onMenuConvertToPdf(() => {
            deps.activeWorkspace.value?.handleConvertToPdf();
        }),
        electronApi.onMenuNewTab(() => {
            deps.createTab();
        }),
        electronApi.onMenuCloseTab(() => {
            if (deps.activeTabId.value) {
                void deps.handleCloseTab(deps.activeTabId.value);
            }
        }),
        electronApi.onMenuSplitEditor((direction) => {
            void deps.splitEditor(direction);
        }),
        electronApi.onMenuFocusEditorGroup((direction) => {
            deps.focusGroup(direction);
        }),
        electronApi.onMenuMoveTabToGroup((direction) => {
            void deps.moveActiveTab(direction);
        }),
        electronApi.onMenuCopyTabToGroup((direction) => {
            void deps.copyActiveTab(direction);
        }),
        electronApi.tabs.onWindowAction((action) => {
            void deps.handleWindowTabsAction(action);
        }),
    ];
}
