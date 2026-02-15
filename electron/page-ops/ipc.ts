import {
    BrowserWindow,
    ipcMain,
    dialog,
} from 'electron';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import {
    basename,
    extname,
    join,
} from 'path';
import {
    createPdfFromInputPaths,
    isPdfOrImagePath,
    SUPPORTED_IMAGE_EXTENSIONS,
} from '@electron/image/pdf-conversion';
import { isAllowedWritePath } from '@electron/utils/path-validator';
import {
    deletePages,
    extractPages,
    reorderPages,
    rotatePages,
} from '@electron/page-ops/qpdf';
import type { TRotationAngle } from '@electron/page-ops/qpdf';
import { createLogger } from '@electron/utils/logger';
import { te } from '@electron/i18n';

const log = createLogger('page-ops-ipc');

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

function formatPageRange(pages: number[]) {
    const sorted = [...pages].sort((a, b) => a - b);
    const parts: string[] = [];
    let i = 0;
    while (i < sorted.length) {
        const start = sorted[i]!;
        let end = start;
        while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
            end = sorted[++i]!;
        }
        parts.push(start === end ? `${start}` : `${start}-${end}`);
        i++;
    }
    return `p${parts.join(',')}`;
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

    const baseName = basename(workingCopyPath, extname(workingCopyPath));
    const rangeLabel = formatPageRange(pages);
    const suggestedName = `${baseName} (${rangeLabel}).pdf`;
    const parentWindow = BrowserWindow.getFocusedWindow();
    const dialogOptions = {
        title: te('dialogs.extractPages'),
        defaultPath: suggestedName,
        filters: [{
            name: te('dialogs.pdfFiles'),
            extensions: ['pdf'],
        }],
    };
    const result = parentWindow
        ? await dialog.showSaveDialog(parentWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);

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

    const parentWindow = BrowserWindow.getFocusedWindow();
    const dialogOptions = {
        title: te('dialogs.insertPagesFromPdf'),
        filters: [{
            name: te('dialogs.documentsFilter'),
            extensions: [
                'pdf',
                ...SUPPORTED_IMAGE_EXTENSIONS.map(ext => ext.slice(1)),
            ],
        }],
        properties: [
            'openFile',
            'multiSelections',
        ] as Array<'openFile' | 'multiSelections'>,
    };
    const result = parentWindow
        ? await dialog.showOpenDialog(parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
        return {
            success: false,
            canceled: true, 
        };
    }

    await insertPagesFromSourcePaths(workingCopyPath, totalPages, result.filePaths, afterPage);
    const pdfData = await readModifiedPdf(workingCopyPath);
    return {
        success: true,
        pdfData, 
    };
}

async function prepareInsertionSourcePdf(
    workingCopyPath: string,
    sourcePaths: string[],
) {
    const normalizedPaths = sourcePaths
        .filter((path): path is string => typeof path === 'string')
        .map(path => path.trim())
        .filter(path => path.length > 0);

    if (normalizedPaths.length === 0) {
        throw new Error('At least one source file is required');
    }

    for (const sourcePath of normalizedPaths) {
        if (!existsSync(sourcePath)) {
            throw new Error(`Source file not found: ${sourcePath}`);
        }
        if (!isPdfOrImagePath(sourcePath)) {
            throw new Error(`Unsupported source file type: ${sourcePath}`);
        }
    }

    if (normalizedPaths.length === 1 && extname(normalizedPaths[0]!).toLowerCase() === '.pdf') {
        return {
            sourcePdfPath: normalizedPaths[0]!,
            cleanup: async () => {},
        };
    }

    const mergedPdf = await createPdfFromInputPaths(normalizedPaths);
    const tempSourcePdfPath = join(
        workingCopyPath,
        '..',
        `insert-source-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`,
    );
    const { writeFile } = await import('fs/promises');
    await writeFile(tempSourcePdfPath, mergedPdf);

    return {
        sourcePdfPath: tempSourcePdfPath,
        cleanup: async () => {
            try {
                if (existsSync(tempSourcePdfPath)) {
                    const { unlink } = await import('fs/promises');
                    await unlink(tempSourcePdfPath);
                }
            } catch (cleanupError) {
                log.debug(`Failed to cleanup insertion source PDF "${tempSourcePdfPath}": ${
                    cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                }`);
            }
        },
    };
}

async function insertPagesFromSourcePaths(
    workingCopyPath: string,
    totalPages: number,
    sourcePaths: string[],
    afterPage: number,
) {
    const { runCommand } = await import('@electron/ocr/worker/run-command');
    const { getOcrToolPaths } = await import('@electron/ocr/paths');
    const {
        rename,
        unlink,
    } = await import('fs/promises');

    const qpdf = getOcrToolPaths().qpdf;
    const dir = join(workingCopyPath, '..');
    const id = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempPath = join(dir, `${id}.pdf`);

    const {
        sourcePdfPath,
        cleanup,
    } = await prepareInsertionSourcePdf(workingCopyPath, sourcePaths);

    try {
        const pagesArgs: string[] = [];

        if (afterPage >= 1) {
            pagesArgs.push(workingCopyPath, `1-${afterPage}`);
        }

        pagesArgs.push(sourcePdfPath, '1-z');

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
        } catch (cleanupError) {
            log.debug(`Failed to cleanup temporary insert output "${tempPath}": ${
                cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`);
        }
        throw err;
    } finally {
        await cleanup();
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

async function handlePageOpsInsertFile(
    _event: Electron.IpcMainInvokeEvent,
    workingCopyPath: string,
    totalPages: number,
    afterPage: number,
    sourcePaths: string[],
) {
    validateWorkingCopyPath(workingCopyPath);

    if (typeof totalPages !== 'number' || totalPages < 1) {
        throw new Error('Invalid totalPages');
    }
    if (typeof afterPage !== 'number' || afterPage < 0) {
        throw new Error('Invalid afterPage');
    }
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
        throw new Error('Invalid source paths');
    }

    await insertPagesFromSourcePaths(workingCopyPath, totalPages, sourcePaths, afterPage);
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
    ipcMain.handle('page-ops:insert-file', handlePageOpsInsertFile);
    ipcMain.handle('page-ops:rotate', handlePageOpsRotate);
}
