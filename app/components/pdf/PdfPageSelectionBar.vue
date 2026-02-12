<template>
    <div
        v-if="selectedCount > 0"
        class="page-selection-bar"
    >
        <span class="page-selection-bar-label">
            {{ t('pageOps.pagesSelected', selectedCount) }}
        </span>

        <div class="page-selection-bar-actions">
            <UTooltip :text="t('pageOps.rotateCcw')" :delay-duration="400">
                <button
                    type="button"
                    class="page-selection-bar-button"
                    :disabled="isOperationInProgress"
                    @click="emit('rotate-ccw')"
                >
                    <UIcon name="i-lucide-rotate-ccw" class="page-selection-bar-icon" />
                </button>
            </UTooltip>

            <UTooltip :text="t('pageOps.rotateCw')" :delay-duration="400">
                <button
                    type="button"
                    class="page-selection-bar-button"
                    :disabled="isOperationInProgress"
                    @click="emit('rotate-cw')"
                >
                    <UIcon name="i-lucide-rotate-cw" class="page-selection-bar-icon" />
                </button>
            </UTooltip>

            <UTooltip :text="t('pageOps.extractPages')" :delay-duration="400">
                <button
                    type="button"
                    class="page-selection-bar-button"
                    :disabled="isOperationInProgress"
                    @click="emit('extract-pages')"
                >
                    <UIcon name="i-lucide-file-output" class="page-selection-bar-icon" />
                </button>
            </UTooltip>

            <UTooltip :text="t('pageOps.deletePages')" :delay-duration="400">
                <button
                    type="button"
                    class="page-selection-bar-button page-selection-bar-button-danger"
                    :disabled="isOperationInProgress"
                    @click="emit('delete-pages')"
                >
                    <UIcon name="i-lucide-trash-2" class="page-selection-bar-icon" />
                </button>
            </UTooltip>
        </div>

        <button
            type="button"
            class="page-selection-bar-deselect"
            @click="emit('deselect')"
        >
            {{ t('pageOps.deselect') }}
        </button>
    </div>
</template>

<script setup lang="ts">
defineProps<{
    selectedCount: number;
    isOperationInProgress: boolean;
}>();

const emit = defineEmits<{
    'rotate-cw': [];
    'rotate-ccw': [];
    'extract-pages': [];
    'delete-pages': [];
    'deselect': [];
}>();

const { t } = useI18n();
</script>

<style scoped>
.page-selection-bar {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.5rem;
    border-bottom: 1px solid var(--ui-border);
    background: color-mix(in oklab, var(--ui-bg) 85%, var(--ui-primary) 15%);
    flex-shrink: 0;
}

.page-selection-bar-label {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--ui-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
}

.page-selection-bar-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
}

.page-selection-bar-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: none;
    border-radius: 0.25rem;
    background: transparent;
    color: var(--ui-text-muted);
    cursor: pointer;
    transition: background-color 0.1s, color 0.1s;
}

.page-selection-bar-button:hover {
    background: var(--ui-bg-elevated);
    color: var(--ui-text);
}

.page-selection-bar-button:disabled {
    color: var(--ui-text-dimmed);
    cursor: default;
}

.page-selection-bar-button-danger:hover:not(:disabled) {
    color: #b42318;
}

.page-selection-bar-icon {
    width: 0.875rem;
    height: 0.875rem;
}

.page-selection-bar-deselect {
    font-size: 0.625rem;
    color: var(--ui-text-muted);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.125rem 0.25rem;
    border-radius: 0.25rem;
    white-space: nowrap;
    flex-shrink: 0;
}

.page-selection-bar-deselect:hover {
    color: var(--ui-text);
    background: var(--ui-bg-elevated);
}
</style>
