<template>
    <div
        class="editor-pane"
        :class="{
            'is-active': pane.paneId === activePaneId,
            'has-multiple-panes': paneCount > 1,
        }"
        :data-editor-pane-id="pane.paneId"
        @pointerdown="emit('activate-pane', pane.paneId)"
    >
        <TabBar
            v-if="!zenMode"
            :tabs="visibleTabs"
            :active-tab-id="pane.activeTabId"
            :context-availability="tabContextAvailability"
            @activate="emit('activate-tab', pane.paneId, $event)"
            @close="emit('close-tab', pane.paneId, $event)"
            @new-tab="emit('new-tab', pane.paneId)"
            @reorder="(fromIndex, toIndex) => emit('reorder-tab', pane.paneId, fromIndex, toIndex)"
            @move-direction="(tabId, direction, targetIndex) => emit('move-tab-direction', pane.paneId, tabId, direction, targetIndex)"
            @tab-context-command="(tabId, command) => emit('tab-context-command', pane.paneId, tabId, command)"
        />
        <div class="editor-pane-content">
            <template v-for="tab in visibleTabs" :key="tab.id">
                <DeferredDocumentWorkspaceHost
                    v-if="shouldMountHost(tab.id)"
                    v-show="tab.id === pane.activeTabId || tab.id === presentationFallbackTabId"
                    :class="{
                        'is-presentation-fallback': tab.id === presentationFallbackTabId
                            && tab.id !== pane.activeTabId,
                    }"
                    :tab-id="tab.id"
                    :document-path="tab.originalPath"
                    :document-record="documentRecordsByTabId[tab.id] ?? null"
                    :has-document-hint="tabHasDocumentHint(tab)"
                    :is-dirty="tab.isDirty"
                    :recovery-working-copy-path="tab.recoveryWorkingCopyPath"
                    :initial-view-state="viewStateByTabId[tab.id] ?? null"
                    :document-session="documentSessionsByTabId[tab.id]!"
                    :is-startup-open-claim-pending="isStartupOpenClaimPending"
                    :is-active="pane.paneId === activePaneId && tab.id === pane.activeTabId"
                    :is-render-active="tab.id === pane.activeTabId"
                    :is-tab-transition-busy="isTabTransitionBusy"
                    :is-fullscreen="isFullscreen"
                    :fullscreen-supported="fullscreenSupported"
                    :is-workspace-layout-resizing="isWorkspaceLayoutResizing"
                    :start-section="startSectionByTabId[tab.id] ?? 'recent'"
                    @update-document-record="emit('update-document-record', tab.id, $event)"
                    @update-session-state="emit('update-tab-session-state', tab.id, $event)"
                    @update:start-section="emit('update-tab-start-section', tab.id, $event)"
                    @open-in-new-tab="emit('open-in-new-tab', $event, pane.paneId)"
                    @request-close-tab="emit('request-close-tab', pane.paneId, tab.id)"
                    @open-settings="emit('open-settings')"
                    @open-combine="emit('open-combine')"
                    @toggle-fullscreen="emit('toggle-fullscreen')"
                    @expose-ready="emit('set-workspace-ref', tab.id, $event)"
                    @expose-released="emit('set-workspace-ref', tab.id, null)"
                />
            </template>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { IEditorPaneState } from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type {
    ITabContextAvailability,
    TTabContextCommand,
} from '@app/types/tabContextMenu';
import type { TStartSection } from '@app/types/startSection';
import type {
    ITabLifecycleState,
    ITabViewSessionState,
} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/tabs/tabHasDocumentHint';
import DeferredDocumentWorkspaceHost from '@app/modules/workspace-shell/components/DeferredDocumentWorkspaceHost.vue';
import TabBar from '@app/modules/workspace-shell/components/layout/TabBar.vue';

