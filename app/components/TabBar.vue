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
            <template v-for="(section, sectionIndex) in menuSections" :key="section.key">
                <div v-if="sectionIndex > 0" class="tab-context-menu-divider" />
                <p v-if="section.title" class="tab-context-menu-section">{{ section.title }}</p>
                <button
                    v-for="action in section.actions"
                    :key="action.key"
                    type="button"
                    class="tab-context-menu-action"
                    :title="action.label"
                    @click="runContextCommand(action.command)"
                >
                    {{ action.label }}
                </button>
            </template>
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
import type { IWindowTabTargetWindow } from '@app/types/window-tab-transfer';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/electron';

const { t } = useTypedI18n();
const { clampToViewport } = useContextMenuPosition();
const hasElectronBridge = hasElectronAPI();
const DIRECTION_ORDER: TGroupDirection[] = [
    'right',
    'left',
    'up',
    'down',
];

interface IContextMenuAction {
    key: string;
    label: string;
    command: TTabContextCommand;
}

interface IContextMenuSection {
    key: string;
    title?: string;
    actions: IContextMenuAction[];
}

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
const windowTransferTargets = ref<IWindowTabTargetWindow[]>([]);
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

    if (command.kind === 'move-to-new-window') {
        return props.contextAvailability?.canMoveToNewWindow ?? props.tabs.length > 1;
    }

    if (command.kind === 'move-to-window') {
        return true;
    }

    return isDirectionEnabled(command.kind, command.direction);
}

function buildDirectionalActions(
    kind: 'split' | 'focus' | 'move' | 'copy',
    labels: Record<TGroupDirection, string>,
) {
    return DIRECTION_ORDER.flatMap((direction) => {
        const command: TTabContextCommand = {
            kind,
            direction,
        };
        if (!isCommandEnabled(command)) {
            return [];
        }

        return [{
            key: `${kind}-${direction}`,
            label: labels[direction],
            command,
        } satisfies IContextMenuAction];
    });
}

const primaryActions = computed<IContextMenuAction[]>(() => {
    const actions: IContextMenuAction[] = [];
    if (isCommandEnabled({kind: 'new-tab'})) {
        actions.push({
            key: 'new-tab',
            label: t('tabs.newTab'),
            command: {kind: 'new-tab'},
        });
    }
    if (isCommandEnabled({kind: 'close-tab'})) {
        actions.push({
            key: 'close-tab',
            label: t('tabs.closeTab'),
            command: {kind: 'close-tab'},
        });
    }
    return actions;
});

const windowActions = computed<IContextMenuAction[]>(() => {
    if (!hasElectronBridge) {
        return [];
    }

    const actions: IContextMenuAction[] = [];
    if (isCommandEnabled({kind: 'move-to-new-window'})) {
        actions.push({
            key: 'move-to-new-window',
            label: t('menu.moveTabToNewWindow'),
            command: {kind: 'move-to-new-window'},
        });
    }

    actions.push(...windowTransferTargets.value.map(targetWindow => ({
        key: `move-to-window-${targetWindow.windowId}`,
        label: `${t('menu.moveTabToWindow')}: ${targetWindow.label}`,
        command: {
            kind: 'move-to-window',
            targetWindowId: targetWindow.windowId,
        } as const,
    })));

    return actions;
});

const splitActions = computed(() => buildDirectionalActions('split', {
    right: t('menu.splitEditorRight'),
    left: t('menu.splitEditorLeft'),
    up: t('menu.splitEditorUp'),
    down: t('menu.splitEditorDown'),
}));

const focusActions = computed(() => buildDirectionalActions('focus', {
    right: t('menu.focusGroupRight'),
    left: t('menu.focusGroupLeft'),
    up: t('menu.focusGroupUp'),
    down: t('menu.focusGroupDown'),
}));

const moveActions = computed(() => buildDirectionalActions('move', {
    right: t('menu.moveTabRight'),
    left: t('menu.moveTabLeft'),
    up: t('menu.moveTabUp'),
    down: t('menu.moveTabDown'),
}));

const copyActions = computed(() => buildDirectionalActions('copy', {
    right: t('menu.copyTabRight'),
    left: t('menu.copyTabLeft'),
    up: t('menu.copyTabUp'),
    down: t('menu.copyTabDown'),
}));

const menuSections = computed<IContextMenuSection[]>(() => {
    const sections: IContextMenuSection[] = [];
    if (primaryActions.value.length > 0) {
        sections.push({
            key: 'primary',
            actions: primaryActions.value,
        });
    }
    if (windowActions.value.length > 0) {
        sections.push({
            key: 'window',
            title: t('menu.window'),
            actions: windowActions.value,
        });
    }
    if (splitActions.value.length > 0) {
        sections.push({
            key: 'split',
            title: t('menu.splitEditor'),
            actions: splitActions.value,
        });
    }
    if (focusActions.value.length > 0) {
        sections.push({
            key: 'focus',
            title: t('menu.focusEditorGroup'),
            actions: focusActions.value,
        });
    }
    if (moveActions.value.length > 0) {
        sections.push({
            key: 'move',
            title: t('menu.moveTabToGroup'),
            actions: moveActions.value,
        });
    }
    if (copyActions.value.length > 0) {
        sections.push({
            key: 'copy',
            title: t('menu.copyTabToGroup'),
            actions: copyActions.value,
        });
    }
    return sections;
});

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

async function loadWindowTransferTargets() {
    if (!hasElectronBridge) {
        windowTransferTargets.value = [];
        return;
    }

    try {
        windowTransferTargets.value = await getElectronAPI().tabs.listTargetWindows();
    } catch {
        windowTransferTargets.value = [];
    }

    if (!contextMenu.value.visible) {
        return;
    }
    await nextTick();
    positionContextMenu(contextMenu.value.x, contextMenu.value.y);
}

function openTabContextMenu(event: MouseEvent, tabId: string) {
    contextMenu.value.visible = true;
    contextMenu.value.tabId = tabId;
    contextMenu.value.x = event.clientX;
    contextMenu.value.y = event.clientY;

    void loadWindowTransferTargets();

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
    max-width: min(560px, calc(100vw - 16px));
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
    width: 100%;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
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
