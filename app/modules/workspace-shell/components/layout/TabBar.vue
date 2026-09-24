<template>
    <div ref="tabBarRef" class="tab-bar">
        <div class="tab-strip" data-tab-list>
            <div
                class="tab-list"
                role="tablist"
                aria-orientation="horizontal"
                :aria-label="t('tabs.tabListLabel')"
            >
                <div
                    v-for="(tab, index) in tabs"
                    :key="tab.id"
                    :data-tab-id="tab.id"
                    role="tab"
                    class="tab"
                    :class="{
                        'is-active': tab.id === activeTabId,
                        'is-dirty': tab.isDirty,
                        'is-dragging': isDragging && dragIndex === index,
                    }"
                    :aria-label="resolveTabTitle(tab)"
                    :aria-description="tab.isDirty ? t('tabs.unsavedChanges') : undefined"
                    :aria-selected="tab.id === activeTabId"
                    :aria-posinset="index + 1"
                    :aria-setsize="tabs.length"
                    :tabindex="tab.id === (focusedTabId ?? activeTabId) ? 0 : -1"
                    @focus="handleTabFocus(tab.id)"
                    @click="handleTabClick(tab.id)"
                    @auxclick.prevent="handleAuxClick($event, tab.id)"
                    @keydown="handleTabKeydown($event, tab.id)"
                    @pointerdown="onPointerDown($event, index)"
                    @contextmenu.prevent.stop="openTabContextMenu($event, tab.id)"
                >
                    <AppTooltip
                        :text="resolveTabTitle(tab)"
                        :delay-duration="800"
                        usefulness="overflow"
                    >
                        <span class="tab-label">{{ tab.fileName ?? t('tabs.newTab') }}</span>
                    </AppTooltip>
                    <button
                        type="button"
                        class="tab-close"
                        :class="{ 'is-visible': tab.id === activeTabId }"
                        :aria-label="t('tabs.closeTab')"
                        :disabled="!canCloseTabs"
                        :tabindex="tab.id === activeTabId && canCloseTabs ? 0 : -1"
                        @pointerdown.stop
                        @click.stop="requestClose(tab.id)"
                        @keydown.enter.stop
                        @keydown.space.stop
                    >
                        <Icon name="ph:x" size="14" />
                    </button>
                </div>
            </div>
            <button
                type="button"
                class="tab-new"
                :aria-label="t('tabs.newTab')"
                @click="handleNewTab"
            >
                <Icon name="ph:plus" size="14" />
            </button>
        </div>
    </div>

    <UDropdownMenu
        v-model:open="contextMenuOpen"
        :items="contextMenuItems"
        :content="contextMenuContentOptions"
        :ui="contextMenuUi"
        portal="body"
    >
        <button
            type="button"
            class="tab-context-menu-anchor"
            :style="contextMenuAnchorStyle"
            tabindex="-1"
            aria-hidden="true"
        />
    </UDropdownMenu>
</template>

<script setup lang="ts">
import { useEventListener } from '@vueuse/core';
import type { TTabView } from '@app/types/tabs';
import { useTabDragReorder } from '@app/modules/workspace-shell/composables/useTabDragReorder';
import type { TPaneDirection } from '@contracts/editorPanes';
import {
    getDocumentRefBaseName,
    isBrowserDocumentRef,
} from '@app/utils/documentRef';
import type {
    ITabContextAvailability,
    TDirectionalTabContextCommand,
    TTabContextCommand,
} from '@app/types/tabContextMenu';
import type { IWindowTabTargetWindow } from '@contracts/windowTabs';
import {
    canUseNativeWindowTabTransfers,
    getWindowTabsCapability,
} from '@app/utils/platformWindowTabs';

const { t } = useTypedI18n();
const SPLIT_DIRECTION_ORDER = [
    'right',
    'down',
] as const satisfies readonly TPaneDirection[];
type TDirectionalAvailabilityKind = 'split' | 'splitEmpty' | 'focus' | 'move' | 'copy';
type TStaticCommandKind = Exclude<TTabContextCommand['kind'], 'split' | 'split-empty' | 'focus' | 'move' | 'copy'>;

interface IContextMenuAction {
    key: string;
    label: string;
    icon: string;
    command: TTabContextCommand;
}

interface IContextMenuSection {
    key: string;
    actions: IContextMenuAction[];
}

type TTabContextMenuItem =
    | { type: 'separator' }
    | {
        label: string;
        icon: string;
        onSelect: () => void;
    };

