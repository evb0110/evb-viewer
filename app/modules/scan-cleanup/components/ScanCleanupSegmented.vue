<template>
    <div
        ref="group"
        class="scan-cleanup-segmented"
        role="radiogroup"
        :aria-label="groupLabel"
    >
        <button
            v-for="(item, index) in items"
            :key="item.value"
            type="button"
            class="scan-cleanup-segmented-option"
            :class="{'is-selected': item.value === modelValue}"
            role="radio"
            :aria-label="item.ariaLabel ?? item.label"
            :aria-checked="item.value === modelValue"
            :disabled="disabled"
            :tabindex="item.value === modelValue || !hasSelectedItem && index === 0 ? 0 : -1"
            @click="select(item.value)"
            @keydown="handleKeydown($event, index)"
        >
            {{ item.label }}
        </button>
    </div>
</template>

<script setup lang="ts">
interface IScanCleanupSegmentedItem {
    ariaLabel?: string;
    label: string;
    value: string;
}

const props = defineProps<{
    disabled?: boolean;
    groupLabel: string;
    items: readonly IScanCleanupSegmentedItem[];
    modelValue: string;
}>();

const emit = defineEmits<{'update:modelValue': [value: string];}>();
const group = ref<HTMLElement | null>(null);
const hasSelectedItem = computed(() => props.items.some(item => item.value === props.modelValue));

function select(value: string) {
    if (props.disabled) {
        return;
    }
    emit('update:modelValue', value);
}

function focusOption(index: number) {
    const count = props.items.length;
    if (count === 0) {
        return;
    }
    const boundedIndex = (index + count) % count;
    const item = props.items[boundedIndex];
    if (!item) {
        return;
    }
    select(item.value);
    void nextTick(() => group.value?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[boundedIndex]?.focus());
}

function handleKeydown(event: KeyboardEvent, index: number) {
    if (props.disabled) {
        return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        focusOption(index - 1);
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        focusOption(index + 1);
    } else if (event.key === 'Home') {
        event.preventDefault();
        focusOption(0);
    } else if (event.key === 'End') {
        event.preventDefault();
        focusOption(props.items.length - 1);
    }
}
</script>

<style scoped>
/* Options share one row while they fit and wrap rather than clip, so every
   choice stays visible in a narrow rail or a longer language. */
.scan-cleanup-segmented {
    display: flex;
    flex-wrap: wrap;
    gap: var(--app-space-3xs);
    border: var(--app-hairline-height) solid var(--ui-border);
    border-radius: var(--app-radius-md);
    background: var(--ui-bg-muted);
    padding: var(--app-space-xs);
}

.scan-cleanup-segmented-option {
    min-width: 0;
    flex: 1 0 auto;
    border: 0;
    border-radius: var(--app-radius-sm);
    background: transparent;
    padding: var(--app-space-sm) var(--app-space-3xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body-sm);
    font-weight: var(--app-font-weight-semibold);
    white-space: nowrap;
    cursor: pointer;
    transition:
        background-color var(--app-transition-fast),
        box-shadow var(--app-transition-fast),
        color var(--app-transition-fast);
}

.scan-cleanup-segmented-option:hover:not(:disabled) {
    background: var(--app-toolbar-control-hover-bg);
    color: var(--ui-text);
}

/* Selected reads like every other selected control in the app (toolbar buttons,
   sidebar tabs): the elevated surface plus the active border, default ink. */
.scan-cleanup-segmented-option.is-selected {
    background: var(--app-control-active-bg);
    box-shadow: inset 0 0 0 var(--app-hairline-height) var(--app-control-active-border);
    color: var(--ui-text);
}

.scan-cleanup-segmented-option.is-selected:hover:not(:disabled) {
    background: var(--app-control-active-hover-bg);
    box-shadow: inset 0 0 0 var(--app-hairline-height) var(--app-control-active-hover-border);
    color: var(--ui-text);
}

.scan-cleanup-segmented-option:focus-visible {
    outline: var(--app-hairline-height) solid var(--ui-primary);
    outline-offset: calc(-1 * var(--app-hairline-height));
}

.scan-cleanup-segmented-option:disabled {
    cursor: not-allowed;
    opacity: var(--app-scan-disabled-opacity);
}
</style>
