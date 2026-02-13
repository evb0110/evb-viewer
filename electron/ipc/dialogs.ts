import {
    BrowserWindow,
    dialog,
} from 'electron';
import { existsSync } from 'fs';
import { copyFile } from 'fs/promises';
import {
    extname,
    basename,
} from 'path';
import { updateRecentFilesMenu } from '@electron/menu';
import { addRecentFile } from '@electron/recent-files';
import {
    createWorkingCopy,
    workingCopyMap,
} from '@electron/ipc/workingCopy';

interface IOpenPdfResult {
    kind: 'pdf';
    workingPath: string;
    originalPath: string;
}

interface IOpenDjvuResult {
    kind: 'djvu';
    workingPath: '';
    originalPath: string;
}

type IOpenFileResult = IOpenPdfResult | IOpenDjvuResult;

export async function handleOpenPdfDirect(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
): Promise<IOpenFileResult | null> {
    if (!filePath || filePath.trim() === '') {
        return null;
    }

    const normalizedPath = filePath.trim();
    const extension = extname(normalizedPath).toLowerCase();

    if (extension !== '.pdf' && extension !== '.djvu') {
        return null;
    }

    if (!existsSync(normalizedPath)) {
        return null;
    }

    // DjVu files don't use working copies — the temp PDF serves that role
    if (extension === '.djvu') {
        await addRecentFile(normalizedPath);
        updateRecentFilesMenu();
        return {
            kind: 'djvu',
            workingPath: '',
            originalPath: normalizedPath,
        };
    }

    try {
        const workingPath = await createWorkingCopy(normalizedPath);
        await addRecentFile(normalizedPath);
        updateRecentFilesMenu();
        return {
            kind: 'pdf',
            workingPath,
            originalPath: normalizedPath,
        };
    } catch (err) {
        console.error('Failed to create working copy:', err);
        return null;
    }
}

export function handleSetWindowTitle(event: Electron.IpcMainInvokeEvent, title: string) {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
        window.setTitle(title || 'EVB Viewer');
    }
}

export async function handleOpenPdfDialog(): Promise<IOpenFileResult | null> {
    const result = await dialog.showOpenDialog({
        title: 'Open Document',
        filters: [{
            name: 'Documents',
            extensions: [
                'pdf',
                'djvu',
            ],
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

    const extension = extname(originalPath).toLowerCase();

    // DjVu files don't use working copies
    if (extension === '.djvu') {
        await addRecentFile(originalPath);
        updateRecentFilesMenu();
        return {
            kind: 'djvu',
            workingPath: '',
            originalPath,
        };
    }

    try {
        const workingPath = await createWorkingCopy(originalPath);
        await addRecentFile(originalPath);
        updateRecentFilesMenu();
        return {
            kind: 'pdf',
            workingPath,
            originalPath,
        };
    } catch (err) {
        console.error('Failed to create working copy:', err);
        return null;
    }
}

export async function handleSavePdfAs(
    _event: Electron.IpcMainInvokeEvent,
    workingPath: string,
): Promise<string | null> {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        return null;
    }

    const extension = extname(normalizedWorkingPath).toLowerCase();
    if (extension !== '.pdf') {
        throw new Error('Invalid file type: only PDF files are allowed');
    }

    if (!existsSync(normalizedWorkingPath)) {
        throw new Error(`File not found: ${normalizedWorkingPath}`);
    }

    const originalPath = workingCopyMap.get(normalizedWorkingPath);
    const suggestedName = originalPath
        ? basename(originalPath)
        : basename(normalizedWorkingPath);

    const result = await dialog.showSaveDialog({
        title: 'Save PDF As',
        defaultPath: suggestedName.endsWith('.pdf') ? suggestedName : `${suggestedName}.pdf`,
        filters: [{
            name: 'PDF Files',
            extensions: ['pdf'],
        }],
    });

    if (result.canceled || !result.filePath) {
        return null;
    }

    let targetPath = result.filePath;
    if (extname(targetPath).toLowerCase() !== '.pdf') {
        targetPath += '.pdf';
    }

    await copyFile(normalizedWorkingPath, targetPath);

    workingCopyMap.set(normalizedWorkingPath, targetPath);
    await addRecentFile(targetPath);
    updateRecentFilesMenu();

    return targetPath;
}

export async function handleSavePdfDialog(
    _event: Electron.IpcMainInvokeEvent,
    suggestedName: string,
): Promise<string | null> {
    const result = await dialog.showSaveDialog({
        title: 'Save PDF',
        defaultPath: suggestedName.endsWith('.pdf') ? suggestedName : `${suggestedName}.pdf`,
        filters: [{
            name: 'PDF Files',
            extensions: ['pdf'],
        }],
    });

    if (result.canceled || !result.filePath) {
        return null;
    }

    let targetPath = result.filePath;
    if (extname(targetPath).toLowerCase() !== '.pdf') {
        targetPath += '.pdf';
    }

    return targetPath;
}

export async function handleSaveDocxAs(
    _event: Electron.IpcMainInvokeEvent,
    workingPath: string,
): Promise<string | null> {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';

    const suggestedBase = normalizedWorkingPath
        ? basename(normalizedWorkingPath, extname(normalizedWorkingPath))
        : 'ocr-text';

    const result = await dialog.showSaveDialog({
        title: 'Save OCR Text As',
        defaultPath: `${suggestedBase}.docx`,
        filters: [{
            name: 'Word Documents',
            extensions: ['docx'],
        }],
    });

    if (result.canceled || !result.filePath) {
        return null;
    }

    let targetPath = result.filePath;
    if (extname(targetPath).toLowerCase() !== '.docx') {
        targetPath += '.docx';
    }

    return targetPath;
}
