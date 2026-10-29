<template>
    <div
        class="scan-cleanup-scope-selector"
        role="radiogroup"
        :aria-label="t('scanCleanup.settings.scope.label')"
    >
        <button
            v-for="item in scopeItems"
            :key="item.value"
            type="button"
            class="scan-cleanup-scope-row"
            :class="{
                'scan-cleanup-scope-row--active': modelValue === item.value,
                'scan-cleanup-scope-row--highlighted': highlightedScope === item.value,
            }"
            :data-settings-scope="item.value"
            :aria-checked="modelValue === item.value"
            :aria-label="item.label"
            role="radio"
            @click="$emit('update:model-value', item.value)"
        >
            <span class="scan-cleanup-scope-label">{{ item.label }}</span>
            <span
                v-if="item.value === 'page' && customizedCounts.page > 0"
                class="scan-cleanup-scope-page-customized"
                data-customized-scope="page"
                role="img"
                :aria-label="t('scanCleanup.settings.scope.pageCustomized')"
            />
        </button>
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
}>();
defineEmits<{'update:model-value': [value: TScanCleanupSettingsScope]}>();
const {t} = useTypedI18n();

const scopeItems = computed(() => [
    {
        value: 'all' as const,
        label: t('scanCleanup.settings.scope.all'),
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
    grid-auto-columns: minmax(0, 1fr);
    grid-auto-flow: column;
    overflow: hidden;
    border: var(--app-hairline-height) solid var(--ui-border);
    border-radius: var(--app-radius-md);
    background: var(--ui-bg-muted);
    padding: var(--app-space-xs);
}

.scan-cleanup-scope-row {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    justify-content: center;
    gap: var(--app-space-sm);
    border: 0;
    border-radius: var(--app-radius-sm);
    background: transparent;
    padding: var(--app-space-sm) var(--app-space-3xl);
    color: var(--ui-text-muted);
    cursor: pointer;
    font-size: var(--app-text-size-body-sm);
    font-weight: var(--app-font-weight-semibold);
    transition:
        background-color var(--app-transition-fast),
        box-shadow var(--app-transition-fast),
        color var(--app-transition-fast);
}

.scan-cleanup-scope-row:hover {
    background: var(--app-toolbar-control-hover-bg);
    color: var(--ui-text);
}

.scan-cleanup-scope-row:focus-visible {
    outline: var(--app-hairline-height) solid var(--ui-primary);
    outline-offset: calc(-1 * var(--app-hairline-height));
}

.scan-cleanup-scope-row--active,
.scan-cleanup-scope-row--active:hover {
    background: var(--app-control-active-bg);
    box-shadow: inset 0 0 0 var(--app-hairline-height) var(--app-control-active-border);
    color: var(--ui-text);
}

/* An edit made in the preview flashes the scope it landed in. */
.scan-cleanup-scope-row--highlighted {
    background: color-mix(in srgb, var(--ui-primary) 22%, var(--ui-bg));
    box-shadow: 0 0 0 var(--app-space-xs) color-mix(in srgb, var(--ui-primary) 24%, transparent);
}

.scan-cleanup-scope-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.scan-cleanup-scope-page-customized {
    width: var(--app-space-3xl);
    height: var(--app-space-3xl);
    flex: none;
    border-radius: var(--app-radius-full);
    background: var(--ui-primary);
}
</style>
