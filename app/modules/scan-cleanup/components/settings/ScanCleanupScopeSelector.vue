<template>
    <div
        class="scan-cleanup-scope-selector"
        role="radiogroup"
        :aria-label="t('scanCleanup.settings.scope.label')"
    >
        <div
            v-for="item in scopeItems"
            :key="item.value"
            class="scan-cleanup-scope-option"
        >
            <button
                type="button"
                class="scan-cleanup-scope-row"
                :class="{
                    'scan-cleanup-scope-row--active': modelValue === item.value,
                    'scan-cleanup-scope-row--all-active': modelValue === 'all' && item.value === 'all',
                    'scan-cleanup-scope-row--highlighted': highlightedScope === item.value,
                }"
                :data-settings-scope="item.value"
                :aria-checked="modelValue === item.value"
                :aria-label="item.label"
                role="radio"
                @click="$emit('update:model-value', item.value)"
            >
                <span class="scan-cleanup-scope-radio" aria-hidden="true">
                    <span v-if="modelValue === item.value" />
                </span>
                <span class="scan-cleanup-scope-label">{{ item.label }}</span>
                <span
                    v-if="item.value !== 'page'"
                    class="scan-cleanup-scope-customized"
                    :class="{'is-placeholder': customizedCounts[item.value] <= 0}"
                    :data-customized-scope="customizedCounts[item.value] > 0 ? item.value : undefined"
                    :aria-hidden="customizedCounts[item.value] <= 0"
                >
                    {{ t('scanCleanup.settings.scope.customized', {
                        count: Math.max(1, customizedCounts[item.value]),
                    }) }}
                </span>
                <span
                    v-else
                    class="scan-cleanup-scope-page-customized"
                    :class="{'is-placeholder': customizedCounts[item.value] <= 0}"
                    :data-customized-scope="customizedCounts[item.value] > 0 ? 'page' : undefined"
                    :aria-hidden="customizedCounts[item.value] <= 0"
                >
                    <span aria-hidden="true" />
                    <span class="sr-only">{{ t('scanCleanup.settings.scope.pageCustomized') }}</span>
                </span>
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
import type {TScanCleanupSettingsScope} from '@app/modules/scan-cleanup/composables/useScanCleanupSelection';

const props = defineProps<{
    customizedCounts: Record<TScanCleanupSettingsScope, number>;
    highlightedScope: TScanCleanupSettingsScope | null;
    modelValue: TScanCleanupSettingsScope;
    pageNumber: number;
    selectedCount: number;
    totalPages: number;
}>();
defineEmits<{'update:model-value': [value: TScanCleanupSettingsScope]}>();
const {t} = useTypedI18n();

const scopeItems = computed(() => [
    {
        value: 'all' as const,
        label: t('scanCleanup.settings.scope.all', {count: props.totalPages}),
    },
    {
        value: 'page' as const,
        label: t('scanCleanup.settings.scope.page', {page: props.pageNumber}),
    },
    ...(props.selectedCount >= 2 ? [{
        value: 'selected' as const,
        label: t('scanCleanup.settings.scope.selected', {count: props.selectedCount}),
    }] : []),
]);
</script>

<style scoped>
.scan-cleanup-scope-selector {
    display: grid;
    gap: var(--app-space-sm);
}

.scan-cleanup-scope-option {
    display: grid;
}

.scan-cleanup-scope-row {
    display: grid;
    width: 100%;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--app-space-3xl);
    border: var(--app-hairline-height) solid var(--ui-border);
    border-radius: var(--app-radius-md);
    background: var(--ui-bg);
    padding: var(--app-space-3xl);
    color: var(--ui-text);
    text-align: start;
    transition:
        background-color var(--app-transition-standard),
        border-color var(--app-transition-standard),
        box-shadow var(--app-transition-standard);
}

.scan-cleanup-scope-row:hover {
    background: var(--ui-bg-elevated);
}

.scan-cleanup-scope-row:focus-visible {
    outline: var(--app-hairline-height) solid var(--ui-primary);
    outline-offset: var(--app-space-xs);
}

.scan-cleanup-scope-row--active {
    border-color: var(--ui-primary);
    background: color-mix(in srgb, var(--ui-primary) 8%, var(--ui-bg));
}

.scan-cleanup-scope-row--all-active {
    background: color-mix(in srgb, var(--ui-primary) 14%, var(--ui-bg));
    box-shadow: inset 0 0 0 var(--app-hairline-height) var(--ui-primary);
    font-weight: var(--app-font-weight-bold);
}

.scan-cleanup-scope-row--highlighted {
    background: color-mix(in srgb, var(--ui-primary) 22%, var(--ui-bg));
    box-shadow: 0 0 0 var(--app-space-xs) color-mix(in srgb, var(--ui-primary) 24%, transparent);
}

.scan-cleanup-scope-radio {
    display: grid;
    width: var(--app-space-5xl);
    height: var(--app-space-5xl);
    place-items: center;
    border: var(--app-hairline-height) solid var(--ui-border);
    border-radius: var(--app-radius-full);
    background: var(--ui-bg);
}

.scan-cleanup-scope-radio > span {
    width: var(--app-space-xl);
    height: var(--app-space-xl);
    border-radius: var(--app-radius-full);
    background: var(--ui-primary);
}

.scan-cleanup-scope-label {
    min-width: 0;
    font-size: var(--app-text-size-body-sm);
}

.scan-cleanup-scope-customized {
    border-radius: var(--app-radius-full);
    background: color-mix(in srgb, var(--ui-primary) 16%, var(--ui-bg));
    padding: var(--app-space-xs) var(--app-space-xl);
    color: var(--ui-primary);
    font-size: var(--app-text-size-kicker);
    font-weight: var(--app-font-weight-bold);
    white-space: nowrap;
}

.scan-cleanup-scope-customized.is-placeholder,
.scan-cleanup-scope-page-customized.is-placeholder {
    visibility: hidden;
}

.scan-cleanup-scope-page-customized {
    display: grid;
    width: var(--app-icon-size-xs);
    height: var(--app-icon-size-xs);
    place-items: center;
}

.scan-cleanup-scope-page-customized > span:first-child {
    width: var(--app-space-3xl);
    height: var(--app-space-3xl);
    border-radius: var(--app-radius-full);
    background: var(--ui-primary);
}

</style>
