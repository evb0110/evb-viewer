<template>
    <div ref="tabBarRef" class="tab-bar">
        <div class="tab-list" role="tablist">
            <button
                v-for="(tab, index) in tabs"
                :key="tab.id"
                :data-tab-id="tab.id"
                role="tab"
                class="tab"
                :class="{
                    'is-active': tab.id === activeTabId,
                    'is-dragging': isDragging && dragIndex === index,
                }"
                :aria-selected="tab.id === activeTabId"
                :title="tab.originalPath ?? tab.fileName ?? t('tabs.newTab')"
                @click="handleTabClick(tab.id)"
                @auxclick.prevent="handleAuxClick($event, tab.id)"
                @pointerdown="onPointerDown($event, index)"
                @contextmenu.prevent.stop="openTabContextMenu($event, tab.id)"
            >
                <span class="tab-label">{{ tab.fileName ?? t('tabs.newTab') }}</span>
                <span
                    v-if="tab.isDirty"
                    class="tab-dirty-dot"
                    :aria-label="t('tabs.unsavedChanges')"
                />
                <button
                    class="tab-close"
                    :class="{ 'is-visible': tab.id === activeTabId }"
                    :aria-label="t('tabs.closeTab')"
                    @pointerdown.stop
                    @click.stop="emit('close', tab.id)"
                >
                    <Icon name="lucide:x" size="14" />
                </button>
            </button>
            <button
                class="tab-new"
                :aria-label="t('tabs.newTab')"
                @click="emit('new-tab')"
            >
                <Icon name="lucide:plus" size="14" />
            </button>
        </div>
    </div>

    <Teleport to="body">
        <div
            v-if="contextMenu.visible"
            ref="contextMenuRef"
            class="tab-context-menu"
            :style="contextMenuStyle"
            @click.stop
            @contextmenu.prevent
        >
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'new-tab' })"
                @click="runContextCommand({ kind: 'new-tab' })"
            >
                {{ t('tabs.newTab') }}
            </button>
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'close-tab' })"
                @click="runContextCommand({ kind: 'close-tab' })"
            >
                {{ t('tabs.closeTab') }}
            </button>

            <div class="tab-context-menu-divider" />
            <p class="tab-context-menu-section">{{ t('menu.splitEditor') }}</p>
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'split', direction: 'right' })"
                @click="runContextCommand({ kind: 'split', direction: 'right' })"
            >
                {{ t('menu.splitEditorRight') }}
            </button>
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'split', direction: 'left' })"
                @click="runContextCommand({ kind: 'split', direction: 'left' })"
            >
                {{ t('menu.splitEditorLeft') }}
            </button>
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'split', direction: 'up' })"
                @click="runContextCommand({ kind: 'split', direction: 'up' })"
            >
                {{ t('menu.splitEditorUp') }}
            </button>
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'split', direction: 'down' })"
                @click="runContextCommand({ kind: 'split', direction: 'down' })"
            >
                {{ t('menu.splitEditorDown') }}
            </button>

            <div class="tab-context-menu-divider" />
            <p class="tab-context-menu-section">{{ t('menu.focusEditorGroup') }}</p>
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'focus', direction: 'right' })"
                @click="runContextCommand({ kind: 'focus', direction: 'right' })"
            >
                {{ t('menu.focusGroupRight') }}
            </button>
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'focus', direction: 'left' })"
                @click="runContextCommand({ kind: 'focus', direction: 'left' })"
            >
                {{ t('menu.focusGroupLeft') }}
            </button>
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'focus', direction: 'up' })"
                @click="runContextCommand({ kind: 'focus', direction: 'up' })"
            >
                {{ t('menu.focusGroupUp') }}
            </button>
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'focus', direction: 'down' })"
                @click="runContextCommand({ kind: 'focus', direction: 'down' })"
            >
                {{ t('menu.focusGroupDown') }}
            </button>

            <div class="tab-context-menu-divider" />
            <p class="tab-context-menu-section">{{ t('menu.moveTabToGroup') }}</p>
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'move', direction: 'right' })"
                @click="runContextCommand({ kind: 'move', direction: 'right' })"
            >
                {{ t('menu.moveTabRight') }}
            </button>
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'move', direction: 'left' })"
                @click="runContextCommand({ kind: 'move', direction: 'left' })"
            >
                {{ t('menu.moveTabLeft') }}
            </button>
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'move', direction: 'up' })"
                @click="runContextCommand({ kind: 'move', direction: 'up' })"
            >
                {{ t('menu.moveTabUp') }}
            </button>
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'move', direction: 'down' })"
                @click="runContextCommand({ kind: 'move', direction: 'down' })"
            >
                {{ t('menu.moveTabDown') }}
            </button>

            <div class="tab-context-menu-divider" />
            <p class="tab-context-menu-section">{{ t('menu.copyTabToGroup') }}</p>
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'copy', direction: 'right' })"
                @click="runContextCommand({ kind: 'copy', direction: 'right' })"
            >
                {{ t('menu.copyTabRight') }}
            </button>
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'copy', direction: 'left' })"
                @click="runContextCommand({ kind: 'copy', direction: 'left' })"
            >
                {{ t('menu.copyTabLeft') }}
            </button>
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'copy', direction: 'up' })"
                @click="runContextCommand({ kind: 'copy', direction: 'up' })"
            >
                {{ t('menu.copyTabUp') }}
            </button>
            <button
                type="button"
                class="tab-context-menu-action"
                :disabled="!isCommandEnabled({ kind: 'copy', direction: 'down' })"
                @click="runContextCommand({ kind: 'copy', direction: 'down' })"
            >
                {{ t('menu.copyTabDown') }}
            </button>
        </div>
    </Teleport>
