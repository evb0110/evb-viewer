<template>
    <nav v-if="isBrowserRuntime" class="app-menu-bar" :aria-label="t('toolbar.appMenu')">
        <UDropdownMenu
            v-model:open="menuOpen"
            :items="appMenuItems"
            :content="menuContentOptions"
            :ui="appMenuUi"
        >
            <button
                type="button"
                :class="['app-menu-trigger', { 'is-open': menuOpen }]"
                :aria-label="t('toolbar.appMenu')"
                aria-haspopup="menu"
                :aria-expanded="menuOpen"
            >
                <UIcon name="i-ph-list" class="app-menu-trigger-icon" />
                <span class="app-menu-trigger-label">{{ t('toolbar.appMenu') }}</span>
                <UIcon name="i-ph-caret-down" class="app-menu-trigger-chevron" />
            </button>

            <template #print-current-page-leading>
                <UIcon
                    v-if="isPreparingCurrentPagePrint"
                    name="i-ph-circle-notch"
                    class="app-menu-icon toolbar-menu-icon animate-spin"
                />
                <PrintCurrentPageIcon v-else class="app-menu-icon toolbar-menu-icon" />
            </template>

            <template #item-trailing="{ item }">
                <span v-if="getMenuShortcut(item)" class="app-menu-shortcut toolbar-menu-shortcut">
                    {{ getMenuShortcut(item) }}
                </span>
            </template>
        </UDropdownMenu>
    </nav>
</template>

<script setup lang="ts">
import { useShortcutLabels } from '@app/constants/shortcuts';
import PrintCurrentPageIcon from '@app/components/icons/PrintCurrentPageIcon.vue';
import { isReaderPrintCommandDisabled } from '@app/utils/isReaderPrintCommandDisabled';
import { useRuntimeEnvironment } from '@app/composables/useRuntimeEnvironment';
import { getReaderCommandMenuIcon } from '@app/utils/readerCommandIcons';
import type { TToolbarAppMenuCommand } from '@app/types/toolbarMenuCommands';

const { t } = useTypedI18n();
const { isBrowserRuntime } = useRuntimeEnvironment();

type TToolbarAppMenuItem = IToolbarAppMenuStructuralItem | IToolbarAppMenuCommandItem;

interface IToolbarAppMenuStructuralItem {
    type: 'label' | 'separator';
    label?: string;
}

interface IToolbarAppMenuCommandItem {
    label: string;
    icon?: string;
    slot?: string;
    disabled?: boolean;
    shortcut?: string;
    loading?: boolean;
    onSelect: () => void;
}

interface IProps {
    open: boolean
    hasPdf: boolean
    canPrint?: boolean
    canSave: boolean
    canSaveAs?: boolean
    canRepairSave: boolean
    canOptimizePdf: boolean
    canUndo: boolean
    canRedo: boolean
    canExportDocx: boolean
    isAnySaving: boolean
    isHistoryBusy: boolean
    isExportingDocx: boolean
    isPreparingPrint: boolean
    isPreparingCurrentPagePrint?: boolean
    isDjvuMode: boolean
    canUseDjvu: boolean
    documentBusy?: boolean
}

const {
    canExportDocx,
    canRedo,
    canOptimizePdf,
    canRepairSave,
    canSave,
    canSaveAs = true,
    canPrint = true,
    canUndo,
    canUseDjvu,
    documentBusy,
    hasPdf,
    isAnySaving,
    isDjvuMode,
    isExportingDocx,
    isHistoryBusy,
    isPreparingCurrentPagePrint,
    isPreparingPrint,
    open,
} = defineProps<IProps>();

const emit = defineEmits<{
    'update:open': [value: boolean];
    'open-file': [];
    save: [];
    'repair-save': [];
    'optimize-pdf-for-interaction': [];
    'save-as': [];
    print: [];
    'print-current-page': [];
    'combine-files': [];
    'export-docx': [];
    'export-images': [];
    'export-multi-page-tiff': [];
    'convert-to-pdf': [];
    undo: [];
    redo: [];
    'insert-image-from-file': [];
    'paste-image-from-clipboard': [];
}>();

const emitMenuCommand = {
    'open-file': () => emit('open-file'),
    save: () => emit('save'),
    'repair-save': () => emit('repair-save'),
    'optimize-pdf-for-interaction': () => emit('optimize-pdf-for-interaction'),
    'save-as': () => emit('save-as'),
    print: () => emit('print'),
    'print-current-page': () => emit('print-current-page'),
    'combine-files': () => emit('combine-files'),
    'export-docx': () => emit('export-docx'),
    'export-images': () => emit('export-images'),
    'export-multi-page-tiff': () => emit('export-multi-page-tiff'),
    'convert-to-pdf': () => emit('convert-to-pdf'),
    undo: () => emit('undo'),
    redo: () => emit('redo'),
    'insert-image-from-file': () => emit('insert-image-from-file'),
    'paste-image-from-clipboard': () => emit('paste-image-from-clipboard'),
} satisfies Record<TToolbarAppMenuCommand, () => void>;

