<template>
    <div
        v-if="leafNode"
        class="editor-group-pane"
        :class="{
            'is-active': leafNode.groupId === activeGroupId,
            'has-multiple-groups': hasMultipleGroups,
        }"
        @pointerdown="handleGroupPointerDown(leafNode.groupId)"
    >
        <template v-if="groupForLeaf">
            <TabBar
                :tabs="tabsForGroup(groupForLeaf!.id)"
                :active-tab-id="groupForLeaf!.activeTabId"
                :context-availability="tabContextAvailabilityByGroup[groupForLeaf!.id] ?? null"
                @activate="(tabId) => emit('activate-tab', groupForLeaf!.id, tabId)"
                @close="(tabId) => emit('close-tab', groupForLeaf!.id, tabId)"
                @new-tab="emit('new-tab', groupForLeaf!.id)"
                @reorder="(fromIndex, toIndex) => emit('reorder-tab', groupForLeaf!.id, fromIndex, toIndex)"
                @move-direction="(tabId, direction) => emit('move-tab-direction', groupForLeaf!.id, tabId, direction)"
                @tab-context-command="(tabId, command) => emit('tab-context-command', groupForLeaf!.id, tabId, command)"
            />
            <div class="editor-group-content">
                <DocumentWorkspace
                    v-for="tab in tabsForGroup(groupForLeaf!.id)"
                    v-show="tab.id === groupForLeaf!.activeTabId"
                    :key="tab.id"
                    :ref="(el) => emit('set-workspace-ref', tab.id, el)"
                    :tab-id="tab.id"
                    :is-active="groupForLeaf!.id === activeGroupId && tab.id === groupForLeaf!.activeTabId"
                    @update-tab="(updates) => emit('update-tab', tab.id, updates)"
                    @open-in-new-tab="(result) => emit('open-in-new-tab', result, groupForLeaf!.id)"
                    @request-close-tab="emit('request-close-tab', groupForLeaf!.id, tab.id)"
                    @open-settings="emit('open-settings')"
                />
            </div>
        </template>
        <div v-else class="editor-group-content" />
    </div>

    <div
        v-else-if="splitNode"
        ref="splitContainerRef"
        class="editor-split"
        :class="splitNode.orientation === 'horizontal' ? 'is-horizontal' : 'is-vertical'"
    >
        <div class="editor-split-pane editor-split-pane-first" :style="firstPaneStyle">
            <EditorGroupsGrid
                :node="splitNode.first"
                :groups="groups"
                :tabs="tabs"
                :active-group-id="activeGroupId"
                :tab-context-availability-by-group="tabContextAvailabilityByGroup"
                @activate-group="(groupId) => emit('activate-group', groupId)"
                @activate-tab="(groupId, tabId) => emit('activate-tab', groupId, tabId)"
                @close-tab="(groupId, tabId) => emit('close-tab', groupId, tabId)"
                @new-tab="(groupId) => emit('new-tab', groupId)"
                @reorder-tab="(groupId, fromIndex, toIndex) => emit('reorder-tab', groupId, fromIndex, toIndex)"
                @move-tab-direction="(groupId, tabId, direction) => emit('move-tab-direction', groupId, tabId, direction)"
                @tab-context-command="(groupId, tabId, command) => emit('tab-context-command', groupId, tabId, command)"
                @set-workspace-ref="(tabId, el) => emit('set-workspace-ref', tabId, el)"
                @update-tab="(tabId, updates) => emit('update-tab', tabId, updates)"
                @open-in-new-tab="(result, groupId) => emit('open-in-new-tab', result, groupId)"
                @request-close-tab="(groupId, tabId) => emit('request-close-tab', groupId, tabId)"
                @open-settings="emit('open-settings')"
                @update-split-ratio="(splitId, ratio) => emit('update-split-ratio', splitId, ratio)"
            />
        </div>

        <div
            class="editor-sash"
            :class="splitNode!.orientation === 'horizontal' ? 'is-vertical-line' : 'is-horizontal-line'"
            role="separator"
            :aria-orientation="splitNode!.orientation === 'horizontal' ? 'vertical' : 'horizontal'"
            @pointerdown.prevent="(event) => startResize(event, splitNode!.id, splitNode!.orientation)"
        />

        <div class="editor-split-pane editor-split-pane-second">
            <EditorGroupsGrid
                :node="splitNode.second"
                :groups="groups"
                :tabs="tabs"
                :active-group-id="activeGroupId"
                :tab-context-availability-by-group="tabContextAvailabilityByGroup"
                @activate-group="(groupId) => emit('activate-group', groupId)"
                @activate-tab="(groupId, tabId) => emit('activate-tab', groupId, tabId)"
                @close-tab="(groupId, tabId) => emit('close-tab', groupId, tabId)"
                @new-tab="(groupId) => emit('new-tab', groupId)"
                @reorder-tab="(groupId, fromIndex, toIndex) => emit('reorder-tab', groupId, fromIndex, toIndex)"
                @move-tab-direction="(groupId, tabId, direction) => emit('move-tab-direction', groupId, tabId, direction)"
                @tab-context-command="(groupId, tabId, command) => emit('tab-context-command', groupId, tabId, command)"
                @set-workspace-ref="(tabId, el) => emit('set-workspace-ref', tabId, el)"
                @update-tab="(tabId, updates) => emit('update-tab', tabId, updates)"
                @open-in-new-tab="(result, groupId) => emit('open-in-new-tab', result, groupId)"
                @request-close-tab="(groupId, tabId) => emit('request-close-tab', groupId, tabId)"
                @open-settings="emit('open-settings')"
                @update-split-ratio="(splitId, ratio) => emit('update-split-ratio', splitId, ratio)"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    onUnmounted,
    ref,
} from 'vue';
import type {
    ITab,
    TTabUpdate,
} from '@app/types/tabs';
import type {
    ITabContextAvailability,
    TTabContextCommand,
} from '@app/types/tab-context-menu';
import type {
    IEditorGroupState,
    IEditorLayoutSplitNode,
    TEditorLayoutNode,
    TGroupOrientation,
} from '@app/types/editor-groups';