</template>

<script setup lang="ts">
import {
    computed,
    nextTick,
    ref,
} from 'vue';
import { useEventListener } from '@vueuse/core';
import type { ITab } from '@app/types/tabs';
import { useTabDragReorder } from '@app/composables/useTabDragReorder';
import { useContextMenuPosition } from '@app/composables/useContextMenuPosition';
import type { TGroupDirection } from '@app/types/editor-groups';
import type {
    ITabContextAvailability,
    TTabContextCommand,
} from '@app/types/tab-context-menu';

const { t } = useTypedI18n();
const { clampToViewport } = useContextMenuPosition();

const props = defineProps<{
    tabs: ITab[];
    activeTabId: string | null;
    contextAvailability?: ITabContextAvailability | null;
}>();

const emit = defineEmits<{
    activate: [id: string];
    close: [id: string];
    'new-tab': [];
    reorder: [fromIndex: number, toIndex: number];
    'move-direction': [tabId: string, direction: 'left' | 'right'];
    'tab-context-command': [tabId: string, command: TTabContextCommand];
}>();

const tabBarRef = useTemplateRef<HTMLElement>('tabBarRef');
const contextMenuRef = ref<HTMLElement | null>(null);
const contextMenu = ref<{
    visible: boolean;
    x: number;
    y: number;
    tabId: string | null;
}>({
    visible: false,
    x: 0,
    y: 0,
    tabId: null,
});
const contextMenuStyle = computed(() => ({
    left: `${contextMenu.value.x}px`,
    top: `${contextMenu.value.y}px`,
}));

function isDirectionEnabled(
    kind: 'split' | 'focus' | 'move' | 'copy',
    direction: TGroupDirection,
) {
    return props.contextAvailability?.[kind][direction] ?? true;
}

function isCommandEnabled(command: TTabContextCommand) {
    if (command.kind === 'new-tab') {
        return props.contextAvailability?.canCreate ?? true;
    }

    if (command.kind === 'close-tab') {
        return props.contextAvailability?.canClose ?? true;
    }

    return isDirectionEnabled(command.kind, command.direction);
}

const {
    isDragging,
    dragIndex,
    onPointerDown,
    shouldSuppressClick,
} = useTabDragReorder(
    tabBarRef,
    (from, to) => emit('reorder', from, to),
    (index) => {
        const tab = props.tabs[index];
        if (tab) emit('activate', tab.id);
    },
    (index, direction) => {
        if (!isDirectionEnabled('move', direction)) {
            return;
        }
        const tab = props.tabs[index];
        if (tab) {
            emit('move-direction', tab.id, direction);
        }
    },
);

function handleTabClick(tabId: string) {
    if (shouldSuppressClick()) {
        return;
    }
    closeTabContextMenu();
    emit('activate', tabId);
}

function handleAuxClick(event: MouseEvent, tabId: string) {
    if (event.button === 1) {
        emit('close', tabId);
    }
}

function closeTabContextMenu() {
    contextMenu.value.visible = false;
    contextMenu.value.tabId = null;
}

function positionContextMenu(x: number, y: number) {
    const menuElement = contextMenuRef.value;
    if (!menuElement) {
        contextMenu.value.x = x;
        contextMenu.value.y = y;
        return;
    }

    const clamped = clampToViewport(
        x,
        y,
        menuElement.offsetWidth,
        menuElement.offsetHeight,
    );
    contextMenu.value.x = clamped.x;
    contextMenu.value.y = clamped.y;
}

function openTabContextMenu(event: MouseEvent, tabId: string) {
    contextMenu.value.visible = true;
    contextMenu.value.tabId = tabId;
    contextMenu.value.x = event.clientX;
    contextMenu.value.y = event.clientY;

    void nextTick(() => {
        if (!contextMenu.value.visible) {
            return;
        }
        positionContextMenu(event.clientX, event.clientY);
    });
}