const {
    contextAvailability = undefined,
    tabs,
} = defineProps<{
    tabs: TTabView[];
    activeTabId: string | null;
    contextAvailability?: ITabContextAvailability | null;
}>();

const emit = defineEmits<{
    activate: [id: string];
    close: [id: string];
    'new-tab': [];
    reorder: [fromIndex: number, toIndex: number];
    'move-direction': [
        tabId: string,
        direction: 'left' | 'right',
        targetIndex?: number | null,
    ];
    'tab-context-command': [tabId: string, command: TTabContextCommand];
}>();

function handleNewTab() {
    emit('new-tab');
}

const tabBarRef = useTemplateRef<HTMLElement>('tabBarRef');
const focusedTabId = ref<string | null>(null);

watch(
    () => tabs.map(tab => tab.id),
    (tabIds) => {
        if (focusedTabId.value !== null && !tabIds.includes(focusedTabId.value)) {
            focusedTabId.value = null;
        }
    },
    {flush: 'post'},
);
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
const canUseNativeWindowTransfers = computed(() => canUseNativeWindowTabTransfers());
const contextMenuAnchorStyle = computed(() => ({
    left: `${contextMenu.value.x}px`,
    top: `${contextMenu.value.y}px`,
}));
const contextMenuOpen = computed({
    get: () => contextMenu.value.visible,
    set: (open: boolean) => {
        if (!open) {
            closeTabContextMenu();
            return;
        }
        contextMenu.value.visible = true;
    },
});
const contextMenuContentOptions = {
    side: 'bottom' as const,
    align: 'start' as const,
    sideOffset: 0,
    collisionPadding: 8,
    positionStrategy: 'fixed' as const,
    updatePositionStrategy: 'always' as const,
};
const contextMenuUi = {
    content: 'tab-context-menu toolbar-menu-panel',
    separator: 'toolbar-menu-divider',
    item: 'toolbar-menu-item',
    itemLeadingIcon: 'toolbar-menu-icon',
    itemLabel: 'toolbar-menu-label',
};
const canCloseTabs = computed(() => contextAvailability?.canClose ?? true);
const clickedTab = computed(() => tabs.find(tab => tab.id === contextMenu.value.tabId) ?? null);
const clickedTabIndex = computed(() => tabs.findIndex(tab => tab.id === contextMenu.value.tabId));
const canCloseOthers = computed(() => canCloseTabs.value && tabs.length > 1);
const canCloseToRight = computed(() =>
    canCloseTabs.value && clickedTabIndex.value >= 0 && clickedTabIndex.value < tabs.length - 1);
const clickedTabFilePath = computed(() => {
    const path = clickedTab.value?.originalPath ?? null;
    return typeof path === 'string' && path.trim().length > 0 && !isBrowserDocumentRef(path)
        ? path
        : null;
});
const canRevealClickedPath = computed(() => Boolean(clickedTabFilePath.value));

function resolveTabTitle(tab: TTabView) {
    return getDocumentRefBaseName(tab.originalPath) ?? tab.fileName ?? t('tabs.newTab');
}

function isDirectionEnabled(kind: TDirectionalAvailabilityKind, direction: TPaneDirection) {
    return contextAvailability?.[kind][direction] ?? true;
}

function resolveDirectionalAvailabilityKind(command: TDirectionalTabContextCommand): TDirectionalAvailabilityKind {
    return command.kind === 'split-empty' ? 'splitEmpty' : command.kind;
}

function isDirectionalCommand(command: TTabContextCommand): command is TDirectionalTabContextCommand {
    return 'direction' in command;
}

function isDirectionalCommandEnabled(command: TDirectionalTabContextCommand) {
    return isDirectionEnabled(resolveDirectionalAvailabilityKind(command), command.direction);
}

function isStaticCommandEnabled(command: Exclude<TTabContextCommand, TDirectionalTabContextCommand>) {
    const staticAvailabilityByKind = {
        'new-tab': contextAvailability?.canCreate ?? true,
        'close-tab': contextAvailability?.canClose ?? true,
        'close-others': canCloseOthers.value,
        'close-right': canCloseToRight.value,
        'reveal-in-folder': canRevealClickedPath.value,
        'copy-path': canRevealClickedPath.value,
        'move-to-new-window': canUseNativeWindowTransfers.value && (contextAvailability?.canMoveToNewWindow ?? tabs.length > 1),
        'move-to-window': canUseNativeWindowTransfers.value && (contextAvailability?.canMoveToWindow ?? true),
    } satisfies Record<TStaticCommandKind, boolean>;

    return staticAvailabilityByKind[command.kind];
}

