import { app } from 'electron';
import { config } from '@electron/config';
import {
    registerIpcHandlers,
    clearAllWorkingCopies,
} from '@electron/ipc';
import { setupMenu } from '@electron/menu';
import { initRecentFilesCache } from '@electron/recent-files';
import { stopServer } from '@electron/server';
import { initPageProcessingPaths } from '@electron/page-processing/paths';
import {
    createWindow,
    hasWindows,
} from '@electron/window';

async function init() {
    await app.whenReady();
    // Warm tool path cache early so the first Process click doesn't pay the discovery cost.
    // Non-blocking: missing tools are handled later via validateTools().
    void initPageProcessingPaths();
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
