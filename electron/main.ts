import { app } from 'electron';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { config } from '@electron/config';
import {
    registerIpcHandlers,
    clearAllWorkingCopies,
} from '@electron/ipc';
import { setupMenu } from '@electron/menu';
import { initRecentFilesCache } from '@electron/recent-files';
import { stopServer } from '@electron/server';
import {
    createWindow,
    hasWindows,
} from '@electron/window';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '..', 'resources', 'icon.png');

async function init() {
    await app.whenReady();
    app.setName('EVB-Viewer');
    if (process.platform === 'win32') {
        app.setAppUserModelId('com.evb.viewer');
    }
    if (process.platform === 'darwin') {
        try {
            app.dock.setIcon(iconPath);
        } catch (err) {
            console.warn('[Electron] Failed to set dock icon:', err);
        }
    }
    registerIpcHandlers();
    await initRecentFilesCache();
    setupMenu();

    app.on('window-all-closed', () => {
        stopServer();
        clearAllWorkingCopies();
        if (!config.isMac) {
            app.quit();
        }
    });

    app.on('activate', () => {
        if (!hasWindows()) {
            void createWindow();
        }
    });

    await createWindow();
}

void init();
