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

            <template #facing-first-single-leading>
                <span class="app-menu-icon toolbar-menu-icon toolbar-menu-icon--facing-first-single">
                    <UIcon name="i-ph-book-open" class="size-[var(--app-toolbar-icon-size)]" />
                    <span class="toolbar-menu-icon-badge" aria-hidden="true">1</span>
                </span>
            </template>

            <template #item-trailing="{ item }">
                <UIcon v-if="hasMenuChildren(item)" name="i-ph-caret-right" class="app-menu-submenu-icon" />
                <span v-else-if="getMenuShortcut(item)" class="app-menu-shortcut toolbar-menu-shortcut">
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
import { keepMovedFocus } from '@app/utils/menuFocus';
import { useRecentFiles } from '@app/composables/useRecentFiles';
import {
    dispatchBrowserMenuEvent,
    onBrowserMenuDocumentStateChange,
    readBrowserMenuDocumentState,
    type TBrowserMenuEventArgs,
    type TBrowserMenuEventName,
} from '@app/platform/browserMenuBar';

const { t } = useTypedI18n();
const { isBrowserRuntime } = useRuntimeEnvironment();
const { recentFiles } = useRecentFiles();

type TToolbarAppMenuItem = IToolbarAppMenuStructuralItem | IToolbarAppMenuCommandItem | IToolbarAppMenuSubmenuItem;

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
    type?: 'checkbox';
    checked?: boolean;
    class?: string;
    onSelect: () => void;
}

interface IToolbarAppMenuSubmenuItem {
    label: string;
    icon: string;
    children: TToolbarAppMenuItem[];
}

