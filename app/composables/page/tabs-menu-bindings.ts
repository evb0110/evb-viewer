import type { IElectronAPI } from '@app/types/electron-api';
import type { Ref } from 'vue';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';

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
    ];
}
