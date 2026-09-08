import type {
    BaseWindow,
    MenuItemConstructorOptions,
} from 'electron';
import {
    app,
    BrowserWindow,
    Menu,
} from 'electron';
import {
    countBy,
    sortBy,
} from 'es-toolkit/array';
import { basename } from 'path';
import { parseDocumentRef } from '@contracts/documentRef';
import type {
    TTabId,
    TWindowTabsAction,
} from '@contracts/windowTabs';
import {
    WINDOW_TABS_PLATFORM_FEATURE,
    type IWindowTabsEventMap,
} from '@contracts/windowTabsPlatformFeature';
import type { IUpdatesEventMap } from '@contracts/updatesPlatformFeature';
import type { IApplicationMenuDocumentState } from '@contracts/electronApiDocuments';
import {
    DOCUMENT_MENU_PLATFORM_FEATURE,
    type IDocumentMenuEventMap as IDocumentsEventMap,
} from '@contracts/documentsPlatformFeature';
import { config } from '@electron/config';
import { createLogger } from '@electron/utils/createLogger';
import { getRecentFilesSync } from '@electron/recentFiles';
import { te } from '@electron/te';
import {
    CORE_IPC_EVENT_CHANNELS,
    type ICoreEventMap,
} from '@electron/platform-ipc/coreContract';
import {
    getAllRegisteredAppWindows,
    getWindowByIdFromRegistry,
} from '@electron/window/registry';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('menu');
const DOCUMENTS_EVENT_CHANNELS = DOCUMENT_MENU_PLATFORM_FEATURE.eventChannels;
const MENU_REBUILD_DEBOUNCE_MS = 40;
type TResolvedApplicationMenuDocumentState = Required<IApplicationMenuDocumentState>;

const EMPTY_MENU_DOCUMENT_STATE: TResolvedApplicationMenuDocumentState = {
    hasDocument: false,
    interactive: false,
    canSave: false,
    supportsSaveAs: false,
    canSaveAs: false,
    supportsRepairSave: false,
    canRepairSave: false,
    supportsOptimizePdf: false,
    canOptimizePdf: false,
    supportsPrint: false,
    canPrint: false,
    supportsExportDocx: false,
    canExportDocx: false,
    isExportingDocx: false,
    supportsRasterExport: false,
    canExportRaster: false,
    canUndo: false,
    canRedo: false,
    supportsPdfMutation: false,
    canMutatePages: false,
    selectedPageCount: 0,
    totalPages: 0,
    supportsContinuousScroll: false,
    canContinuousScroll: false,
    continuousScroll: false,
    supportsViewMode: false,
    viewMode: 'single',
    supportsViewRotation: false,
    viewRotation: 0,
    isActualSizeActive: false,
    isFitWidthActive: false,
    isFitHeightActive: false,
    canToggleAssistant: false,
    canCreatePane: true,
    canCloseTab: false,
    canTransferActiveTab: false,
};

const menuDocumentStateByWindow = new Map<number, TResolvedApplicationMenuDocumentState>();
const menuTabCountByWindow = new Map<number, number>();
const trackedWindowIds = new Set<number>();
let listenersRegistered = false;
let menuRebuildTimer: ReturnType<typeof setTimeout> | null = null;
let menuRebuildPending = false;

type TNativeMenuEventMap = IDocumentsEventMap & IUpdatesEventMap & IWindowTabsEventMap & Pick<
    ICoreEventMap,
    typeof CORE_IPC_EVENT_CHANNELS.menuCheckForUpdates
>;
type TNativeMenuChannel = Extract<keyof TNativeMenuEventMap, string>;
type TNativeMenuArgs<TChannel extends TNativeMenuChannel> =
    TNativeMenuEventMap[TChannel] extends undefined ? [] : [TNativeMenuEventMap[TChannel]];

interface IWindowMenuActionOptions<TChannel extends TNativeMenuChannel = TNativeMenuChannel> {
    label: string;
    channel: TChannel;
    accelerator?: string;
    enabled?: boolean;
    args?: TNativeMenuArgs<TChannel>;
}

interface ITextAwareWindowMenuActionOptions<TChannel extends TNativeMenuChannel = TNativeMenuChannel>
    extends IWindowMenuActionOptions<TChannel> {nativeEditCommand: 'undo' | 'redo';}

