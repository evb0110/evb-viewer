<template>
    <PdfContextMenuBase
        class="page-context-menu"
        :visible="menu.visible"
        :style="style"
        variant="grid"
        min-width="var(--app-context-menu-preferred-width)"
        :accessible-label="t('contextMenu.pageMenu')"
    >
        <p class="pdf-context-menu__section-title">
            {{ menuTitle }}
        </p>

        <button
            type="button"
            class="pdf-context-menu__action pdf-context-menu__action--danger"
            role="menuitem"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="onDeletePages"
        >
            <UIcon name="i-ph-trash" class="pdf-context-menu__icon" />
            {{ t('pageOps.deletePages') }}
        </button>

        <button
            type="button"
            class="pdf-context-menu__action"
            role="menuitem"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="onExtractPages"
        >
            <UIcon name="i-ph-export" class="pdf-context-menu__icon" style="transform: scaleX(-1)" />
            {{ t('pageOps.extractPages') }}
        </button>

        <button
            type="button"
            class="pdf-context-menu__action"
            role="menuitem"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="onExportPages"
        >
            <UIcon name="i-ph-export" class="pdf-context-menu__icon" />
            {{ t('pageOps.exportPages') }}
        </button>

        <div class="pdf-context-menu__divider" />

        <button
            type="button"
            class="pdf-context-menu__action"
            role="menuitem"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="onRotateCw"
        >
            <UIcon name="i-ph-arrow-clockwise" class="pdf-context-menu__icon" />
            {{ t('pageOps.rotateCw') }}
        </button>

        <button
            type="button"
            class="pdf-context-menu__action"
            role="menuitem"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="onRotateCcw"
        >
            <UIcon name="i-ph-arrow-counter-clockwise" class="pdf-context-menu__icon" />
            {{ t('pageOps.rotateCcw') }}
        </button>

        <div class="pdf-context-menu__divider" />

        <button
            type="button"
            class="pdf-context-menu__action"
            role="menuitem"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="onInsertBefore"
        >
            <UIcon name="i-ph-file-plus" class="pdf-context-menu__icon" />
            {{ t('pageOps.insertBefore') }}
        </button>

        <button
            type="button"
            class="pdf-context-menu__action"
            role="menuitem"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="onInsertAfter"
        >
            <UIcon name="i-ph-file-plus" class="pdf-context-menu__icon" />
            {{ t('pageOps.insertAfter') }}
        </button>

        <div class="pdf-context-menu__divider" />

        <button
            type="button"
            class="pdf-context-menu__action"
            role="menuitem"
            @click="onSelectAll"
        >
            {{ t('pageOps.selectAll') }}
        </button>

        <button
            type="button"
            class="pdf-context-menu__action"
            role="menuitem"
            @click="onInvertSelection"
        >
            {{ t('pageOps.invertSelection') }}
        </button>
    </PdfContextMenuBase>
</template>

<script setup lang="ts">
import PdfContextMenuBase from '@app/modules/pdf-viewer/components/PdfContextMenuBase.vue';
import type { IPageContextMenuState } from '@app/types/pdfContextMenu';

const {
    isDjvuMode = false,
    isOperationInProgress,
    menu,
    style,
} = defineProps<{
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

function getRenderedPageIndicator(page: number) {
    if (typeof document === 'undefined') {
        return String(page);
    }

    const renderedLabel = document.querySelector<HTMLElement>(`[data-thumbnail-page="${page}"] [data-document-thumbnail-label]`)
        ?.textContent
        .trim();
    if (renderedLabel === undefined || renderedLabel.length === 0) {
        return String(page);
    }

    return renderedLabel;
}

const menuTitle = computed(() => {
    const [page] = menu.pages;
    if (menu.pages.length === 1 && page !== undefined) {
        return t('pageOps.pageTarget', { page: getRenderedPageIndicator(page) });
    }

    return t('pageOps.pagesSelected', menu.pages.length);
});

function onDeletePages() {
    emit('delete-pages');
}

function onExtractPages() {
    emit('extract-pages');
}

function onExportPages() {
    emit('export-pages');
}

function onRotateCw() {
    emit('rotate-cw');
}

function onRotateCcw() {
    emit('rotate-ccw');
}

function onInsertBefore() {
    emit('insert-before');
}

function onInsertAfter() {
    emit('insert-after');
}

function onSelectAll() {
    emit('select-all');
}

function onInvertSelection() {
    emit('invert-selection');
}
</script>
