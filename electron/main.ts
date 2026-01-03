import { app } from 'electron';
import { config } from './config';
import { stopServer } from './server';
import {
    createWindow, hasWindows, 
} from './window';

async function init() {
    await app.whenReady();
    createWindow();

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
