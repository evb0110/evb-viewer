<template>
    <UProgress
        class="app-progress-bar"
        :class="`app-progress-bar--${variant}`"
        color="primary"
        :size="variant === 'edge' ? 'xs' : 'sm'"
        :max="100"
        :model-value="normalizedValue"
        :ui="progressUi"
    />
</template>

<script setup lang="ts">
import { clamp } from 'es-toolkit/math';

/**
 * `inline` sits inside a card, dialog or panel. `edge` runs along the top
 * edge of a surface as a hairline, under chrome that already has a border.
 */
type TAppProgressBarVariant = 'inline' | 'edge';

const {
    value = null,
    variant = 'inline',
} = defineProps<{
    value?: number | null;
    variant?: TAppProgressBarVariant;
}>();

const progressUi = {
    base: 'app-progress-bar__track',
    indicator: 'app-progress-bar__indicator duration-200',
} as const;

const normalizedValue = computed(() => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }
    return clamp(Math.round(value), 0, 100);
});
</script>

<style scoped>
.app-progress-bar :deep(.app-progress-bar__track) {
    background: var(--app-progress-track);
}

.app-progress-bar :deep(.app-progress-bar__indicator) {
    background: var(--app-progress-indicator);
}

.app-progress-bar--edge :deep(.app-progress-bar__track) {
    border-radius: 0;
    background: var(--app-progress-edge-track);
}

.app-progress-bar--edge :deep(.app-progress-bar__indicator) {
    border-radius: 0;
}

.app-progress-bar--edge :deep(.app-progress-bar__indicator[data-state='indeterminate']) {
    background: var(--app-progress-edge-sweep);
}
</style>
