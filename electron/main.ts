import { app } from 'electron';
import { config } from '@electron/config';
import { registerIpcHandlers } from '@electron/ipc';
import { setupMenu } from '@electron/menu';
import { stopServer } from '@electron/server';
import {
    createWindow,
    hasWindows,
} from '@electron/window';

async function init() {
    await app.whenReady();
    registerIpcHandlers();
    setupMenu();
    void createWindow();

    app.on('window-all-closed', () => {
        stopServer();
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
