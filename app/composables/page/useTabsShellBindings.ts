import {
    nextTick,
    onMounted,
    onUnmounted,
    type Ref,
} from 'vue';
import { useEventListener } from '@vueuse/core';
import type { TGroupDirection } from '@app/types/editor-groups';
import type { TWindowTabsAction } from '@app/types/window-tab-transfer';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/electron';
import { registerTabsMenuBindings } from '@app/composables/page/tabs-menu-bindings';

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
    splitEditor: (direction: TGroupDirection) => Promise<void> | void;
    focusGroup: (direction: TGroupDirection) => void;
    moveActiveTab: (direction: TGroupDirection) => Promise<void> | void;
    copyActiveTab: (direction: TGroupDirection) => Promise<void> | void;
    handleWindowTabsAction: (action: TWindowTabsAction) => Promise<void> | void;
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
        splitEditor,
        focusGroup,
        moveActiveTab,
        copyActiveTab,
        handleWindowTabsAction,
    } = options;

    const menuCleanups: Array<() => void> = [];
    const windowListenerCleanups: Array<() => void> = [];

    function cycleTab(direction: number) {
        if (tabs.value.length <= 1 || !activeTabId.value) {
            return;
        }
        const currentIndex = tabs.value.findIndex(t => t.id === activeTabId.value);
        if (currentIndex < 0) {
            return;
        }
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
        if (!hasElectronAPI() && mod && event.key.toLowerCase() === 't' && !event.shiftKey) {
            event.preventDefault();
            createTab();
            return;
        }

        if (!hasElectronAPI() && mod && event.key.toLowerCase() === 'w' && !event.shiftKey) {
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
        windowListenerCleanups.push(useEventListener(window, 'keydown', handleTabKeyboardShortcut, {capture: true}));

        if (typeof window !== 'undefined') {
            (window as Window & { __openFileDirect?: (path: string) => Promise<void> }).__openFileDirect = openPathInAppropriateTab;
            windowListenerCleanups.push(useEventListener(window, 'dragover', handleWindowDragOver));
            windowListenerCleanups.push(useEventListener(window, 'drop', handleWindowDrop));
        }

        if (hasElectronAPI()) {
            const electronApi = getElectronAPI();
            menuCleanups.push(...registerTabsMenuBindings(electronApi, {
                activeWorkspace,
                activeTabId,
                createTab,
                handleCloseTab,
                openPathInAppropriateTab,
                openPathsInAppropriateTab,
                clearRecentFiles,
                loadRecentFiles,
                openSettings,
                splitEditor,
                focusGroup,
                moveActiveTab,
                copyActiveTab,
                handleWindowTabsAction,
            }));
            void nextTick(() => {
                electronApi.notifyRendererReady();
            });
        }
    });

    onUnmounted(() => {
        if (typeof window !== 'undefined' && (window as Window & { __openFileDirect?: unknown }).__openFileDirect === openPathInAppropriateTab) {
            delete (window as Window & { __openFileDirect?: (path: string) => Promise<void> }).__openFileDirect;
        }
        menuCleanups.forEach(cleanup => cleanup());
        windowListenerCleanups.forEach(cleanup => cleanup());
    });
}
