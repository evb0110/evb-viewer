<template>
    <div
        class="scan-cleanup-auto-value-row"
        :class="{'is-disabled': disabled}"
    >
        <div class="scan-cleanup-auto-value-header">
            <span>{{ label }}</span>
            <span
                v-if="state === 'auto'"
                class="scan-cleanup-auto-value-state is-auto"
                data-auto-value-state="auto"
            >
                {{ t('scanCleanup.settings.automatic') }}
            </span>
            <span
                v-else
                class="scan-cleanup-auto-value-state"
                :class="{'is-mixed': state === 'mixed'}"
                :data-auto-value-state="state"
            >
                <span>{{ state === 'mixed' ? mixedLabel : valueText ?? t('scanCleanup.settings.manual') }}</span>
                <AppTooltip
                    v-if="state === 'manual'"
                    :text="t('scanCleanup.settings.returnToAutomatic')"
                    usefulness="always"
                >
                    <button
                        type="button"
                        class="scan-cleanup-auto-value-reset"
                        :aria-label="t('scanCleanup.settings.returnToAutomatic')"
                        :disabled="disabled"
                        @click="$emit('reset')"
                    >
                        <UIcon name="i-ph-x" aria-hidden="true" />
                    </button>
                </AppTooltip>
            </span>
        </div>
        <div v-if="$slots.entry" class="scan-cleanup-auto-value-entry">
            <slot name="entry" />
        </div>
        <p v-if="reserveHint || hint" class="scan-cleanup-auto-value-hint">{{ hint }}&nbsp;</p>
    </div>
</template>

<script setup lang="ts">
defineProps<{
    disabled?: boolean;
    hint?: string | undefined;
    label: string;
    // Rows whose hint arrives asynchronously (detection results) keep the line
    // reserved, so the surrounding settings never move when it appears.
    reserveHint?: boolean;
    state: 'auto' | 'manual' | 'mixed';
    valueText?: string | undefined;
}>();
defineEmits<{reset: []}>();
const {t} = useTypedI18n();
const mixedLabel = computed(() => t('scanCleanup.settings.mixed').replace(/^—\s*/, ''));
</script>

<style scoped>
.scan-cleanup-auto-value-row {
    display: grid;
    gap: var(--app-space-sm);
}

.scan-cleanup-auto-value-header {
    display: flex;
    box-sizing: border-box;
    min-width: 0;
    min-height: var(--app-scan-settings-affordance-height);
    align-items: center;
    justify-content: space-between;
    gap: var(--app-space-sm);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
}

/* The automatic and manual tags are the same box: only the manual one carries a
   reset button, and that must not make the row taller when deskew is set. */
.scan-cleanup-auto-value-state {
    display: inline-flex;
    box-sizing: border-box;
    min-width: 0;
    height: var(--app-scan-settings-affordance-height);
    flex: none;
    align-items: center;
    gap: var(--app-space-xs);
    border-radius: var(--app-radius-full);
    background: color-mix(in srgb, var(--ui-primary) 16%, var(--ui-bg));
    padding-inline: var(--app-space-xl);
    color: var(--ui-primary);
    font-size: var(--app-text-size-kicker);
    font-weight: var(--app-font-weight-bold);
}

.scan-cleanup-auto-value-state.is-auto {
    background: var(--ui-bg-muted);
    color: var(--ui-text-muted);
    font-weight: var(--app-font-weight-medium);
}

.scan-cleanup-auto-value-reset {
    display: inline-grid;
    width: var(--app-icon-size-xs);
    height: var(--app-icon-size-xs);
    place-items: center;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    padding: 0;
}

.scan-cleanup-auto-value-reset:focus-visible {
    border-radius: var(--app-radius-full);
    outline: var(--app-hairline-height) solid var(--ui-primary);
    outline-offset: var(--app-space-xs);
}

.scan-cleanup-auto-value-reset:disabled {
    cursor: not-allowed;
}

.scan-cleanup-auto-value-entry {
    min-width: 0;
}

.scan-cleanup-auto-value-hint {
    margin: 0;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.scan-cleanup-auto-value-row.is-disabled {
    opacity: var(--app-scan-disabled-opacity);
}
</style>
