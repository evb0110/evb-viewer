import type {
    BaseWindow,
    MenuItemConstructorOptions,
} from 'electron';
import {
    app,
    BrowserWindow,
    Menu,
} from 'electron';
import { basename } from 'path';
import type { TWindowTabsAction } from '@app/types/window-tab-transfer';
import { config } from '@electron/config';
import { getRecentFilesSync } from '@electron/recent-files';
import { te } from '@electron/i18n';
import {
    getAllAppWindows,
    getWindowById,
} from '@electron/window';

const appName = te('app.title');
const WINDOW_TABS_ACTION_CHANNEL = 'menu:windowTabsAction';
const menuDocumentStateByWindow = new Map<number, boolean>();
const menuTabCountByWindow = new Map<number, number>();
const trackedWindowIds = new Set<number>();
let listenersRegistered = false;

interface IWindowMenuActionOptions {
    label: string;
    channel: string;
    accelerator?: string;
    enabled?: boolean;
    args?: unknown[];
}

function getFocusedAppWindow() {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow && !focusedWindow.isDestroyed()) {
        return focusedWindow;
    }

    const windows = getAllAppWindows();
    return windows[0] ?? null;
}

function resolveWindowFromMenuContext(window: BaseWindow | undefined) {
    if (window instanceof BrowserWindow && !window.isDestroyed()) {
        return window;
    }

    return getFocusedAppWindow();
}

function getWindowDocumentState(window: BrowserWindow | null) {
    if (!window) {
        return false;
    }

    return menuDocumentStateByWindow.get(window.id) ?? false;
}

function getWindowTabCount(window: BrowserWindow | null) {
    if (!window) {
        return 0;
    }

    return menuTabCountByWindow.get(window.id) ?? 0;
}

function getWindowDisplayLabel(window: BrowserWindow, duplicateCountByTitle: Map<string, number>) {
    const title = (window.getTitle() || te('app.title')).trim() || te('app.title');
    const duplicateCount = duplicateCountByTitle.get(title) ?? 0;
    if (duplicateCount <= 1) {
        return title;
    }

    return `${title} (${window.id})`;
}

function getOtherWindows(sourceWindowId: number) {
    const windows = getAllAppWindows().filter(window => window.id !== sourceWindowId);
    windows.sort((left, right) => left.id - right.id);
    return windows;
}

function buildDuplicateWindowTitleMap(windows: BrowserWindow[]) {
    const counts = new Map<string, number>();
    for (const window of windows) {
        const title = (window.getTitle() || te('app.title')).trim() || te('app.title');
        counts.set(title, (counts.get(title) ?? 0) + 1);
    }
    return counts;
}

function sendWindowTabsAction(sourceWindowId: number | null, action: TWindowTabsAction) {
    const sourceWindow = sourceWindowId === null
        ? getFocusedAppWindow()
        : (getWindowById(sourceWindowId) ?? getFocusedAppWindow());

    if (!sourceWindow) {
        return;
    }

    sendToWindow(sourceWindow, WINDOW_TABS_ACTION_CHANNEL, action);
}

function buildMoveToWindowSubmenu(
    sourceWindowId: number,
    tabId: string | undefined,
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
            sendWindowTabsAction(sourceWindowId, {
                kind: 'move-tab-to-window',
                targetWindowId: window.id,
                ...(tabId ? { tabId } : {}),
            });
        },
    }));
}

function buildMergeWindowSubmenu(sourceWindowId: number): MenuItemConstructorOptions[] {
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
            sendWindowTabsAction(sourceWindowId, {
                kind: 'merge-window-into',
                targetWindowId: window.id,
            });
        },
    }));
}

export function sendToWindow(window: BaseWindow | undefined | null, channel: string, ...args: unknown[]) {
    if (window instanceof BrowserWindow && !window.isDestroyed()) {
        window.webContents.send(channel, ...args);
    }
}