const {
    documentRecordsByTabId,
    pane,
    tabLifecycleById,
    tabs,
    zenActiveTabId,
    zenMode,
} = defineProps<{
    pane: IEditorPaneState;
    paneCount: number;
    tabs: ITab[];
    activePaneId: string | null;
    isStartupOpenClaimPending: boolean;
    isTabTransitionBusy: boolean;
    presentationFallbackTabId: string | null;
    tabContextAvailability: ITabContextAvailability | null;
    startSectionByTabId: Record<string, TStartSection>;
    tabLifecycleById: Record<string, ITabLifecycleState>;
    viewStateByTabId: Record<string, ITabViewSessionState>;
    documentRecordsByTabId: Record<string, IWorkspaceDocumentRecord>;
    documentSessionsByTabId: Record<string, IWorkspaceDocumentController>;
    zenMode: boolean;
    zenActiveTabId: string | null;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
    isWorkspaceLayoutResizing: boolean;
}>();

const emit = defineEmits<{
    'activate-pane': [paneId: string];
    'activate-tab': [paneId: string, tabId: string];
    'close-tab': [paneId: string, tabId: string];
    'new-tab': [paneId: string];
    'reorder-tab': [paneId: string, fromIndex: number, toIndex: number];
    'move-tab-direction': [paneId: string, tabId: string, direction: 'left' | 'right', targetIndex?: number | null];
    'tab-context-command': [paneId: string, tabId: string, command: TTabContextCommand];
    'set-workspace-ref': [tabId: string, el: unknown];
    'update-document-record': [tabId: string, record: IWorkspaceDocumentRecord];
    'update-tab-session-state': [tabId: string, state: ITabViewSessionState];
    'update-tab-start-section': [tabId: string, section: TStartSection];
    'open-in-new-tab': [result: TDocumentRef | TOpenFileResult, paneId: string];
    'request-close-tab': [paneId: string, tabId: string];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
}>();

const tabById = computed(() => new Map(tabs.map(tab => [
    tab.id,
    tab,
])));
const visibleTabs = computed(() => pane.tabIds.flatMap((tabId) => {
    const tab = tabById.value.get(tabId);
    if (!tab || zenMode && zenActiveTabId !== tab.id) {
        return [];
    }
    const recordTab = documentRecordsByTabId[tab.id]?.tab;
    return [{
        ...tab,
        ...recordTab,
    }];
}));

function shouldMountHost(tabId: string) {
    return tabLifecycleById[tabId]?.shouldMountHost !== false;
}
</script>

<style scoped>
.editor-pane {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    box-sizing: border-box;
    border: 0;
    background: var(--app-window-bg);
}

.editor-pane.has-multiple-panes {
    position: relative;
}

.editor-pane.has-multiple-panes :deep(.tab-bar) {
    transition: background-color 0.12s ease, border-bottom-color 0.12s ease, box-shadow 0.12s ease;
}

.editor-pane.has-multiple-panes.is-active :deep(.tab-bar) {
    background: var(--app-editor-pane-active-tabbar-bg);
    border-bottom-color: var(--app-editor-pane-active-tabbar-divider);
    box-shadow: inset 0 1px 0 var(--app-editor-pane-active-tabbar-glow);

    --app-tab-divider: var(--app-editor-pane-active-tabbar-divider);
    --app-tab-hover-bg: color-mix(in oklab, var(--app-editor-pane-active-tabbar-bg) 55%, var(--ui-bg) 45%);
}

.editor-pane-content {
    position: relative;
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    box-sizing: border-box;
}

.editor-pane-content > .is-presentation-fallback {
    position: absolute;
    inset: 0;
    z-index: var(--app-z-workspace-overlay);
    pointer-events: none;
}

/*
 * The outgoing tab keeps painting its centre pixels under the claiming document
 * until that document commits its own, which is what keeps the open from
 * flashing. Its sidebar describes a different document, so presenting it beside
 * the new tab's title would put two document identities on screen at once.
 */
.editor-pane-content > .is-presentation-fallback :deep(.sidebar-wrapper) {
    visibility: hidden;
}

.editor-pane-content > * {
    flex: 1;
    width: 100%;
    min-width: 0;
    min-height: 0;
}
</style>
