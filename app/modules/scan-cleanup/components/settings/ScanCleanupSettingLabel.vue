<template>
    <div class="scan-cleanup-setting-label">
        <span class="scan-cleanup-setting-label-text">
            <span>{{ label }}</span>
            <span
                v-if="overridden"
                class="scan-cleanup-setting-label-dot"
                role="img"
                :data-override-marker="control"
                :aria-label="t('scanCleanup.settings.override')"
            />
        </span>
        <span class="scan-cleanup-setting-label-affordances">
            <span v-if="mixed" class="scan-cleanup-setting-label-mixed">{{ t('scanCleanup.settings.mixed') }}</span>
            <slot />
            <AppTooltip v-if="overridden" :text="t('scanCleanup.settings.resetToDocument')" usefulness="always">
                <UButton
                    type="button"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    square
                    icon="i-ph-arrow-u-up-left"
                    :data-reset-override="control"
                    :aria-label="t('scanCleanup.settings.resetToDocument')"
                    @click="$emit('reset')"
                />
            </AppTooltip>
        </span>
    </div>
</template>

<script setup lang="ts">
defineProps<{
    control?: string;
    label: string;
    mixed?: boolean;
    overridden?: boolean;
}>();
defineEmits<{reset: []}>();
const {t} = useTypedI18n();
</script>

<style scoped>
.scan-cleanup-setting-label {
    display: flex;
    min-width: 0;
    min-height: var(--app-control-height-xs);
    align-items: center;
    justify-content: space-between;
    gap: var(--app-space-sm);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    font-weight: var(--app-font-weight-medium);
}

.scan-cleanup-setting-label-text,
.scan-cleanup-setting-label-affordances {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: var(--app-space-sm);
}

.scan-cleanup-setting-label-affordances {
    flex: none;
}

.scan-cleanup-setting-label-dot {
    width: var(--app-space-3xl);
    height: var(--app-space-3xl);
    flex: none;
    border-radius: var(--app-radius-full);
    background: var(--ui-primary);
}

.scan-cleanup-setting-label-mixed {
    color: var(--ui-text-dimmed);
}
</style>