const TEXT_EDITING_FOCUS_SCRIPT = `
(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) {
        return false;
    }
    return element.isContentEditable
        || Boolean(element.closest('[contenteditable="true"], [contenteditable=""]'))
        || element instanceof HTMLInputElement
        || element instanceof HTMLTextAreaElement;
})()
`;
const ANNOTATION_SELECTION_FOCUS_SCRIPT = `
(() => {
    const element = document.activeElement;
    return element instanceof HTMLElement
        && !element.isContentEditable
        && !(element instanceof HTMLInputElement)
        && !(element instanceof HTMLTextAreaElement)
        && !(element instanceof HTMLSelectElement)
        && Boolean(element.closest('.pdf-annotation-editor-layer'));
})()
`;
const OPEN_ACKNOWLEDGEMENTS_PAGE_SCRIPT = `
(() => {
    window.history.pushState({}, '', '/about');
    window.dispatchEvent(new PopStateEvent('popstate'));
})()
`;

function getFocusedAppWindow() {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow && !focusedWindow.isDestroyed()) {
        return focusedWindow;
    }

    const windows = getAllRegisteredAppWindows();
    return windows[0] ?? null;
}

function getAppName() {
    return te('app.title');
}

function resolveWindowFromMenuContext(window: BaseWindow | undefined) {
    if (window instanceof BrowserWindow && !window.isDestroyed()) {
        return window;
    }

    return getFocusedAppWindow();
}

function getWindowDocumentState(window: BrowserWindow | null) {
    return window
        ? menuDocumentStateByWindow.get(window.id) ?? EMPTY_MENU_DOCUMENT_STATE
        : EMPTY_MENU_DOCUMENT_STATE;
}

function getWindowTabCount(window: BrowserWindow | null) {
    if (!window) {
        return 0;
    }

    return menuTabCountByWindow.get(window.id) ?? 0;
}

function getWindowDisplayLabel(window: BrowserWindow, duplicateCountByTitle: Record<string, number>) {
    const title = (window.getTitle() || te('app.title')).trim() || te('app.title');
    const duplicateCount = duplicateCountByTitle[title] ?? 0;
    if (duplicateCount <= 1) {
        return title;
    }

    return `${title} (${window.id})`;
}

function getOtherWindows(sourceWindowId: number) {
    return sortBy(
        getAllRegisteredAppWindows().filter(window => window.id !== sourceWindowId),
        [window => window.id],
    );
}

function buildDuplicateWindowTitleMap(windows: BrowserWindow[]) {
    return countBy(windows, window => (window.getTitle() || te('app.title')).trim() || te('app.title'));
}

function sendWindowTabsAction(sourceWindowId: number | null, action: TWindowTabsAction) {
    const sourceWindow = sourceWindowId === null
        ? getFocusedAppWindow()
        : (getWindowByIdFromRegistry(sourceWindowId) ?? getFocusedAppWindow());

    if (!sourceWindow) {
        return;
    }

    sendToWindow(sourceWindow, WINDOW_TABS_PLATFORM_FEATURE.eventChannels.onWindowAction, action);
}

function buildMoveToWindowSubmenu(
    sourceWindowId: number,
    tabId: TTabId | undefined,
): MenuItemConstructorOptions[] {
    return buildWindowTargetSubmenu(sourceWindowId, window => ({
        kind: 'move-tab-to-window',
        targetWindowId: window.id,
        ...(tabId ? { tabId } : {}),
    }));
}

function buildMergeWindowSubmenu(sourceWindowId: number): MenuItemConstructorOptions[] {
    return buildWindowTargetSubmenu(sourceWindowId, window => ({
        kind: 'merge-window-into',
        targetWindowId: window.id,
    }));
}

function buildWindowTargetSubmenu(
    sourceWindowId: number,
    createAction: (window: BaseWindow) => TWindowTabsAction,
): MenuItemConstructorOptions[] {
    const otherWindows = getOtherWindows(sourceWindowId);
    if (otherWindows.length === 0) {
        return [{
            label: te('menu.noOtherWindows'),
            enabled: false,
        }];
    }

    const duplicateCounts = buildDuplicateWindowTitleMap(otherWindows);

    return otherWindows.map((window) => ({
        label: getWindowDisplayLabel(window, duplicateCounts),
        click: () => {
            sendWindowTabsAction(sourceWindowId, createAction(window));
        },
    }));
}