defineOptions({name: 'EditorGroupsGrid'});

const props = defineProps<{
    node: TEditorLayoutNode;
    groups: IEditorGroupState[];
    tabs: ITab[];
    activeGroupId: string | null;
    tabContextAvailabilityByGroup: Record<string, ITabContextAvailability>;
}>();

const emit = defineEmits<{
    'activate-group': [groupId: string];
    'activate-tab': [groupId: string, tabId: string];
    'close-tab': [groupId: string, tabId: string];
    'new-tab': [groupId: string];
    'reorder-tab': [groupId: string, fromIndex: number, toIndex: number];
    'move-tab-direction': [groupId: string, tabId: string, direction: 'left' | 'right'];
    'tab-context-command': [groupId: string, tabId: string, command: TTabContextCommand];
    'set-workspace-ref': [tabId: string, el: unknown];
    'update-tab': [tabId: string, updates: TTabUpdate];
    'open-in-new-tab': [result: string | import('@app/types/electron-api').TOpenFileResult, groupId: string];
    'request-close-tab': [groupId: string, tabId: string];
    'open-settings': [];
    'update-split-ratio': [splitId: string, ratio: number];
}>();

const splitContainerRef = ref<HTMLElement | null>(null);
const hasMultipleGroups = computed(() => props.groups.length > 1);
const leafNode = computed(() => (props.node.type === 'leaf' ? props.node : null));
const splitNode = computed<IEditorLayoutSplitNode | null>(() => (props.node.type === 'split' ? props.node : null));
const firstPaneStyle = computed(() => {
    if (!splitNode.value) {
        return undefined;
    }

    return {flexBasis: `${Math.max(0.15, Math.min(0.85, splitNode.value.ratio)) * 100}%`};
});