interface IMenuEventItemOptions {
    disabled?: boolean;
    shortcut?: string;
    slot?: string;
    loading?: boolean;
    /** A checkbox or radio entry of desktop's menu: shown with its check. */
    checked?: boolean;
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

// Combine Files and Convert to PDF are the browser's own entries; desktop's
// menu has no event for them.
const emit = defineEmits<{
    'update:open': [value: boolean];
    'combine-files': [];
    'convert-to-pdf': [];
}>();

const shortcutLabels = useShortcutLabels();
// The state the renderer reports for desktop's native menu (useMenuSync); the
// items below that desktop's menu also shows take their availability from it.
const menuState = shallowRef(readBrowserMenuDocumentState());
onScopeDispose(onBrowserMenuDocumentStateChange((state) => {
    menuState.value = state;
}));
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
    onCloseAutoFocus: keepMovedFocus,
};
const appMenuUi = {
    content: 'app-menu toolbar-menu-panel',
    viewport: 'divide-y-0 p-1',
    group: 'app-menu-section toolbar-menu-section p-0',
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

// The dropdown keys its groups and entries by position, so each top-level
// section is a group of its own: Pages coming or going with the active
// document never turns an open View or Help submenu into another one.
const appMenuItems = computed((): TToolbarAppMenuItem[][] => [
    buildFileItems(),
    buildEditItems(),
    menuState.value?.supportsPdfMutation ?? menuState.value?.hasDocument
        ? [createSubmenu(t('menu.pages'), 'i-ph-files', buildPagesItems())]
        : [],
    [createSubmenu(t('menu.view'), 'i-ph-eye', buildViewItems())],
    [createSubmenu(t('menu.help'), 'i-ph-question', [{
        label: t('menu.acknowledgements'),
        icon: 'i-ph-info',
        onSelect: () => {
            close();
            void navigateTo('/about');
        },
    }])],
]);

function buildFileItems(): TToolbarAppMenuItem[] {
    const items: TToolbarAppMenuItem[] = [
        {
            type: 'label',
            label: t('menu.file'),
        },
        createMenuEventItem('onMenuOpenPdf', t('menu.openFile'), getReaderCommandMenuIcon('open-file'), {shortcut: shortcutLabels.value.openFile}),
        createSubmenu(t('menu.openRecent'), 'i-ph-clock', buildOpenRecentItems()),
        createMenuEventItem('onMenuSave', t('menu.save'), getReaderCommandMenuIcon('save'), {
            disabled: !hasInteractiveDocument.value || !canSave || isAnySaving || isHistoryBusy || isDjvuMode,
            shortcut: shortcutLabels.value.save,
        }),
        createMenuEventItem('onMenuRepairSave', t('menu.repairAndSave'), 'i-ph-magic-wand', {disabled: !hasInteractiveDocument.value || !canRepairSave || isAnySaving || isHistoryBusy || isDjvuMode}),
        createMenuEventItem('onMenuOptimizePdfForInteraction', t('menu.optimizePdfForInteraction'), 'i-ph-gauge', {disabled: !hasInteractiveDocument.value || !canOptimizePdf || isAnySaving || isHistoryBusy || isDjvuMode}),
        createMenuEventItem('onMenuSaveAs', t('menu.saveAs'), getReaderCommandMenuIcon('save-as'), {
            disabled: !hasInteractiveDocument.value || !canSaveAs || isAnySaving || isHistoryBusy,
            shortcut: shortcutLabels.value.saveAs,
        }),
        createMenuEventItem(
            'onMenuPrint',
            t('menu.print'),
            isPreparingPrint && !isPreparingCurrentPagePrint ? 'i-ph-circle-notch' : getReaderCommandMenuIcon('print'),
            {
                disabled: isPrintCommandDisabled.value,
                loading: isPreparingPrint && !isPreparingCurrentPagePrint,
                shortcut: shortcutLabels.value.print,
            },
        ),
        createMenuEventItem('onMenuPrintCurrentPage', t('menu.printCurrentPage'), undefined, {
            disabled: isPrintCommandDisabled.value,
            slot: 'print-current-page',
        }),
        { type: 'separator' },
        {
            label: t('menu.combineFiles'),
            icon: 'i-ph-stack-plus',
            onSelect: () => {
                emit('combine-files');
                close();
            },
        },
        { type: 'separator' },
        // Desktop's File > Export submenu.
        createSubmenu(t('menu.export'), 'i-ph-export', [
            createMenuEventItem(
                'onMenuExportDocx',
                isExportingDocx ? t('ocr.cancel') : t('menu.exportDocx'),
                isExportingDocx ? 'i-ph-stop' : getReaderCommandMenuIcon('export-docx'),
                {
                    disabled: isExportDocxCommandDisabled.value,
                    shortcut: shortcutLabels.value.exportDocx,
                },
            ),
            createMenuEventItem('onMenuExportImages', t('menu.exportImages'), 'i-ph-image', {disabled: !hasExportableRasterSource.value}),
            createMenuEventItem('onMenuExportMultiPageTiff', t('menu.exportMultiPageTiff'), 'i-ph-images', {disabled: !hasExportableRasterSource.value}),
        ]),
    ];
    if (isDjvuMode) {
        items.push(
            { type: 'separator' },
            {
                label: t('menu.convertToPdf'),
                icon: 'i-ph-arrows-clockwise',
                disabled: documentBusy === true,
                onSelect: () => {
                    emit('convert-to-pdf');
                    close();
                },
            },
        );
    }
    items.push(
        { type: 'separator' },
        createMenuEventItem('onMenuNewTab', t('menu.newTab'), 'i-ph-plus'),
        createMenuEventItem('onMenuCloseTab', t('menu.closeTab'), 'i-ph-x', {disabled: menuState.value?.canCloseTab !== true}),
    );
    return items;
}

function buildEditItems(): TToolbarAppMenuItem[] {
    return [
        { type: 'separator' },
        {
            type: 'label',
            label: t('menu.edit'),
        },
        createMenuEventItem('onMenuUndo', t('menu.undo'), getReaderCommandMenuIcon('undo'), {
            disabled: !hasInteractiveDocument.value || !canUndo || isHistoryBusy || isAnySaving || isDjvuMode,
            shortcut: shortcutLabels.value.undo,
        }),
        createMenuEventItem('onMenuRedo', t('menu.redo'), getReaderCommandMenuIcon('redo'), {
            disabled: !hasInteractiveDocument.value || !canRedo || isHistoryBusy || isAnySaving || isDjvuMode,
            shortcut: shortcutLabels.value.redo,
        }),
        { type: 'separator' },
        createMenuEventItem('onMenuInsertImageFromFile', t('menu.insertImageFromFile'), 'i-ph-image', {disabled: !hasInteractiveDocument.value || isDjvuMode}),
        createMenuEventItem('onMenuPasteImageFromClipboard', t('menu.pasteImageFromClipboard'), 'i-ph-clipboard-text', {disabled: !hasInteractiveDocument.value || isDjvuMode}),
        { type: 'separator' },
    ];
}

function buildOpenRecentItems(): TToolbarAppMenuItem[] {
    if (recentFiles.value.length === 0) {
        return [{
            label: t('menu.noRecentFiles'),
            disabled: true,
            onSelect: () => {},
        }];
    }

    return [
        ...recentFiles.value.map(file => createMenuEventItem('onMenuOpenRecentFile', file.fileName, undefined, {}, file.originalPath)),
        { type: 'separator' },
        createMenuEventItem('onMenuClearRecentFiles', t('menu.clearRecentFiles')),
    ];
}

// Desktop's Pages menu, with its availability rules.
function buildPagesItems(): TToolbarAppMenuItem[] {
    const state = menuState.value;
    const selectedPageCount = state?.selectedPageCount ?? 0;
    const canOperateOnSelection = (state?.canMutatePages ?? state?.hasDocument ?? false) && selectedPageCount > 0;
    return [
        createMenuEventItem('onMenuDeletePages', t('menu.deleteSelectedPages'), 'i-ph-trash', {disabled: !canOperateOnSelection || selectedPageCount >= (state?.totalPages ?? 0)}),
        createMenuEventItem('onMenuExtractPages', t('menu.extractSelectedPages'), 'i-ph-export', {disabled: !canOperateOnSelection}),
        { type: 'separator' },
        createMenuEventItem('onMenuRotateCw', t('menu.rotateClockwise'), 'i-ph-arrow-clockwise', {disabled: !canOperateOnSelection}),
        createMenuEventItem('onMenuRotateCcw', t('menu.rotateCounterclockwise'), 'i-ph-arrow-counter-clockwise', {disabled: !canOperateOnSelection}),
        { type: 'separator' },
        createMenuEventItem('onMenuInsertPages', t('menu.insertPages'), 'i-ph-file-plus', {disabled: !(state?.canMutatePages ?? state?.hasDocument ?? false)}),
    ];
}

// Desktop's View menu, with its availability rules. The Assistant entry is
// left out: the assistant panel is desktop-only.
function buildViewItems(): TToolbarAppMenuItem[] {
    const state = menuState.value;
    const hasDocument = state?.hasDocument ?? false;
    const disabled = !(state?.interactive ?? hasDocument);
    const items: TToolbarAppMenuItem[] = [
        createMenuEventItem('onMenuZoomIn', t('menu.zoomIn'), 'i-ph-plus', {
            disabled,
            shortcut: shortcutLabels.value.zoomIn,
        }),
        createMenuEventItem('onMenuZoomOut', t('menu.zoomOut'), 'i-ph-minus', {
            disabled,
            shortcut: shortcutLabels.value.zoomOut,
        }),
        { type: 'separator' },
        createMenuEventItem('onMenuActualSize', t('menu.actualSize'), 'i-ph-frame-corners', {
            disabled,
            shortcut: shortcutLabels.value.actualSize,
            checked: state?.isActualSizeActive === true,
        }),
        createMenuEventItem('onMenuFitWidth', t('menu.fitWidth'), getReaderCommandMenuIcon('fit-width'), {
            disabled,
            shortcut: shortcutLabels.value.fitWidth,
            checked: state?.isFitWidthActive === true,
        }),
        createMenuEventItem('onMenuFitHeight', t('menu.fitHeight'), getReaderCommandMenuIcon('fit-height'), {
            disabled,
            shortcut: shortcutLabels.value.fitHeight,
            checked: state?.isFitHeightActive === true,
        }),
    ];
    if (state?.supportsContinuousScroll ?? state?.canContinuousScroll) {
        items.push(
            { type: 'separator' },
            createMenuEventItem('onMenuToggleContinuousScroll', t('zoom.continuousScroll'), getReaderCommandMenuIcon('continuous-scroll'), {
                disabled: disabled || state?.canContinuousScroll !== true,
                checked: state?.continuousScroll === true,
            }),
        );
    }
    if (state?.supportsViewMode ?? hasDocument) {
        const viewMode = state?.viewMode ?? 'single';
        items.push(
            { type: 'separator' },
            createMenuEventItem('onMenuViewModeSingle', t('menu.singlePage'), 'i-ph-file', {
                disabled,
                checked: viewMode === 'single',
            }),
            createMenuEventItem('onMenuViewModeFacing', t('menu.facingPages'), 'i-ph-book-open', {
                disabled,
                checked: viewMode === 'facing',
            }),
            createMenuEventItem('onMenuViewModeFacingFirstSingle', t('menu.facingWithFirstSingle'), undefined, {
                disabled,
                checked: viewMode === 'facing-first-single',
                slot: 'facing-first-single',
            }),
        );
    }
    if (state?.supportsViewRotation ?? hasDocument) {
        items.push(
            { type: 'separator' },
            createMenuEventItem('onMenuViewRotationCw', t('menu.rotateViewClockwise'), 'i-ph-arrow-clockwise', {disabled}),
            createMenuEventItem('onMenuViewRotationCcw', t('menu.rotateViewCounterclockwise'), 'i-ph-arrow-counter-clockwise', {disabled}),
        );
    }
    const paneDisabled = state?.canCreatePane === false;
    items.push(
        { type: 'separator' },
        createMenuEventItem('onMenuSplitEditor', t('menu.newPaneRight'), 'i-ph-square-split-horizontal', {
            disabled: paneDisabled,
            shortcut: shortcutLabels.value.newPaneRight,
        }, 'right'),
        createMenuEventItem('onMenuSplitEditor', t('menu.newPaneDown'), 'i-ph-square-split-vertical', {disabled: paneDisabled}, 'down'),
    );
    return items;
}

function close() {
    emit('update:open', false);
}

function createSubmenu(label: string, icon: string, children: TToolbarAppMenuItem[]): IToolbarAppMenuSubmenuItem {
    return {
        label,
        icon,
        children,
    };
}

/** An entry of desktop's menu: it sends the platform menu event desktop's item sends. */
function createMenuEventItem<TName extends TBrowserMenuEventName>(
    name: TName,
    label: string,
    icon?: string,
    options: IMenuEventItemOptions = {},
    ...args: TBrowserMenuEventArgs[TName]
): IToolbarAppMenuCommandItem {
    const item: IToolbarAppMenuCommandItem = {
        label,
        onSelect: () => {
            dispatchBrowserMenuEvent(name, ...args);
            close();
        },
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
    if (options.checked !== undefined) {
        item.type = 'checkbox';
        item.checked = options.checked;
        if (options.checked) {
            item.class = 'is-active';
        }
    }
    return item;
}

function hasMenuChildren(item: unknown) {
    return typeof item === 'object' && item !== null && 'children' in item;
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

.app-menu-submenu-icon {
    width: var(--app-icon-size-xs);
    height: var(--app-icon-size-xs);
    flex-shrink: 0;
    color: var(--ui-text-muted);
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
