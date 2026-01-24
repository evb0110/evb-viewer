import {
    BrowserWindow,
    dialog,
    ipcMain,
    app,
} from 'electron';
import {
    existsSync,
    mkdirSync,
    rmSync,
} from 'fs';
import {
    readFile,
    writeFile,
    copyFile,
} from 'fs/promises';
import {
    extname,
    join,
    basename,
    dirname,
    isAbsolute,
    resolve,
    relative,
    sep,
} from 'path';
import { registerOcrHandlers } from '@electron/ocr/ipc';
import { registerSearchHandlers } from '@electron/search/ipc';
import { updateRecentFilesMenu } from '@electron/menu';
import {
    isAllowedWritePath,
    isAllowedReadPath,
} from '@electron/utils/path-validator';
import {
    addRecentFile,
    getRecentFiles,
    removeRecentFile,
    clearRecentFiles,
} from '@electron/recent-files';

// Map to track original path → working copy path
const workingCopyMap = new Map<string, string>();

/**
 * Create a working copy of the PDF in a temp directory
 * Original file remains untouched until explicit save
 */
async function createWorkingCopy(originalPath: string): Promise<string> {
    const tempDir = app.getPath('temp');
    const sessionId = `pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workDir = join(tempDir, `pdf-work-${sessionId}`);

    // Create work directory
    mkdirSync(workDir, { recursive: true });

    // Copy original to working directory
    const fileName = basename(originalPath);
    const workingPath = join(workDir, fileName);
    await copyFile(originalPath, workingPath);

    // Track mapping for later save
    workingCopyMap.set(workingPath, originalPath);

    return workingPath;
}

export function registerIpcHandlers() {
    ipcMain.handle('dialog:openPdf', handleOpenPdfDialog);
    ipcMain.handle('dialog:openPdfDirect', handleOpenPdfDirect);
    ipcMain.handle('file:read', handleFileRead);
    ipcMain.handle('file:readText', handleFileReadText);
    ipcMain.handle('file:exists', handleFileExists);
    ipcMain.handle('file:write', handleFileWrite);
    ipcMain.handle('file:save', handleFileSave);
    ipcMain.handle('file:cleanup', (_event, workingPath: string) => {
        cleanupWorkingCopy(workingPath);
        return;
    });
    ipcMain.handle('window:setTitle', handleSetWindowTitle);

    // Recent files handlers
    ipcMain.handle('recent-files:get', () => getRecentFiles());
    ipcMain.handle('recent-files:add', async (_event, originalPath: string) => {
        await addRecentFile(originalPath);
        updateRecentFilesMenu();
    });
    ipcMain.handle('recent-files:remove', async (_event, originalPath: string) => {
        await removeRecentFile(originalPath);
        updateRecentFilesMenu();
    });
    ipcMain.handle('recent-files:clear', async () => {
        await clearRecentFiles();
        updateRecentFilesMenu();
    });

    registerOcrHandlers();
    registerSearchHandlers();
}

async function handleOpenPdfDirect(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
): Promise<string | null> {
    if (!filePath || filePath.trim() === '') {
        return null;
    }

    const normalizedPath = filePath.trim();
    const extension = extname(normalizedPath).toLowerCase();

    if (extension !== '.pdf') {
        return null;
    }

    if (!existsSync(normalizedPath)) {
        return null;
    }

    // Create working copy and return working path (not original)
    try {
        const workingPath = await createWorkingCopy(normalizedPath);
        await addRecentFile(normalizedPath);
        updateRecentFilesMenu();
        return workingPath;
    } catch (err) {
        console.error('Failed to create working copy:', err);
        return null;
    }
}

function handleSetWindowTitle(event: Electron.IpcMainInvokeEvent, title: string) {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
        window.setTitle(title || 'PDF Viewer');
    }
}

async function handleOpenPdfDialog(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
        title: 'Open PDF',
        filters: [{
            name: 'PDF Files',
            extensions: ['pdf'],
        }],
        properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    const originalPath = result.filePaths[0];
    if (!originalPath) {
        return null;
    }

    // Create working copy and return working path (not original)
    try {
        const workingPath = await createWorkingCopy(originalPath);
        await addRecentFile(originalPath);
        updateRecentFilesMenu();
        return workingPath;
    } catch (err) {
        console.error('Failed to create working copy:', err);
        return null;
    }
}

async function handleFileRead(_event: Electron.IpcMainInvokeEvent, filePath: string): Promise<Uint8Array> {
    if (!filePath || filePath.trim() === '') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }

    const normalizedPath = filePath.trim();
    const extension = extname(normalizedPath).toLowerCase();

    if (extension !== '.pdf') {
        throw new Error('Invalid file type: only PDF files are allowed');
    }

    if (!existsSync(normalizedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    const buffer = await readFile(normalizedPath);
    return new Uint8Array(buffer);
}

async function handleFileWrite(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
    data: Uint8Array,
): Promise<boolean> {
    if (!filePath || filePath.trim() === '') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }

    if (!(data instanceof Uint8Array)) {
        throw new Error('Invalid data: must be a Uint8Array');
    }

    const normalizedPath = filePath.trim();

    if (!isAllowedWritePath(normalizedPath)) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }

    await writeFile(normalizedPath, data);
    return true;
}

const ALLOWED_READ_EXTENSIONS = new Set([
    '.json',
    '.txt',
    '.tsv',
]);

async function handleFileReadText(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
): Promise<string> {
    if (!filePath || filePath.trim() === '') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }

    const normalizedPath = filePath.trim();
    const extension = extname(normalizedPath).toLowerCase();

    if (!ALLOWED_READ_EXTENSIONS.has(extension)) {
        throw new Error('Invalid file type: only .json, .txt, and .tsv files are allowed');
    }

    if (!isAllowedReadPath(normalizedPath)) {
        throw new Error('Invalid file path: reads only allowed within temp directory');
    }

    if (!existsSync(normalizedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    const buffer = await readFile(normalizedPath, 'utf-8');
    return buffer;
}

function handleFileExists(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
): boolean {
    if (!filePath || filePath.trim() === '') {
        return false;
    }

    const normalizedPath = filePath.trim();

    if (!isAllowedReadPath(normalizedPath)) {
        return false;
    }

    return existsSync(normalizedPath);
}

/**
 * Save working copy back to original location
 * Used when user clicks "Save" button
 */
async function handleFileSave(
    _event: Electron.IpcMainInvokeEvent,
    workingPath: string,
): Promise<boolean> {
    if (!workingPath || workingPath.trim() === '') {
        throw new Error('Invalid file path');
    }

    const normalizedWorkingPath = workingPath.trim();
    const originalPath = workingCopyMap.get(normalizedWorkingPath);

    if (!originalPath) {
        throw new Error('No original path found for this working copy');
    }

    try {
        // Copy working version back to original location
        const workingData = await readFile(normalizedWorkingPath);
        await writeFile(originalPath, workingData);

        return true;
    } catch (err) {
        throw new Error(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * Clean up a working copy entry from the map
 * Called when user closes a PDF without saving
 */
function cleanupWorkingCopy(workingPath: string) {
    const normalizedPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedPath) {
        return;
    }

    workingCopyMap.delete(normalizedPath);

    try {
        const tempDir = resolve(app.getPath('temp'));
        const workDir = resolve(dirname(normalizedPath));
        const relativePath = relative(tempDir, workDir);
        const workDirName = basename(workDir);

        const isWithinTemp = (
            relativePath !== '..'
            && !relativePath.startsWith(`..${sep}`)
            && !isAbsolute(relativePath)
        );
        const isWorkingCopyDir = workDirName.startsWith('pdf-work-');

        if (isWithinTemp && isWorkingCopyDir && existsSync(workDir)) {
            rmSync(workDir, {
                recursive: true,
                force: true,
            });
        }
    } catch (err) {
        console.warn('[cleanup] Failed to delete working directory:', err);
    }
}

/**
 * Clear all working copy entries
 * Called on app shutdown
 */
export function clearAllWorkingCopies() {
    workingCopyMap.clear();
}
