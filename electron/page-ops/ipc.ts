import {
    ipcMain,
    dialog,
} from 'electron';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import {
    basename,
    extname,
} from 'path';
import { isAllowedWritePath } from '@electron/utils/path-validator';
import {
    deletePages,
    extractPages,
    reorderPages,
    rotatePages,
} from '@electron/page-ops/qpdf';
import type { TRotationAngle } from '@electron/page-ops/qpdf';

function validateWorkingCopyPath(path: unknown): asserts path is string {
    if (!path || typeof path !== 'string' || path.trim() === '') {
        throw new Error('Invalid working copy path');
    }
    if (!isAllowedWritePath(path)) {
        throw new Error('Path is outside the allowed working directory');
    }
    if (!existsSync(path)) {
        throw new Error(`Working copy not found: ${path}`);
    }
}

function validatePageNumbers(pages: unknown, label: string): asserts pages is number[] {
    if (!Array.isArray(pages) || pages.length === 0) {
        throw new Error(`${label}: must be a non-empty array of page numbers`);
    }
    for (const p of pages) {
        if (typeof p !== 'number' || !Number.isInteger(p) || p < 1) {
            throw new Error(`${label}: invalid page number ${p}`);
        }
    }
}

async function readModifiedPdf(workingCopyPath: string) {
    const buffer = await readFile(workingCopyPath);
    return new Uint8Array(buffer);
}

async function handlePageOpsDelete(
    _event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    pages: number[],
    totalPages: number,
) {
    validateWorkingCopyPath(workingCopyPath);
    validatePageNumbers(pages, 'deletePages');

    if (typeof totalPages !== 'number' || totalPages < 1) {
        throw new Error('Invalid totalPages');
    }

    const result = await deletePages(workingCopyPath, pages, totalPages);
    const pdfData = await readModifiedPdf(workingCopyPath);
    return {
        success: true,
        pageCount: result.pageCount,
        pdfData, 
    };
}

async function handlePageOpsExtract(
    _event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    pages: number[],
) {
    validateWorkingCopyPath(workingCopyPath);
    validatePageNumbers(pages, 'extractPages');

    const suggestedName = `${basename(workingCopyPath, extname(workingCopyPath))}-extracted.pdf`;
    const result = await dialog.showSaveDialog({
        title: 'Extract Pages',
        defaultPath: suggestedName,
        filters: [{
            name: 'PDF Files',
            extensions: ['pdf'], 
        }],
    });

    if (result.canceled || !result.filePath) {
        return {
            success: false,
            canceled: true, 
        };
    }

    let destPath = result.filePath;
    if (extname(destPath).toLowerCase() !== '.pdf') {
        destPath += '.pdf';
    }

    await extractPages(workingCopyPath, destPath, pages);
    return {
        success: true,
        destPath, 
    };
}

async function handlePageOpsReorder(
    _event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    newOrder: number[],
) {
    validateWorkingCopyPath(workingCopyPath);
    validatePageNumbers(newOrder, 'reorderPages');

    const result = await reorderPages(workingCopyPath, newOrder);
    const pdfData = await readModifiedPdf(workingCopyPath);
    return {
        success: true,
        pageCount: result.pageCount,
        pdfData, 
    };
}

async function handlePageOpsInsert(
    _event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    totalPages: number,
    afterPage: number,
) {
    validateWorkingCopyPath(workingCopyPath);

    if (typeof totalPages !== 'number' || totalPages < 1) {
        throw new Error('Invalid totalPages');
    }
    if (typeof afterPage !== 'number' || afterPage < 0) {
        throw new Error('Invalid afterPage');
    }

    const result = await dialog.showOpenDialog({
        title: 'Insert Pages From PDF',
        filters: [{
            name: 'PDF Files',
            extensions: ['pdf'], 
        }],
        properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
        return {
            success: false,
            canceled: true, 
        };
    }

    const sourcePath = result.filePaths[0];
    if (!sourcePath) {
        return {
            success: false,
            canceled: true, 
        };
    }

    await insertPagesFromSource(workingCopyPath, totalPages, sourcePath, afterPage);
    const pdfData = await readModifiedPdf(workingCopyPath);
    return {
        success: true,
        pdfData, 
    };
}

async function insertPagesFromSource(
    workingCopyPath: string,
    totalPages: number,
    sourcePath: string,
    afterPage: number,
) {
    const { runCommand } = await import('@electron/ocr/worker/run-command');
    const { getOcrToolPaths } = await import('@electron/ocr/paths');
    const { join } = await import('path');
    const {
        rename,
        unlink,
    } = await import('fs/promises');

    const qpdf = getOcrToolPaths().qpdf;
    const dir = join(workingCopyPath, '..');
    const id = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempPath = join(dir, `${id}.pdf`);

    try {
        const pagesArgs: string[] = [];

        if (afterPage >= 1) {
            pagesArgs.push(workingCopyPath, `1-${afterPage}`);
        }

        pagesArgs.push(sourcePath, '1-z');

        if (afterPage < totalPages) {
            pagesArgs.push(workingCopyPath, `${afterPage + 1}-${totalPages}`);
        }

        const args = [
            workingCopyPath,
            '--pages',
            ...pagesArgs,
            '--',
            tempPath,
        ];
        await runCommand(qpdf, args);
        await rename(tempPath, workingCopyPath);
    } catch (err) {
        try {
            if (existsSync(tempPath)) {
                await unlink(tempPath);
            }
        } catch {
            // best-effort
        }
        throw err;
    }
}

async function handlePageOpsRotate(
    _event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    pages: number[],
    angle: TRotationAngle,
) {
    validateWorkingCopyPath(workingCopyPath);
    validatePageNumbers(pages, 'rotatePages');

    if (![
        90,
        180,
        270,
    ].includes(angle)) {
        throw new Error(`Invalid rotation angle: ${angle}`);
    }

    await rotatePages(workingCopyPath, pages, angle);
    const pdfData = await readModifiedPdf(workingCopyPath);
    return {
        success: true,
        pdfData, 
    };
}

export function registerPageOpsHandlers() {
    ipcMain.handle('page-ops:delete', handlePageOpsDelete);
    ipcMain.handle('page-ops:extract', handlePageOpsExtract);
    ipcMain.handle('page-ops:reorder', handlePageOpsReorder);
    ipcMain.handle('page-ops:insert', handlePageOpsInsert);
    ipcMain.handle('page-ops:rotate', handlePageOpsRotate);
}
