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

function normalizeRequestedPageNumbers(pageNumbers: unknown): number[] | undefined {
    if (!Array.isArray(pageNumbers)) {
        return undefined;
    }

    const normalized = Array.from(new Set(pageNumbers))
        .filter(page => typeof page === 'number' && Number.isInteger(page) && page > 0)
        .sort((left, right) => left - right);

    if (normalized.length === 0) {
        throw new Error('At least one page number must be provided for scoped export');
    }

    return normalized;
}

function buildImageSuggestedName(pageNumbers: number[] | undefined): string {
    if (!pageNumbers || pageNumbers.length === 0) {
        return 'document-page.png';
    }

    if (pageNumbers.length === 1) {
        return `document-page-${String(pageNumbers[0]).padStart(3, '0')}.png`;
    }

    return 'document-pages.png';
}

function buildMultiPageTiffSuggestedName(pageNumbers: number[] | undefined): string {
    if (!pageNumbers || pageNumbers.length === 0) {
        return 'document.tiff';
    }

    if (pageNumbers.length === 1) {
        return `document-page-${String(pageNumbers[0]).padStart(3, '0')}.tiff`;
    }

    return 'document-pages.tiff';
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
    pageNumbers?: number[],
): Promise<{
    success: boolean;
    canceled?: boolean;
    outputPaths?: string[];
}> {
    validateWorkingPdfPath(workingCopyPath);
    const normalizedPageNumbers = normalizeRequestedPageNumbers(pageNumbers);

    const result = await showExportImageDialog(buildImageSuggestedName(normalizedPageNumbers));
    if (result.canceled || !result.filePath) {
        return {
            success: false,
            canceled: true,
        };
    }

    const { normalizedPath } = normalizeImageExportPath(result.filePath, 'png');
    const outputPaths = await exportPdfPagesAsImages(workingCopyPath, normalizedPath, {pageNumbers: normalizedPageNumbers});

    return {
        success: true,
        outputPaths,
    };
}

export async function handlePdfExportMultiPageTiff(
    _event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    pageNumbers?: number[],
): Promise<{
    success: boolean;
    canceled?: boolean;
    outputPath?: string;
}> {
    validateWorkingPdfPath(workingCopyPath);
    const normalizedPageNumbers = normalizeRequestedPageNumbers(pageNumbers);

    const result = await showMultiPageTiffDialog(buildMultiPageTiffSuggestedName(normalizedPageNumbers));
    if (result.canceled || !result.filePath) {
        return {
            success: false,
            canceled: true,
        };
    }

    const outputPath = await exportPdfAsMultiPageTiff(workingCopyPath, result.filePath, {pageNumbers: normalizedPageNumbers});

    return {
        success: true,
        outputPath,
    };
}
