<template>
    <AppProgressChip
        :visible="overlay !== null"
        :title="title"
        :detail="detail"
        :sub-detail="subDetail"
        :value="overlay?.progressPercent ?? null"
        :state="overlay?.state ?? 'running'"
        offset-bottom="low"
    />
</template>

<script setup lang="ts">
import { clamp } from 'es-toolkit/math';
import AppProgressChip from '@app/components/AppProgressChip.vue';
import { useDocumentContext } from '@app/modules/workspace-shell/documentContext';

const { exportOverlay: overlay } = useDocumentContext().exportWorkflow;

const { t } = useTypedI18n();

const title = computed(() => {
    const current = overlay.value;
    if (!current) {
        return '';
    }
    if (current.state === 'success') {
        return current.kind === 'images' ? t('export.successImages') : t('export.successTiff');
    }
    return current.kind === 'images' ? t('export.statusImages') : t('export.statusTiff');
});
const detail = computed(() => overlay.value
    ? t('export.pageCount', {count: overlay.value.pageCount})
    : '');
const subDetail = computed(() => {
    const current = overlay.value;
    if (!current || current.state !== 'running' || typeof current.progressPercent !== 'number') {
        return '';
    }
    return `${clamp(Math.round(current.progressPercent), 0, 100)}%`;
});
</script>
