<template>
    <AppTooltip
        usefulness="always"
        :delay-duration="150"
        class="ocr-setting-help"
    >
        <UButton
            type="button"
            class="ocr-setting-help-trigger"
            color="neutral"
            variant="ghost"
            size="xs"
            square
            icon="i-ph-info"
            :ui="{leadingIcon: 'size-3.5'}"
            :aria-label="triggerLabel"
            @click.stop.prevent
        />

        <template #content>
            <dl class="ocr-setting-help-options">
                <div
                    v-for="option in options"
                    :key="option.label"
                    class="ocr-setting-help-option"
                >
                    <dt class="ocr-setting-help-term">{{ option.label }}</dt>
                    <dd class="ocr-setting-help-description">{{ option.description }}</dd>
                </div>
            </dl>
        </template>
    </AppTooltip>
</template>

<script setup lang="ts">
interface IOcrSettingHelpOption {
    label: string;
    description: string;
}

interface IProps {
    triggerLabel: string;
    options: IOcrSettingHelpOption[];
}

const {triggerLabel, options} = defineProps<IProps>();
</script>

<style scoped>
.ocr-setting-help-trigger {
    cursor: help;
}

.ocr-setting-help-options {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-3xl);
    text-transform: none;
    letter-spacing: normal;
}

.ocr-setting-help-option {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
}

.ocr-setting-help-term {
    font-size: var(--app-text-size-kicker);
    font-weight: var(--app-font-weight-semibold);
    color: var(--ui-text-highlighted);
}

.ocr-setting-help-description {
    font-size: var(--app-text-size-kicker);
    line-height: var(--app-line-height-text);
    color: var(--ui-text-muted);
}
</style>