export function sendToWindow<TChannel extends TNativeMenuChannel>(
    window: BaseWindow | undefined | null,
    channel: TChannel,
    ...args: TNativeMenuArgs<TChannel>
) {
    if (!(window instanceof BrowserWindow) || window.isDestroyed() || window.webContents.isDestroyed()) {
        return false;
    }

    try {
        window.webContents.send(channel, ...args);
        return true;
    } catch (error) {
        const message = getErrorMessage(error);
        // Menu clicks can race with window teardown; avoid surfacing this as a main-process crash.
        logger.warn(`Failed to send "${channel}" to renderer: ${message}`);
        return false;
    }
}

function createWindowMenuAction<TChannel extends TNativeMenuChannel>(
    options: IWindowMenuActionOptions<TChannel>,
): MenuItemConstructorOptions {
    const {
        label,
        channel,
        accelerator,
        enabled = true,
    } = options;
    const args = options.args ?? ([] as TNativeMenuArgs<TChannel>);

    return {
        label,
        ...(accelerator ? { accelerator } : {}),
        enabled,
        click: (_item, window) => {
            sendToWindow(resolveWindowFromMenuContext(window), channel, ...args);
        },
    };
}

async function isTextEditingFocused(window: BrowserWindow) {
    try {
        return Boolean(await window.webContents.executeJavaScript(TEXT_EDITING_FOCUS_SCRIPT, true));
    } catch (error) {
        logger.warn(`Failed to inspect focused edit target: ${getErrorMessage(error)}`);
        return false;
    }
}

function createTextAwareWindowMenuAction<TChannel extends TNativeMenuChannel>(
    options: ITextAwareWindowMenuActionOptions<TChannel>,
): MenuItemConstructorOptions {
    const {
        label,
        channel,
        accelerator,
        enabled = true,
        nativeEditCommand,
    } = options;
    const args = options.args ?? ([] as TNativeMenuArgs<TChannel>);

    return {
        label,
        ...(accelerator ? { accelerator } : {}),
        click: (_item, window) => {
            void (async () => {
                const targetWindow = resolveWindowFromMenuContext(window);
                if (!targetWindow) {
                    return;
                }

                if (await isTextEditingFocused(targetWindow)) {
                    if (targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
                        return;
                    }

                    try {
                        targetWindow.webContents[nativeEditCommand]();
                    } catch (error) {
                        logger.warn(`Failed to invoke native ${nativeEditCommand}: ${getErrorMessage(error)}`);
                    }
                    return;
                }

                if (enabled) {
                    sendToWindow(targetWindow, channel, ...args);
                }
            })().catch(error => logger.warn(`Failed to handle menu action "${channel}": ${getErrorMessage(error)}`));
        },
    };
}

function createSelectAllMenuAction(): MenuItemConstructorOptions {
    return {
        label: te('menu.selectAll'),
        accelerator: 'CmdOrCtrl+A',
        click: (_item, window) => {
            void (async () => {
                const targetWindow = resolveWindowFromMenuContext(window);
                if (!targetWindow) {
                    return;
                }
                const annotationFocused: unknown = await targetWindow.webContents.executeJavaScript(
                    ANNOTATION_SELECTION_FOCUS_SCRIPT,
                    true,
                );
                if (targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
                    return;
                }
                if (annotationFocused === true) {
                    sendToWindow(targetWindow, DOCUMENTS_EVENT_CHANNELS.onMenuSelectAll);
                } else {
                    targetWindow.webContents.selectAll();
                }
            })().catch(error => logger.warn(`Failed to handle Select All: ${getErrorMessage(error)}`));
        },
    };
}

function buildRecentFilesSubmenu(): MenuItemConstructorOptions[] {
    const recentFiles = getRecentFilesSync();

    if (recentFiles.length === 0) {
        return [{
            label: te('menu.noRecentFiles'),
            enabled: false,
        }];
    }

    const fileItems: MenuItemConstructorOptions[] = recentFiles.map((filePath) => ({
        label: basename(filePath),
        click: (_, window) => {
            const documentRef = parseDocumentRef(filePath);
            if (documentRef === null) {
                return;
            }
            sendToWindow(
                resolveWindowFromMenuContext(window),
                DOCUMENTS_EVENT_CHANNELS.onMenuOpenRecentFile,
                documentRef,
            );
        },
    }));

    return [
        ...fileItems,
        { type: 'separator' },
        {
            label: te('menu.clearRecentFiles'),
            click: (_, window) => {
                sendToWindow(resolveWindowFromMenuContext(window), DOCUMENTS_EVENT_CHANNELS.onMenuClearRecentFiles);
            },
        },
    ];
}

