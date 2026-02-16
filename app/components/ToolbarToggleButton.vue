<template>
    <UTooltip :text="tooltip" :delay-duration="1200">
        <button
            class="toolbar-toggle"
            :class="{ 'is-grouped': grouped, 'is-active': active }"
            :disabled="disabled"
            :aria-label="tooltip"
            :aria-pressed="active"
            @click="emit('click')"
        >
            <Icon :name="icon" class="size-5" />
        </button>
    </UTooltip>
</template>

<script setup lang="ts">
defineProps<{
    icon: string;
    active: boolean;
    tooltip: string;
    disabled?: boolean;
    grouped?: boolean;
}>();

const emit = defineEmits<{click: [];}>();
</script>

<style scoped>
.toolbar-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--toolbar-control-height);
    height: var(--toolbar-control-height);
    padding: 0.25rem;
    border: 1px solid transparent;
    border-radius: 3px;
    background: transparent;
    color: var(--app-toolbar-control-inactive-fg);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease, box-shadow 0.1s ease, opacity 0.1s ease;
}

.toolbar-toggle.is-grouped {
    border-radius: 0;
    min-width: var(--toolbar-control-height);
    width: auto;
}

.toolbar-toggle:hover {
    background: var(--app-toolbar-control-hover-bg);
    color: var(--app-toolbar-control-hover-fg);
}

.toolbar-toggle.is-active {
    background: var(--app-toolbar-control-active-bg);
    color: var(--app-toolbar-control-hover-fg);
}

.toolbar-toggle.is-active:hover {
    background: var(--app-toolbar-control-active-hover-bg);
}

.toolbar-toggle:focus {
    outline: none;
}

.toolbar-toggle:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
    position: relative;
    z-index: 1;
}

.toolbar-toggle:disabled {
    opacity: var(--app-toolbar-control-disabled-opacity);
    color: var(--app-toolbar-control-disabled-fg);
    cursor: not-allowed;
}

.toolbar-toggle:disabled:hover {
    background: transparent;
    color: var(--app-toolbar-control-disabled-fg);
}

.toolbar-toggle :deep(svg) {
    width: 1.25rem;
    height: 1.25rem;
}
</style>
