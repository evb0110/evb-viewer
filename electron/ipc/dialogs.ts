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
import { uniq } from 'es-toolkit/array';
import {
    buildCombinedPdfOutputPath,
    createPdfFromInputPaths,
    isDjvuPath,
    isPdfPath,
    isSupportedOpenPath,
    SUPPORTED_IMAGE_EXTENSIONS,
} from '@electron/image/pdf-conversion';
import { updateRecentFilesMenu } from '@electron/menu';
import { addRecentFile } from '@electron/recent-files';
import { allowDocxWritePath } from '@electron/ipc/docxExportPaths';
import {
    createWorkingCopy,
    createWorkingCopyFromData,
    workingCopyMap,
} from '@electron/ipc/workingCopy';
import { te } from '@electron/i18n';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('dialogs');

interface IOpenPdfResult {
    kind: 'pdf';
    workingPath: string;
    originalPath: string;
    isGenerated?: boolean;
}

interface IOpenDjvuResult {
    kind: 'djvu';
    workingPath: '';
    originalPath: string;
}

type IOpenFileResult = IOpenPdfResult | IOpenDjvuResult;

function toRecentDocumentPaths(paths: string[]) {
    return paths.filter(path => isPdfPath(path) || isDjvuPath(path));
}

async function addRecentInputs(paths: string[]) {
    const uniquePaths = uniq(paths);
    for (const path of uniquePaths) {
        await addRecentFile(path);
    }
    updateRecentFilesMenu();
}

function normalizeInputPaths(paths: string[]) {
    return paths
        .map(path => path.trim())
        .filter(path => path.length > 0);
}

function errorWithDetails(fallbackMessage: string, details: unknown): Error {
    const detailText = details instanceof Error ? details.message : String(details ?? '').trim();
    if (!detailText) {
        return new Error(fallbackMessage);
    }
    return new Error(`${fallbackMessage}: ${detailText}`);
}

async function openInputPaths(paths: string[]): Promise<IOpenFileResult | null> {
    const normalizedPaths = normalizeInputPaths(paths);
    if (normalizedPaths.length === 0) {
        return null;
    }

    if (normalizedPaths.some(path => !existsSync(path))) {
        throw new Error(te('errors.file.invalid'));
    }

    if (normalizedPaths.some(path => !isSupportedOpenPath(path))) {
        throw new Error(te('errors.file.invalid'));
    }

    const djvuPaths = normalizedPaths.filter(path => isDjvuPath(path));
    if (djvuPaths.length > 0) {
        if (normalizedPaths.length !== 1 || djvuPaths.length !== 1) {
            throw new Error(te('errors.file.invalid'));
        }

        const djvuPath = djvuPaths[0]!;
        await addRecentInputs([djvuPath]);
        return {
            kind: 'djvu',
            workingPath: '',
            originalPath: djvuPath,
        };
    }

    if (normalizedPaths.length === 1 && isPdfPath(normalizedPaths[0]!)) {
        const originalPath = normalizedPaths[0]!;
        const workingPath = await createWorkingCopy(originalPath);
        await addRecentInputs([originalPath]);
        return {
            kind: 'pdf',
            workingPath,
            originalPath,
        };
    }

    const mergedPdf = await createPdfFromInputPaths(normalizedPaths);
    const outputPath = buildCombinedPdfOutputPath(normalizedPaths);
    const workingPath = await createWorkingCopyFromData(
        basename(outputPath),
        mergedPdf,
        outputPath,
    );

    const recentDocumentPaths = toRecentDocumentPaths(normalizedPaths);
    if (recentDocumentPaths.length > 0) {
        await addRecentInputs(recentDocumentPaths);
    }

    return {
        kind: 'pdf',
        workingPath,
        originalPath: outputPath,
        isGenerated: true,
    };
}

export async function handleOpenPdfDirect(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
): Promise<IOpenFileResult | null> {
    if (!filePath || filePath.trim() === '') {
        return null;
    }

    try {
        return await openInputPaths([filePath]);
    } catch (err) {
        logger.error(`Failed to create working copy: ${err instanceof Error ? err.message : String(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenPdfDirectBatch(
    _event: Electron.IpcMainInvokeEvent,
    filePaths: string[],
): Promise<IOpenFileResult | null> {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return null;
    }

    try {
        return await openInputPaths(filePaths);
    } catch (err) {
        logger.error(`Failed to create working copy from batch: ${err instanceof Error ? err.message : String(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export function handleSetWindowTitle(event: Electron.IpcMainInvokeEvent, title: string) {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
        window.setTitle(title || te('app.title'));
    }
}

export async function handleOpenPdfDialog(): Promise<IOpenFileResult | null> {
    const result = await dialog.showOpenDialog({
        title: te('dialogs.openDocument'),
        filters: [{
            name: te('dialogs.documentsFilter'),
            extensions: [
                'pdf',
                'djvu',
                'djv',
                ...SUPPORTED_IMAGE_EXTENSIONS.map(ext => ext.slice(1)),
            ],
        }],
        properties: [
            'openFile',
            'multiSelections',
        ],
    });

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    try {
        return await openInputPaths(result.filePaths);
    } catch (err) {
        logger.error(`Failed to create working copy: ${err instanceof Error ? err.message : String(err)}`);
        throw errorWithDetails(te('errors.file.open'), err);
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
        title: te('dialogs.savePdfAs'),
        defaultPath: suggestedName.endsWith('.pdf') ? suggestedName : `${suggestedName}.pdf`,
        filters: [{
            name: te('dialogs.pdfFiles'),
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
        title: te('dialogs.savePdf'),
        defaultPath: suggestedName.endsWith('.pdf') ? suggestedName : `${suggestedName}.pdf`,
        filters: [{
            name: te('dialogs.pdfFiles'),
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
        title: te('dialogs.saveOcrTextAs'),
        defaultPath: `${suggestedBase}.docx`,
        filters: [{
            name: te('dialogs.wordDocuments'),
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

    allowDocxWritePath(targetPath);

    return targetPath;
}
