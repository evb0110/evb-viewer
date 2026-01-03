import {
    BrowserWindow,
    session,
} from 'electron';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { config } from '@electron/config';
import {
    startServer,
    waitForServer,
} from '@electron/server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;

function setupContentSecurityPolicy() {
    const csp = [
        'default-src \'self\'',
        'script-src \'self\' \'unsafe-inline\'',
        'style-src \'self\' \'unsafe-inline\'',
        'img-src \'self\' data: blob:',
        'font-src \'self\' data:',
        'connect-src \'self\' blob: data: ws:',
        'worker-src \'self\' blob:',
        'object-src \'none\'',
        'base-uri \'self\'',
        'form-action \'self\'',
    ].join('; ');

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [csp],
        }});
    });
}

export async function createWindow() {
    const preloadPath = join(__dirname, 'preload.js');
    console.log('[Electron] __dirname:', __dirname);
    console.log('[Electron] preload path:', preloadPath);

    setupContentSecurityPolicy();
    await startServer();
    await waitForServer();

    mainWindow = new BrowserWindow({
        width: config.window.width,
        height: config.window.height,
        title: config.window.title,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: preloadPath,
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