const shortcutLabels = useShortcutLabels();
const hasInteractiveDocument = computed(() => hasPdf && documentBusy !== true);
const hasExportableRasterSource = computed(() => (hasPdf || isDjvuMode) && documentBusy !== true);
const isPrintCommandDisabled = computed(() => isReaderPrintCommandDisabled({
    hasInteractiveDocument: hasInteractiveDocument.value,
    canPrint,
    isPreparingPrint,
    isAnySaving,
    isHistoryBusy,
}));
const isExportDocxCommandDisabled = computed(() => !isExportingDocx && (
    !hasInteractiveDocument.value
    || isDjvuMode
    || !canExportDocx
    || isAnySaving
    || isHistoryBusy
));
const menuContentOptions = {
    side: 'bottom' as const,
    align: 'start' as const,
    sideOffset: 8,
    collisionPadding: 8,
};
const appMenuUi = {
    content: 'app-menu toolbar-menu-panel',
    group: 'app-menu-section toolbar-menu-section',
    label: 'app-menu-section-header toolbar-menu-section-header',
    separator: 'app-menu-divider toolbar-menu-divider',
    item: 'app-menu-item toolbar-menu-item',
    itemLeadingIcon: 'app-menu-icon toolbar-menu-icon',
    itemLabel: 'app-menu-label toolbar-menu-label',
    itemTrailing: 'app-menu-trailing',
};

const menuOpen = computed({
    get: () => open,
    set: (open: boolean) => emit('update:open', open),
});

const appMenuItems = computed(() => {
    const items: TToolbarAppMenuItem[] = [
        {
            type: 'label',
            label: t('menu.file'),
        },
        createCommandItem('open-file', t('menu.openFile'), getReaderCommandMenuIcon('open-file'), {shortcut: shortcutLabels.value.openFile}),
        createCommandItem('save', t('menu.save'), getReaderCommandMenuIcon('save'), {
            disabled: !hasInteractiveDocument.value || !canSave || isAnySaving || isHistoryBusy || isDjvuMode,
            shortcut: shortcutLabels.value.save,
        }),
        createCommandItem('repair-save', t('menu.repairAndSave'), 'i-ph-magic-wand', {disabled: !hasInteractiveDocument.value || !canRepairSave || isAnySaving || isHistoryBusy || isDjvuMode}),
        createCommandItem('optimize-pdf-for-interaction', t('menu.optimizePdfForInteraction'), 'i-ph-gauge', {disabled: !hasInteractiveDocument.value || !canOptimizePdf || isAnySaving || isHistoryBusy || isDjvuMode}),
        createCommandItem('save-as', t('menu.saveAs'), getReaderCommandMenuIcon('save-as'), {
            disabled: !hasInteractiveDocument.value || !canSaveAs || isAnySaving || isHistoryBusy,
            shortcut: shortcutLabels.value.saveAs,
        }),
        createCommandItem(
            'print',
            t('menu.print'),
            isPreparingPrint && !isPreparingCurrentPagePrint ? 'i-ph-circle-notch' : getReaderCommandMenuIcon('print'),
            {
                disabled: isPrintCommandDisabled.value,
                loading: isPreparingPrint && !isPreparingCurrentPagePrint,
                shortcut: shortcutLabels.value.print,
            },
        ),
        createCommandItem('print-current-page', t('menu.printCurrentPage'), undefined, {
            disabled: isPrintCommandDisabled.value,
            slot: 'print-current-page',
        }),
        { type: 'separator' },
        createCommandItem('combine-files', t('menu.combineFiles'), 'i-ph-stack-plus'),
        { type: 'separator' },
        createCommandItem(
            'export-docx',
            isExportingDocx ? t('ocr.cancel') : t('menu.exportDocx'),
            isExportingDocx ? 'i-ph-stop' : getReaderCommandMenuIcon('export-docx'),
            {
                disabled: isExportDocxCommandDisabled.value,
                shortcut: shortcutLabels.value.exportDocx,
            },
        ),
        createCommandItem('export-images', t('menu.exportImages'), 'i-ph-image', {disabled: !hasExportableRasterSource.value}),
        createCommandItem('export-multi-page-tiff', t('menu.exportMultiPageTiff'), 'i-ph-images', {disabled: !hasExportableRasterSource.value}),
    ];

    if (canUseDjvu && isDjvuMode) {
        items.push(
            { type: 'separator' },
            createCommandItem('convert-to-pdf', t('menu.convertToPdf'), 'i-ph-arrows-clockwise', {disabled: documentBusy}),
        );
    }

    items.push(
        { type: 'separator' },
        {
            type: 'label',
            label: t('menu.edit'),
        },
        createCommandItem('undo', t('menu.undo'), getReaderCommandMenuIcon('undo'), {
            disabled: !hasInteractiveDocument.value || !canUndo || isHistoryBusy || isAnySaving || isDjvuMode,
            shortcut: shortcutLabels.value.undo,
        }),
        createCommandItem('redo', t('menu.redo'), getReaderCommandMenuIcon('redo'), {
            disabled: !hasInteractiveDocument.value || !canRedo || isHistoryBusy || isAnySaving || isDjvuMode,
            shortcut: shortcutLabels.value.redo,
        }),
        { type: 'separator' },
        createCommandItem('insert-image-from-file', t('menu.insertImageFromFile'), 'i-ph-image', {disabled: !hasInteractiveDocument.value || isDjvuMode}),
        createCommandItem('paste-image-from-clipboard', t('menu.pasteImageFromClipboard'), 'i-ph-clipboard-text', {disabled: !hasInteractiveDocument.value || isDjvuMode}),
    );

    return items;
});

