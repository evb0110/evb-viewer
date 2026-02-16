<template>
    <div class="h-screen min-w-0 flex flex-col bg-[var(--app-window-bg)]">
        <div id="editor-global-toolbar-host" class="editor-global-toolbar-host" />

        <div class="flex-1 min-h-0 min-w-0">
            <EditorGroupsGrid
                v-if="layout && chromeHostsReady"
                :node="layout"
                :groups="groups"
                :tabs="tabs"
                :active-group-id="activeGroupId"
                :tab-context-availability-by-group="tabContextAvailabilityByGroup"
                @activate-group="activateGroup"
                @activate-tab="activateTab"
                @close-tab="handleCloseTab"
                @new-tab="createTabInGroup"
                @reorder-tab="moveTabWithinGroup"
                @move-tab-direction="handleTabMoveDirection"
                @tab-context-command="handleTabContextCommand"
                @set-workspace-ref="setWorkspaceRef"
                @update-tab="updateTab"
                @open-in-new-tab="handleOpenInNewTab"
                @request-close-tab="handleCloseTab"
                @open-settings="showSettings = true"
                @update-split-ratio="setSplitRatio"
            />
        </div>

        <div id="editor-global-status-host" class="editor-global-status-host" />

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
import { useEditorGroupsManager } from '@app/composables/useEditorGroupsManager';
import { useWorkspaceRestoreTracker } from '@app/composables/useWorkspaceRestoreTracker';
import { useWorkspaceSplitCache } from '@app/composables/useWorkspaceSplitCache';
import type { TOpenFileResult } from '@app/types/electron-api';
import type { ITab } from '@app/types/tabs';
import type { TGroupDirection } from '@app/types/editor-groups';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import type { TSplitPayload } from '@app/types/split-payload';
import type {
    ITabContextAvailability,
    TDirectionalCommandAvailability,
    TTabContextCommand,
} from '@app/types/tab-context-menu';

const {
    groups,
    tabs,
    layout,
    activeGroupId,
    activeTabId,
    ensureAtLeastOneTab,
    getGroupById,
    getTabById,
    getGroupByTabId,
    activateGroup,
    activateTab,
    createTab,
    closeTab,
    moveTabWithinGroup,
    splitGroup,
    closeGroup,
    setSplitRatio,
    focusGroup,
    findDirectionalGroup,
    moveTabToGroup,
} = useEditorGroupsManager();

const { t } = useTypedI18n();
const showSettings = ref(false);
const chromeHostsReady = ref(false);
const dirtyTabCloseDialogOpen = ref(false);
const dirtyTabCloseTargetId = ref<string | null>(null);
let dirtyTabCloseDialogResolver: ((confirmed: boolean) => void) | null = null;
const workspaceSplitCache = useWorkspaceSplitCache();
const workspaceRestoreTracker = useWorkspaceRestoreTracker();

const workspaceRefs = ref<Map<string, IWorkspaceExpose>>(new Map());
const WORKSPACE_REF_WAIT_TIMEOUT_MS = 4000;
const WORKSPACE_REF_POLL_MS = 16;
const TAB_TRANSITION_CACHE_GRACE_MS = 1200;
const DIRECTION_ORDER: TGroupDirection[] = [
    'left',
    'right',
    'up',
    'down',
];
const activeTabTransitions = ref(0);
let tabTransitionQueue: Promise<void> = Promise.resolve();

const REQUIRED_WORKSPACE_METHODS: Array<keyof Omit<IWorkspaceExpose, 'hasPdf'>> = [
    'handleSave',
    'handleSaveAs',
    'handleUndo',
    'handleRedo',
    'handleOpenFileFromUi',
    'handleOpenFileDirectWithPersist',
    'handleOpenFileDirectBatchWithPersist',
    'handleOpenFileWithResult',
    'handleCloseFileFromUi',
    'handleExportDocx',
    'handleExportImages',
    'handleExportMultiPageTiff',
    'handleZoomIn',
    'handleZoomOut',
    'handleFitWidth',
    'handleFitHeight',
    'handleActualSize',
    'handleViewModeSingle',
    'handleViewModeFacing',
    'handleViewModeFacingFirstSingle',
    'handleDeletePages',
    'handleExtractPages',
    'handleRotateCw',
    'handleRotateCcw',
    'handleInsertPages',
    'handleConvertToPdf',
    'captureSplitPayload',
    'restoreSplitPayload',
    'closeAllDropdowns',
];