function getFileMenu(state: TResolvedApplicationMenuDocumentState): MenuItemConstructorOptions {
    const exportItems: MenuItemConstructorOptions[] = [
        ...(state.supportsExportDocx ? [createWindowMenuAction({
            label: state.isExportingDocx ? te('ocr.cancel') : te('menu.exportDocx'),
            accelerator: 'CmdOrCtrl+Shift+E',
            enabled: state.canExportDocx,
            channel: DOCUMENTS_EVENT_CHANNELS.onMenuExportDocx,
        })] : []),
        ...(state.supportsRasterExport ? [
            createWindowMenuAction({
                label: te('menu.exportImages'),
                enabled: state.canExportRaster,
                channel: DOCUMENTS_EVENT_CHANNELS.onMenuExportImages,
            }),
            createWindowMenuAction({
                label: te('menu.exportMultiPageTiff'),
                enabled: state.canExportRaster,
                channel: DOCUMENTS_EVENT_CHANNELS.onMenuExportMultiPageTiff,
            }),
        ] : []),
    ];

    return {
        label: te('menu.file'),
        submenu: [
            createWindowMenuAction({
                label: te('menu.openFile'),
                accelerator: 'CmdOrCtrl+O',
                channel: DOCUMENTS_EVENT_CHANNELS.onMenuOpenPdf,
            }),
            {
                label: te('menu.openRecent'),
                submenu: buildRecentFilesSubmenu(),
            },
            createWindowMenuAction({
                label: te('menu.save'),
                accelerator: 'CmdOrCtrl+S',
                enabled: state.canSave,
                channel: DOCUMENTS_EVENT_CHANNELS.onMenuSave,
            }),
            ...(state.supportsRepairSave ? [createWindowMenuAction({
                label: te('menu.repairAndSave'),
                enabled: state.canRepairSave,
                channel: DOCUMENTS_EVENT_CHANNELS.onMenuRepairSave,
            })] : []),
            ...(state.supportsOptimizePdf ? [createWindowMenuAction({
                label: te('menu.optimizePdfForInteraction'),
                enabled: state.canOptimizePdf,
                channel: DOCUMENTS_EVENT_CHANNELS.onMenuOptimizePdfForInteraction,
            })] : []),
            ...(state.supportsSaveAs ? [createWindowMenuAction({
                label: te('menu.saveAs'),
                accelerator: 'CmdOrCtrl+Shift+S',
                enabled: state.canSaveAs,
                channel: DOCUMENTS_EVENT_CHANNELS.onMenuSaveAs,
            })] : []),
            ...(state.supportsPrint ? [
                createWindowMenuAction({
                    label: te('menu.print'),
                    accelerator: 'CmdOrCtrl+P',
                    enabled: state.canPrint,
                    channel: DOCUMENTS_EVENT_CHANNELS.onMenuPrint,
                }),
                createWindowMenuAction({
                    label: te('menu.printCurrentPage'),
                    enabled: state.canPrint,
                    channel: DOCUMENTS_EVENT_CHANNELS.onMenuPrintCurrentPage,
                }),
            ] : []),
            ...(exportItems.length > 0 ? [{
                label: te('menu.export'),
                submenu: exportItems,
            } satisfies MenuItemConstructorOptions] : []),
            { type: 'separator' },
            createWindowMenuAction({
                label: te('menu.newTab'),
                accelerator: 'CmdOrCtrl+T',
                channel: WINDOW_TABS_PLATFORM_FEATURE.eventChannels.onMenuNewTab,
            }),
            createWindowMenuAction({
                label: te('menu.closeTab'),
                accelerator: 'CmdOrCtrl+W',
                enabled: state.canCloseTab,
                channel: WINDOW_TABS_PLATFORM_FEATURE.eventChannels.onMenuCloseTab,
            }),
            ...(config.isMac ? [] : [
                { type: 'separator' as const },
                {
                    label: te('menu.quit'),
                    accelerator: 'CmdOrCtrl+Q',
                    click: () => {
                        app.quit();
                    },
                },
            ]),
        ],
    };
}