function close() {
    emit('update:open', false);
}

function handleMenuCommand(command: TToolbarAppMenuCommand) {
    emitMenuCommand[command]();
    close();
}

function createCommandItem(
    command: TToolbarAppMenuCommand,
    label: string,
    icon?: string,
    options: {
        disabled?: boolean;
        shortcut?: string;
        slot?: string;
        loading?: boolean;
    } = {},
): IToolbarAppMenuCommandItem {
    const item: IToolbarAppMenuCommandItem = {
        label,
        onSelect: () => handleMenuCommand(command),
    };

    if (icon !== undefined) {
        item.icon = icon;
    }

    if (options.disabled !== undefined) {
        item.disabled = options.disabled;
    }

    if (options.shortcut !== undefined) {
        item.shortcut = options.shortcut;
    }

    if (options.slot !== undefined) {
        item.slot = options.slot;
    }

    if (options.loading !== undefined) {
        item.loading = options.loading;
    }

    return item;
}

function getMenuShortcut(item: unknown) {
    if (typeof item !== 'object' || item === null || !('shortcut' in item)) {
        return '';
    }
    return typeof item.shortcut === 'string' ? item.shortcut : '';
}
</script>

<style lang="scss">
@use '@app/assets/css/toolbar-menu-shared';

.app-menu {
    min-width: min(var(--app-toolbar-app-menu-min-width), var(--app-floating-panel-viewport-width));
}
</style>

<style lang="scss" scoped>
.app-menu-bar {
    display: inline-flex;
    align-items: center;
    gap: var(--app-toolbar-group-gap);
    height: var(--toolbar-control-height, 2.25rem);
}

.app-menu-trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--app-space-sm);
    min-width: 0;
    max-width: min(var(--app-toolbar-app-menu-trigger-max-width), var(--app-toolbar-app-menu-trigger-max-viewport-width));
    height: var(--toolbar-control-height, 2.25rem);
    padding: 0 var(--app-space-3xl) 0 var(--app-toolbar-control-padding-x);
    border: 1px solid transparent;
    border-radius: var(--app-toolbar-button-radius);
    background: transparent;
    color: var(--app-toolbar-menu-trigger-fg);
    font: inherit;
    font-size: var(--app-text-size-body);
    font-weight: var(--app-font-weight-medium);
    cursor: pointer;
    transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, box-shadow 150ms ease;
}

.app-menu-trigger-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.app-menu-trigger-icon {
    display: none;
}

.app-menu-trigger:hover,
.app-menu-trigger.is-open {
    background: var(--app-toolbar-control-hover-bg);
    border-color: var(--app-toolbar-control-hover-border);
    color: var(--ui-text);
}

.app-menu-trigger.is-open {
    background: var(--app-toolbar-control-active-bg);
    border-color: var(--app-toolbar-control-active-border);
}

.app-menu-trigger.is-open:hover {
    background: var(--app-toolbar-control-active-hover-bg);
    border-color: var(--app-toolbar-control-active-hover-border);
}

.app-menu-trigger:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
    outline: none;
}

.app-menu-trigger-chevron {
    width: var(--app-icon-size-xs);
    height: var(--app-icon-size-xs);
    flex-shrink: 0;
    color: var(--ui-text-muted);
    transition: transform 150ms ease;
}

.app-menu-trigger.is-open .app-menu-trigger-chevron {
    transform: rotate(180deg);
}

@container (max-width: 520px) {
    .app-menu-trigger {
        width: var(--toolbar-control-height, var(--app-toolbar-control-size));
        padding: 0;
        justify-content: center;
    }

    .app-menu-trigger-icon {
        display: inline-block;
        width: var(--app-toolbar-icon-size);
        height: var(--app-toolbar-icon-size);
    }

    .app-menu-trigger-label,
    .app-menu-trigger-chevron {
        display: none;
    }
}

</style>
