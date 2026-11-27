<template>
    <div
        v-if="visible"
        :class="containerClass"
        role="status"
        aria-live="polite"
    >
        <div class="flex items-center gap-2">
            <UIcon
                v-if="state === 'success'"
                name="i-ph-check-circle"
                class="app-progress-chip-success-icon size-4"
                aria-hidden="true"
            />
            <AppSpinner
                v-else
                size="sm"
                tone="muted"
            />
            <div class="min-w-0 flex-1">
                <p class="m-0 text-xs font-medium text-default">
                    {{ title }}
                </p>
                <p
                    v-if="detail"
                    class="app-progress-chip-detail m-0 text-muted"
                >
                    {{ detail }}
                </p>
                <p
                    v-if="subDetail"
                    class="app-progress-chip-detail m-0 text-dimmed"
                >
                    {{ subDetail }}
                </p>
            </div>
        </div>
        <AppProgressBar
            :value="progressValue"
            class="mt-2"
        />
    </div>
</template>

<script setup lang="ts">
import AppSpinner from '@app/components/AppSpinner.vue';
import AppProgressBar from '@app/components/AppProgressBar.vue';

type TProgressChipState = 'running' | 'success';
type TProgressChipOffset = 'low' | 'high';

interface IAppProgressChipProps {
    visible?: boolean;
    title: string;
    detail?: string;
    subDetail?: string;
    value?: number | null;
    state?: TProgressChipState;
    offsetBottom?: TProgressChipOffset;
}

const {
    visible = true,
    detail = '',
    subDetail = '',
    value = null,
    state = 'running',
    offsetBottom = 'low',
} = defineProps<IAppProgressChipProps>();

const progressValue = computed(() => {
    if (state === 'success') {
        return 100;
    }
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
});

const containerClass = computed(() => {
    const offsetClass = offsetBottom === 'high' ? 'app-progress-chip--offset-high' : 'app-progress-chip--offset-low';
    return [
        'app-progress-chip pointer-events-none absolute',
        'rounded-md border border-default bg-default/95 px-3 py-2 shadow-lg',
        offsetClass,
    ].join(' ');
});
</script>

<style scoped>
.app-progress-chip {
    z-index: var(--app-z-progress);
    inset-inline-end: var(--app-space-12xl);
    inline-size: var(--app-progress-bar-width);
    max-inline-size: calc(100% - (2 * var(--app-space-12xl)));
    box-sizing: border-box;
}

.app-progress-chip--offset-low {
    inset-block-end: var(--app-progress-chip-offset-low);
}

.app-progress-chip--offset-high {
    inset-block-end: var(--app-progress-chip-offset-high);
}

.app-progress-chip-success-icon {
    color: var(--ui-success);
}

.app-progress-chip-detail {
    font-size: var(--app-text-size-micro);
}
</style>
