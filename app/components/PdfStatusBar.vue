<template>
    <footer class="status-bar">
        <div class="status-bar-path" :title="filePath">
            {{ filePath }}
        </div>
        <div class="status-bar-metrics">
            <span class="status-bar-item">{{ fileSizeLabel }}</span>
            <span class="status-bar-item">{{ zoomLabel }}</span>
            <UTooltip :text="saveDotTooltip" :delay-duration="800">
                <button
                    type="button"
                    class="status-save-dot-button"
                    :class="[saveDotClass, { 'is-actionable': canSave }]"
                    :disabled="!canSave"
                    :aria-label="saveDotAriaLabel"
                    @click="emit('save')"
                >
                    <span class="status-save-dot" />
                </button>
            </UTooltip>
        </div>
    </footer>
</template>

<script setup lang="ts">
defineProps<{
    filePath: string;
    fileSizeLabel: string;
    zoomLabel: string;
    saveDotClass: string;
    saveDotTooltip: string;
    saveDotAriaLabel: string;
    canSave: boolean;
}>();

const emit = defineEmits<{save: [];}>();
</script>

<style scoped>
.status-bar {
    min-height: 1.9rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.3rem 0.75rem;
    border-top: 1px solid var(--ui-border);
    background: color-mix(in oklab, var(--ui-bg) 95%, var(--ui-bg-elevated) 5%);
    color: var(--ui-text-dimmed);
    font-size: 0.74rem;
    line-height: 1.2;
    transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.status-bar-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: 0.01em;
}

.status-bar-metrics {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.875rem;
}

.status-bar-metrics > * + * {
    position: relative;
}

.status-bar-metrics > * + *::before {
    content: "";
    position: absolute;
    left: -0.5rem;
    top: 50%;
    width: 1px;
    height: 0.76rem;
    transform: translateY(-50%);
    background: color-mix(in oklab, var(--ui-border) 86%, transparent 14%);
}

.status-bar-item {
    white-space: nowrap;
}

.status-save-dot-button {
    width: 1.1rem;
    height: 1.1rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    padding: 0;
    border-radius: 999px;
    cursor: default;
}

.status-save-dot-button.is-actionable {
    cursor: pointer;
}

.status-save-dot {
    width: 0.56rem;
    height: 0.56rem;
    border-radius: 999px;
    background: color-mix(in oklab, var(--ui-text-dimmed) 72%, var(--ui-bg) 28%);
    box-shadow: 0 0 0 1px color-mix(in oklab, var(--ui-bg) 36%, #a1a1aa 64%);
    transition: transform 0.14s ease, background-color 0.14s ease, box-shadow 0.14s ease;
}

.status-save-dot-button.is-dirty .status-save-dot {
    background: #f59e0b;
    box-shadow: 0 0 0 1px color-mix(in oklab, #f59e0b 55%, #78350f 45%);
}

.status-save-dot-button.is-clean .status-save-dot {
    background: #16a34a;
    box-shadow: 0 0 0 1px color-mix(in oklab, #16a34a 58%, #14532d 42%);
}

.status-save-dot-button.is-saving .status-save-dot {
    background: #2563eb;
    box-shadow: 0 0 0 1px color-mix(in oklab, #2563eb 58%, #1e3a8a 42%);
    animation: status-save-dot-pulse 1s ease-in-out infinite;
}

.status-save-dot-button.is-actionable:hover .status-save-dot {
    transform: scale(1.15);
}

@keyframes status-save-dot-pulse {
    0%,
    100% {
        transform: scale(1);
        opacity: 1;
    }

    50% {
        transform: scale(1.15);
        opacity: 0.72;
    }
}
</style>
