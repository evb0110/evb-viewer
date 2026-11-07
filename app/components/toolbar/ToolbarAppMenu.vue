<template>
    <nav v-if="isBrowserRuntime" class="app-menu-bar" :aria-label="t('toolbar.appMenu')">
        <UDropdownMenu
            v-model:open="menuOpen"
            :modal="false"
            :items="appMenuItems"
            :content="menuContentOptions"
            :ui="appMenuUi"
        >
            <button
                type="button"
                :class="['app-menu-trigger', TEXT_EDIT_MENU_CLASS, { 'is-open': menuOpen }]"
                :aria-label="t('toolbar.appMenu')"
                aria-haspopup="menu"
                :aria-expanded="menuOpen"
                @pointerdown.capture="captureTextEditSource()"
                @mousedown.prevent
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
import { useEventListener } from '@vueuse/core';
import { useShortcutLabels } from '@app/constants/shortcuts';
import PrintCurrentPageIcon from '@app/components/icons/PrintCurrentPageIcon.vue';
import { isReaderPrintCommandDisabled } from '@app/utils/isReaderPrintCommandDisabled';
import { useRuntimeEnvironment } from '@app/composables/useRuntimeEnvironment';
import { getReaderCommandMenuIcon } from '@app/utils/readerCommandIcons';
import {
    keepMenuFocusWhenItemsChange,
    keepMovedFocus,
} from '@app/utils/menuFocus';
import {TEXT_EDIT_MENU_CLASS} from '@app/constants/textEditMenuClass';
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
    onPointerDownOutside: (event: CustomEvent<{originalEvent: Event}>) => inTextEditMenu(event.detail.originalEvent.target) || (textEditSource.value = null),
    onCloseAutoFocus: (event: Event) => {
        // Dismissing the menu returns to the text it was opened over.
        const source = textEditSource.value;
        textEditSource.value = null;
        const active = document.activeElement;
        if (source !== null && (active === document.body || inTextEditMenu(active)) && restoreTextEditSource(source)) {
            event.preventDefault();
            return;
        }
        keepMovedFocus(event);
    },
};

// Cut, Copy, Paste and Select All act on what had input before the menu opened,
// borrowed for this opening only, in an active workspace. The menu is not modal,
// as a focus trap would take back the focus they restore; its trigger takes none.
const inTextEditMenu = (node: EventTarget | null) => node instanceof Element && node.closest(`.${TEXT_EDIT_MENU_CLASS}`) !== null;
interface ITextEditSource {
    element: HTMLElement;
    /** The element had focus, so restoring it must regain focus. */
    focused: boolean;
    selection: {
        start: number;
        end: number;
        direction: 'forward' | 'backward' | 'none';
    } | Range[];
}
const textEditSource = shallowRef<ITextEditSource | null>(null);
const toast = useToast();

function textControl(element: Element | null) {
    if (element instanceof HTMLTextAreaElement) return element;
    if (!(element instanceof HTMLInputElement)) return null;
    try {
        return element.selectionStart === null ? null : element;
    } catch {
        return null;
    }
}

function editingHost(element: Element | null) {
    let host = element instanceof HTMLElement && element.isContentEditable ? element : null;
    while (host?.parentElement?.isContentEditable) host = host.parentElement;
    return host;
}

function currentRanges() {
    const selection = window.getSelection();
    return selection === null ? [] : Array.from({length: selection.rangeCount}, (_, index) => selection.getRangeAt(index).cloneRange());
}

function readTextEditSource(focused: Element | null): ITextEditSource | null {
    const owner = focused instanceof HTMLElement && focused !== document.body && !inTextEditMenu(focused) ? focused : null;
    const control = textControl(owner);
    const host = editingHost(owner);
    // A focused annotation keeps its own selection routing, with or without selected text.
    const annotation = owner?.closest('.pdf-annotation-editor-layer') ? owner : null;
    const ranges = currentRanges();
    const selected = ranges.filter(range => !range.collapsed);
    // Selected document text leaves focus on the page; its range is the source.
    const container = selected[0]?.commonAncestorContainer;
    const focusedSource = control ?? host ?? annotation;
    const element = focusedSource ?? (container instanceof HTMLElement ? container : container?.parentElement ?? null);
    if (element === null || inTextEditMenu(element)) return null;
    return {
        element,
        focused: focusedSource !== null,
        selection: control === null ? host === null ? selected : ranges : {
            start: control.selectionStart ?? 0,
            end: control.selectionEnd ?? 0,
            direction: control.selectionDirection ?? 'none',
        },
    };
}

