<template>
    <div
        v-if="selectedCount > 0"
        class="page-selection-bar"
    >
        <span class="page-selection-bar-label">
            {{ t('pageOps.pagesSelected', selectedCount) }}
        </span>

        <div class="page-selection-bar-actions">
            <AppTooltip :text="t('pageOps.rotateCcw')" :delay-duration="400">
                <UButton
                    type="button"
                    class="page-selection-bar-button"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    square
                    icon="i-ph-arrow-counter-clockwise"
                    :aria-label="t('pageOps.rotateCcw')"
                    :disabled="isOperationInProgress || isDjvuMode"
                    @click="onRotateCcw"
                />
            </AppTooltip>

            <AppTooltip :text="t('pageOps.rotateCw')" :delay-duration="400">
                <UButton
                    type="button"
                    class="page-selection-bar-button"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    square
                    icon="i-ph-arrow-clockwise"
                    :aria-label="t('pageOps.rotateCw')"
                    :disabled="isOperationInProgress || isDjvuMode"
                    @click="onRotateCw"
                />
            </AppTooltip>

            <AppTooltip :text="t('pageOps.extractPages')" :delay-duration="400">
                <UButton
                    type="button"
                    class="page-selection-bar-button"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    square
                    icon="i-ph-file-arrow-down"
                    :aria-label="t('pageOps.extractPages')"
                    :disabled="isOperationInProgress || isDjvuMode"
                    @click="onExtractPages"
                />
            </AppTooltip>

            <AppTooltip :text="t('pageOps.exportPages')" :delay-duration="400">
                <UButton
                    type="button"
                    class="page-selection-bar-button"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    square
                    icon="i-ph-images"
                    :aria-label="t('pageOps.exportPages')"
                    :disabled="isOperationInProgress || isDjvuMode"
                    @click="onExportPages"
                />
            </AppTooltip>

            <AppTooltip :text="t('pageOps.deletePages')" :delay-duration="400">
                <UButton
                    type="button"
                    class="page-selection-bar-button"
                    color="error"
                    variant="ghost"
                    size="xs"
                    square
                    icon="i-ph-trash"
                    :aria-label="t('pageOps.deletePages')"
                    :disabled="isOperationInProgress || isDjvuMode"
                    @click="onDeletePages"
                />
            </AppTooltip>
        </div>

        <UButton
            type="button"
            class="page-selection-bar-deselect"
            color="neutral"
            variant="outline"
            size="xs"
            :label="t('pageOps.deselect')"
            @click="onDeselect"
        />
    </div>
</template>

<script setup lang="ts">
defineProps<{
    selectedCount: number;
    isOperationInProgress: boolean;
    isDjvuMode?: boolean;
}>();

const emit = defineEmits<{
    'rotate-cw': [];
    'rotate-ccw': [];
    'extract-pages': [];
    'export-pages': [];
    'delete-pages': [];
    'deselect': [];
}>();

const { t } = useTypedI18n();

function onRotateCw() {
    emit('rotate-cw');
}

function onRotateCcw() {
    emit('rotate-ccw');
}

function onExtractPages() {
    emit('extract-pages');
}

function onExportPages() {
    emit('export-pages');
}

function onDeletePages() {
    emit('delete-pages');
}

function onDeselect() {
    emit('deselect');
}
</script>

<style lang="scss" scoped>
.page-selection-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--app-sidebar-row-gap);
    padding: var(--app-sidebar-row-padding-block) var(--app-sidebar-content-padding);
    border-bottom: 1px solid var(--app-sidebar-border);
    background: var(--app-pdf-page-selection-bar-bg);
    flex-shrink: 0;
}

.page-selection-bar-label {
    flex: 1 1 7rem;
    font-size: var(--app-sidebar-caption-font-size);
    font-weight: var(--app-font-weight-semibold);
    color: var(--ui-text);
    min-width: 0;

    @include app.truncate-single-line;
}

.page-selection-bar-actions {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    gap: var(--app-space-3xs);
    margin-left: auto;
}

.page-selection-bar-button {
    flex: 0 0 auto;
}

.page-selection-bar-deselect {
    margin-left: auto;
    white-space: nowrap;
    flex-shrink: 0;
}
</style>
