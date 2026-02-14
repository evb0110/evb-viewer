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
</template>

<script setup lang="ts">
import type { ITab } from '@app/types/tabs';
import { useTabDragReorder } from '@app/composables/useTabDragReorder';

const { t } = useI18n();

const props = defineProps<{
    tabs: ITab[];
    activeTabId: string | null;
}>();

const emit = defineEmits<{
    activate: [id: string];
    close: [id: string];
    'new-tab': [];
    reorder: [fromIndex: number, toIndex: number];
}>();

const tabBarRef = useTemplateRef<HTMLElement>('tabBarRef');

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
);

function handleTabClick(tabId: string) {
    if (shouldSuppressClick()) {
        return;
    }
    emit('activate', tabId);
}

function handleAuxClick(event: MouseEvent, tabId: string) {
    if (event.button === 1) {
        emit('close', tabId);
    }
}
</script>

<style scoped>
.tab-bar {
    display: flex;
    align-items: stretch;
    height: 36px;
    min-height: 36px;
    background: var(--app-chrome);
    border-bottom: 1px solid var(--ui-border);
    user-select: none;
    -webkit-app-region: drag;
}

.tab-list {
    display: flex;
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
</style>
