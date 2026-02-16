import {
    app,
    ipcMain,
} from 'electron';
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

app.setName(app.isPackaged ? 'EVB Viewer' : 'EVB Viewer Dev');
if (process.platform === 'win32') {
    app.setAppUserModelId('com.evb.viewer');
}

// Explicitly set userData path to ensure it uses our app name
// This fixes a race condition where imports above may cache the default "Electron" path
app.setPath('userData', join(app.getPath('appData'), app.name));

const logger = createLogger('main');

const __dirname = dirname(fileURLToPath(import.meta.url));
const devDockIconPath = join(__dirname, '..', 'resources', 'icon.png');
const aboutIconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : devDockIconPath;

const SUPPORTED_EXTENSIONS = new Set([
    '.pdf',
    '.djvu',
    '.djv',
    '.png',
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
    '.bmp',
    '.webp',
    '.gif',
]);
const pendingOpenRequests: string[][] = [];
let rendererReady = false;
let defaultViewerPromptShown = false;
let flushPendingFilesTimer: ReturnType<typeof setTimeout> | null = null;
const EXTERNAL_OPEN_BATCH_WINDOW_MS = 250;

function isSupportedFile(filePath: string) {
    return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function normalizeCommandLineArg(arg: string): string | null {
    let normalized = arg.trim();
    if (!normalized || normalized.startsWith('-')) {
        return null;
    }

    if (
        (normalized.startsWith('"') && normalized.endsWith('"'))
        || (normalized.startsWith('\'') && normalized.endsWith('\''))
    ) {
        normalized = normalized.slice(1, -1);
    }

    if (!normalized) {
        return null;
    }

    if (process.platform === 'win32' && normalized.startsWith('/')) {
        return null;
    }

    if (normalized.startsWith('file://')) {
        try {
            return fileURLToPath(normalized);
        } catch {
            return null;
        }
    }

    return normalized;
}

function collectSupportedPathsFromArgs(args: string[]): string[] {
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const normalized = normalizeCommandLineArg(args[i] ?? '');
        if (!normalized) {
            continue;
        }

        if (isSupportedFile(normalized)) {
            files.push(normalized);
            continue;
        }

        // Some shell verbs can emit unquoted multi-token paths (e.g., from %*).
        // Reconstruct path candidates by joining subsequent tokens with spaces.
        let candidate = normalized;
        for (let j = i + 1; j < args.length && j <= i + 7; j++) {
            const nextToken = normalizeCommandLineArg(args[j] ?? '');
            if (!nextToken) {
                break;
            }
            candidate = `${candidate} ${nextToken}`;
            if (isSupportedFile(candidate)) {
                files.push(candidate);
                i = j;
                break;
            }
        }
    }
    return files;
}

function queueOpenRequest(paths: string[]) {
    const seen = new Set<string>();
    const normalizedPaths = paths
        .map(path => path.trim())
        .filter((path) => {
            if (path.length === 0) {
                return false;
            }
            if (seen.has(path)) {
                return false;
            }
            seen.add(path);
            return true;
        });
    if (normalizedPaths.length === 0) {
        return;
    }
    pendingOpenRequests.push(normalizedPaths);
}

function collectMergedPendingPaths() {
    if (pendingOpenRequests.length === 0) {
        return [];
    }

    const seen = new Set<string>();
    const mergedPaths: string[] = [];

    while (pendingOpenRequests.length > 0) {
        const batch = pendingOpenRequests.shift()!;
        for (const path of batch) {
            if (seen.has(path)) {
                continue;
            }
            seen.add(path);
            mergedPaths.push(path);
        }
    }

    return mergedPaths;
}

function queueOpenRequestFromArgs(args: string[]) {
    const parsedPaths = collectSupportedPathsFromArgs(args);
    if (parsedPaths.length > 0) {
        logger.info(`Parsed external open paths (${parsedPaths.length}): ${parsedPaths.join(' | ')}`);
    }
    queueOpenRequest(parsedPaths);
}

function focusMainWindow() {
    const window = getMainWindow();
    if (!window) {
        return;
    }

    if (window.isMinimized()) {
        window.restore();
    }
    window.focus();
}

function flushPendingFiles() {
    if (flushPendingFilesTimer) {
        clearTimeout(flushPendingFilesTimer);
        flushPendingFilesTimer = null;
    }

    if (!rendererReady) {
        return;
    }

    const window = getMainWindow();
    if (!window) {
        return;
    }

    const paths = collectMergedPendingPaths();
    if (paths.length > 0) {
        sendToWindow(window, 'menu:openExternalPaths', paths);
    }
}

function scheduleFlushPendingFiles() {
    if (!rendererReady || flushPendingFilesTimer) {
        return;
    }

    flushPendingFilesTimer = setTimeout(() => {
        flushPendingFiles();
    }, EXTERNAL_OPEN_BATCH_WINDOW_MS);
}

function maybePromptForDefaultViewer() {
    if (defaultViewerPromptShown) {
        return;
    }
    const window = getMainWindow();
    if (!window) {
        return;
    }
    defaultViewerPromptShown = true;
    void promptSetDefaultViewer(window);
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
    app.quit();
    process.exit(0);
}

// macOS: open-file fires when a file is double-clicked while the app is running or launching.
// Must register before app.whenReady() because macOS sends it early during launch.
app.on('open-file', (event, filePath) => {
    event.preventDefault();
    queueOpenRequest([filePath]);
    scheduleFlushPendingFiles();
});

// Windows/Linux: the OS passes the file path as a command-line argument
if (process.platform !== 'darwin') {
    queueOpenRequestFromArgs(process.argv.slice(1));
}

app.on('second-instance', (_event, commandLine) => {
    queueOpenRequestFromArgs(commandLine.slice(1));
    focusMainWindow();
    scheduleFlushPendingFiles();
});

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
    app.setAboutPanelOptions({
        applicationName: 'EVB Viewer',
        applicationVersion: app.getVersion(),
        copyright: 'Copyright \u00A9 2026 Eugene Barsky',
        iconPath: aboutIconPath,
        authors: ['Eugene Barsky'],
    });

    registerIpcHandlers();
    await initRecentFilesCache();
    setupMenu();
    ipcMain.on('app:rendererReady', () => {
        rendererReady = true;
        scheduleFlushPendingFiles();
        maybePromptForDefaultViewer();
    });

    app.on('window-all-closed', () => {
        stopServer();
        clearAllWorkingCopies();
        if (!config.isMac) {
            app.quit();
        }
    });

    app.on('activate', () => {
        if (!hasWindows()) {
            rendererReady = false;
            void createWindow();
        }
    });

    rendererReady = false;
    await createWindow();
}

void init();
