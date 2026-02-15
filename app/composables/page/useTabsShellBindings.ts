import {
    nextTick,
    onMounted,
    onUnmounted,
    type Ref,
} from 'vue';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';

interface IUseTabsShellBindingsOptions {
    tabs: Ref<Array<{ id: string }>>;
    activeTabId: Ref<string | null>;
    activeWorkspace: Ref<IWorkspaceExpose | null>;
    createTab: () => { id: string };
    activateTab: (tabId: string) => void;
    handleCloseTab: (tabId: string) => Promise<void>;
    openPathInAppropriateTab: (path: string) => Promise<void>;
    openPathsInAppropriateTab: (paths: string[]) => Promise<void>;
    clearRecentFiles: () => Promise<void>;
    loadRecentFiles: () => Promise<void>;
    ensureAtLeastOneTab: () => void;
    handleWindowDragOver: (event: DragEvent) => void;
    handleWindowDrop: (event: DragEvent) => void;
    openSettings: () => void;
}

export function useTabsShellBindings(options: IUseTabsShellBindingsOptions) {
    const {
        tabs,
        activeTabId,
        activeWorkspace,
        createTab,
        activateTab,
        handleCloseTab,
        openPathInAppropriateTab,
        openPathsInAppropriateTab,
        clearRecentFiles,
        loadRecentFiles,
        ensureAtLeastOneTab,
        handleWindowDragOver,
        handleWindowDrop,
        openSettings,
    } = options;

    const menuCleanups: Array<() => void> = [];

    function cycleTab(direction: number) {
        if (tabs.value.length <= 1 || !activeTabId.value) {
            return;
        }
        const currentIndex = tabs.value.findIndex(t => t.id === activeTabId.value);
        const nextIndex = (currentIndex + direction + tabs.value.length) % tabs.value.length;
        const nextTab = tabs.value[nextIndex];
        if (nextTab) {
            activateTab(nextTab.id);
        }
    }

    function handleTabKeyboardShortcut(event: KeyboardEvent) {
        const mod = event.metaKey || event.ctrlKey;

        // In Electron these accelerators are handled by the app menu.
        // Keep renderer-level handlers only as a non-Electron fallback.
        if (!window.electronAPI && mod && event.key.toLowerCase() === 't' && !event.shiftKey) {
            event.preventDefault();
            createTab();
            return;
        }

        if (!window.electronAPI && mod && event.key.toLowerCase() === 'w' && !event.shiftKey) {
            event.preventDefault();
            if (activeTabId.value) {
                void handleCloseTab(activeTabId.value);
            }
            return;
        }

        if (event.ctrlKey && event.key === 'Tab' && !event.shiftKey) {
            event.preventDefault();
            cycleTab(1);
            return;
        }

        if (event.ctrlKey && event.key === 'Tab' && event.shiftKey) {
            event.preventDefault();
            cycleTab(-1);
        }
    }

    onMounted(() => {
        ensureAtLeastOneTab();
        window.addEventListener('keydown', handleTabKeyboardShortcut, true);

        if (typeof window !== 'undefined') {
            (window as Window & { __openFileDirect?: (path: string) => Promise<void> }).__openFileDirect = openPathInAppropriateTab;
            window.addEventListener('dragover', handleWindowDragOver);
            window.addEventListener('drop', handleWindowDrop);
        }

        if (window.electronAPI) {
            menuCleanups.push(
                window.electronAPI.onMenuOpenPdf(() => {
                    void activeWorkspace.value?.handleOpenFileFromUi();
                }),
                window.electronAPI.onMenuSave(() => {
                    void activeWorkspace.value?.handleSave();
                }),
                window.electronAPI.onMenuSaveAs(() => {
                    void activeWorkspace.value?.handleSaveAs();
                }),
                window.electronAPI.onMenuExportDocx(() => {
                    void activeWorkspace.value?.handleExportDocx();
                }),
                window.electronAPI.onMenuExportImages(() => {
                    void activeWorkspace.value?.handleExportImages();
                }),
                window.electronAPI.onMenuExportMultiPageTiff(() => {
                    void activeWorkspace.value?.handleExportMultiPageTiff();
                }),
                window.electronAPI.onMenuUndo(() => {
                    activeWorkspace.value?.handleUndo();
                }),
                window.electronAPI.onMenuRedo(() => {
                    activeWorkspace.value?.handleRedo();
                }),
                window.electronAPI.onMenuZoomIn(() => {
                    activeWorkspace.value?.handleZoomIn();
                }),
                window.electronAPI.onMenuZoomOut(() => {
                    activeWorkspace.value?.handleZoomOut();
                }),
                window.electronAPI.onMenuActualSize(() => {
                    activeWorkspace.value?.handleActualSize();
                }),
                window.electronAPI.onMenuFitWidth(() => {
                    activeWorkspace.value?.handleFitWidth();
                }),
                window.electronAPI.onMenuFitHeight(() => {
                    activeWorkspace.value?.handleFitHeight();
                }),
                window.electronAPI.onMenuOpenRecentFile((path: string) => {
                    void openPathInAppropriateTab(path);
                }),
                window.electronAPI.onMenuOpenExternalPaths((paths: string[]) => {
                    void openPathsInAppropriateTab(paths);
                }),
                window.electronAPI.onMenuClearRecentFiles(() => {
                    void clearRecentFiles();
                    void loadRecentFiles();
                }),
                window.electronAPI.onMenuOpenSettings(() => {
                    openSettings();
                }),
                window.electronAPI.onMenuDeletePages(() => {
                    activeWorkspace.value?.handleDeletePages();
                }),
                window.electronAPI.onMenuExtractPages(() => {
                    activeWorkspace.value?.handleExtractPages();
                }),
                window.electronAPI.onMenuRotateCw(() => {
                    activeWorkspace.value?.handleRotateCw();
                }),
                window.electronAPI.onMenuRotateCcw(() => {
                    activeWorkspace.value?.handleRotateCcw();
                }),
                window.electronAPI.onMenuInsertPages(() => {
                    activeWorkspace.value?.handleInsertPages();
                }),
                window.electronAPI.onMenuConvertToPdf(() => {
                    activeWorkspace.value?.handleConvertToPdf();
                }),
                window.electronAPI.onMenuNewTab(() => {
                    createTab();
                }),
                window.electronAPI.onMenuCloseTab(() => {
                    if (activeTabId.value) {
                        void handleCloseTab(activeTabId.value);
                    }
                }),
            );
            void nextTick(() => {
                window.electronAPI.notifyRendererReady();
            });
        }
    });

    onUnmounted(() => {
        menuCleanups.forEach(cleanup => cleanup());
        window.removeEventListener('keydown', handleTabKeyboardShortcut, true);
        window.removeEventListener('dragover', handleWindowDragOver);
        window.removeEventListener('drop', handleWindowDrop);
    });
}
