<template>
    <div v-if="hasDocument" class="page-op-progress-reserved-row">
        <AppProgressOverlay
            class="workspace-page-op-progress-overlay"
            :open="showProgress"
            :title="operationTitle"
            :detail="detailText"
            :sub-detail="subDetailText"
            :value="progress?.percent ?? null"
            :show-indeterminate-bar="false"
            :cancel-label="cancelLabel"
            :cancel-disabled="cancelState !== 'idle'"
            @cancel="requestCancel"
        />
    </div>
</template>

<script setup lang="ts">
import {
    useIntervalFn,
    useTimeoutFn,
} from '@vueuse/core';
import AppProgressOverlay from '@app/components/AppProgressOverlay.vue';
import {
    displayProcessedCount,
    formatEtaDuration,
} from '@app/utils/progressFormatting';
import type { IPageOperationPresentation } from '@app/modules/workspace-shell/composables/usePageOpsHandlers';
import type { TPageOperationCancelState } from '@app/modules/pdf-viewer/public';

const {
    progress,
    etaText,
    hasDocument,
    isPageOperationInProgress,
    operation,
    canCancel,
    cancelState,
    lastOutcomeStatus,
} = defineProps<{
    progress: {
        processed: number;
        total: number;
        percent: number;
    } | null;
    etaText: string | null;
    hasDocument: boolean;
    isPageOperationInProgress: boolean;
    operation: IPageOperationPresentation | null;
    canCancel: boolean;
    cancelState: TPageOperationCancelState;
    lastOutcomeStatus: string | null;
}>();

const emit = defineEmits<{cancel: [];}>();

const { t } = useTypedI18n();
const toast = useToast();

const cancelLabel = computed(() => {
    if (!canCancel) {
        return '';
    }
    switch (cancelState) {
        case 'canceling':
            return t('pageOps.canceling');
        case 'finishing':
            return t('pageOps.finishing');
        case 'idle':
            return t('common.cancel');
    }
});

let userRequestedCancel = false;
function requestCancel() {
    userRequestedCancel = true;
    emit('cancel');
}

const delayedProgressVisible = ref(false);
const {
    start: startProgressDelay,
    stop: stopProgressDelay,
} = useTimeoutFn(() => {
    delayedProgressVisible.value = true;
}, 400, {immediate: false});

const showProgress = computed(() => isPageOperationInProgress && delayedProgressVisible.value);
function resolveOperationTitle(activeOperation: IPageOperationPresentation) {
    const operationLabel = (() => {
        switch (activeOperation.kind) {
            case 'delete':
                return t('pageOps.deletePages');
            case 'extract':
                return t('pageOps.extractPages');
            case 'insert':
            case 'insertFile':
                return t('pageOps.insertAfter');
            case 'reorder':
            case 'move':
                return t('pageOps.movePages');
            case 'rotate':
                return activeOperation.direction === 'ccw'
                    ? t('pageOps.rotateCcw')
                    : t('pageOps.rotateCw');
            case 'crop':
                return t('crop.dialogTitle');
            case 'removeCrop':
                return t('crop.removeCrop');
        }
    })();
    const operationCountLabel = activeOperation.kind === 'insertFile'
        ? t('combinePdf.fileCount', activeOperation.pageCount)
        : t('export.pageCount', activeOperation.pageCount);
    return `${operationLabel} · ${operationCountLabel}`;
}
const operationTitle = computed(() => {
    if (!operation) {
        return t('pageOps.operationInProgress');
    }
    return resolveOperationTitle(operation);
});

// Without a measurable count the panel shows an elapsed clock, so long work
// keeps visibly moving (behavior contract I4).
const operationStartedAt = ref<number | null>(null);
const now = ref(Date.now());
const {
    pause: pauseElapsedClock,
    resume: resumeElapsedClock,
} = useIntervalFn(() => {
    now.value = Date.now();
}, 1_000, {immediate: false});
const elapsedText = computed(() => (
    operationStartedAt.value === null
        ? null
        : formatEtaDuration(now.value - operationStartedAt.value)
));

watch(() => isPageOperationInProgress, (inProgress) => {
    stopProgressDelay();
    delayedProgressVisible.value = false;
    if (inProgress) {
        userRequestedCancel = false;
        operationStartedAt.value = Date.now();
        now.value = operationStartedAt.value;
        resumeElapsedClock();
        startProgressDelay();
        return;
    }
    pauseElapsedClock();
    operationStartedAt.value = null;
    if (userRequestedCancel && lastOutcomeStatus === 'canceled') {
        toast.add({
            color: 'neutral',
            title: t('pageOps.canceled'),
        });
    }
    userRequestedCancel = false;
}, {immediate: true});

onBeforeUnmount(() => {
    stopProgressDelay();
    pauseElapsedClock();
});

const detailText = computed(() => {
    if (!progress) {
        return '';
    }
    return t('emptyState.preparingBatchProgress', {
        processed: displayProcessedCount(progress.processed, progress.total),
        total: progress.total,
    });
});

const subDetailText = computed(() => {
    if (etaText) {
        return t('emptyState.preparingBatchEta', { eta: etaText });
    }
    return !progress && elapsedText.value
        ? t('pageOps.elapsed', {time: elapsedText.value})
        : '';
});
</script>

<style scoped>
.page-op-progress-reserved-row {
    display: flex;
    flex: 0 0 var(--app-toolbar-row-height);
    align-items: center;
    justify-content: flex-end;
    box-sizing: border-box;
    padding-inline: var(--app-space-md) calc(var(--app-toolbar-control-size) + var(--app-space-9xl) + (2 * var(--app-space-3xl)) + var(--app-space-md));
}

:global(.workspace-page-op-progress-overlay.app-progress-overlay) {
    position: static;
    inset: auto;
    z-index: auto;
    display: flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: flex-end;
    pointer-events: none;
    background: transparent;
}

:global(.workspace-page-op-progress-overlay .app-progress-overlay-card) {
    flex-direction: row;
    gap: var(--app-space-md);
    width: auto;
    max-width: 100%;
    padding: var(--app-space-xs) var(--app-space-md);
    pointer-events: none;
}

:global(.workspace-page-op-progress-overlay .app-progress-overlay-title) {
    white-space: nowrap;
}

:global(.workspace-page-op-progress-overlay .app-progress-overlay-cancel) {
    pointer-events: auto;
}

:global(.workspace-page-op-progress-overlay .app-progress-overlay-bar) {
    width: var(--app-progress-bar-width);
}
</style>
