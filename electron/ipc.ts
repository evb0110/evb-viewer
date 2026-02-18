import {
    BrowserWindow,
    ipcMain,
} from 'electron';
import type { ISettingsData } from '@app/types/shared';
import type {
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
    IWindowTabTargetWindow,
} from '@app/types/window-tab-transfer';
import { registerDjvuHandlers } from '@electron/djvu/ipc';
import { te } from '@electron/i18n';
import {
    setMenuDocumentState,
    setMenuTabCount,
    showTabContextMenu,
    updateRecentFilesMenu,
} from '@electron/menu';
import { getAllAppWindows } from '@electron/window';
import {
    acknowledgeWindowTabTransfer,
    requestWindowTabTransfer,
} from '@electron/window-tab-transfer';
import {
    handleCleanupOcrTemp,
    handleFileExists,
    handleFileRead,
    handleFileReadRange,
    handleFileReadText,
    handleFileStat,
    handleFileWrite,
    handleFileWriteDocx,
} from '@electron/ipc/fileOps';
import {
    handleCreateWorkingCopyFromData,
    handleOpenPdfDialog,
    handleOpenPdfDirect,
    handleOpenPdfDirectBatch,
    handleSaveDocxAs,
    handleSavePdfAs,
    handleSavePdfDialog,
    handleSetWindowTitle,
    handleShowItemInFolder,
} from '@electron/ipc/dialogs';
import {
    cleanupWorkingCopy,
    handleFileSave,
} from '@electron/ipc/workingCopy';
import {
    handlePdfExportImages,
    handlePdfExportMultiPageTiff,
} from '@electron/ipc/pdfExport';
import { registerOcrHandlers } from '@electron/ocr/ipc';
import { registerPageOpsHandlers } from '@electron/page-ops/ipc';
import {
    addRecentFile,
    clearRecentFiles,
    getRecentFiles,
    removeRecentFile,
} from '@electron/recent-files';
import { registerSearchHandlers } from '@electron/search/ipc';
import {
    loadSettings,
    saveSettings,
} from '@electron/settings';
import {
    deferDownloadedUpdate,
    getUpdateStatus,
    installDownloadedUpdate,
    skipUpdateVersion,
    triggerManualUpdateCheck,
} from '@electron/updates';

export { clearAllWorkingCopies } from '@electron/ipc/workingCopy';

function buildTabTransferTargetLabels(sourceWindowId: number): IWindowTabTargetWindow[] {
    const otherWindows = getAllAppWindows()
        .filter(window => window.id !== sourceWindowId)
        .sort((left, right) => left.id - right.id);

    const titleCountByLabel = new Map<string, number>();
    for (const window of otherWindows) {
        const title = (window.getTitle() || te('app.title')).trim() || te('app.title');
        titleCountByLabel.set(title, (titleCountByLabel.get(title) ?? 0) + 1);
    }

    return otherWindows.map((window) => {
        const title = (window.getTitle() || te('app.title')).trim() || te('app.title');
        const duplicateCount = titleCountByLabel.get(title) ?? 0;
        return {
            windowId: window.id,
            label: duplicateCount > 1 ? `${title} (${window.id})` : title,
        };
    });
}

export function registerIpcHandlers() {
    ipcMain.handle('dialog:openPdf', handleOpenPdfDialog);
    ipcMain.handle('dialog:openPdfDirect', handleOpenPdfDirect);
    ipcMain.handle('dialog:openPdfDirectBatch', handleOpenPdfDirectBatch);
    ipcMain.handle('working-copy:createFromData', handleCreateWorkingCopyFromData);
    ipcMain.handle('dialog:savePdfAs', handleSavePdfAs);
    ipcMain.handle('dialog:savePdfDialog', handleSavePdfDialog);
    ipcMain.handle('dialog:saveDocxAs', handleSaveDocxAs);
    ipcMain.handle('pdf-export:images', handlePdfExportImages);
    ipcMain.handle('pdf-export:multipage-tiff', handlePdfExportMultiPageTiff);
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
    ipcMain.handle('shell:showItemInFolder', handleShowItemInFolder);
    ipcMain.handle('menu:setDocumentState', (event, hasDocument: boolean) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            return;
        }

        setMenuDocumentState(window.id, hasDocument);
    });
    ipcMain.handle('menu:setTabCount', (event, tabCount: number) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            return;
        }

        setMenuTabCount(window.id, tabCount);
    });

    ipcMain.handle('tabs:transfer', async (event, request: IWindowTabTransferRequest) => {
        const sourceWindow = BrowserWindow.fromWebContents(event.sender);
        if (!sourceWindow) {
            return {
                transferId: '',
                success: false,
                targetWindowId: request.target.kind === 'window' ? request.target.windowId : -1,
                error: 'Source window is not available.',
            };
        }

        return requestWindowTabTransfer(sourceWindow.id, request);
    });

    ipcMain.handle('tabs:transferAck', (event, ack: IWindowTabTransferAck) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            return false;
        }

        return acknowledgeWindowTabTransfer(window.id, ack);
    });

    ipcMain.handle('tabs:listTargets', (event): IWindowTabTargetWindow[] => {
        const sourceWindow = BrowserWindow.fromWebContents(event.sender);
        if (!sourceWindow) {
            return [];
        }

        return buildTabTransferTargetLabels(sourceWindow.id);
    });

    ipcMain.handle('tabs:showContextMenu', (event, tabId: string) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            return;
        }

        showTabContextMenu(window, tabId);
    });

    ipcMain.handle('window:closeCurrent', (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window || window.isDestroyed()) {
            return false;
        }

        window.close();
        return true;
    });

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
        updateRecentFilesMenu();
    });

    ipcMain.handle('updates:getState', () => getUpdateStatus());
    ipcMain.handle('updates:check', () => triggerManualUpdateCheck());
    ipcMain.handle('updates:install', () => installDownloadedUpdate());
    ipcMain.handle('updates:defer', () => deferDownloadedUpdate());
    ipcMain.handle('updates:skipVersion', (_event, version: string) => skipUpdateVersion(version));

    registerOcrHandlers();
    registerSearchHandlers();
    registerPageOpsHandlers();
    registerDjvuHandlers();
}