function createWindowMenuAction(options: IWindowMenuActionOptions): MenuItemConstructorOptions {
    const {
        label,
        channel,
        accelerator,
        enabled = true,
        args = [],
    } = options;

    return {
        label,
        ...(accelerator ? { accelerator } : {}),
        enabled,
        click: (_item, window) => {
            sendToWindow(resolveWindowFromMenuContext(window), channel, ...args);
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
            sendToWindow(resolveWindowFromMenuContext(window), 'menu:openRecentFile', filePath);
        },
    }));

    return [
        ...fileItems,
        { type: 'separator' },
        {
            label: te('menu.clearRecentFiles'),
            click: (_, window) => {
                sendToWindow(resolveWindowFromMenuContext(window), 'menu:clearRecentFiles');
            },
        },
    ];
}

function getFileMenu(documentActionsEnabled: boolean): MenuItemConstructorOptions {
    return {
        label: te('menu.file'),
        submenu: [
            createWindowMenuAction({
                label: te('menu.openFile'),
                accelerator: 'CmdOrCtrl+O',
                channel: 'menu:openPdf',
            }),
            {
                label: te('menu.openRecent'),
                submenu: buildRecentFilesSubmenu(),
            },
            createWindowMenuAction({
                label: te('menu.save'),
                accelerator: 'CmdOrCtrl+S',
                enabled: documentActionsEnabled,
                channel: 'menu:save',
            }),
            createWindowMenuAction({
                label: te('menu.saveAs'),
                accelerator: 'CmdOrCtrl+Shift+S',
                enabled: documentActionsEnabled,
                channel: 'menu:saveAs',
            }),
            {
                label: te('menu.export'),
                enabled: documentActionsEnabled,
                submenu: [
                    createWindowMenuAction({
                        label: te('menu.exportDocx'),
                        accelerator: 'CmdOrCtrl+Shift+E',
                        channel: 'menu:exportDocx',
                    }),
                    createWindowMenuAction({
                        label: te('menu.exportImages'),
                        channel: 'menu:exportImages',
                    }),
                    createWindowMenuAction({
                        label: te('menu.exportMultiPageTiff'),
                        channel: 'menu:exportMultiPageTiff',
                    }),
                ],
            },
            createWindowMenuAction({
                label: te('menu.convertToPdf'),
                channel: 'menu:convertToPdf',
            }),
            { type: 'separator' },
            createWindowMenuAction({
                label: te('menu.newTab'),
                accelerator: 'CmdOrCtrl+T',
                channel: 'menu:newTab',
            }),
            createWindowMenuAction({
                label: te('menu.closeTab'),
                accelerator: 'CmdOrCtrl+W',
                channel: 'menu:closeTab',
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

function getEditMenu(documentActionsEnabled: boolean): MenuItemConstructorOptions {
    return {
        label: te('menu.actions'),
        submenu: [
            createWindowMenuAction({
                label: te('menu.undo'),
                accelerator: 'CmdOrCtrl+Z',
                enabled: documentActionsEnabled,
                channel: 'menu:undo',
            }),
            createWindowMenuAction({
                label: te('menu.redo'),
                accelerator: config.isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y',
                enabled: documentActionsEnabled,
                channel: 'menu:redo',
            }),
            { type: 'separator' },
            {
                label: te('menu.copy'),
                accelerator: 'CmdOrCtrl+C',
                click: (_item, window) => {
                    (resolveWindowFromMenuContext(window) as Electron.BrowserWindow | null)?.webContents.copy();
                },
            },
        ],
    };
}

function getPagesMenu(documentActionsEnabled: boolean): MenuItemConstructorOptions {
    return {
        label: te('menu.pages'),
        enabled: documentActionsEnabled,
        submenu: [
            createWindowMenuAction({
                label: te('menu.deleteSelectedPages'),
                channel: 'menu:deletePages',
            }),
            createWindowMenuAction({
                label: te('menu.extractSelectedPages'),
                channel: 'menu:extractPages',
            }),
            { type: 'separator' },
            createWindowMenuAction({
                label: te('menu.rotateClockwise'),
                channel: 'menu:rotateCw',
            }),
            createWindowMenuAction({
                label: te('menu.rotateCounterclockwise'),
                channel: 'menu:rotateCcw',
            }),
            { type: 'separator' },
            createWindowMenuAction({
                label: te('menu.insertPages'),
                channel: 'menu:insertPages',
            }),
        ],
    };
}

function getViewMenu(documentActionsEnabled: boolean): MenuItemConstructorOptions {
    return {
        label: te('menu.view'),
        submenu: [
            createWindowMenuAction({
                label: te('menu.zoomIn'),
                accelerator: 'CmdOrCtrl+=',
                enabled: documentActionsEnabled,
                channel: 'menu:zoomIn',
            }),
            createWindowMenuAction({
                label: te('menu.zoomOut'),
                accelerator: 'CmdOrCtrl+-',
                enabled: documentActionsEnabled,
                channel: 'menu:zoomOut',
            }),
            createWindowMenuAction({
                label: te('menu.actualSize'),
                accelerator: 'CmdOrCtrl+0',
                enabled: documentActionsEnabled,
                channel: 'menu:actualSize',
            }),
            { type: 'separator' },
            createWindowMenuAction({
                label: te('menu.fitWidth'),
                accelerator: 'CmdOrCtrl+1',
                enabled: documentActionsEnabled,
                channel: 'menu:fitWidth',
            }),
            createWindowMenuAction({
                label: te('menu.fitHeight'),
                accelerator: 'CmdOrCtrl+2',
                enabled: documentActionsEnabled,
                channel: 'menu:fitHeight',
            }),
            { type: 'separator' },
            createWindowMenuAction({
                label: te('menu.singlePage'),
                enabled: documentActionsEnabled,
                channel: 'menu:viewModeSingle',
            }),
            createWindowMenuAction({
                label: te('menu.facingPages'),
                enabled: documentActionsEnabled,
                channel: 'menu:viewModeFacing',
            }),
            createWindowMenuAction({
                label: te('menu.facingWithFirstSingle'),
                enabled: documentActionsEnabled,
                channel: 'menu:viewModeFacingFirstSingle',
            }),
            { type: 'separator' },
            {
                label: te('menu.editorGroups'),
                submenu: [
                    {
                        label: te('menu.splitEditor'),
                        submenu: [
                            createWindowMenuAction({
                                label: te('menu.splitEditorRight'),
                                channel: 'menu:splitEditor',
                                accelerator: 'CmdOrCtrl+\\',
                                args: ['right'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.splitEditorLeft'),
                                channel: 'menu:splitEditor',
                                args: ['left'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.splitEditorUp'),
                                channel: 'menu:splitEditor',
                                args: ['up'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.splitEditorDown'),
                                channel: 'menu:splitEditor',
                                args: ['down'],
                            }),
                        ],
                    },
                    {
                        label: te('menu.focusEditorGroup'),
                        submenu: [
                            createWindowMenuAction({
                                label: te('menu.focusGroupRight'),
                                channel: 'menu:focusEditorGroup',
                                args: ['right'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.focusGroupLeft'),
                                channel: 'menu:focusEditorGroup',
                                args: ['left'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.focusGroupUp'),
                                channel: 'menu:focusEditorGroup',
                                args: ['up'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.focusGroupDown'),
                                channel: 'menu:focusEditorGroup',
                                args: ['down'],
                            }),
                        ],
                    },
                    {
                        label: te('menu.moveTabToGroup'),
                        submenu: [
                            createWindowMenuAction({
                                label: te('menu.moveTabRight'),
                                channel: 'menu:moveTabToGroup',
                                args: ['right'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.moveTabLeft'),
                                channel: 'menu:moveTabToGroup',
                                args: ['left'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.moveTabUp'),
                                channel: 'menu:moveTabToGroup',
                                args: ['up'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.moveTabDown'),
                                channel: 'menu:moveTabToGroup',
                                args: ['down'],
                            }),
                        ],
                    },
                    {
                        label: te('menu.copyTabToGroup'),
                        submenu: [
                            createWindowMenuAction({
                                label: te('menu.copyTabRight'),
                                channel: 'menu:copyTabToGroup',
                                args: ['right'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.copyTabLeft'),
                                channel: 'menu:copyTabToGroup',
                                args: ['left'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.copyTabUp'),
                                channel: 'menu:copyTabToGroup',
                                args: ['up'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.copyTabDown'),
                                channel: 'menu:copyTabToGroup',
                                args: ['down'],
                            }),
                        ],
                    },
                ],
            },
            { type: 'separator' },
            { role: 'toggleDevTools' },
        ],
    };
}

function getWindowMenu(activeWindow: BrowserWindow | null): MenuItemConstructorOptions {
    const sourceWindowId = activeWindow?.id ?? null;
    const hasTargets = sourceWindowId === null
        ? false
        : getOtherWindows(sourceWindowId).length > 0;
    const canMoveActiveTabToNewWindow = getWindowTabCount(activeWindow) > 1;

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
                enabled: sourceWindowId !== null && hasTargets,
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
        submenu: [config.isMac
            ? { role: 'about' }
            : {
                label: te('menu.about'),
                click: () => { app.showAboutPanel(); },
            }],
    };
}

function getMacAppMenu(): MenuItemConstructorOptions {
    return {
        label: appName,
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
    const documentActionsEnabled = getWindowDocumentState(activeWindow);

    if (config.isMac) {
        template.push(getMacAppMenu());
    }

    template.push(
        getFileMenu(documentActionsEnabled),
        getEditMenu(documentActionsEnabled),
        getPagesMenu(documentActionsEnabled),
        getViewMenu(documentActionsEnabled),
        getWindowMenu(activeWindow),
        getHelpMenu(),
    );

    return template;
}

function rebuildMenu() {
    const activeWindow = getFocusedAppWindow();
    const template = buildMenuTemplate(activeWindow);
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
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
    for (const window of getAllAppWindows()) {
        trackWindowForMenu(window);
    }
    rebuildMenu();
}

export function updateRecentFilesMenu() {
    rebuildMenu();
}

export function refreshMenu() {
    rebuildMenu();
}

export function setMenuDocumentState(windowId: number, hasDocument: boolean) {
    const normalized = Boolean(hasDocument);
    if (menuDocumentStateByWindow.get(windowId) === normalized) {
        return;
    }

    menuDocumentStateByWindow.set(windowId, normalized);
    rebuildMenu();
}

export function clearMenuDocumentState(windowId: number) {
    if (!menuDocumentStateByWindow.has(windowId)) {
        return;
    }

    menuDocumentStateByWindow.delete(windowId);
    rebuildMenu();
}

export function setMenuTabCount(windowId: number, tabCount: number) {
    const normalized = Number.isFinite(tabCount)
        ? Math.max(0, Math.floor(tabCount))
        : 0;
    if (menuTabCountByWindow.get(windowId) === normalized) {
        return;
    }

    menuTabCountByWindow.set(windowId, normalized);
    rebuildMenu();
}

export function showTabContextMenu(window: BrowserWindow, tabId: string) {
    const normalizedTabId = tabId.trim();
    if (!normalizedTabId || window.isDestroyed()) {
        return;
    }

    const sourceWindowId = window.id;
    const hasTargets = getOtherWindows(sourceWindowId).length > 0;
    const canMoveToNewWindow = getWindowTabCount(window) > 1;

    const menu = Menu.buildFromTemplate([
        {
            label: te('menu.closeTab'),
            click: () => {
                sendWindowTabsAction(sourceWindowId, {
                    kind: 'close-tab',
                    tabId: normalizedTabId,
                });
            },
        },
        { type: 'separator' },
        {
            label: te('menu.moveTabToNewWindow'),
            enabled: canMoveToNewWindow,
            click: () => {
                sendWindowTabsAction(sourceWindowId, {
                    kind: 'move-tab-to-new-window',
                    tabId: normalizedTabId,
                });
            },
        },
        {
            label: te('menu.moveTabToWindow'),
            enabled: hasTargets,
            submenu: buildMoveToWindowSubmenu(sourceWindowId, normalizedTabId),
        },
    ]);

    menu.popup({ window });
}
