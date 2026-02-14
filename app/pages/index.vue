<template>
    <div class="h-screen flex flex-col bg-[var(--app-window-bg)]">
        <TabBar
            :tabs="tabs"
            :active-tab-id="activeTabId"
            @activate="activateTab"
            @close="handleCloseTab"
            @new-tab="createTab"
            @reorder="moveTab"
        />
        <div
            v-for="tab in tabs"
            v-show="tab.id === activeTabId"
            :key="tab.id"
            class="flex-1 overflow-hidden flex flex-col"
        >
            <DocumentWorkspace
                :ref="(el) => setWorkspaceRef(tab.id, el)"
                :tab-id="tab.id"
                :is-active="tab.id === activeTabId"
                @update-tab="(u) => updateTab(tab.id, u)"
                @open-in-new-tab="handleOpenInNewTab"
                @request-close-tab="handleCloseTab(tab.id)"
                @open-settings="showSettings = true"
            />
        </div>
        <SettingsDialog v-if="showSettings" v-model:open="showSettings" />
        <UModal
            v-model:open="dirtyTabCloseDialogOpen"
            :title="t('tabs.confirmCloseDirtyTitle')"
            :ui="{ footer: 'justify-end' }"
        >
            <template #description>
                <span class="sr-only">
                    {{ t('tabs.confirmCloseDirtyDescription', { name: dirtyTabCloseTargetName }) }}
                </span>
            </template>

            <template #body>
                <p class="text-sm text-muted">
                    {{ t('tabs.confirmCloseDirtyDescription', { name: dirtyTabCloseTargetName }) }}
                </p>
            </template>

            <template #footer="{ close }">
                <UButton
                    :label="t('common.cancel')"
                    color="neutral"
                    variant="outline"
                    @click="close"
                />
                <UButton
                    :label="t('tabs.closeTab')"
                    @click="confirmDirtyTabClose"
                />
            </template>
        </UModal>
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    nextTick,
    onMounted,
    onUnmounted,
    ref,
    watch,
    watchEffect,
} from 'vue';
import { useTabManager } from '@app/composables/useTabManager';

interface IWorkspaceExpose {
    handleSave: () => Promise<void>;
    handleSaveAs: () => Promise<void>;
    handleUndo: () => void;
    handleRedo: () => void;
    handleOpenFileFromUi: () => Promise<void>;
    handleOpenFileDirectWithPersist: (path: string) => Promise<void>;
    handleCloseFileFromUi: () => Promise<void>;
    handleExportDocx: () => Promise<void>;
    handleExportImages: () => Promise<void>;
    handleExportMultiPageTiff: () => Promise<void>;
    hasPdf: { value: boolean } | boolean;
    handleZoomIn: () => void;
    handleZoomOut: () => void;
    handleFitWidth: () => void;
    handleFitHeight: () => void;
    handleActualSize: () => void;
    handleDeletePages: () => void;
    handleExtractPages: () => void;
    handleRotateCw: () => void;
    handleRotateCcw: () => void;
    handleInsertPages: () => void;
    handleConvertToPdf: () => void;
    closeAllDropdowns: () => void;
}

const {
    tabs,
    activeTabId,
    createTab,
    closeTab,
    activateTab,
    updateTab,
    moveTab,
    ensureAtLeastOneTab,
} = useTabManager();

const { t } = useI18n();
const showSettings = ref(false);
const dirtyTabCloseDialogOpen = ref(false);
const dirtyTabCloseTargetId = ref<string | null>(null);
let dirtyTabCloseDialogResolver: ((confirmed: boolean) => void) | null = null;

const workspaceRefs = ref<Map<string, IWorkspaceExpose>>(new Map());

function setWorkspaceRef(tabId: string, el: unknown) {
    if (el) {
        workspaceRefs.value.set(tabId, el as IWorkspaceExpose);
    } else {
        workspaceRefs.value.delete(tabId);
    }
}

const activeWorkspace = computed(() => {
    if (!activeTabId.value) {
        return null;
    }
    return workspaceRefs.value.get(activeTabId.value) ?? null;
});

let lastSyncedMenuDocumentState: boolean | null = null;

function workspaceHasPdf(workspace: IWorkspaceExpose | null | undefined) {
    if (!workspace) {
        return false;
    }
    return typeof workspace.hasPdf === 'boolean' ? workspace.hasPdf : workspace.hasPdf.value;
}

function syncMenuDocumentState() {
    if (typeof window === 'undefined') {
        return;
    }
    if (!window.electronAPI) {
        return;
    }
    const hasDocument = workspaceHasPdf(activeWorkspace.value);
    if (lastSyncedMenuDocumentState === hasDocument) {
        return;
    }
    lastSyncedMenuDocumentState = hasDocument;
    void window.electronAPI.setMenuDocumentState(hasDocument);
}

const dirtyTabCloseTargetName = computed(() => {
    const tab = dirtyTabCloseTargetId.value
        ? tabs.value.find(candidate => candidate.id === dirtyTabCloseTargetId.value)
        : null;
    return tab?.fileName ?? t('tabs.newTab');
});

function resolveDirtyTabCloseDialog(confirmed: boolean) {
    const resolver = dirtyTabCloseDialogResolver;
    dirtyTabCloseDialogResolver = null;
    dirtyTabCloseTargetId.value = null;
    dirtyTabCloseDialogOpen.value = false;
    if (resolver) {
        resolver(confirmed);
    }
}

