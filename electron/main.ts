import { app } from 'electron';
import { config } from '@electron/config';
import { stopServer } from '@electron/server';
import {
    createWindow,
    hasWindows,
} from '@electron/window';

async function init() {
    await app.whenReady();
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
