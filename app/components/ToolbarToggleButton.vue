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
            <Icon :name="icon" />
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
    color: var(--ui-text);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease, box-shadow 0.1s ease;
}

.toolbar-toggle.is-grouped {
    color: var(--ui-text-dimmed);
    border-radius: 0;
    min-width: var(--toolbar-control-height);
    width: auto;
}

.toolbar-toggle:hover {
    background: var(--app-toolbar-control-hover-bg);
    color: var(--ui-text);
}

.toolbar-toggle.is-active {
    background: var(--app-toolbar-control-active-bg);
    color: var(--ui-text);
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
    opacity: 0.5;
    cursor: not-allowed;
}

.toolbar-toggle:disabled:hover {
    background: transparent;
    color: var(--ui-text-dimmed);
}

.toolbar-toggle :deep(svg) {
    width: 1.1rem;
    height: 1.1rem;
}
</style>
