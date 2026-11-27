<template>
    <aside
        ref="shellRef"
        class="app-sidebar-shell"
        :style="shellStyle"
    >
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
            <template #leading="{item}">
                <AppTooltip
                    v-if="isCompact"
                    :text="item.title"
                    :delay-duration="300"
                >
                    <UIcon
                        :name="item.icon"
                        class="size-[var(--app-icon-size-xs)] shrink-0"
                    />
                </AppTooltip>
                <UIcon
                    v-else
                    :name="item.icon"
                    class="size-[var(--app-icon-size-xs)] shrink-0"
                />
            </template>
        </UTabs>
        <div
            ref="tabFitProbeRef"
            class="app-sidebar-shell__tab-fit-probe"
            aria-hidden="true"
        >
            <span
                v-for="item in tabs"
                :key="item.value"
            >
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
import {useResizeObserver} from '@vueuse/core';

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
    widthPx = undefined,
} = defineProps<{
    modelValue: string;
    tabs: IAppSidebarShellTab[];
    outerScroll?: boolean | undefined;
    widthPx?: number | undefined;
}>();
const emit = defineEmits<{'update:model-value': [value: string]}>();
const shellRef = useTemplateRef<HTMLElement>('shellRef');
const tabFitProbeRef = useTemplateRef<HTMLElement>('tabFitProbeRef');
const isCompact = ref(true);
const shellStyle = computed(() => (widthPx === undefined ? undefined : {width: `${widthPx}px`}));
const displayTabs = computed(() =>
    tabs.map((item) => ({
        ...item,
        // Keep the localized label in the DOM when the compact layout hides it
        // visually. UTabs derives the tab's accessible name from this slot.
        label: item.label,
    })),
);
const tabsUi = computed(() => ({
    root: 'app-sidebar-shell__tabs',
    list: 'app-sidebar-shell__tabs-list',
    indicator: 'hidden',
    trigger: isCompact.value ? 'app-sidebar-shell__tabs-trigger is-compact' : 'app-sidebar-shell__tabs-trigger',
    label: isCompact.value ? 'sr-only' : 'app-sidebar-shell__tabs-label',
    leadingIcon: 'app-sidebar-shell__tabs-icon',
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
watch(
    () => tabs,
    async () => {
        await nextTick();
        updateTabFitMode();
    },
    {immediate: true},
);
</script>

<style lang="scss" scoped>
.app-sidebar-shell {
    position: relative;
    display: flex;
    flex: 1;
    height: 100%;
    min-width: 0;
    max-width: 100%;
    flex-direction: column;
    overflow: hidden;
    background: var(--app-sidebar-bg);
}

:deep(.app-sidebar-shell__tabs) {
    gap: 0;
}

:deep(.app-sidebar-shell__tabs-list) {
    gap: var(--app-space-sm);
    padding: var(--app-sidebar-row-padding-block) var(--app-sidebar-content-padding);
    margin-bottom: 0;
    border-radius: 0;
    background: transparent;
    border-bottom: var(--app-hairline-height) solid var(--app-sidebar-border);
}

:deep(.app-sidebar-shell__tabs-trigger) {
    flex: 0 1 auto;
    min-width: fit-content;
    justify-content: center;
    gap: var(--app-sidebar-row-gap);
    height: var(--app-sidebar-action-size);
    padding: 0 var(--app-sidebar-row-padding-inline);
    border: 1px solid transparent;
    border-radius: var(--app-radius-md);
    font-size: var(--app-sidebar-tab-font-size);
    font-weight: var(--app-font-weight-semibold);
    white-space: nowrap;
}

:deep(.app-sidebar-shell__tabs-trigger.is-compact) {
    flex: 1 1 0%;
    min-width: 0;
}

:deep(.app-sidebar-shell__tabs-trigger[data-state='active']) {
    background: var(--app-control-active-bg);
    border-color: var(--app-control-active-border);
    color: var(--ui-text);
}

:deep(.app-sidebar-shell__tabs-trigger[data-state='inactive']) {
    color: var(--ui-text-muted);
}

:deep(.app-sidebar-shell__tabs-trigger[data-state='inactive']:hover) {
    background: var(--app-sidebar-control-hover-bg);
    color: var(--ui-text);
}

:deep(.app-sidebar-shell__tabs-label) {
    overflow: visible;
    white-space: nowrap;
}

:deep(.app-sidebar-shell__tabs-icon) {
    width: var(--app-icon-size-xs);
    height: var(--app-icon-size-xs);
    flex-shrink: 0;
}

.app-sidebar-shell__content {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
}

.app-sidebar-shell__content > :slotted(*) {
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