function isCommandEnabled(command: TTabContextCommand) {
    return isDirectionalCommand(command)
        ? isDirectionalCommandEnabled(command)
        : isStaticCommandEnabled(command);
}

function buildDirectionalActions(
    kind: 'split' | 'split-empty' | 'focus' | 'move' | 'copy',
    labels: Record<TPaneDirection, string>,
    icons: Record<TPaneDirection, string>,
) {
    return SPLIT_DIRECTION_ORDER.flatMap((direction) => {
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
            icon: icons[direction],
            command,
        } satisfies IContextMenuAction];
    });
}

const primaryActions = computed(() => {
    const actions: IContextMenuAction[] = [];
    if (isCommandEnabled({kind: 'new-tab'})) {
        actions.push({
            key: 'new-tab',
            label: t('tabs.newTab'),
            icon: 'i-ph-plus',
            command: {kind: 'new-tab'},
        });
    }
    if (isCommandEnabled({kind: 'close-tab'})) {
        actions.push({
            key: 'close-tab',
            label: t('tabs.closeTab'),
            icon: 'i-ph-x',
            command: {kind: 'close-tab'},
        });
    }
    if (isCommandEnabled({kind: 'close-others'})) {
        actions.push({
            key: 'close-others',
            label: t('tabs.closeOthers'),
            icon: 'i-ph-x-circle',
            command: {kind: 'close-others'},
        });
    }
    if (isCommandEnabled({kind: 'close-right'})) {
        actions.push({
            key: 'close-right',
            label: t('tabs.closeToRight'),
            icon: 'i-ph-arrow-line-right',
            command: {kind: 'close-right'},
        });
    }
    return actions;
});

const fileActions = computed(() => {
    const actions: IContextMenuAction[] = [];
    if (isCommandEnabled({kind: 'reveal-in-folder'})) {
        actions.push({
            key: 'reveal-in-folder',
            label: t('status.showInFolder'),
            icon: 'i-ph-folder-open',
            command: {kind: 'reveal-in-folder'},
        });
    }
    if (isCommandEnabled({kind: 'copy-path'})) {
        actions.push({
            key: 'copy-path',
            label: t('tabs.copyPath'),
            icon: 'i-ph-copy',
            command: {kind: 'copy-path'},
        });
    }
    return actions;
});

const windowActions = computed(() => {
    const actions: IContextMenuAction[] = [];
    if (isCommandEnabled({kind: 'move-to-new-window'})) {
        actions.push({
            key: 'move-to-new-window',
            label: t('menu.moveTabToNewWindow'),
            icon: 'i-ph-arrow-square-out',
            command: {kind: 'move-to-new-window'},
        });
    }

    actions.push(...windowTransferTargets.value.flatMap((targetWindow) => {
        const command = {
            kind: 'move-to-window',
            targetWindowId: targetWindow.windowId,
        } as const;
        if (!isCommandEnabled(command)) {
            return [];
        }

        return [{
            key: `move-to-window-${targetWindow.windowId}`,
            label: `${t('menu.moveTabToWindow')}: ${targetWindow.label}`,
            icon: 'i-ph-arrow-square-out',
            command,
        }];
    }));

    return actions;
});

const splitActions = computed(() => buildDirectionalActions('split', {
    right: t('menu.splitEditorRight'),
    left: t('menu.splitEditorLeft'),
    up: t('menu.splitEditorUp'),
    down: t('menu.splitEditorDown'),
}, {
    right: 'i-ph-square-split-horizontal',
    left: 'i-ph-square-split-horizontal',
    up: 'i-ph-square-split-vertical',
    down: 'i-ph-square-split-vertical',
}));

const menuSections = computed(() => {
    const sections: IContextMenuSection[] = [];
    if (primaryActions.value.length > 0) {
        sections.push({
            key: 'primary',
            actions: primaryActions.value,
        });
    }
    if (splitActions.value.length > 0) {
        sections.push({
            key: 'split',
            actions: splitActions.value,
        });
    }
    if (fileActions.value.length > 0) {
        sections.push({
            key: 'file',
            actions: fileActions.value,
        });
    }
    if (windowActions.value.length > 0) {
        sections.push({
            key: 'window',
            actions: windowActions.value,
        });
    }
    return sections;
});

