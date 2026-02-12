import { ipcMain } from 'electron';
import { registerOcrHandlers } from '@electron/ocr/ipc';
import { registerSearchHandlers } from '@electron/search/ipc';
import { registerPageOpsHandlers } from '@electron/page-ops/ipc';
import type { ISettingsData } from '@app/types/shared';
import {
    loadSettings,
    saveSettings,
} from '@electron/settings';
import { updateRecentFilesMenu } from '@electron/menu';
import {
    addRecentFile,
    getRecentFiles,
    removeRecentFile,
    clearRecentFiles,
} from '@electron/recent-files';
import {
    handleFileRead,
    handleFileStat,
    handleFileReadRange,
    handleFileReadText,
    handleFileExists,
    handleFileWrite,
    handleFileWriteDocx,
    handleCleanupOcrTemp,
} from '@electron/ipc/fileOps';
import {
    handleOpenPdfDialog,
    handleOpenPdfDirect,
    handleSavePdfAs,
    handleSaveDocxAs,
    handleSetWindowTitle,
} from '@electron/ipc/dialogs';
import {
    handleFileSave,
    cleanupWorkingCopy,
} from '@electron/ipc/workingCopy';

export { clearAllWorkingCopies } from '@electron/ipc/workingCopy';

export function registerIpcHandlers() {
    ipcMain.handle('dialog:openPdf', handleOpenPdfDialog);
    ipcMain.handle('dialog:openPdfDirect', handleOpenPdfDirect);
    ipcMain.handle('dialog:savePdfAs', handleSavePdfAs);
    ipcMain.handle('dialog:saveDocxAs', handleSaveDocxAs);
    ipcMain.handle('file:read', handleFileRead);
    ipcMain.handle('file:stat', handleFileStat);
    ipcMain.handle('file:readRange', handleFileReadRange);
    ipcMain.handle('file:readText', handleFileReadText);
    ipcMain.handle('file:exists', handleFileExists);
    ipcMain.handle('file:write', handleFileWrite);
    ipcMain.handle('file:writeDocx', handleFileWriteDocx);
    ipcMain.handle('file:save', handleFileSave);
    ipcMain.handle('file:cleanup', (_event, workingPath: string) => {
        cleanupWorkingCopy(workingPath);
        return;
    });
    ipcMain.handle('file:cleanupOcrTemp', handleCleanupOcrTemp);
    ipcMain.handle('window:setTitle', handleSetWindowTitle);

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

    ipcMain.handle('settings:get', () => loadSettings());
    ipcMain.handle('settings:save', async (_event, settings: ISettingsData) => {
        await saveSettings(settings);
    });

    registerOcrHandlers();
    registerSearchHandlers();
    registerPageOpsHandlers();
}
