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
import { config } from '@electron/config';
import { getRecentFilesSync } from '@electron/recent-files';
import { te } from '@electron/i18n';

const appName = te('app.title');
const menuState = {hasDocument: false};

interface IWindowMenuActionOptions {
    label: string;
    channel: string;
    accelerator?: string;
    enabled?: boolean;
    args?: unknown[];
}

export function sendToWindow(window: BaseWindow | undefined, channel: string, ...args: unknown[]) {
    if (window instanceof BrowserWindow) {
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
            sendToWindow(window, channel, ...args);
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
            sendToWindow(window, 'menu:openRecentFile', filePath);
        },
    }));

    return [
        ...fileItems,
        { type: 'separator' },
        {
            label: te('menu.clearRecentFiles'),
            click: (_, window) => {
                sendToWindow(window, 'menu:clearRecentFiles');
            },
        },
    ];
}

function getFileMenu(): MenuItemConstructorOptions {
    const documentActionsEnabled = menuState.hasDocument;

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

function getEditMenu(): MenuItemConstructorOptions {
    const documentActionsEnabled = menuState.hasDocument;

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
                    (window as Electron.BrowserWindow | undefined)?.webContents.copy();
                },
            },
        ],
    };
}

function getPagesMenu(): MenuItemConstructorOptions {
    return {
        label: te('menu.pages'),
        enabled: menuState.hasDocument,
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

function getViewMenu(): MenuItemConstructorOptions {
    const documentActionsEnabled = menuState.hasDocument;

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

function getWindowMenu(): MenuItemConstructorOptions {
    return {
        label: te('menu.window'),
        submenu: [
            { role: 'minimize' },
            { role: 'close' },
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

function buildMenuTemplate(): MenuItemConstructorOptions[] {
    const template: MenuItemConstructorOptions[] = [];

    if (config.isMac) {
        template.push(getMacAppMenu());
    }

    template.push(
        getFileMenu(),
        getEditMenu(),
        getPagesMenu(),
        getViewMenu(),
        getWindowMenu(),
        getHelpMenu(),
    );

    return template;
}

function rebuildMenu() {
    const template = buildMenuTemplate();
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

export function setupMenu() {
    rebuildMenu();
}

export function updateRecentFilesMenu() {
    rebuildMenu();
}

export function setMenuDocumentState(hasDocument: boolean) {
    const normalized = Boolean(hasDocument);
    if (menuState.hasDocument === normalized) {
        return;
    }
    menuState.hasDocument = normalized;
    rebuildMenu();
}
