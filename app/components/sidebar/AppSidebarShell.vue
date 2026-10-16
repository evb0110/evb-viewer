<template>
    <aside ref="shellRef" class="app-sidebar-shell">
        <UTabs
            :model-value="modelValue"
            :items="displayTabs"
            :content="false"
            variant="link"
            color="primary"
            size="sm"
            :ui="tabsUi"
            class="shrink-0"
            @update:model-value="handleTabUpdate"
        >
            <template #leading="{ item }">
                <AppTooltip v-if="isCompact" :text="item.title" :delay-duration="300">
                    <UIcon :name="item.icon" class="size-[var(--app-icon-size-xs)] shrink-0" />
                </AppTooltip>
                <UIcon v-else :name="item.icon" class="size-[var(--app-icon-size-xs)] shrink-0" />
            </template>
        </UTabs>
        <div ref="tabFitProbeRef" class="app-sidebar-shell__tab-fit-probe" aria-hidden="true">
            <span v-for="item in tabs" :key="item.value">
                <UIcon :name="item.icon" />{{ item.title }}
            </span>
        </div>
        <div
            class="app-sidebar-shell__content app-scrollbar app-scroll-region--balanced app-panel-scroll"
            :class="{'app-sidebar-shell__content--no-outer-scroll': !outerScroll}"
        >
            <slot />
        </div>
    </aside>
</template>

<script setup lang="ts">
import { useResizeObserver } from '@vueuse/core';

interface IAppSidebarShellTab {
    value: string;
    label: string;
    title: string;
    icon: string;
}

const {
    modelValue,
    outerScroll = false,
    tabs,
} = defineProps<{
    modelValue: string;
    tabs: IAppSidebarShellTab[];
    outerScroll?: boolean | undefined;
}>();
const emit = defineEmits<{'update:model-value': [value: string];}>();
const shellRef = useTemplateRef<HTMLElement>('shellRef');
const tabFitProbeRef = useTemplateRef<HTMLElement>('tabFitProbeRef');
const isCompact = ref(true);
const displayTabs = computed(() => tabs.map(item => ({
    ...item,
    // Keep the localized label in the DOM when the compact layout hides it
    // visually. UTabs derives the tab's accessible name from this slot.
    label: item.label,
})));
const tabsUi = computed(() => ({
    root: 'gap-0',
    list: 'gap-1 px-[var(--app-sidebar-content-padding)] py-[var(--app-sidebar-row-padding-block)] mb-0 rounded-none bg-transparent border-b border-[var(--app-sidebar-border)]',
    indicator: 'hidden',
    trigger: `${isCompact.value ? 'flex-1 min-w-0' : 'flex-initial min-w-fit'} justify-center gap-[var(--app-sidebar-row-gap)] h-[var(--app-sidebar-action-size)] px-[var(--app-sidebar-row-padding-inline)] py-0 rounded-md border border-transparent text-[var(--app-sidebar-tab-font-size)] font-semibold whitespace-nowrap data-[state=active]:bg-[var(--app-control-active-bg)] data-[state=active]:border-[var(--app-control-active-border)] data-[state=active]:text-default data-[state=inactive]:text-muted data-[state=inactive]:hover:bg-[var(--app-sidebar-control-hover-bg)] data-[state=inactive]:hover:text-default`,
    label: isCompact.value ? 'sr-only' : 'overflow-visible whitespace-nowrap',
    leadingIcon: 'size-[var(--app-icon-size-xs)] shrink-0',
}));

function updateTabFitMode() {
    const shell = shellRef.value;
    const probe = tabFitProbeRef.value;
    if (!shell || !probe) {
        return;
    }
    isCompact.value = probe.scrollWidth > shell.clientWidth;
}

function handleTabUpdate(value: string | number) {
    emit('update:model-value', String(value));
}

useResizeObserver(shellRef, updateTabFitMode);
useResizeObserver(tabFitProbeRef, updateTabFitMode);
watch(() => tabs, async () => {
    await nextTick();
    updateTabFitMode();
}, {immediate: true});
</script>

<style scoped>
.app-sidebar-shell {
    position: relative;
    display: flex;
    flex: 1;
    height: 100%;
    min-width: 0;
    flex-direction: column;
    overflow: hidden;
    background: var(--app-sidebar-bg);
}

.app-sidebar-shell__content {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
}

.app-sidebar-shell__content > :deep(*) {
    width: 100%;
}

.app-sidebar-shell__content--no-outer-scroll {
    overflow: hidden;
    scrollbar-gutter: auto;
}

.app-sidebar-shell__tab-fit-probe {
    position: absolute;
    visibility: hidden;
    pointer-events: none;
    display: flex;
    gap: var(--app-sidebar-row-gap);
    width: max-content;
    font-size: var(--app-sidebar-tab-font-size);
    font-weight: var(--app-font-weight-semibold);
}

.app-sidebar-shell__tab-fit-probe span {
    display: inline-flex;
    align-items: center;
    gap: var(--app-sidebar-row-gap);
    padding-inline: var(--app-sidebar-row-padding-inline);
    white-space: nowrap;
}
</style>