function getEditMenu(state: TResolvedApplicationMenuDocumentState): MenuItemConstructorOptions {
    return {
        label: te('menu.edit'),
        submenu: [
            ...(state.supportsPdfMutation ? [
                createWindowMenuAction({
                    label: te('menu.insertImageFromFile'),
                    accelerator: 'CmdOrCtrl+Shift+I',
                    enabled: state.canMutatePages,
                    channel: DOCUMENTS_EVENT_CHANNELS.onMenuInsertImageFromFile,
                }),
                createWindowMenuAction({
                    label: te('menu.pasteImageFromClipboard'),
                    accelerator: 'CmdOrCtrl+Shift+V',
                    enabled: state.canMutatePages,
                    channel: DOCUMENTS_EVENT_CHANNELS.onMenuPasteImageFromClipboard,
                }),
                { type: 'separator' as const },
            ] : []),
            createTextAwareWindowMenuAction({
                label: te('menu.undo'),
                accelerator: 'CmdOrCtrl+Z',
                enabled: state.canUndo,
                channel: DOCUMENTS_EVENT_CHANNELS.onMenuUndo,
                nativeEditCommand: 'undo',
            }),
            createTextAwareWindowMenuAction({
                label: te('menu.redo'),
                accelerator: config.isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y',
                enabled: state.canRedo,
                channel: DOCUMENTS_EVENT_CHANNELS.onMenuRedo,
                nativeEditCommand: 'redo',
            }),
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            createSelectAllMenuAction(),
        ],
    };
}

function getPagesMenu(state: TResolvedApplicationMenuDocumentState): MenuItemConstructorOptions {
    const hasSelection = state.selectedPageCount > 0;
    const canOperateOnSelection = state.canMutatePages && hasSelection;
    return {
        label: te('menu.pages'),
        submenu: [
            createWindowMenuAction({
                label: te('menu.deleteSelectedPages'),
                enabled: canOperateOnSelection && state.selectedPageCount < state.totalPages,
                channel: DOCUMENTS_EVENT_CHANNELS.onMenuDeletePages,
            }),
            createWindowMenuAction({
                label: te('menu.extractSelectedPages'),
                enabled: canOperateOnSelection,
                channel: DOCUMENTS_EVENT_CHANNELS.onMenuExtractPages,
            }),
            { type: 'separator' },
            createWindowMenuAction({
                label: te('menu.rotateClockwise'),
                enabled: canOperateOnSelection,
                channel: DOCUMENTS_EVENT_CHANNELS.onMenuRotateCw,
            }),
            createWindowMenuAction({
                label: te('menu.rotateCounterclockwise'),
                enabled: canOperateOnSelection,
                channel: DOCUMENTS_EVENT_CHANNELS.onMenuRotateCcw,
            }),
            { type: 'separator' },
            createWindowMenuAction({
                label: te('menu.insertPages'),
                enabled: state.canMutatePages,
                channel: DOCUMENTS_EVENT_CHANNELS.onMenuInsertPages,
            }),
        ],
    };
}

