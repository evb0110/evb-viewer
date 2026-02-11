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

app.setName('EVB Viewer');
if (process.platform === 'win32') {
    app.setAppUserModelId('com.evb.viewer');
}

// Explicitly set userData path to ensure it uses our app name
// This fixes a race condition where imports above may cache the default "Electron" path
app.setPath('userData', join(app.getPath('appData'), app.name));

const __dirname = dirname(fileURLToPath(import.meta.url));
const devDockIconPath = join(__dirname, '..', 'resources', 'icon.png');

async function init() {
    await app.whenReady();
    // In packaged builds, macOS uses the app bundle's .icns icon.
    // Only override in development where the host Electron binary has the default icon.
    if (process.platform === 'darwin' && !app.isPackaged) {
        try {
            app.dock?.setIcon(devDockIconPath);
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
