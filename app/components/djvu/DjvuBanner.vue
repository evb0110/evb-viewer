<template>
    <div
        v-if="visible"
        class="djvu-banner"
    >
        <UIcon
            :name="isLoadingPages ? 'i-lucide-loader-circle' : 'i-lucide-info'"
            class="djvu-banner-icon"
            :class="{ 'is-spinning': isLoadingPages }"
        />
        <span class="djvu-banner-text">
            <template v-if="isLoadingPages">
                {{ t('djvu.loadingPages', {
                    current: loadingCurrent,
                    total: loadingTotal,
                }) }}
            </template>
            <template v-else>
                {{ t('djvu.bannerHint') }}
            </template>
        </span>
        <UButton
            v-if="!isLoadingPages"
            :label="t('djvu.convertToPdf')"
            variant="soft"
            color="primary"
            size="xs"
            @click="$emit('convert')"
        />
        <UButton
            icon="i-lucide-x"
            variant="ghost"
            color="neutral"
            size="xs"
            class="djvu-banner-close"
            @click="$emit('dismiss')"
        />
    </div>
</template>

<script setup lang="ts">
const { t } = useI18n();

defineProps<{
    visible: boolean;
    isLoadingPages?: boolean;
    loadingCurrent?: number;
    loadingTotal?: number;
}>();

defineEmits<{
    convert: [];
    dismiss: [];
}>();
</script>

<style scoped>
.djvu-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--ui-bg-elevated);
    border-bottom: 1px solid var(--ui-border);
    font-size: 13px;
}

.djvu-banner-icon {
    width: 16px;
    height: 16px;
    color: var(--ui-primary);
    flex-shrink: 0;
}

.djvu-banner-icon.is-spinning {
    animation: spin 1s linear infinite;
}

@keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}

.djvu-banner-text {
    flex: 1;
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
}

.djvu-banner-close {
    flex-shrink: 0;
}
</style>
