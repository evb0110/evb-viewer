<template>
    <UTooltip :text="tooltip" :delay-duration="1200">
        <button
            class="toolbar-btn"
            :class="{
                'is-toggle': active != null,
                'is-active': active,
                'is-grouped': grouped,
                'is-loading': loading,
            }"
            :disabled="disabled || loading"
            :aria-label="tooltip"
            :aria-pressed="active"
            @click="emit('click')"
        >
            <Icon v-if="!loading" :name="icon" :class="iconClass" />
            <Icon v-else name="lucide:loader-2" :class="[iconClass, 'animate-spin']" />
        </button>
    </UTooltip>
</template>

<script setup lang="ts">
const {
    icon,
    tooltip,
    active = undefined,
    disabled = false,
    loading = false,
    grouped = false,
    iconClass = 'size-5',
} = defineProps<{
    icon: string;
    tooltip: string;
    active?: boolean;
    disabled?: boolean;
    loading?: boolean;
    grouped?: boolean;
    iconClass?: string;
}>();

const emit = defineEmits<{ click: [] }>();
</script>

<style scoped>
.toolbar-btn {
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
    transition: background-color 0.1s ease, color 0.1s ease, box-shadow 0.1s ease, opacity 0.1s ease;
}

.toolbar-btn.is-toggle {
    color: var(--app-toolbar-control-inactive-fg);
}

.toolbar-btn.is-grouped {
    border-radius: 0;
}

.toolbar-btn:hover {
    background: var(--app-toolbar-control-hover-bg);
    color: var(--ui-text);
}

.toolbar-btn.is-toggle:hover {
    color: var(--app-toolbar-control-hover-fg);
}

.toolbar-btn.is-active {
    background: var(--app-toolbar-control-active-bg);
    color: var(--app-toolbar-control-hover-fg);
}

.toolbar-btn.is-active:hover {
    background: var(--app-toolbar-control-active-hover-bg);
}

.toolbar-btn:focus {
    outline: none;
}

.toolbar-btn:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
    position: relative;
    z-index: 1;
}

.toolbar-btn:disabled {
    opacity: var(--app-toolbar-control-disabled-opacity);
    color: var(--app-toolbar-control-disabled-fg);
    cursor: not-allowed;
}

.toolbar-btn:disabled:hover {
    background: transparent;
    color: var(--app-toolbar-control-disabled-fg);
}

.toolbar-btn:disabled.is-loading {
    opacity: 1;
    color: var(--ui-text-muted);
    cursor: wait;
}
</style>