const contextMenuItems = computed(() => {
    const items: TTabContextMenuItem[] = [];
    for (const section of menuSections.value) {
        if (items.length > 0) {
            items.push({ type: 'separator' });
        }

        items.push(...section.actions.map(action => ({
            label: action.label,
            icon: action.icon,
            onSelect: () => runContextCommand(action.command),
        })));
    }
    return items;
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
        const tab = tabs[index];
        if (tab) emit('activate', tab.id);
    },
    (index, direction, targetIndex) => {
        if (!isDirectionEnabled('move', direction)) {
            return;
        }
        const tab = tabs[index];
        if (tab) {
            emit('move-direction', tab.id, direction, targetIndex);
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

function handleTabFocus(tabId: string) {
    focusedTabId.value = tabId;
}

function handleTabKeydown(event: KeyboardEvent, tabId: string) {
    const tabIndex = tabs.findIndex(tab => tab.id === tabId);
    if (tabIndex < 0) {
        return;
    }

    const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? -1
        : event.key === 'ArrowRight' || event.key === 'ArrowDown'
            ? 1
            : 0;
    const targetIndex = direction !== 0
        ? (tabIndex + direction + tabs.length) % tabs.length
        : event.key === 'Home'
            ? 0
            : event.key === 'End'
                ? tabs.length - 1
                : null;
    if (targetIndex !== null && targetIndex !== tabIndex) {
        const targetTab = tabs[targetIndex];
        if (!targetTab) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeTabContextMenu();
        focusedTabId.value = targetTab.id;
        tabBarRef.value?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(targetTab.id)}"]`)
            ?.focus({preventScroll: true});
        return;
    }

    if (event.key !== 'Enter' && event.key !== ' ') {
        return;
    }

    event.preventDefault();
    handleTabClick(tabId);
}

function handleAuxClick(event: MouseEvent, tabId: string) {
    if (event.button === 1 && canCloseTabs.value) {
        emit('close', tabId);
    }
}

function requestClose(tabId: string) {
    if (!canCloseTabs.value) {
        return;
    }
    emit('close', tabId);
}

function closeTabContextMenu() {
    contextMenu.value.visible = false;
    contextMenu.value.tabId = null;
}

async function loadWindowTransferTargets() {
    if (!canUseNativeWindowTransfers.value) {
        windowTransferTargets.value = [];
        return;
    }

    try {
        windowTransferTargets.value = await getWindowTabsCapability().listTargetWindows();
    } catch {
        windowTransferTargets.value = [];
    }
}

function openTabContextMenu(event: MouseEvent, tabId: string) {
    contextMenu.value.visible = true;
    contextMenu.value.tabId = tabId;
    contextMenu.value.x = event.clientX;
    contextMenu.value.y = event.clientY;

    void loadWindowTransferTargets();
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

</script>

<style lang="scss">
@use '@app/assets/css/toolbar-menu-shared';

.tab-context-menu {
    min-width: min(var(--app-tab-context-menu-min-width), var(--app-floating-panel-viewport-width));
}
</style>

<style scoped>
.tab-bar {
    display: flex;
    align-items: stretch;
    width: 100%;
    min-width: 0;
    height: var(--app-tabbar-height, 2.375rem);
    min-height: var(--app-tabbar-height, 2.375rem);
    background: var(--app-tabbar-bg);
    border-bottom: 1px solid var(--ui-border);
    user-select: none;
    -webkit-app-region: drag;
}

.tab-strip {
    display: flex;
    flex: 1;
    align-items: stretch;
    min-width: 0;
}

.tab-list {
    display: flex;
    flex: 0 1 auto;
    align-items: stretch;
    overflow: auto hidden;
    min-width: 0;
    scrollbar-width: none;
    padding-left: var(--app-tab-list-start-padding);
}

.tab-list::-webkit-scrollbar {
    display: none;
}

.tab {
    display: flex;
    align-items: center;
    gap: var(--app-space-sm);
    padding: 0 calc(var(--app-tab-close-size, 1.25rem) + var(--app-space-3xl) + var(--app-space-sm)) 0 var(--app-space-9xl);
    min-width: 0;
    max-width: var(--app-tab-max-width);
    height: 100%;
    border: none;
    background: transparent;
    color: var(--ui-text-dimmed);
    font-size: var(--app-text-size-kicker);
    position: relative;
    touch-action: none;
    -webkit-app-region: no-drag;
    transition:
        color var(--app-transition-quick),
        background-color var(--app-transition-quick);
}

.tab:not(.is-active):hover {
    color: var(--ui-text);
    background: var(--app-tab-hover-bg);
}

.tab.is-active {
    color: var(--ui-text);
    background: var(--app-tab-active-bg);
    border-top-left-radius: var(--app-tab-active-radius);
    border-top-right-radius: var(--app-tab-active-radius);
    margin-bottom: var(--app-tab-active-overlap);
    z-index: var(--app-z-local-raised);
}

.tab + .tab::before {
    content: '';
    position: absolute;
    left: 0;
    top: 28%;
    bottom: 28%;
    width: var(--app-divider-width);
    background: var(--app-tab-divider);
    pointer-events: none;
    transition: opacity var(--app-transition-quick);
}

.tab.is-active::before,
.tab.is-active + .tab::before,
.tab:hover::before,
.tab:hover + .tab::before {
    opacity: 0;
}

.tab-label {
    overflow: hidden;
    padding-block: var(--app-space-2xs);
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    line-height: var(--app-line-height-body);
    min-width: 0;
}

.tab-close {
    position: absolute;
    right: var(--app-space-3xl);
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--app-tab-close-size, 1.25rem);
    height: var(--app-tab-close-size, 1.25rem);
    min-width: var(--app-tab-close-size, 1.25rem);
    border: none;
    border-radius: var(--app-radius-xs);
    background: transparent;
    color: var(--ui-text-dimmed);
    opacity: 0;
    transition:
        opacity var(--app-transition-fast),
        background-color var(--app-transition-fast);
}

.tab.is-dirty .tab-close {
    opacity: 1;
    color: var(--ui-text-muted);
}

.tab.is-dirty .tab-close :deep(svg),
.tab.is-dirty .tab-close :deep(.iconify) {
    display: none;
}

.tab.is-dirty .tab-close::before {
    content: '';
    display: block;
    width: var(--app-tab-dirty-dot-size, 0.4375rem);
    height: var(--app-tab-dirty-dot-size, 0.4375rem);
    flex: 0 0 var(--app-tab-dirty-dot-size, 0.4375rem);
    border-radius: 50%;
    background: currentcolor;
}

.tab.is-dirty .tab-close:hover:not(:disabled)::before {
    display: none;
}

.tab.is-dirty .tab-close:hover:not(:disabled) :deep(svg),
.tab.is-dirty .tab-close:hover:not(:disabled) :deep(.iconify) {
    display: inline;
}

.tab-close:disabled {
    opacity: 0.35;
}

.tab-close:focus-visible {
    opacity: 1;
    outline: 2px solid var(--app-toolbar-focus-ring);
    outline-offset: 2px;
}

.tab.is-dirty .tab-close:disabled {
    opacity: 1;
}

.tab:hover .tab-close:not(:disabled),
.tab-close.is-visible:not(:disabled) {
    opacity: 1;
}

/* stylelint-disable-next-line no-descending-specificity */
.tab-close:hover:not(:disabled) {
    opacity: 1;
    background: var(--app-chrome-subtle-hover);
    color: var(--ui-text);
}

.tab-new {
    display: flex;
    align-items: center;
    align-self: center;
    justify-content: center;
    flex: none;
    width: var(--app-tab-new-width, 3rem);
    min-width: var(--app-tab-new-width, 3rem);
    height: calc(var(--app-tabbar-height, 2.375rem) - (var(--app-tab-new-block-inset, 0.125rem) * 2));
    margin: var(--app-tab-new-block-inset, 0.125rem) 0.25rem;
    border: none;
    border-radius: var(--app-tab-new-radius, 0.75rem);
    background: transparent;
    color: var(--ui-text-dimmed);
    -webkit-app-region: no-drag;
    transition:
        background-color var(--app-transition-quick),
        color var(--app-transition-quick);
}

.tab-new:hover {
    background: var(--app-chrome-subtle-hover);
    color: var(--ui-text);
}

.tab-bar:has(.is-dragging) .tab-list {
    overflow: visible;
}

.tab.is-dragging {
    z-index: var(--app-z-local-sticky);
    opacity: 0.7;
}

.tab-context-menu-anchor {
    position: fixed;
    width: var(--app-divider-width);
    height: var(--app-hairline-height);
    padding: 0;
    border: 0;
    opacity: 0;
    pointer-events: none;
}
</style>
