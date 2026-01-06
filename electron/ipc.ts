import {
    BrowserWindow,
    dialog,
    ipcMain,
    app,
} from 'electron';
import {
    existsSync,
    mkdirSync,
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
} from 'path';
import { registerOcrHandlers } from '@electron/ocr/ipc';
import { registerSearchHandlers } from '@electron/search/ipc';

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
    ipcMain.handle('file:write', handleFileWrite);
    ipcMain.handle('file:save', handleFileSave);
    ipcMain.handle('window:setTitle', handleSetWindowTitle);

    registerOcrHandlers();
    registerSearchHandlers();
}

async function handleOpenPdfDirect(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
): Promise<string | null> {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
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

    // Create working copy and return working path (not original)
    try {
        const workingPath = await createWorkingCopy(originalPath);
        return workingPath;
    } catch (err) {
        console.error('Failed to create working copy:', err);
        return null;
    }
}

async function handleFileRead(_event: Electron.IpcMainInvokeEvent, filePath: string): Promise<Uint8Array> {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
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
    if (typeof filePath !== 'string' || filePath.trim() === '') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }

    if (!(data instanceof Uint8Array)) {
        throw new Error('Invalid data: must be a Uint8Array');
    }

    const normalizedPath = filePath.trim();
    await writeFile(normalizedPath, data);
    return true;
}

/**
 * Save working copy back to original location
 * Used when user clicks "Save" button
 */
async function handleFileSave(
    _event: Electron.IpcMainInvokeEvent,
    workingPath: string,
): Promise<boolean> {
    if (typeof workingPath !== 'string' || workingPath.trim() === '') {
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