const isTabTransitionBusy = computed(() => activeTabTransitions.value > 0);

function enqueueTabTransition<T>(task: () => Promise<T>): Promise<T> {
    const chained = tabTransitionQueue.then(async () => {
        activeTabTransitions.value += 1;
        try {
            return await task();
        } finally {
            activeTabTransitions.value = Math.max(0, activeTabTransitions.value - 1);
        }
    });

    tabTransitionQueue = chained.then(
        () => undefined,
        () => undefined,
    );

    return chained;
}

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

function updateTab(tabId: string, updates: Partial<ITab>) {
    const tab = getTabById(tabId);
    if (!tab) {
        return;
    }
    Object.assign(tab, updates);
}

function sleep(ms: number) {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function waitForWorkspace(tabId: string, timeoutMs = WORKSPACE_REF_WAIT_TIMEOUT_MS) {
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
        const workspace = workspaceRefs.value.get(tabId) ?? null;
        if (workspace) {
            return workspace;
        }
        await nextTick();
        await sleep(WORKSPACE_REF_POLL_MS);
    }

    BrowserLogger.warn('tabs', 'Workspace did not mount in time', {
        tabId,
        timeoutMs,
    });
    return null;
}

function removeTabFromState(tabId: string) {
    const group = getGroupByTabId(tabId);
    if (group) {
        closeTab(group.id, tabId);
    }
    workspaceSplitCache.clear(tabId);
}

function cleanupEmptyGroups() {
    for (const group of [...groups.value]) {
        if (groups.value.length <= 1) {
            break;
        }
        if (group.tabIds.length === 0) {
            closeGroup(group.id);
        }
    }
}

const activeWorkspace = computed(() => {
    if (!activeTabId.value) {
        return null;
    }
    return workspaceRefs.value.get(activeTabId.value) ?? null;
});

function createDirectionalAvailability(value: boolean): TDirectionalCommandAvailability {
    return {
        left: value,
        right: value,
        up: value,
        down: value,
    };
}

function getDirectionalTargetGroup(sourceGroupId: string, direction: TGroupDirection) {
    return findDirectionalGroup(sourceGroupId, direction, false);
}

