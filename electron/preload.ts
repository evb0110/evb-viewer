import type {IpcRendererEvent} from 'electron';
import {
    contextBridge,
    ipcRenderer,
} from 'electron';
import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from 'electron/ipc-types';

// Set up debug log forwarding from main process to console
ipcRenderer.on('debug:log', (_event: IpcRendererEvent, data: {
    source: string;
    message: string;
    timestamp: string 
}) => {
    console.log(`[${data.timestamp}] [${data.source}] ${data.message}`);
});

function installViteOutdatedOptimizeDepRecovery() {
    // Only applies in development (running via `electron .`).
    if (!process.defaultApp) {
        return;
    }
    if (typeof window === 'undefined') {
        return;
    }

    const RELOAD_KEY = 'electron-nuxt:dev:optimize-dep-reload';
    const RELOAD_COOLDOWN_MS = 10_000;

    function shouldReloadNow() {
        try {
            const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? '0');
            if (Number.isFinite(last) && last > 0 && Date.now() - last < RELOAD_COOLDOWN_MS) {
                return false;
            }
            window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
            return true;
        } catch {
            // If sessionStorage is unavailable, allow one reload attempt.
            return true;
        }
    }

    function scheduleReload(reason: string) {
        if (!window.location?.href?.includes('localhost:')) {
            return;
        }
        if (!shouldReloadNow()) {
            return;
        }
        console.warn(`[Dev] Recovering from Vite optimize-deps error (${reason}); reloading...`);
        setTimeout(() => window.location.reload(), 250);
    }

    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
        const message = event?.reason instanceof Error ? event.reason.message : String(event?.reason ?? '');
        if (
            message.includes('Failed to fetch dynamically imported module')
            || message.includes('Outdated Optimize Dep')
        ) {
            scheduleReload(message);
        }
    });
}

installViteOutdatedOptimizeDepRecovery();

contextBridge.exposeInMainWorld('electronAPI', {
    openPdfDialog: () => ipcRenderer.invoke('dialog:openPdf'),
    openPdfDirect: (path: string) => ipcRenderer.invoke('dialog:openPdfDirect', path),
    readFile: (path: string) => ipcRenderer.invoke('file:read', path),
    readTextFile: (path: string) => ipcRenderer.invoke('file:readText', path),
    fileExists: (path: string) => ipcRenderer.invoke('file:exists', path),
    writeFile: (path: string, data: Uint8Array) => ipcRenderer.invoke('file:write', path, data),
    saveFile: (path: string) => ipcRenderer.invoke('file:save', path),
    cleanupFile: (path: string) => ipcRenderer.invoke('file:cleanup', path),
    setWindowTitle: (title: string) => ipcRenderer.invoke('window:setTitle', title),

    onMenuOpenPdf: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent) => callback();
        ipcRenderer.on('menu:openPdf', handler);
        return () => ipcRenderer.removeListener('menu:openPdf', handler);
    },
    onMenuSave: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent) => callback();
        ipcRenderer.on('menu:save', handler);
        return () => ipcRenderer.removeListener('menu:save', handler);
    },
    onMenuZoomIn: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent) => callback();
        ipcRenderer.on('menu:zoomIn', handler);
        return () => ipcRenderer.removeListener('menu:zoomIn', handler);
    },
    onMenuZoomOut: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent) => callback();
        ipcRenderer.on('menu:zoomOut', handler);
        return () => ipcRenderer.removeListener('menu:zoomOut', handler);
    },
    onMenuActualSize: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent) => callback();
        ipcRenderer.on('menu:actualSize', handler);
        return () => ipcRenderer.removeListener('menu:actualSize', handler);
    },
    onMenuFitWidth: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent) => callback();
        ipcRenderer.on('menu:fitWidth', handler);
        return () => ipcRenderer.removeListener('menu:fitWidth', handler);
    },
    onMenuFitHeight: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent) => callback();
        ipcRenderer.on('menu:fitHeight', handler);
        return () => ipcRenderer.removeListener('menu:fitHeight', handler);
    },
    onMenuAbout: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent) => callback();
        ipcRenderer.on('menu:about', handler);
        return () => ipcRenderer.removeListener('menu:about', handler);
    },

    // OCR API
    ocrRecognize: (request: {
        pageNumber: number;
        imageData: number[];
        languages: string[];
    }) => ipcRenderer.invoke('ocr:recognize', request),

    ocrRecognizeBatch: (
        pages: Array<{
            pageNumber: number;
            imageData: number[];
            languages: string[] 
        }>,
        requestId: string,
    ) => ipcRenderer.invoke('ocr:recognizeBatch', pages, requestId),

    ocrGetLanguages: () => ipcRenderer.invoke('ocr:getLanguages'),

    ocrCreateSearchablePdf: (
        originalPdfData: Uint8Array,  // Electron IPC supports Uint8Array directly - no conversion needed
        pages: Array<{
            pageNumber: number;
            languages: string[];
        }>,
        requestId: string,
        workingCopyPath?: string,
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
        pdfData: number[] | null;
        pdfPath?: string;
        errors: string[];
    }) => void): (() => void) => {
        const handler = (_event: IpcRendererEvent, result: {
            requestId: string;
            success: boolean;
            pdfData: number[] | null;
            pdfPath?: string;
            errors: string[];
        }) => callback(result);
        ipcRenderer.on('ocr:complete', handler);
        return () => ipcRenderer.removeListener('ocr:complete', handler);
    },

    // Search API
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

    // Preprocessing API
    preprocessing: {
        validate: () => ipcRenderer.invoke('preprocessing:validate'),
        preprocessPage: (imageData: number[], usePreprocessing: boolean) =>
            ipcRenderer.invoke('preprocessing:preprocessPage', imageData, usePreprocessing),
    },

    recentFiles: {
        get: () => ipcRenderer.invoke('recent-files:get'),
        add: (path: string) => ipcRenderer.invoke('recent-files:add', path),
        remove: (path: string) => ipcRenderer.invoke('recent-files:remove', path),
        clear: () => ipcRenderer.invoke('recent-files:clear'),
    },

    onMenuClearRecentFiles: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent) => callback();
        ipcRenderer.on('menu:clearRecentFiles', handler);
        return () => ipcRenderer.removeListener('menu:clearRecentFiles', handler);
    },

    onMenuOpenRecentFile: (callback: (filePath: string) => void): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent, filePath: string) => callback(filePath);
        ipcRenderer.on('menu:openRecentFile', handler);
        return () => ipcRenderer.removeListener('menu:openRecentFile', handler);
    },
});
