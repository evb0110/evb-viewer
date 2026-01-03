import { app, BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let nuxtServer: ChildProcess | null = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 700,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
        title: 'Electron + Nuxt SSR',
    });

    if (isDev) {
        mainWindow.loadURL('http://localhost:3235');
        mainWindow.webContents.openDevTools();
    } else {
        startProductionServer();
        mainWindow.loadURL('http://localhost:3235');
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function startProductionServer() {
    const serverPath = join(__dirname, '../.output/server/index.mjs');

    nuxtServer = spawn('node', [serverPath], {
        env: { ...process.env, PORT: '3235' },
        stdio: 'inherit',
    });

    nuxtServer.on('error', (err) => {
        console.error('Failed to start Nuxt server:', err);
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (nuxtServer) {
        nuxtServer.kill();
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
