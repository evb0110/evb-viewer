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

function sendToWindow(window: BaseWindow | undefined, channel: string, ...args: unknown[]) {
    if (window instanceof BrowserWindow) {
        window.webContents.send(channel, ...args);
    }
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
    return {
        label: te('menu.file'),
        submenu: [
            {
                label: te('menu.openFile'),
                accelerator: 'CmdOrCtrl+O',
                click: (_, window) => {
                    sendToWindow(window, 'menu:openPdf');
                },
            },
            {
                label: te('menu.openRecent'),
                submenu: buildRecentFilesSubmenu(),
            },
            {
                label: te('menu.save'),
                accelerator: 'CmdOrCtrl+S',
                click: (_, window) => {
                    sendToWindow(window, 'menu:save');
                },
            },
            {
                label: te('menu.saveAs'),
                accelerator: 'CmdOrCtrl+Shift+S',
                click: (_, window) => {
                    sendToWindow(window, 'menu:saveAs');
                },
            },
            {
                label: te('menu.exportDocx'),
                accelerator: 'CmdOrCtrl+Shift+E',
                click: (_, window) => {
                    sendToWindow(window, 'menu:exportDocx');
                },
            },
            {
                label: te('menu.exportImages'),
                click: (_, window) => {
                    sendToWindow(window, 'menu:exportImages');
                },
            },
            {
                label: te('menu.exportMultiPageTiff'),
                click: (_, window) => {
                    sendToWindow(window, 'menu:exportMultiPageTiff');
                },
            },
            {
                label: te('menu.convertToPdf'),
                click: (_, window) => {
                    sendToWindow(window, 'menu:convertToPdf');
                },
            },
            { type: 'separator' },
            {
                label: te('menu.newTab'),
                accelerator: 'CmdOrCtrl+T',
                click: (_, window) => {
                    sendToWindow(window, 'menu:newTab');
                },
            },
            {
                label: te('menu.closeTab'),
                accelerator: 'CmdOrCtrl+W',
                click: (_, window) => {
                    sendToWindow(window, 'menu:closeTab');
                },
            },
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
    return {
        label: te('menu.actions'),
        submenu: [
            {
                label: te('menu.undo'),
                accelerator: 'CmdOrCtrl+Z',
                click: (_, window) => {
                    sendToWindow(window, 'menu:undo');
                },
            },
            {
                label: te('menu.redo'),
                accelerator: 'CmdOrCtrl+Shift+Z',
                click: (_, window) => {
                    sendToWindow(window, 'menu:redo');
                },
            },
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
        submenu: [
            {
                label: te('menu.deleteSelectedPages'),
                click: (_, window) => {
                    sendToWindow(window, 'menu:deletePages');
                },
            },
            {
                label: te('menu.extractSelectedPages'),
                click: (_, window) => {
                    sendToWindow(window, 'menu:extractPages');
                },
            },
            { type: 'separator' },
            {
                label: te('menu.rotateClockwise'),
                click: (_, window) => {
                    sendToWindow(window, 'menu:rotateCw');
                },
            },
            {
                label: te('menu.rotateCounterclockwise'),
                click: (_, window) => {
                    sendToWindow(window, 'menu:rotateCcw');
                },
            },
            { type: 'separator' },
            {
                label: te('menu.insertPages'),
                click: (_, window) => {
                    sendToWindow(window, 'menu:insertPages');
                },
            },
        ],
    };
}

function getViewMenu(): MenuItemConstructorOptions {
    return {
        label: te('menu.view'),
        submenu: [
            {
                label: te('menu.zoomIn'),
                accelerator: 'CmdOrCtrl+Plus',
                click: (_, window) => {
                    sendToWindow(window, 'menu:zoomIn');
                },
            },
            {
                label: te('menu.zoomOut'),
                accelerator: 'CmdOrCtrl+-',
                click: (_, window) => {
                    sendToWindow(window, 'menu:zoomOut');
                },
            },
            {
                label: te('menu.actualSize'),
                accelerator: 'CmdOrCtrl+0',
                click: (_, window) => {
                    sendToWindow(window, 'menu:actualSize');
                },
            },
            { type: 'separator' },
            {
                label: te('menu.fitWidth'),
                accelerator: 'CmdOrCtrl+1',
                click: (_, window) => {
                    sendToWindow(window, 'menu:fitWidth');
                },
            },
            {
                label: te('menu.fitHeight'),
                accelerator: 'CmdOrCtrl+2',
                click: (_, window) => {
                    sendToWindow(window, 'menu:fitHeight');
                },
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
        submenu: [{ role: 'about' }],
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

export function setupMenu() {
    const template = buildMenuTemplate();
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

export function updateRecentFilesMenu() {
    const template = buildMenuTemplate();
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}
