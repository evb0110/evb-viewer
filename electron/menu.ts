import type {MenuItemConstructorOptions} from 'electron';
import {
    app,
    BrowserWindow,
    Menu,
    shell,
} from 'electron';
import { config } from '@electron/config';

function getFileMenu(): MenuItemConstructorOptions {
    return {
        label: 'File',
        submenu: [
            {
                label: 'Open PDF...',
                accelerator: 'CmdOrCtrl+O',
                click: (_, window) => {
                    window?.webContents.send('menu:openPdf');
                },
            },
            {
                label: 'Save',
                accelerator: 'CmdOrCtrl+S',
                click: (_, window) => {
                    window?.webContents.send('menu:save');
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
        label: 'Edit',
        submenu: [
            { role: 'copy' },
            { type: 'separator' },
            { role: 'selectAll' },
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
                    window?.webContents.send('menu:zoomIn');
                },
            },
            {
                label: 'Zoom Out',
                accelerator: 'CmdOrCtrl+-',
                click: (_, window) => {
                    window?.webContents.send('menu:zoomOut');
                },
            },
            {
                label: 'Actual Size',
                accelerator: 'CmdOrCtrl+0',
                click: (_, window) => {
                    window?.webContents.send('menu:actualSize');
                },
            },
            { type: 'separator' },
            {
                label: 'Fit Width',
                accelerator: 'CmdOrCtrl+1',
                click: (_, window) => {
                    window?.webContents.send('menu:fitWidth');
                },
            },
            {
                label: 'Fit Height',
                accelerator: 'CmdOrCtrl+2',
                click: (_, window) => {
                    window?.webContents.send('menu:fitHeight');
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
            {
                label: 'About',
                click: (_, window) => {
                    window?.webContents.send('menu:about');
                },
            },
            { type: 'separator' },
            {
                label: 'Learn More',
                click: async () => {
                    await shell.openExternal('https://www.electronjs.org');
                },
            },
        ],
    };
}

function getMacAppMenu(): MenuItemConstructorOptions {
    return {
        label: app.name,
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
