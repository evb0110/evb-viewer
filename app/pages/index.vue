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
    ref,
    watch,
    watchEffect,
} from 'vue';
import { BrowserLogger } from '@app/utils/browser-logger';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/electron';
import { useExternalFileDrop } from '@app/composables/page/useExternalFileDrop';
import { useTabsShellBindings } from '@app/composables/page/useTabsShellBindings';
import { useTabManager } from '@app/composables/useTabManager';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';

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

const { t } = useTypedI18n();
const showSettings = ref(false);
const dirtyTabCloseDialogOpen = ref(false);
const dirtyTabCloseTargetId = ref<string | null>(null);
let dirtyTabCloseDialogResolver: ((confirmed: boolean) => void) | null = null;

const workspaceRefs = ref<Map<string, IWorkspaceExpose>>(new Map());

const REQUIRED_WORKSPACE_METHODS: Array<keyof Omit<IWorkspaceExpose, 'hasPdf'>> = [
    'handleSave',
    'handleSaveAs',
    'handleUndo',
    'handleRedo',
    'handleOpenFileFromUi',
    'handleOpenFileDirectWithPersist',
    'handleOpenFileDirectBatchWithPersist',
    'handleCloseFileFromUi',
    'handleExportDocx',
    'handleExportImages',
    'handleExportMultiPageTiff',
    'handleZoomIn',
    'handleZoomOut',
    'handleFitWidth',
    'handleFitHeight',
    'handleActualSize',
    'handleDeletePages',
    'handleExtractPages',
    'handleRotateCw',
    'handleRotateCcw',
    'handleInsertPages',
    'handleConvertToPdf',
    'closeAllDropdowns',
];

function isWorkspaceExpose(value: unknown): value is IWorkspaceExpose {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    if (!('hasPdf' in candidate)) {
        return false;
    }

    return REQUIRED_WORKSPACE_METHODS.every(methodName => typeof candidate[methodName] === 'function');
}

function setWorkspaceRef(tabId: string, el: unknown) {
    if (isWorkspaceExpose(el)) {
        workspaceRefs.value.set(tabId, el);
        return;
    }

    if (el) {
        BrowserLogger.warn('tabs', 'Ignoring workspace ref with unexpected shape', {
            tabId,
            receivedType: typeof el,
        });
    }
    workspaceRefs.value.delete(tabId);
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
    if (!hasElectronAPI()) {
        return;
    }
    const hasDocument = workspaceHasPdf(activeWorkspace.value);
    if (lastSyncedMenuDocumentState === hasDocument) {
        return;
    }
    lastSyncedMenuDocumentState = hasDocument;
    void getElectronAPI().setMenuDocumentState(hasDocument);
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

async function openPathsInAppropriateTab(paths: string[]) {
    const normalizedPaths = paths
        .map(path => path.trim())
        .filter(path => path.length > 0);
    if (normalizedPaths.length === 0) {
        return;
    }

    if (normalizedPaths.length === 1) {
        await openPathInAppropriateTab(normalizedPaths[0]!);
        return;
    }

    let ws = activeWorkspace.value;
    if (!ws || workspaceHasPdf(ws)) {
        const tab = createTab();
        await nextTick();
        ws = workspaceRefs.value.get(tab.id) ?? null;
    }
    if (!ws) {
        return;
    }

    await ws.handleOpenFileDirectBatchWithPersist(normalizedPaths);
}

const {
    handleWindowDragOver,
    handleWindowDrop,
} = useExternalFileDrop({ openPathInAppropriateTab });

const {
    loadRecentFiles,
    clearRecentFiles,
} = useRecentFiles();

useTabsShellBindings({
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
    openSettings: () => {
        showSettings.value = true;
    },
});

watchEffect(() => {
    syncMenuDocumentState();
});

watch(dirtyTabCloseDialogOpen, (isOpen) => {
    if (!isOpen && dirtyTabCloseDialogResolver) {
        resolveDirtyTabCloseDialog(false);
    }
});

</script>
