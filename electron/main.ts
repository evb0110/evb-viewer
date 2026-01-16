import { app } from 'electron';
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

async function init() {
    await app.whenReady();
    registerIpcHandlers();
    await initRecentFilesCache();
    setupMenu();
    void createWindow();

    app.on('window-all-closed', () => {
        stopServer();
        clearAllWorkingCopies();
        if (!config.isMac) {
            app.quit();
        }
    });

    app.on('activate', () => {
        if (!hasWindows()) {
            createWindow();
        }
    });
}

void init();
