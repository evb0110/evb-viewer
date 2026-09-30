<template>
    <AppProgressOverlay
        :open="isConverting"
        :title="overlayTitle"
        :value="percent"
        :sub-detail="stageClock"
        :modal="modal"
        :cancel-label="t('common.cancel')"
        @cancel="emit('cancel')"
    />
</template>

<script setup lang="ts">
import AppProgressOverlay from '@app/components/AppProgressOverlay.vue';
import { useStageElapsedClock } from '@app/composables/useStageElapsedClock';

const { t } = useTypedI18n();

// Modal only in the pane in use; a visible inactive pane shows its progress
// without taking focus or keys from the rest of the window.
const {
    isConverting,
    modal,
    percent,
    phase,
} = defineProps<{
    isConverting: boolean;
    modal: boolean;
    phase: 'converting' | 'bookmarks' | 'optimizing' | null;
    percent: number;
}>();

const emit = defineEmits<{cancel: [];}>();

// Bookmarks and the interaction pass have no page count; their elapsed time
// keeps the overlay moving on a long book.
const stageClock = useStageElapsedClock(
    () => (isConverting ? phase ?? 'preparing' : null),
    new Set([
        'preparing',
        'bookmarks',
        'optimizing',
    ] as const),
);

const overlayTitle = computed(() => {
    if (phase === 'converting') {
        return t('djvu.overlayConverting');
    }
    if (phase === 'bookmarks') {
        return t('djvu.overlayBookmarks');
    }
    if (phase === 'optimizing') {
        return t('djvu.overlayOptimizing');
    }
    return t('djvu.overlayPreparing');
});
</script>