function getViewMenu(state: TResolvedApplicationMenuDocumentState): MenuItemConstructorOptions {
    const documentActionsEnabled = state.interactive;
    return {
        label: te('menu.view'),
        submenu: [
            createWindowMenuAction({
                label: te('menu.zoomIn'),
                accelerator: 'CmdOrCtrl+=',
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.onMenuZoomIn,
            }),
            createWindowMenuAction({
                label: te('menu.zoomOut'),
                accelerator: 'CmdOrCtrl+-',
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.onMenuZoomOut,
            }),
            { type: 'separator' },
            {
                ...createWindowMenuAction({
                    label: te('menu.actualSize'),
                    accelerator: 'CmdOrCtrl+0',
                    enabled: documentActionsEnabled,
                    channel: DOCUMENTS_EVENT_CHANNELS.onMenuActualSize,
                }),
                type: 'radio',
                checked: state.isActualSizeActive,
            },
            {
                ...createWindowMenuAction({
                    label: te('menu.fitWidth'),
                    accelerator: 'CmdOrCtrl+1',
                    enabled: documentActionsEnabled,
                    channel: DOCUMENTS_EVENT_CHANNELS.onMenuFitWidth,
                }),
                type: 'radio',
                checked: state.isFitWidthActive,
            },
            {
                ...createWindowMenuAction({
                    label: te('menu.fitHeight'),
                    accelerator: 'CmdOrCtrl+2',
                    enabled: documentActionsEnabled,
                    channel: DOCUMENTS_EVENT_CHANNELS.onMenuFitHeight,
                }),
                type: 'radio',
                checked: state.isFitHeightActive,
            },
            ...(state.supportsContinuousScroll ? [
                { type: 'separator' as const },
                {
                    ...createWindowMenuAction({
                        label: te('zoom.continuousScroll'),
                        enabled: state.canContinuousScroll,
                        channel: DOCUMENTS_EVENT_CHANNELS.onMenuToggleContinuousScroll,
                    }),
                    type: 'checkbox' as const,
                    checked: state.continuousScroll,
                },
            ] : []),
            ...(state.supportsViewMode ? [
                { type: 'separator' as const },
                {
                    ...createWindowMenuAction({
                        label: te('menu.singlePage'),
                        enabled: documentActionsEnabled,
                        channel: DOCUMENTS_EVENT_CHANNELS.onMenuViewModeSingle,
                    }),
                    type: 'radio' as const,
                    checked: state.viewMode === 'single',
                },
                {
                    ...createWindowMenuAction({
                        label: te('menu.facingPages'),
                        enabled: documentActionsEnabled,
                        channel: DOCUMENTS_EVENT_CHANNELS.onMenuViewModeFacing,
                    }),
                    type: 'radio' as const,
                    checked: state.viewMode === 'facing',
                },
                {
                    ...createWindowMenuAction({
                        label: te('menu.facingWithFirstSingle'),
                        enabled: documentActionsEnabled,
                        channel: DOCUMENTS_EVENT_CHANNELS.onMenuViewModeFacingFirstSingle,
                    }),
                    type: 'radio' as const,
                    checked: state.viewMode === 'facing-first-single',
                },
            ] : []),
            ...(state.supportsViewRotation ? [
                { type: 'separator' as const },
                createWindowMenuAction({
                    label: te('menu.rotateViewClockwise'),
                    enabled: documentActionsEnabled,
                    channel: DOCUMENTS_EVENT_CHANNELS.onMenuViewRotationCw,
                }),
                createWindowMenuAction({
                    label: te('menu.rotateViewCounterclockwise'),
                    enabled: documentActionsEnabled,
                    channel: DOCUMENTS_EVENT_CHANNELS.onMenuViewRotationCcw,
                }),
            ] : []),
            ...(state.canToggleAssistant ? [
                { type: 'separator' as const },
                createWindowMenuAction({
                    label: te('menu.assistant'),
                    accelerator: 'CmdOrCtrl+Shift+A',
                    channel: DOCUMENTS_EVENT_CHANNELS.onMenuToggleAssistant,
                }),
            ] : []),
            { type: 'separator' },
            createWindowMenuAction({
                label: te('menu.newPaneRight'),
                channel: WINDOW_TABS_PLATFORM_FEATURE.eventChannels.onMenuSplitEditor,
                accelerator: 'CmdOrCtrl+\\',
                enabled: state.canCreatePane,
                args: ['right'],
            }),
            createWindowMenuAction({
                label: te('menu.newPaneDown'),
                channel: WINDOW_TABS_PLATFORM_FEATURE.eventChannels.onMenuSplitEditor,
                enabled: state.canCreatePane,
                args: ['down'],
            }),
            { type: 'separator' },
            { role: 'toggleDevTools' },
        ],
    };
}

