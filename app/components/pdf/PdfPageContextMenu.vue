<template>
    <div
        v-if="menu.visible"
        class="page-context-menu"
        :style="style"
        @click.stop
    >
        <p class="page-context-menu-section-title">
            {{ t('pageOps.pagesSelected', menu.pages.length) }}
        </p>

        <button
            type="button"
            class="page-context-menu-action page-context-menu-action-danger"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="emit('delete-pages')"
        >
            <UIcon name="i-lucide-trash-2" class="page-context-menu-icon" />
            {{ t('pageOps.deletePages') }}
        </button>

        <button
            type="button"
            class="page-context-menu-action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="emit('extract-pages')"
        >
            <UIcon name="i-lucide-file-output" class="page-context-menu-icon" style="transform: scaleX(-1)" />
            {{ t('pageOps.extractPages') }}
        </button>

        <button
            type="button"
            class="page-context-menu-action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="emit('export-pages')"
        >
            <UIcon name="i-lucide-file-output" class="page-context-menu-icon" />
            {{ t('pageOps.exportPages') }}
        </button>

        <div class="page-context-menu-divider" />

        <button
            type="button"
            class="page-context-menu-action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="emit('rotate-cw')"
        >
            <UIcon name="i-lucide-rotate-cw" class="page-context-menu-icon" />
            {{ t('pageOps.rotateCw') }}
        </button>

        <button
            type="button"
            class="page-context-menu-action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="emit('rotate-ccw')"
        >
            <UIcon name="i-lucide-rotate-ccw" class="page-context-menu-icon" />
            {{ t('pageOps.rotateCcw') }}
        </button>

        <div class="page-context-menu-divider" />

        <button
            type="button"
            class="page-context-menu-action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="emit('insert-before')"
        >
            <UIcon name="i-lucide-file-plus" class="page-context-menu-icon" />
            {{ t('pageOps.insertBefore') }}
        </button>

        <button
            type="button"
            class="page-context-menu-action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="emit('insert-after')"
        >
            <UIcon name="i-lucide-file-plus" class="page-context-menu-icon" />
            {{ t('pageOps.insertAfter') }}
        </button>

        <div class="page-context-menu-divider" />

        <button
            type="button"
            class="page-context-menu-action"
            @click="emit('select-all')"
        >
            {{ t('pageOps.selectAll') }}
        </button>

        <button
            type="button"
            class="page-context-menu-action"
            @click="emit('invert-selection')"
        >
            {{ t('pageOps.invertSelection') }}
        </button>
    </div>
</template>

<script setup lang="ts">
interface IPageContextMenuState {
    visible: boolean;
    pages: number[];
}

defineProps<{
    menu: IPageContextMenuState;
    style: Record<string, string>;
    isOperationInProgress: boolean;
    isDjvuMode?: boolean;
}>();

const emit = defineEmits<{
    'delete-pages': [];
    'extract-pages': [];
    'export-pages': [];
    'rotate-cw': [];
    'rotate-ccw': [];
    'insert-before': [];
    'insert-after': [];
    'select-all': [];
    'invert-selection': [];
}>();

const { t } = useTypedI18n();
</script>

<style scoped>
.page-context-menu {
    position: fixed;
    z-index: 70;
    min-width: 208px;
    display: grid;
    gap: 1px;
    border: 1px solid var(--ui-border);
    background: var(--ui-border);
    box-shadow:
        0 10px 24px rgb(0 0 0 / 15%),
        0 3px 8px rgb(0 0 0 / 10%);
}

.page-context-menu-section-title {
    margin: 0;
    padding: 0.45rem 0.6rem 0.35rem;
    background: var(--ui-bg-muted);
    color: var(--ui-text-dimmed);
    font-size: 0.64rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 600;
}

.page-context-menu-divider {
    height: 1px;
    background: var(--ui-border);
}

.page-context-menu-action {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-align: left;
    border: none;
    background: var(--ui-bg, #fff);
    color: var(--ui-text);
    min-height: 2rem;
    padding: 0 0.6rem;
    cursor: pointer;
    font-size: 0.8125rem;
}

.page-context-menu-action:hover {
    background: color-mix(in oklab, var(--ui-bg, #fff) 93%, var(--ui-primary) 7%);
}

.page-context-menu-action:disabled {
    color: var(--ui-text-dimmed);
    cursor: default;
    background: var(--ui-bg-muted);
}

.page-context-menu-action-danger {
    color: #b42318;
}

.page-context-menu-icon {
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
}
</style>