const groupForLeaf = computed(() => {
    const leaf = leafNode.value;
    if (!leaf) {
        return null;
    }

    return props.groups.find(group => group.id === leaf.groupId) ?? null;
});

function tabsForGroup(groupId: string) {
    const group = props.groups.find(candidate => candidate.id === groupId);
    if (!group) {
        return [];
    }

    return group.tabIds
        .map(tabId => props.tabs.find(tab => tab.id === tabId))
        .filter((tab): tab is ITab => Boolean(tab));
}

function handleGroupPointerDown(groupId: string) {
    emit('activate-group', groupId);
}

let moveListener: ((event: PointerEvent) => void) | null = null;
let upListener: ((event: PointerEvent) => void) | null = null;

function clearResizeListeners() {
    if (moveListener) {
        window.removeEventListener('pointermove', moveListener);
        moveListener = null;
    }

    if (upListener) {
        window.removeEventListener('pointerup', upListener);
        window.removeEventListener('pointercancel', upListener);
        upListener = null;
    }
}

function startResize(event: PointerEvent, splitId: string, orientation: TGroupOrientation) {
    const container = splitContainerRef.value;
    if (!container) {
        return;
    }

    const startRect = container.getBoundingClientRect();

    moveListener = (nextEvent: PointerEvent) => {
        if (orientation === 'horizontal') {
            const raw = (nextEvent.clientX - startRect.left) / startRect.width;
            emit('update-split-ratio', splitId, raw);
            return;
        }

        const raw = (nextEvent.clientY - startRect.top) / startRect.height;
        emit('update-split-ratio', splitId, raw);
    };

    upListener = () => {
        clearResizeListeners();
    };

    window.addEventListener('pointermove', moveListener);
    window.addEventListener('pointerup', upListener);
    window.addEventListener('pointercancel', upListener);

    const sash = event.currentTarget;
    if (sash instanceof Element && 'setPointerCapture' in sash) {
        const pointerSash = sash as Element & { setPointerCapture?: (pointerId: number) => void };
        pointerSash.setPointerCapture?.(event.pointerId);
    }
}

onUnmounted(() => {
    clearResizeListeners();
});
</script>

<style scoped>
.editor-group-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    box-sizing: border-box;
    border: 0;
    background: var(--app-window-bg);
}

.editor-group-pane.has-multiple-groups {
    position: relative;
}

.editor-group-pane.has-multiple-groups :deep(.tab-bar) {
    transition: background-color 0.12s ease, border-bottom-color 0.12s ease, box-shadow 0.12s ease;
}

.editor-group-pane.has-multiple-groups.is-active :deep(.tab-bar) {
    background: var(--app-editor-group-active-tabbar-bg);
    border-bottom-color: var(--app-editor-group-active-tabbar-divider);
    box-shadow: inset 0 1px 0 var(--app-editor-group-active-tabbar-glow);
}

.editor-group-content {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    box-sizing: border-box;
}

.editor-group-content > * {
    flex: 1;
    width: 100%;
    min-width: 0;
    min-height: 0;
}

.editor-split {
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--app-editor-group-grid-bg);
    box-sizing: border-box;
}

.editor-split.is-horizontal {
    flex-direction: row;
}

.editor-split.is-vertical {
    flex-direction: column;
}

.editor-split-pane {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex: 1;
    box-sizing: border-box;
}

.editor-split-pane > * {
    flex: 1;
    min-width: 0;
    min-height: 0;
}

.editor-split-pane-first {
    flex-grow: 0;
    flex-shrink: 0;
}

.editor-sash {
    flex-shrink: 0;
    background: var(--app-editor-sash-bg);
    transition: background-color 0.12s ease;
}

.editor-sash:hover {
    background: var(--app-editor-sash-bg-hover);
}

.editor-sash.is-vertical-line {
    width: var(--app-editor-sash-size);
    cursor: col-resize;
}

.editor-sash.is-horizontal-line {
    height: var(--app-editor-sash-size);
    cursor: row-resize;
}
</style>