function getWindowMenu(
    activeWindow: BrowserWindow | null,
    state: TResolvedApplicationMenuDocumentState,
): MenuItemConstructorOptions {
    const sourceWindowId = activeWindow?.id ?? null;
    const hasTargets = sourceWindowId === null
        ? false
        : getOtherWindows(sourceWindowId).length > 0;
    const canMoveActiveTabToNewWindow = state.canTransferActiveTab && getWindowTabCount(activeWindow) > 1;

    return {
        label: te('menu.window'),
        submenu: [
            { role: 'minimize' },
            { role: 'close' },
            { type: 'separator' },
            {
                label: te('menu.moveActiveTabToNewWindow'),
                enabled: sourceWindowId !== null && canMoveActiveTabToNewWindow,
                click: () => {
                    sendWindowTabsAction(sourceWindowId, {kind: 'move-tab-to-new-window'});
                },
            },
            {
                label: te('menu.moveActiveTabToWindow'),
                enabled: sourceWindowId !== null && state.canTransferActiveTab && hasTargets,
                submenu: sourceWindowId === null
                    ? [{
                        label: te('menu.noOtherWindows'),
                        enabled: false,
                    }]
                    : buildMoveToWindowSubmenu(sourceWindowId, undefined),
            },
            {
                label: te('menu.mergeWindowInto'),
                enabled: sourceWindowId !== null && hasTargets,
                submenu: sourceWindowId === null
                    ? [{
                        label: te('menu.noOtherWindows'),
                        enabled: false,
                    }]
                    : buildMergeWindowSubmenu(sourceWindowId),
            },
            ...(config.isMac ? [
                { type: 'separator' as const },
                { role: 'front' as const },
            ] : []),
        ],
    };
}

function getHelpMenu(): MenuItemConstructorOptions {
    return {
        label: te('menu.help'),
        submenu: [
            createWindowMenuAction({
                label: te('menu.checkForUpdates'),
                channel: CORE_IPC_EVENT_CHANNELS.menuCheckForUpdates,
            }),
            { type: 'separator' },
            config.isMac
                ? { role: 'about' }
                : {
                    label: te('menu.about'),
                    click: () => { app.showAboutPanel(); },
                },
            { type: 'separator' },
            {
                label: te('menu.acknowledgements'),
                click: (_item, window) => {
                    const targetWindow = resolveWindowFromMenuContext(window);
                    if (!targetWindow || targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
                        return;
                    }

                    void targetWindow.webContents.executeJavaScript(OPEN_ACKNOWLEDGEMENTS_PAGE_SCRIPT, true).catch((error) => {
                        logger.warn(`Failed to open acknowledgements page: ${getErrorMessage(error)}`);
                    });
                },
            },
        ],
    };
}

function getMacAppMenu(): MenuItemConstructorOptions {
    return {
        label: getAppName(),
        submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
        ],
    };
}

function buildMenuTemplate(activeWindow: BrowserWindow | null): MenuItemConstructorOptions[] {
    const template: MenuItemConstructorOptions[] = [];
    const state = getWindowDocumentState(activeWindow);

    if (config.isMac) {
        template.push(getMacAppMenu());
    }

    template.push(
        getFileMenu(state),
        getEditMenu(state),
        ...(state.supportsPdfMutation ? [getPagesMenu(state)] : []),
        getViewMenu(state),
        getWindowMenu(activeWindow, state),
        getHelpMenu(),
    );

    return template;
}

