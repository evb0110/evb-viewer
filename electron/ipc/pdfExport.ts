import {
    BrowserWindow,
    dialog,
} from 'electron';
import { existsSync } from 'fs';
import { extname } from 'path';
import { isAllowedWritePath } from '@electron/utils/path-validator';
import {
    exportPdfAsMultiPageTiff,
    exportPdfPagesAsImages,
    normalizeImageExportPath,
} from '@electron/image/export';
import { te } from '@electron/i18n';

function validateWorkingPdfPath(path: unknown): asserts path is string {
    if (!path || typeof path !== 'string' || path.trim() === '') {
        throw new Error('Invalid working copy path');
    }

    if (!isAllowedWritePath(path)) {
        throw new Error('Path is outside the allowed working directory');
    }

    if (!existsSync(path)) {
        throw new Error(`Working copy not found: ${path}`);
    }

    if (extname(path).toLowerCase() !== '.pdf') {
        throw new Error('Working file must be a PDF');
    }
}

async function showExportImageDialog(defaultName: string) {
    const parentWindow = BrowserWindow.getFocusedWindow();
    const dialogOptions = {
        title: te('dialogs.exportImages'),
        defaultPath: defaultName,
        filters: [
            {
                name: te('dialogs.pngImages'),
                extensions: ['png'],
            },
            {
                name: te('dialogs.jpegImages'),
                extensions: [
                    'jpg',
                    'jpeg',
                ],
            },
            {
                name: te('dialogs.tiffImages'),
                extensions: [
                    'tif',
                    'tiff',
                ],
            },
        ],
    };

    return parentWindow
        ? dialog.showSaveDialog(parentWindow, dialogOptions)
        : dialog.showSaveDialog(dialogOptions);
}

async function showMultiPageTiffDialog(defaultName: string) {
    const parentWindow = BrowserWindow.getFocusedWindow();
    const dialogOptions = {
        title: te('dialogs.exportMultiPageTiff'),
        defaultPath: defaultName,
        filters: [{
            name: te('dialogs.tiffImages'),
            extensions: [
                'tif',
                'tiff',
            ],
        }],
    };

    return parentWindow
        ? dialog.showSaveDialog(parentWindow, dialogOptions)
        : dialog.showSaveDialog(dialogOptions);
}

export async function handlePdfExportImages(
    _event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
): Promise<{
    success: boolean;
    canceled?: boolean;
    outputPaths?: string[];
}> {
    validateWorkingPdfPath(workingCopyPath);

    const result = await showExportImageDialog('document-page.png');
    if (result.canceled || !result.filePath) {
        return {
            success: false,
            canceled: true,
        };
    }

    const { normalizedPath } = normalizeImageExportPath(result.filePath, 'png');
    const outputPaths = await exportPdfPagesAsImages(workingCopyPath, normalizedPath);

    return {
        success: true,
        outputPaths,
    };
}

export async function handlePdfExportMultiPageTiff(
    _event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
): Promise<{
    success: boolean;
    canceled?: boolean;
    outputPath?: string;
}> {
    validateWorkingPdfPath(workingCopyPath);

    const result = await showMultiPageTiffDialog('document.tiff');
    if (result.canceled || !result.filePath) {
        return {
            success: false,
            canceled: true,
        };
    }

    const outputPath = await exportPdfAsMultiPageTiff(workingCopyPath, result.filePath);

    return {
        success: true,
        outputPath,
    };
}