function captureTextEditSource(focused: Element | null = document.activeElement) {
    // The open menu's own trigger dismisses it; the source stays for that dismissal.
    if (!menuOpen.value) textEditSource.value = readTextEditSource(focused);
}

// Keyboard entry: focus leaving a source for this menu names the source.
useEventListener(typeof document === 'undefined' ? undefined : document, 'focusout', (event: FocusEvent) => {
    if (inTextEditMenu(event.relatedTarget) && event.target instanceof Element && !inTextEditMenu(event.target)) {
        captureTextEditSource(event.target);
    }
}, {capture: true});

function isTextEditSourceCurrent(source: ITextEditSource) {
    return source.element.isConnected
        && source.element.closest('[data-workspace-active]')?.getAttribute('data-workspace-active') !== 'false'
        && (!Array.isArray(source.selection) || source.selection.every(range => range.startContainer.isConnected && range.endContainer.isConnected));
}

function restoreTextEditSource(source: ITextEditSource) {
    if (!isTextEditSourceCurrent(source)) return false;
    source.element.focus({preventScroll: true});
    if (Array.isArray(source.selection)) {
        const selection = window.getSelection();
        selection?.removeAllRanges();
        for (const range of source.selection) selection?.addRange(range);
    } else {
        (source.element as HTMLInputElement).setSelectionRange(source.selection.start, source.selection.end, source.selection.direction);
    }
    return !source.focused || source.element.contains(document.activeElement);
}

function textEditState() {
    const source = textEditSource.value;
    const control = source === null ? null : textControl(source.element);
    const writable = control !== null
        ? !control.readOnly && !control.disabled
        : source !== null && editingHost(source.element) !== null;
    const selected = source !== null && (Array.isArray(source.selection)
        ? source.selection.some(range => !range.collapsed)
        : source.selection.start !== source.selection.end);
    const secret = control?.type === 'password';
    return {
        canCut: writable && selected && !secret,
        canCopy: selected && !secret,
        canPaste: writable,
    };
}

function warnTextEdit(key: 'menu.cutUnavailable' | 'menu.copyUnavailable' | 'menu.pasteUnavailable', shortcut: string) {
    toast.add({
        color: 'warning',
        title: t(key, {shortcut}),
    });
}

function takeTextEditSource() {
    const source = textEditSource.value;
    textEditSource.value = null;
    close();
    return source !== null && restoreTextEditSource(source) ? source : null;
}

/** The browser's own editing command: no other API keeps its clipboard trust, selection and undo. */
function runEditingCommand(command: 'cut' | 'copy' | 'insertText', value?: string) {
    // An engine without it offers its keyboard shortcuts only; the caller says so.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- no replacement keeps native undo and clipboard semantics.
    return typeof document.execCommand === 'function' && document.execCommand(command, false, value);
}

function runNativeTextEdit(command: 'cut' | 'copy') {
    // Inside the trusted selection event, so the browser keeps its own
    // clipboard, selection and undo semantics.
    if (takeTextEditSource() === null || !runEditingCommand(command)) {
        warnTextEdit(command === 'cut' ? 'menu.cutUnavailable' : 'menu.copyUnavailable', shortcutLabels.value[command]);
    }
}

/** The target's text and exact selection: a moved caret is a changed target. */
function snapshotTextEditTarget(source: ITextEditSource): unknown[] {
    const control = textControl(source.element);
    return control === null
        ? [
            source.element.textContent,
            ...currentRanges().flatMap(range => [
                range.startContainer,
                range.startOffset,
                range.endContainer,
                range.endOffset,
            ]),
        ]
        : [
            control.value,
            control.selectionStart,
            control.selectionEnd,
        ];
}

const isSameSnapshot = (left: unknown[], right: unknown[]) => left.length === right.length
    && left.every((value, index) => value === right[index]);