function rebuildMenuNow() {
    const activeWindow = getFocusedAppWindow();
    const template = buildMenuTemplate(activeWindow);
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

function rebuildMenu(immediate = false) {
    if (immediate) {
        if (menuRebuildTimer) {
            clearTimeout(menuRebuildTimer);
            menuRebuildTimer = null;
        }
        menuRebuildPending = false;
        rebuildMenuNow();
        return;
    }

    menuRebuildPending = true;
    if (menuRebuildTimer) {
        return;
    }

    menuRebuildTimer = setTimeout(() => {
        menuRebuildTimer = null;

        if (!menuRebuildPending) {
            return;
        }
        menuRebuildPending = false;
        rebuildMenuNow();
    }, MENU_REBUILD_DEBOUNCE_MS);
}

function rebuildMenuForWindowStateChange(windowId: number) {
    const focusedWindow = getFocusedAppWindow();
    rebuildMenu(focusedWindow?.id === windowId);
}

function trackWindowForMenu(window: BrowserWindow) {
    if (trackedWindowIds.has(window.id)) {
        return;
    }

    trackedWindowIds.add(window.id);

    window.on('page-title-updated', () => {
        rebuildMenu();
    });

    window.on('closed', () => {
        trackedWindowIds.delete(window.id);
        menuDocumentStateByWindow.delete(window.id);
        menuTabCountByWindow.delete(window.id);
        rebuildMenu();
    });
}

function registerMenuListeners() {
    if (listenersRegistered) {
        return;
    }

    listenersRegistered = true;

    app.on('browser-window-focus', () => {
        rebuildMenu();
    });

    app.on('browser-window-blur', () => {
        rebuildMenu();
    });

    app.on('browser-window-created', (_event, window) => {
        trackWindowForMenu(window);
        rebuildMenu();
    });

}

export function setupMenu() {
    registerMenuListeners();
    for (const window of getAllRegisteredAppWindows()) {
        trackWindowForMenu(window);
    }
    rebuildMenu(true);
}

export function updateRecentFilesMenu() {
    rebuildMenu();
}

export function refreshMenu() {
    rebuildMenu(true);
}

function normalizeMenuDocumentState(
    state: boolean | IApplicationMenuDocumentState,
): TResolvedApplicationMenuDocumentState {
    const hasDocument = typeof state === 'boolean' ? state : state.hasDocument;
    const value = typeof state === 'boolean' ? null : state;
    const interactive = value?.interactive ?? hasDocument;
    const canRepairSave = value?.canRepairSave ?? hasDocument;
    const canContinuousScroll = value?.canContinuousScroll ?? false;
    return {
        hasDocument,
        interactive,
        canSave: value?.canSave ?? hasDocument,
        supportsSaveAs: value?.supportsSaveAs ?? hasDocument,
        canSaveAs: value?.canSaveAs ?? hasDocument,
        supportsRepairSave: value?.supportsRepairSave ?? hasDocument,
        canRepairSave,
        supportsOptimizePdf: value?.supportsOptimizePdf ?? hasDocument,
        canOptimizePdf: value?.canOptimizePdf ?? canRepairSave,
        supportsPrint: value?.supportsPrint ?? hasDocument,
        canPrint: value?.canPrint ?? hasDocument,
        supportsExportDocx: value?.supportsExportDocx ?? hasDocument,
        canExportDocx: value?.canExportDocx ?? hasDocument,
        isExportingDocx: value?.isExportingDocx ?? false,
        supportsRasterExport: value?.supportsRasterExport ?? hasDocument,
        canExportRaster: value?.canExportRaster ?? hasDocument,
        canUndo: value?.canUndo ?? hasDocument,
        canRedo: value?.canRedo ?? hasDocument,
        supportsPdfMutation: value?.supportsPdfMutation ?? hasDocument,
        canMutatePages: value?.canMutatePages ?? hasDocument,
        selectedPageCount: value?.selectedPageCount ?? 0,
        totalPages: value?.totalPages ?? 0,
        supportsContinuousScroll: value?.supportsContinuousScroll ?? canContinuousScroll,
        canContinuousScroll: interactive && canContinuousScroll,
        continuousScroll: value?.continuousScroll ?? false,
        supportsViewMode: value?.supportsViewMode ?? hasDocument,
        viewMode: value?.viewMode ?? 'single',
        supportsViewRotation: value?.supportsViewRotation ?? hasDocument,
        viewRotation: value?.viewRotation ?? 0,
        isActualSizeActive: value?.isActualSizeActive ?? false,
        isFitWidthActive: value?.isFitWidthActive ?? false,
        isFitHeightActive: value?.isFitHeightActive ?? false,
        canToggleAssistant: value?.canToggleAssistant ?? hasDocument,
        canCreatePane: value?.canCreatePane ?? true,
        canCloseTab: value?.canCloseTab ?? true,
        canTransferActiveTab: value?.canTransferActiveTab ?? true,
    };
}

export function setMenuDocumentState(
    windowId: number,
    state: boolean | IApplicationMenuDocumentState,
) {
    const normalized = normalizeMenuDocumentState(state);
    if (JSON.stringify(menuDocumentStateByWindow.get(windowId)) === JSON.stringify(normalized)) {
        return;
    }

    menuDocumentStateByWindow.set(windowId, normalized);
    rebuildMenuForWindowStateChange(windowId);
}

export function setMenuTabCount(windowId: number, tabCount: number) {
    const normalized = Number.isFinite(tabCount)
        ? Math.max(0, Math.floor(tabCount))
        : 0;
    if (menuTabCountByWindow.get(windowId) === normalized) {
        return;
    }

    menuTabCountByWindow.set(windowId, normalized);
    rebuildMenuForWindowStateChange(windowId);
}
