<template>
    <div ref="hostRef" class="editor-panes-host flex-1 min-h-0 min-w-0">
        <div
            ref="parkingTarget"
            class="editor-pane-parking"
            aria-hidden="true"
        />
        <EditorPanesGrid
            v-if="layout"
            :node="layout"
            :zen-mode="zenMode"
            :zen-active-pane-id="zenActivePaneId"
            @set-pane-slot="handlePaneSlot"
            @update-split-ratio="handleUpdateSplitRatio"
            @update-layout-resizing="emit('update-layout-resizing', $event)"
        />
        <template v-if="parkingTarget">
            <Teleport
                v-for="pane in panes"
                :key="pane.paneId"
                :to="paneSlotTargets.get(pane.paneId) ?? parkingTarget"
            >
                <EditorPaneView
                    :key="pane.paneId"
                    :pane="pane"
                    :pane-count="panes.length"
                    :tabs="tabs"
                    :active-pane-id="activePaneId"
                    :is-startup-open-claim-pending="isStartupOpenClaimPending"
                    :is-tab-transition-busy="isTabTransitionBusy"
                    :presentation-fallback-tab-id="presentationFallbackTabId"
                    :tab-context-availability="tabContextAvailabilityByPane[pane.paneId] ?? null"
                    :start-section-by-tab-id="startSectionByTabId"
                    :tab-lifecycle-by-id="tabLifecycleById"
                    :view-state-by-tab-id="viewStateByTabId"
                    :document-records-by-tab-id="documentRecordsByTabId"
                    :document-sessions-by-tab-id="documentSessionsByTabId"
                    :zen-mode="zenMode"
                    :zen-active-tab-id="zenActiveTabId"
                    :is-fullscreen="isFullscreen"
                    :fullscreen-supported="fullscreenSupported"
                    :is-workspace-layout-resizing="isWorkspaceLayoutResizing ?? false"
                    @activate-pane="handleActivatePane"
                    @activate-tab="handleActivateTab"
                    @close-tab="handleCloseTab"
                    @new-tab="handleNewTab"
                    @reorder-tab="handleReorderTab"
                    @move-tab-direction="handleMoveTabDirection"
                    @tab-context-command="handleTabContextCommand"
                    @set-workspace-ref="handleSetWorkspaceRef"
                    @update-document-record="handleUpdateDocumentRecord"
                    @update-tab-session-state="handleUpdateTabSessionState"
                    @update-tab-start-section="handleUpdateTabStartSection"
                    @open-in-new-tab="handleOpenInNewTab"
                    @request-close-tab="handleRequestCloseTab"
                    @open-settings="handleOpenSettings"
                    @open-combine="handleOpenCombine"
                    @toggle-fullscreen="handleToggleFullscreen"
                />
            </Teleport>
        </template>
    </div>
</template>

<script setup lang="ts">
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import EditorPanesGrid from '@app/modules/workspace-shell/components/EditorPanesGrid.vue';
import EditorPaneView from '@app/modules/workspace-shell/components/EditorPaneView.vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import { parsePaneId } from '@contracts/editorPanes';
import { parseTabId } from '@contracts/windowTabs';
import type {
    ITabContextAvailability,
    TTabContextCommand,
} from '@app/types/tabContextMenu';
import type {ITab} from '@app/types/tabs';
import type { TStartSection } from '@app/types/startSection';
import type {
    ITabLifecycleState,
    ITabViewSessionState,
} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import {
    capturePaneRelocationScroll,
    restorePaneRelocationScroll,
} from '@app/modules/workspace-shell/layout/preservePaneRelocationScroll';
import {
    clearDocumentViewportPaneRelocationScrollFence,
    fenceDocumentViewportPaneRelocationScroll,
} from '@app/modules/document-viewer/runtime/documentViewportWritePort';

defineOptions({ name: 'EditorPanesHost' });

const {
    activePaneId,
    documentRecordsByTabId,
    documentSessionsByTabId,
    fullscreenSupported,
    isFullscreen,
    isStartupOpenClaimPending,
    isTabTransitionBusy,
    presentationFallbackTabId,
    isWorkspaceLayoutResizing = false,
    layout,
    panes,
    startSectionByTabId,
    tabContextAvailabilityByPane,
    tabLifecycleById,
    tabs,
    viewStateByTabId,
    zenActiveTabId,
    zenMode,
} = defineProps<{
    layout: TEditorLayoutNode | null;
    panes: IEditorPaneState[];
    tabs: ITab[];
    activePaneId: string | null;
    isStartupOpenClaimPending: boolean;
    isTabTransitionBusy: boolean;
    presentationFallbackTabId: string | null;
    tabContextAvailabilityByPane: Record<string, ITabContextAvailability>;
    startSectionByTabId: Record<string, TStartSection>;
    tabLifecycleById: Record<string, ITabLifecycleState>;
    viewStateByTabId: Record<string, ITabViewSessionState>;
    documentRecordsByTabId: Record<string, IWorkspaceDocumentRecord>;
    documentSessionsByTabId: Record<string, IWorkspaceDocumentController>;
    zenMode: boolean;
    zenActiveTabId: string | null;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
    isWorkspaceLayoutResizing?: boolean | undefined;
}>();

const parkingTarget = ref<HTMLElement | null>(null);
const hostRef = ref<HTMLElement | null>(null);
const paneSlotTargets = shallowReactive(new Map<string, HTMLElement>());
const zenActivePaneId = computed(() => {
    const tabId = parseTabId(zenActiveTabId);
    return tabId === null
        ? null
        : panes.find(pane => pane.tabIds.includes(tabId))?.paneId ?? null;
});