const tabContextAvailabilityByGroup = computed<Record<string, ITabContextAvailability>>(() => {
    const result: Record<string, ITabContextAvailability> = {};
    const transitionsBusy = isTabTransitionBusy.value;

    for (const group of groups.value) {
        const hasActiveTab = Boolean(group.activeTabId);
        const focus = createDirectionalAvailability(false);
        const move = createDirectionalAvailability(false);
        const copy = createDirectionalAvailability(false);

        for (const direction of DIRECTION_ORDER) {
            const focusTarget = findDirectionalGroup(group.id, direction, true);
            const directionalTarget = getDirectionalTargetGroup(group.id, direction);
            const hasUsableDirectionalGroup = Boolean(directionalTarget && directionalTarget.tabIds.length > 0);
            focus[direction] = groups.value.length > 1
                ? Boolean(focusTarget && focusTarget.tabIds.length > 0) && !transitionsBusy
                : false;
            move[direction] = hasActiveTab && hasUsableDirectionalGroup && !transitionsBusy;
            copy[direction] = hasActiveTab && hasUsableDirectionalGroup && !transitionsBusy;
        }

        result[group.id] = {
            split: createDirectionalAvailability(hasActiveTab && !transitionsBusy),
            focus,
            move,
            copy,
            canClose: hasActiveTab && !transitionsBusy,
            canCreate: !transitionsBusy,
        };
    }

    return result;
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

async function handleCloseTab(groupId: string, tabId: string) {
    await enqueueTabTransition(async () => {
        const tab = getTabById(tabId);
        if (!tab) {
            return;
        }

        let shouldPersistBeforeClose = true;
        if (tab.isDirty) {
            const confirmed = await requestDirtyTabCloseConfirmation(tabId);
            if (!confirmed) {
                return;
            }
            shouldPersistBeforeClose = false;
        }

        const workspace = workspaceRefs.value.get(tabId);
        if (workspace && workspaceHasPdf(workspace)) {
            workspaceRestoreTracker.start(tabId);
            try {
                await workspace.handleCloseFileFromUi({ persist: shouldPersistBeforeClose });
            } finally {
                workspaceRestoreTracker.finish(tabId);
            }

            if (!workspaceHasPdf(workspace)) {
                const resolvedGroup = getGroupByTabId(tabId) ?? getGroupById(groupId);
                if (resolvedGroup) {
                    closeTabInState(resolvedGroup.id, tabId);
                }
            }
            cleanupEmptyGroups();
            return;
        }

        const resolvedGroup = getGroupByTabId(tabId) ?? getGroupById(groupId);
        if (resolvedGroup) {
            closeTabInState(resolvedGroup.id, tabId);
        }

        cleanupEmptyGroups();
    });
}

function scheduleSplitCacheCleanup(tabId: string) {
    setTimeout(() => {
        const workspace = workspaceRefs.value.get(tabId);
        if (workspace && workspaceHasPdf(workspace)) {
            workspaceSplitCache.clear(tabId);
        }
    }, TAB_TRANSITION_CACHE_GRACE_MS);
}

function createTabInGroup(groupId: string) {
    createTab({
        groupId,
        activate: true,
    });
}

async function handleOpenInNewTab(pathOrResult: string | TOpenFileResult, groupId?: string) {
    const targetGroupId = groupId ?? activeGroupId.value ?? undefined;
    const tab = createTab({
        groupId: targetGroupId,
        activate: true,
    });
    const ws = await waitForWorkspace(tab.id);
    if (!ws) {
        removeTabFromState(tab.id);
        return;
    }
    if (typeof pathOrResult === 'string') {
        await ws.handleOpenFileDirectWithPersist(pathOrResult);
    } else {
        await ws.handleOpenFileWithResult(pathOrResult);
    }
}

async function openPathInAppropriateTab(path: string) {
    const ws = activeWorkspace.value;
    if (ws && !workspaceHasPdf(ws)) {
        await ws.handleOpenFileDirectWithPersist(path);
        return;
    }
    await handleOpenInNewTab(path, activeGroupId.value ?? undefined);
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
        const tab = createTab({
            groupId: activeGroupId.value,
            activate: true,
        });
        ws = await waitForWorkspace(tab.id);
        if (!ws) {
            removeTabFromState(tab.id);
            return;
        }
    }

    await ws.handleOpenFileDirectBatchWithPersist(normalizedPaths);
}

async function captureWorkspacePayload(
    tabId: string,
    timeoutMs = WORKSPACE_REF_WAIT_TIMEOUT_MS,
): Promise<TSplitPayload | null> {
    const workspace = await waitForWorkspace(tabId, timeoutMs);
    if (!workspace) {
        return null;
    }

    try {
        return await workspace.captureSplitPayload();
    } catch (error) {
        BrowserLogger.error('tabs', 'Failed to capture split payload', {
            tabId,
            error,
        });
        return null;
    }
}

async function restoreWorkspacePayload(tabId: string, payload: TSplitPayload | null) {
    if (!payload) {
        return false;
    }

    workspaceRestoreTracker.start(tabId);
    try {
        const workspace = await waitForWorkspace(tabId);
        if (!workspace) {
            return false;
        }
        await workspace.restoreSplitPayload(payload);
        await nextTick();

        // Non-empty payloads must result in an opened document.
        if (payload.kind !== 'empty' && !workspaceHasPdf(workspace)) {
            BrowserLogger.warn('tabs', 'Split payload restore finished without an opened document', {
                tabId,
                payloadKind: payload.kind,
            });
            return false;
        }

        return true;
    } catch (error) {
        BrowserLogger.error('tabs', 'Failed to restore split payload', {
            tabId,
            payloadKind: payload.kind,
            error,
        });
        return false;
    } finally {
        workspaceRestoreTracker.finish(tabId);
    }
}

function closeTabInState(groupId: string, tabId: string) {
    closeTab(groupId, tabId);
    workspaceSplitCache.clear(tabId);
}

async function splitEditor(direction: TGroupDirection) {
    await enqueueTabTransition(async () => {
        const sourceGroup = getGroupById(activeGroupId.value);
        const sourceTabId = sourceGroup?.activeTabId ?? null;
        if (!sourceGroup || !sourceTabId) {
            return;
        }

        const payload = await captureWorkspacePayload(sourceTabId);
        if (!payload) {
            return;
        }

        workspaceSplitCache.set(sourceTabId, payload);
        scheduleSplitCacheCleanup(sourceTabId);

        const newGroupId = splitGroup(sourceGroup.id, direction);
        if (!newGroupId) {
            return;
        }

        const newTab = createTab({
            groupId: newGroupId,
            activate: true,
        });

        const restored = await restoreWorkspacePayload(newTab.id, payload);
        if (!restored) {
            removeTabFromState(newTab.id);
            activateTab(sourceGroup.id, sourceTabId);
            return;
        }

        activateTab(newGroupId, newTab.id);
        cleanupEmptyGroups();
    });
}

function focusEditorGroup(direction: TGroupDirection) {
    if (isTabTransitionBusy.value) {
        return;
    }
    focusGroup(direction, true);
}

function ensureTargetGroupForDirection(direction: TGroupDirection) {
    const sourceGroup = getGroupById(activeGroupId.value);
    if (!sourceGroup) {
        return null;
    }

    const existing = getDirectionalTargetGroup(sourceGroup.id, direction);
    if (!existing || existing.tabIds.length === 0) {
        return null;
    }

    return {
        sourceGroup,
        targetGroupId: existing.id,
    };
}

async function moveActiveTab(direction: TGroupDirection) {
    await enqueueTabTransition(async () => {
        const sourceGroup = getGroupById(activeGroupId.value);
        const sourceTabId = sourceGroup?.activeTabId ?? null;
        if (!sourceGroup || !sourceTabId) {
            return;
        }

        const route = ensureTargetGroupForDirection(direction);
        if (!route) {
            return;
        }

        const payload = await captureWorkspacePayload(sourceTabId);
        if (!payload) {
            return;
        }

        if (payload.kind !== 'empty') {
            workspaceSplitCache.set(sourceTabId, payload);
            scheduleSplitCacheCleanup(sourceTabId);
        }

        const moved = moveTabToGroup(sourceTabId, route.targetGroupId, true);
        if (moved) {
            activateTab(route.targetGroupId, sourceTabId);
        }
        cleanupEmptyGroups();
    });
}

async function copyActiveTab(direction: TGroupDirection) {
    await enqueueTabTransition(async () => {
        const sourceGroup = getGroupById(activeGroupId.value);
        const sourceTabId = sourceGroup?.activeTabId ?? null;
        if (!sourceGroup || !sourceTabId) {
            return;
        }

        const payload = await captureWorkspacePayload(sourceTabId);
        if (!payload) {
            return;
        }

        const route = ensureTargetGroupForDirection(direction);
        if (!route) {
            return;
        }

        const targetTab = createTab({
            groupId: route.targetGroupId,
            activate: true,
        });

        const restored = await restoreWorkspacePayload(targetTab.id, payload);
        if (!restored) {
            removeTabFromState(targetTab.id);
            activateTab(sourceGroup.id, sourceTabId);
            return;
        }

        activateTab(route.targetGroupId, targetTab.id);
        cleanupEmptyGroups();
    });
}

async function handleTabContextCommand(
    groupId: string,
    tabId: string,
    command: TTabContextCommand,
) {
    const group = getGroupById(groupId);
    if (!group) {
        return;
    }

    activateGroup(groupId);
    activateTab(groupId, tabId);

    if (command.kind === 'new-tab') {
        createTabInGroup(groupId);
        return;
    }

    if (command.kind === 'close-tab') {
        await handleCloseTab(groupId, tabId);
        return;
    }

    if (command.kind === 'split') {
        await splitEditor(command.direction);
        return;
    }

    if (command.kind === 'focus') {
        focusEditorGroup(command.direction);
        return;
    }

    if (command.kind === 'move') {
        await moveActiveTab(command.direction);
        return;
    }

    await copyActiveTab(command.direction);
}

function handleTabMoveDirection(
    groupId: string,
    tabId: string,
    direction: 'left' | 'right',
) {
    const group = getGroupById(groupId);
    if (!group || !group.tabIds.includes(tabId)) {
        return;
    }

    activateGroup(groupId);
    activateTab(groupId, tabId);
    void moveActiveTab(direction);
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
    createTab: () => createTab({ activate: true }),
    activateTab: (tabId) => {
        const group = getGroupByTabId(tabId);
        if (group) {
            activateTab(group.id, tabId);
        }
    },
    handleCloseTab: async (tabId) => {
        const group = getGroupByTabId(tabId);
        if (!group) {
            return;
        }
        await handleCloseTab(group.id, tabId);
    },
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
    splitEditor,
    focusGroup: focusEditorGroup,
    moveActiveTab,
    copyActiveTab,
});

onMounted(() => {
    chromeHostsReady.value = true;
    cleanupEmptyGroups();
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

<style scoped>
.editor-global-toolbar-host,
.editor-global-status-host {
    display: flex;
    flex-direction: column;
    min-height: 0;
}
</style>
