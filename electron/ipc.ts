import {
    BrowserWindow,
    dialog,
    ipcMain,
} from 'electron';
import { existsSync } from 'fs';
import {
    readFile,
    writeFile,
} from 'fs/promises';
import { extname } from 'path';
import { registerOcrHandlers } from './ocr/ipc';

export function registerIpcHandlers() {
    ipcMain.handle('dialog:openPdf', handleOpenPdfDialog);
    ipcMain.handle('dialog:openPdfDirect', handleOpenPdfDirect);
    ipcMain.handle('file:read', handleFileRead);
    ipcMain.handle('file:write', handleFileWrite);
    ipcMain.handle('window:setTitle', handleSetWindowTitle);

    registerOcrHandlers();
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

    return normalizedPath;
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

    return result.filePaths[0];
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
