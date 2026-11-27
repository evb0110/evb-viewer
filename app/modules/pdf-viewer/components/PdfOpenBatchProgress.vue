<template>
    <div
        class="batch-progress"
        role="status"
        aria-live="polite"
    >
        <div class="batch-progress-status">
            <AppSpinner
                size="sm"
                tone="inherit"
            />
            <span>{{ t('emptyState.preparingBatch') }}</span>
        </div>
        <p class="batch-progress-detail">
            {{
                t('emptyState.preparingBatchProgress', {
                    processed: displayProcessedCount(progress.processed, progress.total),
                    total: progress.total,
                })
            }}
        </p>
        <AppProgressBar
            :value="progress.percent"
            class="mt-2"
        />
        <p
            v-if="batchEtaText"
            class="batch-progress-eta"
        >
            {{ t('emptyState.preparingBatchEta', {eta: batchEtaText}) }}
        </p>
    </div>
</template>

<script setup lang="ts">
import AppProgressBar from '@app/components/AppProgressBar.vue';
import AppSpinner from '@app/components/AppSpinner.vue';
import {displayProcessedCount, formatEtaDuration} from '@app/utils/progressFormatting';
import type {IPdfOpenBatchProgress} from '@app/modules/pdf-viewer/runtime/contracts/pdfOpenBatchProgress.types';

const {progress} = defineProps<{progress: IPdfOpenBatchProgress}>();

const {t} = useTypedI18n();
const batchEtaText = computed(() => formatEtaDuration(progress.estimatedRemainingMs));
</script>

<style scoped>
.batch-progress {
    width: min(100%, var(--app-content-width-md));
    margin: var(--app-empty-state-margin) auto;
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-2xl);
    background: var(--ui-bg-elevated);
    padding: var(--app-space-9xl) var(--app-space-12xl);
}

.batch-progress-status {
    display: flex;
    align-items: center;
    gap: var(--app-space-3xl);
    color: var(--ui-text);
    font-size: var(--app-text-size-body);
}

.batch-progress-detail,
.batch-progress-eta {
    margin: var(--app-space-3xl) 0 0;
    font-size: var(--app-text-size-kicker);
}

.batch-progress-detail {
    color: var(--ui-text-muted);
}

.batch-progress-eta {
    color: var(--ui-text-dimmed);
}
</style>