function runContextCommand(command: TTabContextCommand) {
    const tabId = contextMenu.value.tabId;
    if (!isCommandEnabled(command)) {
        closeTabContextMenu();
        return;
    }
    closeTabContextMenu();
    if (!tabId) {
        return;
    }

    emit('tab-context-command', tabId, command);
}

useEventListener(window, 'resize', () => {
    closeTabContextMenu();
});

useEventListener(window, 'scroll', () => {
    closeTabContextMenu();
}, { capture: true });

useEventListener(window, 'keydown', (event) => {
    if (event.key === 'Escape') {
        closeTabContextMenu();
    }
});

useEventListener(window, 'pointerdown', (event) => {
    if (!contextMenu.value.visible) {
        return;
    }

    const target = event.target instanceof Node ? event.target : null;
    if (target && contextMenuRef.value?.contains(target)) {
        return;
    }
    closeTabContextMenu();
});
</script>

<style scoped>
.tab-bar {
    display: flex;
    align-items: stretch;
    width: 100%;
    min-width: 0;
    height: 36px;
    min-height: 36px;
    background: var(--app-chrome);
    border-bottom: 1px solid var(--ui-border);
    user-select: none;
    -webkit-app-region: drag;
}

.tab-list {
    display: flex;
    flex: 1;
    width: 100%;
    align-items: stretch;
    overflow: auto hidden;
    min-width: 0;
    scrollbar-width: none;
}

.tab-list::-webkit-scrollbar {
    display: none;
}

.tab {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 8px 0 12px;
    min-width: 0;
    max-width: 200px;
    height: 100%;
    border: none;
    border-right: 1px solid var(--ui-border);
    background: transparent;
    color: var(--ui-text-dimmed);
    font-size: 12px;
    cursor: pointer;
    position: relative;
    touch-action: none;
    -webkit-app-region: no-drag;
    transition: background-color 0.1s ease, color 0.1s ease;
}

.tab:hover {
    background: var(--app-chrome-hover);
}

.tab.is-active {
    background: var(--ui-bg);
    color: var(--ui-text);
}

.tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
}

.tab-dirty-dot {
    width: 8px;
    height: 8px;
    min-width: 8px;
    border-radius: 50%;
    background: var(--ui-text-dimmed);
    margin: 0 3px;
}

.tab-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    min-width: 20px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--ui-text-dimmed);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.1s ease, background-color 0.1s ease;
}

.tab:hover .tab-close,
.tab-close.is-visible {
    opacity: 1;
}

/* stylelint-disable-next-line no-descending-specificity */
.tab-close:hover {
    opacity: 1;
    background: var(--app-chrome-subtle-hover);
    color: var(--ui-text);
}

.tab-new {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    min-width: 28px;
    height: 100%;
    border: none;
    background: transparent;
    color: var(--ui-text-dimmed);
    cursor: pointer;
    -webkit-app-region: no-drag;
    transition: background-color 0.1s ease, color 0.1s ease;
}

.tab-new:hover {
    background: var(--app-chrome-hover);
    color: var(--ui-text);
}

.tab-bar:has(.is-dragging) .tab-list {
    overflow: visible;
}

.tab.is-dragging {
    z-index: 10;
    opacity: 0.85;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.tab-context-menu {
    position: fixed;
    z-index: 1400;
    min-width: 210px;
    display: grid;
    gap: 1px;
    border: 1px solid var(--ui-border);
    background: var(--ui-border);
    box-shadow:
        0 10px 24px rgb(0 0 0 / 15%),
        0 3px 8px rgb(0 0 0 / 10%);
}

.tab-context-menu-divider {
    height: 1px;
    background: var(--ui-border);
}

.tab-context-menu-section {
    margin: 0;
    padding: 0.45rem 0.6rem 0.35rem;
    background: var(--ui-bg-muted);
    color: var(--ui-text-dimmed);
    font-size: 0.64rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 600;
}

.tab-context-menu-action {
    display: flex;
    align-items: center;
    text-align: left;
    border: none;
    background: var(--ui-bg);
    color: var(--ui-text);
    min-height: 2rem;
    padding: 0 0.6rem;
    cursor: pointer;
    font-size: 0.8125rem;
}

.tab-context-menu-action:hover {
    background: color-mix(in oklab, var(--ui-bg) 93%, var(--ui-primary) 7%);
}

.tab-context-menu-action:disabled {
    cursor: default;
    color: var(--ui-text-dimmed);
    background: var(--ui-bg);
    opacity: 0.6;
}

.tab-context-menu-action:disabled:hover {
    background: var(--ui-bg);
}
</style>
