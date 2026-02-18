import type {
    IpcRenderer,
    IpcRendererEvent,
    webUtils,
} from 'electron';
import type { ISettingsData } from '@app/types/shared';
import type {
    IAppUpdateStatus,
    IElectronAPI,
} from '@app/types/electron-api';
import type {
    IWindowTabIncomingTransfer,
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
    TWindowTabsAction,
} from '@app/types/window-tab-transfer';
import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from 'electron/ipc-types';
import { getDebugLogMessages } from '@electron/preload/debug-log-buffer';

function onNoArgEvent(ipcRenderer: IpcRenderer, channel: string, callback: IMenuEventCallback): IMenuEventUnsubscribe {
    const handler = (_event: IpcRendererEvent) => callback();
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

function onSingleArgEvent<T>(
    ipcRenderer: IpcRenderer,
    channel: string,
    callback: (arg: T) => void,
): IMenuEventUnsubscribe {
    const handler = (_event: IpcRendererEvent, arg: T) => callback(arg);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

export function createElectronApi(ipcRenderer: IpcRenderer, electronWebUtils: typeof webUtils): IElectronAPI {
    const api = {
        openPdfDialog: () => ipcRenderer.invoke('dialog:openPdf'),
        openPdfDirect: (path: string) => ipcRenderer.invoke('dialog:openPdfDirect', path),
        openPdfDirectBatch: (paths: string[], requestId?: string) => ipcRenderer.invoke('dialog:openPdfDirectBatch', paths, requestId),
        savePdfAs: (workingPath: string) => ipcRenderer.invoke('dialog:savePdfAs', workingPath),
        savePdfDialog: (suggestedName: string) => ipcRenderer.invoke('dialog:savePdfDialog', suggestedName),
        saveDocxAs: (workingPath: string) => ipcRenderer.invoke('dialog:saveDocxAs', workingPath),
        exportPdfToImages: (workingPath: string, pageNumbers?: number[]) =>
            ipcRenderer.invoke('pdf-export:images', workingPath, pageNumbers),
        exportPdfToMultiPageTiff: (workingPath: string, pageNumbers?: number[]) =>
            ipcRenderer.invoke('pdf-export:multipage-tiff', workingPath, pageNumbers),
        readFile: (path: string) => ipcRenderer.invoke('file:read', path),
        statFile: (path: string) => ipcRenderer.invoke('file:stat', path),
        readFileRange: (path: string, offset: number, length: number) => ipcRenderer.invoke('file:readRange', path, offset, length),
        readTextFile: (path: string) => ipcRenderer.invoke('file:readText', path),
        fileExists: (path: string) => ipcRenderer.invoke('file:exists', path),
        writeFile: (path: string, data: Uint8Array) => ipcRenderer.invoke('file:write', path, data),
        writeDocxFile: (path: string, data: Uint8Array) => ipcRenderer.invoke('file:writeDocx', path, data),
        createWorkingCopyFromData: (fileName: string, data: Uint8Array, originalPath?: string) =>
            ipcRenderer.invoke('working-copy:createFromData', fileName, data, originalPath),
        saveFile: (path: string) => ipcRenderer.invoke('file:save', path),
        cleanupFile: (path: string) => ipcRenderer.invoke('file:cleanup', path),
        cleanupOcrTemp: (path: string) => ipcRenderer.invoke('file:cleanupOcrTemp', path),
        setWindowTitle: (title: string) => ipcRenderer.invoke('window:setTitle', title),
        showItemInFolder: (path: string) => ipcRenderer.invoke('shell:showItemInFolder', path),
        setMenuDocumentState: (hasDocument: boolean) => ipcRenderer.invoke('menu:setDocumentState', hasDocument),
        setMenuTabCount: (tabCount: number) => ipcRenderer.invoke('menu:setTabCount', tabCount),
        closeCurrentWindow: () => ipcRenderer.invoke('window:closeCurrent'),
        notifyRendererReady: () => ipcRenderer.send('app:rendererReady'),
        getDebugLogs: () => Promise.resolve(getDebugLogMessages()),

        onMenuOpenPdf: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:openPdf', callback),
        onMenuSave: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:save', callback),
        onMenuSaveAs: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:saveAs', callback),
        onMenuExportDocx: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:exportDocx', callback),
        onMenuExportImages: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:exportImages', callback),
        onMenuExportMultiPageTiff: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:exportMultiPageTiff', callback),
        onMenuZoomIn: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:zoomIn', callback),
        onMenuZoomOut: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:zoomOut', callback),
        onMenuActualSize: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:actualSize', callback),
        onMenuFitWidth: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:fitWidth', callback),
        onMenuFitHeight: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:fitHeight', callback),
        onMenuViewModeSingle: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:viewModeSingle', callback),
        onMenuViewModeFacing: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:viewModeFacing', callback),
        onMenuViewModeFacingFirstSingle: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:viewModeFacingFirstSingle', callback),
        onMenuUndo: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:undo', callback),
        onMenuRedo: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:redo', callback),

        ocrRecognize: (request: {
            pageNumber: number;
            imageData: Uint8Array;
            languages: string[];
        }) => ipcRenderer.invoke('ocr:recognize', request),

        ocrRecognizeBatch: (
            pages: Array<{
                pageNumber: number;
                imageData: Uint8Array;
                languages: string[];
            }>,
            requestId: string,
        ) => ipcRenderer.invoke('ocr:recognizeBatch', pages, requestId),

        ocrCancel: (requestId: string) => ipcRenderer.invoke('ocr:cancel', requestId),

        ocrGetLanguages: () => ipcRenderer.invoke('ocr:getLanguages'),

        ocrCreateSearchablePdf: (
            originalPdfData: Uint8Array,
            pages: Array<{
                pageNumber: number;
                languages: string[];
            }>,
            requestId: string,
            workingCopyPath?: string | null,
            renderDpi?: number,
        ) => ipcRenderer.invoke('ocr:createSearchablePdf', originalPdfData, pages, requestId, workingCopyPath, renderDpi),

        onOcrProgress: (callback: (progress: {
            requestId: string;
            currentPage: number;
            processedCount: number;
            totalPages: number;
        }) => void): (() => void) => {
            const handler = (_event: IpcRendererEvent, progress: {
                requestId: string;
                currentPage: number;
                processedCount: number;
                totalPages: number;
            }) => callback(progress);
            ipcRenderer.on('ocr:progress', handler);
            return () => ipcRenderer.removeListener('ocr:progress', handler);
        },

        onOcrComplete: (callback: (result: {
            requestId: string;
            success: boolean;
            pdfData: Uint8Array | null;
            pdfPath?: string;
            errors: string[];
        }) => void): (() => void) => {
            const handler = (_event: IpcRendererEvent, result: {
                requestId: string;
                success: boolean;
                pdfData: Uint8Array | null;
                pdfPath?: string;
                errors: string[];
            }) => callback(result);
            ipcRenderer.on('ocr:complete', handler);
            return () => ipcRenderer.removeListener('ocr:complete', handler);
        },

        pdfSearch: (
            pdfPath: string,
            query: string,
            options?: {
                requestId?: string;
                pageCount?: number;
            },
        ) => ipcRenderer.invoke('pdf:search', {
            pdfPath,
            query,
            ...options,
        }),
        pdfSearchCancel: (requestId?: string) =>
            ipcRenderer.invoke('pdf:search:cancel', requestId),

        onPdfSearchProgress: (callback: (progress: {
            requestId: string;
            processed: number;
            total: number;
        }) => void): (() => void) => {
            const handler = (_event: IpcRendererEvent, progress: {
                requestId: string;
                processed: number;
                total: number;
            }) => callback(progress);
            ipcRenderer.on('pdf:search:progress', handler);
            return () => ipcRenderer.removeListener('pdf:search:progress', handler);
        },

        pdfSearchResetCache: () => ipcRenderer.invoke('pdf:search:resetCache'),

        preprocessing: {
            validate: () => ipcRenderer.invoke('preprocessing:validate'),
            preprocessPage: (imageData: Uint8Array, usePreprocessing: boolean) =>
                ipcRenderer.invoke('preprocessing:preprocessPage', imageData, usePreprocessing),
        },

        recentFiles: {
            get: () => ipcRenderer.invoke('recent-files:get'),
            add: (path: string) => ipcRenderer.invoke('recent-files:add', path),
            remove: (path: string) => ipcRenderer.invoke('recent-files:remove', path),
            clear: () => ipcRenderer.invoke('recent-files:clear'),
        },

        onMenuClearRecentFiles: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:clearRecentFiles', callback),

        onMenuOpenRecentFile: (callback: (filePath: string) => void): IMenuEventUnsubscribe =>
            onSingleArgEvent(ipcRenderer, 'menu:openRecentFile', callback),
        onMenuOpenExternalPaths: (callback: (paths: string[]) => void): IMenuEventUnsubscribe =>
            onSingleArgEvent(ipcRenderer, 'menu:openExternalPaths', callback),
        onOpenPdfDirectBatchProgress: (callback: (progress: {
            requestId: string;
            processed: number;
            total: number;
            percent: number;
            elapsedMs: number;
            estimatedRemainingMs: number | null;
        }) => void): IMenuEventUnsubscribe => onSingleArgEvent(
            ipcRenderer,
            'dialog:openPdfDirectBatch:progress',
            callback,
        ),

        settings: {
            get: () => ipcRenderer.invoke('settings:get'),
            save: (settings: ISettingsData) => ipcRenderer.invoke('settings:save', settings),
        },

        onMenuOpenSettings: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:openSettings', callback),
        onMenuCheckForUpdates: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:checkForUpdates', callback),

        onMenuDeletePages: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:deletePages', callback),
        onMenuExtractPages: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:extractPages', callback),
        onMenuRotateCw: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:rotateCw', callback),
        onMenuRotateCcw: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:rotateCcw', callback),
        onMenuInsertPages: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:insertPages', callback),

        djvu: {
            openForViewing: (djvuPath: string) =>
                ipcRenderer.invoke('djvu:openForViewing', djvuPath),
            convertToPdf: (djvuPath: string, outputPath: string, options: {
                subsample?: number;
                preserveBookmarks?: boolean;
            }) =>
                ipcRenderer.invoke('djvu:convertToPdf', djvuPath, outputPath, options),
            cancel: (jobId: string) =>
                ipcRenderer.invoke('djvu:cancel', jobId),
            getInfo: (djvuPath: string) =>
                ipcRenderer.invoke('djvu:getInfo', djvuPath),
            estimateSizes: (djvuPath: string) =>
                ipcRenderer.invoke('djvu:estimateSizes', djvuPath),
            cleanupTemp: (tempPdfPath: string) =>
                ipcRenderer.invoke('djvu:cleanupTemp', tempPdfPath),
            onProgress: (callback: (progress: {
                jobId: string;
                phase: 'converting' | 'bookmarks' | 'loading';
                current?: number;
                total?: number;
                percent: number;
            }) => void): (() => void) => {
                const handler = (_event: IpcRendererEvent, progress: {
                    jobId: string;
                    phase: 'converting' | 'bookmarks' | 'loading';
                    current?: number;
                    total?: number;
                    percent: number;
                }) => callback(progress);
                ipcRenderer.on('djvu:progress', handler);
                return () => ipcRenderer.removeListener('djvu:progress', handler);
            },
            onViewingReady: (callback: (data: {
                pdfPath: string;
                isPartial: boolean;
                jobId?: string;
            }) => void): (() => void) => {
                const handler = (_event: IpcRendererEvent, data: {
                    pdfPath: string;
                    isPartial: boolean;
                    jobId?: string;
                }) => callback(data);
                ipcRenderer.on('djvu:viewingReady', handler);
                return () => ipcRenderer.removeListener('djvu:viewingReady', handler);
            },
            onViewingError: (callback: (data: {
                error: string;
                jobId?: string;
            }) => void): (() => void) => {
                const handler = (_event: IpcRendererEvent, data: {
                    error: string;
                    jobId?: string;
                }) => callback(data);
                ipcRenderer.on('djvu:viewingError', handler);
                return () => ipcRenderer.removeListener('djvu:viewingError', handler);
            },
        },

        updates: {
            getState: () => ipcRenderer.invoke('updates:getState'),
            check: () => ipcRenderer.invoke('updates:check'),
            install: () => ipcRenderer.invoke('updates:install'),
            defer: () => ipcRenderer.invoke('updates:defer'),
            skipVersion: (version: string) => ipcRenderer.invoke('updates:skipVersion', version),
            onStatus: (callback: (status: IAppUpdateStatus) => void): IMenuEventUnsubscribe =>
                onSingleArgEvent(ipcRenderer, 'updates:status', callback),
        },

        onMenuConvertToPdf: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:convertToPdf', callback),

        onMenuNewTab: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:newTab', callback),
        onMenuCloseTab: (callback: IMenuEventCallback): IMenuEventUnsubscribe => onNoArgEvent(ipcRenderer, 'menu:closeTab', callback),
        onMenuSplitEditor: (callback: (direction: 'left' | 'right' | 'up' | 'down') => void): IMenuEventUnsubscribe =>
            onSingleArgEvent(ipcRenderer, 'menu:splitEditor', callback),
        onMenuFocusEditorGroup: (callback: (direction: 'left' | 'right' | 'up' | 'down') => void): IMenuEventUnsubscribe =>
            onSingleArgEvent(ipcRenderer, 'menu:focusEditorGroup', callback),
        onMenuMoveTabToGroup: (callback: (direction: 'left' | 'right' | 'up' | 'down') => void): IMenuEventUnsubscribe =>
            onSingleArgEvent(ipcRenderer, 'menu:moveTabToGroup', callback),
        onMenuCopyTabToGroup: (callback: (direction: 'left' | 'right' | 'up' | 'down') => void): IMenuEventUnsubscribe =>
            onSingleArgEvent(ipcRenderer, 'menu:copyTabToGroup', callback),

        pageOps: {
            delete: (workingCopyPath: string, pages: number[], totalPages: number) =>
                ipcRenderer.invoke('page-ops:delete', workingCopyPath, pages, totalPages),
            extract: (workingCopyPath: string, pages: number[]) =>
                ipcRenderer.invoke('page-ops:extract', workingCopyPath, pages),
            reorder: (workingCopyPath: string, newOrder: number[]) =>
                ipcRenderer.invoke('page-ops:reorder', workingCopyPath, newOrder),
            insert: (workingCopyPath: string, totalPages: number, afterPage: number) =>
                ipcRenderer.invoke('page-ops:insert', workingCopyPath, totalPages, afterPage),
            insertFile: (workingCopyPath: string, totalPages: number, afterPage: number, sourcePaths: string[]) =>
                ipcRenderer.invoke('page-ops:insert-file', workingCopyPath, totalPages, afterPage, sourcePaths),
            rotate: (workingCopyPath: string, pages: number[], angle: number) =>
                ipcRenderer.invoke('page-ops:rotate', workingCopyPath, pages, angle),
        },

        tabs: {
            transfer: (request: IWindowTabTransferRequest) =>
                ipcRenderer.invoke('tabs:transfer', request),
            transferAck: (ack: IWindowTabTransferAck) =>
                ipcRenderer.invoke('tabs:transferAck', ack),
            listTargetWindows: () =>
                ipcRenderer.invoke('tabs:listTargets'),
            showContextMenu: (tabId: string) =>
                ipcRenderer.invoke('tabs:showContextMenu', tabId),
            onIncomingTransfer: (callback: (transfer: IWindowTabIncomingTransfer) => void): IMenuEventUnsubscribe =>
                onSingleArgEvent(ipcRenderer, 'tabs:incomingTransfer', callback),
            onWindowAction: (callback: (action: TWindowTabsAction) => void): IMenuEventUnsubscribe =>
                onSingleArgEvent(ipcRenderer, 'menu:windowTabsAction', callback),
        },

        getPathForFile: (file: File) => electronWebUtils.getPathForFile(file),
    } satisfies IElectronAPI;

    return api;
}
