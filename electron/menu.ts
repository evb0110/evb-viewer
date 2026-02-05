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

const appName = 'EVB-Viewer';

function sendToWindow(window: BaseWindow | undefined, channel: string, ...args: unknown[]) {
    if (window instanceof BrowserWindow) {
        window.webContents.send(channel, ...args);
    }
}

function buildRecentFilesSubmenu(): MenuItemConstructorOptions[] {
    const recentFiles = getRecentFilesSync();

    if (recentFiles.length === 0) {
        return [{
            label: 'No Recent Files',
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
            label: 'Clear Recent Files',
            click: (_, window) => {
                sendToWindow(window, 'menu:clearRecentFiles');
            },
        },
    ];
}

function getFileMenu(): MenuItemConstructorOptions {
    return {
        label: 'File',
        submenu: [
            {
                label: 'Open PDF...',
                accelerator: 'CmdOrCtrl+O',
                click: (_, window) => {
                    sendToWindow(window, 'menu:openPdf');
                },
            },
            {
                label: 'Open Recent',
                submenu: buildRecentFilesSubmenu(),
            },
            {
                label: 'Save',
                accelerator: 'CmdOrCtrl+S',
                click: (_, window) => {
                    sendToWindow(window, 'menu:save');
                },
            },
            {
                label: 'Save As...',
                accelerator: 'CmdOrCtrl+Shift+S',
                click: (_, window) => {
                    sendToWindow(window, 'menu:saveAs');
                },
            },
            {
                label: 'Export DOCX...',
                accelerator: 'CmdOrCtrl+Shift+E',
                click: (_, window) => {
                    sendToWindow(window, 'menu:exportDocx');
                },
            },
            { type: 'separator' },
            {
                label: 'Close',
                accelerator: 'CmdOrCtrl+W',
                click: (_, window) => {
                    window?.close();
                },
            },
            ...(config.isMac ? [] : [
                { type: 'separator' as const },
                {
                    label: 'Quit',
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
        label: 'Actions',
        submenu: [
            {
                label: 'Undo',
                accelerator: 'CmdOrCtrl+Z',
                click: (_, window) => {
                    sendToWindow(window, 'menu:undo');
                },
            },
            {
                label: 'Redo',
                accelerator: 'CmdOrCtrl+Shift+Z',
                click: (_, window) => {
                    sendToWindow(window, 'menu:redo');
                },
            },
            { type: 'separator' },
            {
                label: 'Copy',
                accelerator: 'CmdOrCtrl+C',
                click: (_item, window) => {
                    window?.webContents.copy();
                },
            },
        ],
    };
}

function getViewMenu(): MenuItemConstructorOptions {
    return {
        label: 'View',
        submenu: [
            {
                label: 'Zoom In',
                accelerator: 'CmdOrCtrl+Plus',
                click: (_, window) => {
                    sendToWindow(window, 'menu:zoomIn');
                },
            },
            {
                label: 'Zoom Out',
                accelerator: 'CmdOrCtrl+-',
                click: (_, window) => {
                    sendToWindow(window, 'menu:zoomOut');
                },
            },
            {
                label: 'Actual Size',
                accelerator: 'CmdOrCtrl+0',
                click: (_, window) => {
                    sendToWindow(window, 'menu:actualSize');
                },
            },
            { type: 'separator' },
            {
                label: 'Fit Width',
                accelerator: 'CmdOrCtrl+1',
                click: (_, window) => {
                    sendToWindow(window, 'menu:fitWidth');
                },
            },
            {
                label: 'Fit Height',
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
        label: 'Window',
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
        label: 'Help',
        submenu: [
            { role: 'about' },
        ],
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

export function sendMenuCommand(channel: string) {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) {
        focusedWindow.webContents.send(channel);
    }
}

export function updateRecentFilesMenu() {
    const template = buildMenuTemplate();
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}
