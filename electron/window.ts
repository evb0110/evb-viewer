import { BrowserWindow } from 'electron';
import { config } from './config';
import {
    startServer, waitForServer, 
} from './server';

let mainWindow: BrowserWindow | null = null;

export async function createWindow() {
    startServer();
    await waitForServer();

    mainWindow = new BrowserWindow({
        width: config.window.width,
        height: config.window.height,
        title: config.window.title,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    if (config.isDev) {
        mainWindow.webContents.openDevTools();
    }

    void mainWindow.loadURL(config.server.url);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

export function hasWindows() {
    return BrowserWindow.getAllWindows().length > 0;
}
