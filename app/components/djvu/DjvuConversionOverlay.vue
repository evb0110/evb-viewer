<template>
    <div
        v-if="isConverting"
        class="djvu-overlay"
    >
        <div class="djvu-overlay-card">
            <UIcon
                name="i-lucide-loader-circle"
                class="djvu-overlay-spinner"
            />
            <div class="djvu-overlay-text">
                <span v-if="phase === 'converting'">{{ t('djvu.overlayConverting') }}</span>
                <span v-else-if="phase === 'bookmarks'">{{ t('djvu.overlayBookmarks') }}</span>
                <span v-else>{{ t('djvu.overlayPreparing') }}</span>
            </div>
            <div class="djvu-overlay-progress">
                <div
                    class="djvu-overlay-progress-bar"
                    :style="{ width: `${percent}%` }"
                />
            </div>
            <div class="djvu-overlay-percent">
                {{ percent }}%
            </div>
            <UButton
                :label="t('common.cancel')"
                variant="ghost"
                color="neutral"
                size="sm"
                @click="$emit('cancel')"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
const { t } = useI18n();

defineProps<{
    isConverting: boolean;
    phase: 'converting' | 'bookmarks' | null;
    percent: number;
}>();

defineEmits<{cancel: [];}>();
</script>

<style scoped>
.djvu-overlay {
    position: absolute;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--ui-bg-elevated);
}

.djvu-overlay-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 32px 48px;
    border-radius: 12px;
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    box-shadow: var(--ui-shadow-lg);
}

.djvu-overlay-spinner {
    width: 32px;
    height: 32px;
    color: var(--ui-primary);
    animation: spin 1s linear infinite;
}

@keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}

.djvu-overlay-text {
    font-size: 14px;
    color: var(--ui-text);
    font-weight: 500;
}

.djvu-overlay-progress {
    width: 240px;
    height: 4px;
    background: var(--ui-border);
    border-radius: 2px;
    overflow: hidden;
}

.djvu-overlay-progress-bar {
    height: 100%;
    background: var(--ui-primary);
    border-radius: 2px;
    transition: width 0.3s ease;
}

.djvu-overlay-percent {
    font-size: 12px;
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
}
</style>