function pasteText() {
    const source = takeTextEditSource();
    const read = navigator.clipboard?.readText;
    if (source === null || read === undefined) {
        warnTextEdit('menu.pasteUnavailable', shortcutLabels.value.paste);
        return;
    }
    const before = snapshotTextEditTarget(source);
    // Read within the user's activation; the permission prompt, if any, is the browser's.
    void navigator.clipboard.readText().then((text) => {
        if (text === '') {
            toast.add({
                color: 'warning',
                title: t('menu.clipboardEmpty'),
            });
        } else if (!isTextEditSourceCurrent(source) || !source.element.contains(document.activeElement)
            || !isSameSnapshot(snapshotTextEditTarget(source), before)) {
            toast.add({
                color: 'warning',
                title: t('menu.pasteTargetChanged'),
            });
        } else if (!runEditingCommand('insertText', text)) {
            warnTextEdit('menu.pasteUnavailable', shortcutLabels.value.paste);
        }
    }, () => warnTextEdit('menu.pasteUnavailable', shortcutLabels.value.paste));
}

function selectAllText() {
    takeTextEditSource();
    dispatchBrowserMenuEvent('onMenuSelectAll');
}
const appMenuUi = {
    content: `app-menu toolbar-menu-panel ${TEXT_EDIT_MENU_CLASS}`,
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
keepMenuFocusWhenItemsChange(() => menuOpen.value, () => appMenuItems.value, '.app-menu.toolbar-menu-panel');

function buildFileItems(): TToolbarAppMenuItem[] {
    const writeBlocked = !hasInteractiveDocument.value || isAnySaving || isHistoryBusy;
    const items: TToolbarAppMenuItem[] = [
        {
            type: 'label',
            label: t('menu.file'),
        },
        createMenuEventItem('onMenuOpenPdf', t('menu.openFile'), getReaderCommandMenuIcon('open-file'), {shortcut: shortcutLabels.value.openFile}),
        createSubmenu(t('menu.openRecent'), 'i-ph-clock', buildOpenRecentItems()),
        createMenuEventItem('onMenuSave', t('menu.save'), getReaderCommandMenuIcon('save'), {
            disabled: writeBlocked || !canSave || isDjvuMode,
            shortcut: shortcutLabels.value.save,
        }),
        createMenuEventItem('onMenuRepairSave', t('menu.repairAndSave'), 'i-ph-magic-wand', {disabled: writeBlocked || !canRepairSave || isDjvuMode}),
        createMenuEventItem('onMenuOptimizePdfForInteraction', t('menu.optimizePdfForInteraction'), 'i-ph-gauge', {disabled: writeBlocked || !canOptimizePdf || isDjvuMode}),
        createMenuEventItem('onMenuSaveAs', t('menu.saveAs'), getReaderCommandMenuIcon('save-as'), {
            disabled: writeBlocked || !canSaveAs,
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
    const editDisabled = !hasInteractiveDocument.value || isDjvuMode;
    const historyDisabled = editDisabled || isAnySaving || isHistoryBusy;
    return [
        { type: 'separator' },
        {
            type: 'label',
            label: t('menu.edit'),
        },
        createMenuEventItem('onMenuUndo', t('menu.undo'), getReaderCommandMenuIcon('undo'), {
            disabled: historyDisabled || !canUndo,
            shortcut: shortcutLabels.value.undo,
        }),
        createMenuEventItem('onMenuRedo', t('menu.redo'), getReaderCommandMenuIcon('redo'), {
            disabled: historyDisabled || !canRedo,
            shortcut: shortcutLabels.value.redo,
        }),
        { type: 'separator' },
        ...buildTextEditItems(),
        { type: 'separator' },
        createMenuEventItem('onMenuInsertImageFromFile', t('menu.insertImageFromFile'), 'i-ph-image', {disabled: editDisabled}),
        createMenuEventItem('onMenuPasteImageFromClipboard', t('menu.pasteImageFromClipboard'), 'i-ph-clipboard-text', {disabled: editDisabled}),
        { type: 'separator' },
    ];
}

function buildTextEditItems(): TToolbarAppMenuItem[] {
    const state = textEditState();
    const item = (label: string, icon: string, shortcut: string, disabled: boolean, onSelect: () => void) => ({
        label,
        icon,
        disabled,
        shortcut,
        onSelect,
    });
    return [
        item(t('menu.cut'), 'i-ph-scissors', shortcutLabels.value.cut, !state.canCut, () => runNativeTextEdit('cut')),
        item(t('menu.copy'), 'i-ph-copy', shortcutLabels.value.copy, !state.canCopy, () => runNativeTextEdit('copy')),
        item(t('menu.paste'), 'i-ph-clipboard-text', shortcutLabels.value.paste, !state.canPaste, pasteText),
        item(t('menu.selectAll'), 'i-ph-selection-all', shortcutLabels.value.selectAll, false, selectAllText),
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
