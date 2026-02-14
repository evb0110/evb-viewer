import { app } from 'electron';
import {
    dirname,
    extname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { config } from '@electron/config';
import {
    registerIpcHandlers,
    clearAllWorkingCopies,
} from '@electron/ipc';
import {
    sendToWindow,
    setupMenu,
} from '@electron/menu';
import { initRecentFilesCache } from '@electron/recent-files';
import { stopServer } from '@electron/server';
import {
    createWindow,
    getMainWindow,
    hasWindows,
} from '@electron/window';
import { promptSetDefaultViewer } from '@electron/default-viewer';
import { createLogger } from '@electron/utils/logger';

app.setName('EVB Viewer');
if (process.platform === 'win32') {
    app.setAppUserModelId('com.evb.viewer');
}

// Explicitly set userData path to ensure it uses our app name
// This fixes a race condition where imports above may cache the default "Electron" path
app.setPath('userData', join(app.getPath('appData'), app.name));

const logger = createLogger('main');

const __dirname = dirname(fileURLToPath(import.meta.url));
const devDockIconPath = join(__dirname, '..', 'resources', 'icon.png');

const SUPPORTED_EXTENSIONS = new Set([
    '.pdf',
    '.djvu',
    '.djv',
]);
const pendingFilePaths: string[] = [];

function isSupportedFile(filePath: string) {
    return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function flushPendingFiles() {
    const window = getMainWindow();
    if (!window) {
        return;
    }

    while (pendingFilePaths.length > 0) {
        const filePath = pendingFilePaths.shift()!;
        sendToWindow(window, 'menu:openRecentFile', filePath);
    }
}

// macOS: open-file fires when a file is double-clicked while the app is running or launching.
// Must register before app.whenReady() because macOS sends it early during launch.
app.on('open-file', (event, filePath) => {
    event.preventDefault();

    const window = getMainWindow();
    if (window) {
        sendToWindow(window, 'menu:openRecentFile', filePath);
    } else {
        pendingFilePaths.push(filePath);
    }
});

// Windows/Linux: the OS passes the file path as a command-line argument
if (process.platform !== 'darwin') {
    for (const arg of process.argv.slice(1)) {
        if (isSupportedFile(arg)) {
            pendingFilePaths.push(arg);
        }
    }
}

async function init() {
    await app.whenReady();
    // In packaged builds, macOS uses the app bundle's .icns icon.
    // Only override in development where the host Electron binary has the default icon.
    if (process.platform === 'darwin' && !app.isPackaged) {
        try {
            app.dock?.setIcon(devDockIconPath);
        } catch (err) {
            logger.warn(`Failed to set dock icon: ${err instanceof Error ? err.message : String(err)}`);
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

    // Give the renderer time to initialize before sending file paths or showing prompts
    setTimeout(() => {
        flushPendingFiles();

        const window = getMainWindow();
        if (window) {
            void promptSetDefaultViewer(window);
        }
    }, 2000);
}

void init();