function confirmDirtyTabClose() {
    resolveDirtyTabCloseDialog(true);
}

function requestDirtyTabCloseConfirmation(tabId: string) {
    if (dirtyTabCloseDialogResolver) {
        resolveDirtyTabCloseDialog(false);
    }
    dirtyTabCloseTargetId.value = tabId;
    dirtyTabCloseDialogOpen.value = true;
    return new Promise<boolean>((resolve) => {
        dirtyTabCloseDialogResolver = resolve;
    });
}

async function handleCloseTab(tabId: string) {
    const tab = tabs.value.find(candidate => candidate.id === tabId);
    if (!tab) {
        return;
    }

    if (tab.isDirty) {
        const confirmed = await requestDirtyTabCloseConfirmation(tabId);
        if (!confirmed) {
            return;
        }
    }

    const workspace = workspaceRefs.value.get(tabId);
    if (workspace && workspaceHasPdf(workspace)) {
        await workspace.handleCloseFileFromUi();
        if (!workspaceHasPdf(workspace)) {
            closeTab(tabId);
        }
    } else {
        closeTab(tabId);
    }
}

async function handleOpenInNewTab(path: string) {
    const tab = createTab();
    await nextTick();
    const ws = workspaceRefs.value.get(tab.id);
    if (ws) {
        await ws.handleOpenFileDirectWithPersist(path);
    }
}

async function openPathInAppropriateTab(path: string) {
    const ws = activeWorkspace.value;
    if (ws && !workspaceHasPdf(ws)) {
        await ws.handleOpenFileDirectWithPersist(path);
        return;
    }
    await handleOpenInNewTab(path);
}

function hasExternalFilePayload(dataTransfer: DataTransfer | null) {
    if (!dataTransfer) {
        return false;
    }
    return Array.from(dataTransfer.types).includes('Files');
}

function getDroppedDocumentPaths(dataTransfer: DataTransfer | null) {
    if (!dataTransfer || !window.electronAPI) {
        return [];
    }

    const paths: string[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < dataTransfer.files.length; i++) {
        const file = dataTransfer.files[i];
        if (!file) {
            continue;
        }

        const path = window.electronAPI.getPathForFile(file);
        if (!path || seen.has(path)) {
            continue;
        }

        const lowerPath = path.toLowerCase();
        if (
            lowerPath.endsWith('.pdf')
            || lowerPath.endsWith('.djvu')
            || lowerPath.endsWith('.png')
            || lowerPath.endsWith('.jpg')
            || lowerPath.endsWith('.jpeg')
            || lowerPath.endsWith('.tif')
            || lowerPath.endsWith('.tiff')
            || lowerPath.endsWith('.bmp')
            || lowerPath.endsWith('.webp')
            || lowerPath.endsWith('.gif')
        ) {
            seen.add(path);
            paths.push(path);
        }
    }

    return paths;
}

function isSidebarDropArea(event: DragEvent) {
    const target = event.target;
    if (!(target instanceof Element)) {
        return false;
    }
    return Boolean(target.closest('.pdf-sidebar-pages-thumbnails'));
}

function handleWindowDragOver(event: DragEvent) {
    if (event.defaultPrevented || isSidebarDropArea(event)) {
        return;
    }

    if (!hasExternalFilePayload(event.dataTransfer)) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
    }
}

function handleWindowDrop(event: DragEvent) {
    if (event.defaultPrevented || isSidebarDropArea(event)) {
        return;
    }

    if (!hasExternalFilePayload(event.dataTransfer)) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const paths = getDroppedDocumentPaths(event.dataTransfer);
    if (paths.length === 0) {
        return;
    }

    void (async () => {
        for (const path of paths) {
            await openPathInAppropriateTab(path);
        }
    })();
}

const {
    loadRecentFiles,
    clearRecentFiles,
} = useRecentFiles();

function handleTabKeyboardShortcut(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;

    if (mod && event.key.toLowerCase() === 't' && !event.shiftKey) {
        event.preventDefault();
        createTab();
        return;
    }

    if (mod && event.key.toLowerCase() === 'w' && !event.shiftKey) {
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

const menuCleanups: Array<() => void> = [];

onMounted(() => {
    ensureAtLeastOneTab();

    window.addEventListener('keydown', handleTabKeyboardShortcut, true);

    if (typeof window !== 'undefined') {
        window.__openFileDirect = openPathInAppropriateTab;
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
            window.electronAPI.onMenuClearRecentFiles(() => {
                clearRecentFiles();
                loadRecentFiles();
            }),
            window.electronAPI.onMenuOpenSettings(() => {
                showSettings.value = true;
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
    }
});

watchEffect(() => {
    syncMenuDocumentState();
});

watch(dirtyTabCloseDialogOpen, (isOpen) => {
    if (!isOpen && dirtyTabCloseDialogResolver) {
        resolveDirtyTabCloseDialog(false);
    }
});

onUnmounted(() => {
    menuCleanups.forEach(cleanup => cleanup());
    window.removeEventListener('keydown', handleTabKeyboardShortcut, true);
    window.removeEventListener('dragover', handleWindowDragOver);
    window.removeEventListener('drop', handleWindowDrop);
});
</script>