watchEffect(() => {
    const livePaneIds = new Set(panes.map(pane => pane.paneId));
    for (const paneId of paneSlotTargets.keys()) {
        const parsedPaneId = parsePaneId(paneId);
        if (parsedPaneId === null || !livePaneIds.has(parsedPaneId)) {
            paneSlotTargets.delete(paneId);
        }
    }
});

let paneRelocationRestoreGeneration = 0;
function waitForPaneRelocationFrame() {
    return new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

watch(
    () => layout,
    () => {
        const snapshots = capturePaneRelocationScroll(hostRef.value);
        if (snapshots.length === 0) {
            return;
        }
        const generation = ++paneRelocationRestoreGeneration;
        void (async () => {
            await nextTick();
            if (generation !== paneRelocationRestoreGeneration) {
                return;
            }
            restorePaneRelocationScroll(snapshots);
            await waitForPaneRelocationFrame();
            if (generation !== paneRelocationRestoreGeneration) {
                return;
            }
            restorePaneRelocationScroll(snapshots);
            await waitForPaneRelocationFrame();
            if (generation !== paneRelocationRestoreGeneration) {
                return;
            }
            restorePaneRelocationScroll(snapshots);
        })();
    },
    {flush: 'sync'},
);

const emit = defineEmits<{
    'activate-pane': [paneId: string];
    'activate-tab': [paneId: string, tabId: string];
    'close-tab': [paneId: string, tabId: string];
    'new-tab': [paneId: string];
    'reorder-tab': [paneId: string, fromIndex: number, toIndex: number];
    'move-tab-direction': [
        paneId: string,
        tabId: string,
        direction: 'left' | 'right',
        targetIndex?: number | null,
    ];
    'tab-context-command': [paneId: string, tabId: string, command: TTabContextCommand];
    'set-workspace-ref': [tabId: string, el: unknown];
    'update-document-record': [tabId: string, record: IWorkspaceDocumentRecord];
    'update-tab-session-state': [tabId: string, state: ITabViewSessionState];
    'update-tab-start-section': [tabId: string, section: TStartSection];
    'open-in-new-tab': [result: TDocumentRef | TOpenFileResult, paneId?: string];
    'request-close-tab': [paneId: string, tabId: string];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
    'update-split-ratio': [splitId: string, ratio: number];
    'update-layout-resizing': [value: boolean];
}>();

function handleActivatePane(paneId: string) {
    emit('activate-pane', paneId);
}

function handleActivateTab(paneId: string, tabId: string) {
    emit('activate-tab', paneId, tabId);
}

function handleCloseTab(paneId: string, tabId: string) {
    emit('close-tab', paneId, tabId);
}

function handleNewTab(paneId: string) {
    emit('new-tab', paneId);
}

function handleReorderTab(paneId: string, fromIndex: number, toIndex: number) {
    emit('reorder-tab', paneId, fromIndex, toIndex);
}

function handleMoveTabDirection(
    paneId: string,
    tabId: string,
    direction: 'left' | 'right',
    targetIndex?: number | null,
) {
    emit('move-tab-direction', paneId, tabId, direction, targetIndex);
}

function handleTabContextCommand(paneId: string, tabId: string, command: TTabContextCommand) {
    emit('tab-context-command', paneId, tabId, command);
}

function handleSetWorkspaceRef(tabId: string, el: unknown) {
    emit('set-workspace-ref', tabId, el);
}

function handleUpdateDocumentRecord(tabId: string, record: IWorkspaceDocumentRecord) {
    emit('update-document-record', tabId, record);
}

function handleUpdateTabSessionState(tabId: string, state: ITabViewSessionState) {
    emit('update-tab-session-state', tabId, state);
}

function handleUpdateTabStartSection(tabId: string, section: TStartSection) {
    emit('update-tab-start-section', tabId, section);
}

function handleOpenInNewTab(result: TDocumentRef | TOpenFileResult, paneId?: string) {
    emit('open-in-new-tab', result, paneId);
}

function handleRequestCloseTab(paneId: string, tabId: string) {
    emit('request-close-tab', paneId, tabId);
}

function handleOpenSettings() {
    emit('open-settings');
}

function handleOpenCombine() {
    emit('open-combine');
}

function handleToggleFullscreen() {
    emit('toggle-fullscreen');
}

function handleUpdateSplitRatio(splitId: string, ratio: number) {
    emit('update-split-ratio', splitId, ratio);
}

function handlePaneSlot(paneId: string, element: HTMLElement | null) {
    if (element) {
        const pane = Array.from(
            hostRef.value?.querySelectorAll<HTMLElement>('[data-editor-pane-id]') ?? [],
        ).find(candidate => candidate.dataset.editorPaneId === paneId);
        if (pane) {
            fenceDocumentViewportPaneRelocationScroll(pane);
            requestAnimationFrame(() => clearDocumentViewportPaneRelocationScrollFence(pane));
        }
        paneSlotTargets.set(paneId, element);
        return;
    }
    const current = paneSlotTargets.get(paneId);
    if (current && !current.isConnected) {
        // Keep the detached target until its replacement registers in the
        // same layout transition. Teleport then moves the persistent pane
        // without ever unmounting its document workspace.
        return;
    }
    paneSlotTargets.delete(paneId);
}
</script>

<style scoped>
.editor-panes-host {
    position: relative;
}

.editor-pane-parking {
    position: fixed;
    width: var(--app-divider-width);
    height: var(--app-hairline-height);
    overflow: hidden;
    visibility: hidden;
    pointer-events: none;
}
</style>
