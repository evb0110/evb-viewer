import type {IpcRendererEvent} from 'electron';
import {
    contextBridge,
    ipcRenderer,
} from 'electron';
import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from 'electron/ipc-types';
import type {
    IProcessingOptions,
    IProcessingProgress,
    IProcessingRequest,
    IProcessingResult,
} from 'electron/page-processing/types';
import type {
    ICreateProjectRequest,
    ICreateProjectResult,
    IGenerateOutputRequest,
    IGenerateOutputResult,
    ILoadProjectResult,
    IPreviewStageRequest,
    IPreviewStageResult,
    IProcessingProject,
    IProjectStatusResult,
    IRunStageRequest,
    IRunStageResult,
    ISaveProjectResult,
    IStageProgress,
} from 'electron/page-processing/project';

// M1.4: Improved preload guard - skip duplicate installation without throwing
const __preloadAlreadyInstalled = (globalThis as Record<string, unknown>).__preloadInstalled === true;
if (__preloadAlreadyInstalled) {
    console.debug('[Preload] Skipping duplicate installation (fast reload detected)');
}

if (!__preloadAlreadyInstalled) {
    (globalThis as Record<string, unknown>).__preloadInstalled = true;

    // Set up debug log forwarding from main process to console
    ipcRenderer.on('debug:log', (_event: IpcRendererEvent, data: {
        source: string;
        message: string;
        timestamp: string
    }) => {
        console.log(`[${data.timestamp}] [${data.source}] ${data.message}`);
    });

    // M6.1: Reload event tracking interface and history
    interface IReloadEvent {
        timestamp: number;
        reason: string;
        blocked: boolean;
        blockReason?: string;
        reloadId: string;
    }

    const reloadHistory: IReloadEvent[] = [];
    if (typeof window !== 'undefined') {
        (window as Window & { __reloadHistory?: IReloadEvent[] }).__reloadHistory = reloadHistory;
    }

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
        // M1.2: First-load grace period
        const INITIAL_LOAD_GRACE_MS = 1000;
        // M1.3: Maximum reloads per session
        const MAX_RELOADS_KEY = 'electron-nuxt:dev:reload-count';
        const MAX_RELOADS_PER_SESSION = 3;

        const pageLoadTime = Date.now();

        // M1.1: Improved error matching specificity
        function isViteOptimizeDepError(msg: string): boolean {
            if (msg.includes('Outdated Optimize Dep')) {
                return true;
            }
            if (msg.includes('Failed to fetch dynamically imported module') && msg.includes('localhost:')) {
                return true;
            }
            return false;
        }

        function shouldReloadNow(): {
            allowed: boolean;
            blockReason?: string 
        } {
            try {
                // M1.2: Check grace period first
                const timeSinceLoad = Date.now() - pageLoadTime;
                if (timeSinceLoad < INITIAL_LOAD_GRACE_MS) {
                    return {
                        allowed: false,
                        blockReason: `Within initial load grace period (${timeSinceLoad}ms < ${INITIAL_LOAD_GRACE_MS}ms)`,
                    };
                }

                // M1.3: Check maximum reloads per session
                const reloadCount = Number(window.sessionStorage.getItem(MAX_RELOADS_KEY) ?? '0');
                if (reloadCount >= MAX_RELOADS_PER_SESSION) {
                    return {
                        allowed: false,
                        blockReason: `Maximum reloads exceeded (${reloadCount} >= ${MAX_RELOADS_PER_SESSION})`,
                    };
                }

                // Check cooldown
                const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? '0');
                if (Number.isFinite(last) && last > 0 && Date.now() - last < RELOAD_COOLDOWN_MS) {
                    return {
                        allowed: false,
                        blockReason: `Cooldown active (${Date.now() - last}ms < ${RELOAD_COOLDOWN_MS}ms)`,
                    };
                }

                // Update session storage
                window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
                window.sessionStorage.setItem(MAX_RELOADS_KEY, String(reloadCount + 1));
                return { allowed: true };
            } catch {
                // If sessionStorage is unavailable, allow one reload attempt.
                return { allowed: true };
            }
        }

        function scheduleReload(reason: string) {
            // M0.1: Generate unique reload ID
            const reloadId = `reload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

            if (!window.location?.href?.includes('localhost:')) {
                const event: IReloadEvent = {
                    timestamp: Date.now(),
                    reason,
                    blocked: true,
                    blockReason: 'Not running on localhost',
                    reloadId,
                };
                reloadHistory.push(event);
                return;
            }

            const reloadCheck = shouldReloadNow();
            if (!reloadCheck.allowed) {
                const event: IReloadEvent = {
                    timestamp: Date.now(),
                    reason,
                    blocked: true,
                    blockReason: reloadCheck.blockReason,
                    reloadId,
                };
                reloadHistory.push(event);
                console.debug(`[Dev] Reload blocked: ${reloadCheck.blockReason} [${reloadId}]`);
                return;
            }

            // M6.1: Track reload event before executing
            const event: IReloadEvent = {
                timestamp: Date.now(),
                reason,
                blocked: false,
                reloadId,
            };
            reloadHistory.push(event);

            // M0.1: Enhanced logging
            console.warn(`[Dev] Recovering from Vite optimize-deps error (${reason}); reloading... [${reloadId}]`);
            try {
                console.warn(`[Dev] Reload scheduled at ${new Date().toISOString()}, cooldown state:`, {
                    lastReload: window.sessionStorage.getItem(RELOAD_KEY),
                    timeSinceLastReload: Date.now() - Number(window.sessionStorage.getItem(RELOAD_KEY) ?? '0'),
                    reloadCount: window.sessionStorage.getItem(MAX_RELOADS_KEY),
                });
            } catch {
                // sessionStorage may be unavailable
            }

            setTimeout(() => window.location.reload(), 250);
        }

        window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
            const message = event?.reason instanceof Error ? event.reason.message : String(event?.reason ?? '');
            // M1.1: Use improved error matching
            if (isViteOptimizeDepError(message)) {
                scheduleReload(message);
            }
        });
    }

    installViteOutdatedOptimizeDepRecovery();

    contextBridge.exposeInMainWorld('electronAPI', {
        openPdfDialog: () => ipcRenderer.invoke('dialog:openPdf'),
        openPdfDirect: (path: string) => ipcRenderer.invoke('dialog:openPdfDirect', path),
        savePdfAs: (workingPath: string) => ipcRenderer.invoke('dialog:savePdfAs', workingPath),
        readFile: (path: string) => ipcRenderer.invoke('file:read', path),
        statFile: (path: string) => ipcRenderer.invoke('file:stat', path),
        readFileRange: (path: string, offset: number, length: number) => ipcRenderer.invoke('file:readRange', path, offset, length),
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
        onMenuSaveAs: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
            const handler = (_event: IpcRendererEvent) => callback();
            ipcRenderer.on('menu:saveAs', handler);
            return () => ipcRenderer.removeListener('menu:saveAs', handler);
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
                languages: string[];
            }>,
            requestId: string,
        ) => ipcRenderer.invoke('ocr:recognizeBatch', pages, requestId),

        ocrGetLanguages: () => ipcRenderer.invoke('ocr:getLanguages'),

        ocrCreateSearchablePdf: (
            originalPdfData: Uint8Array,
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

        // Page Processing API (Legacy)
        pageProcessing: {
            process: (
                pdfPath: string,
                pages: number[],
                options: Partial<IProcessingOptions>,
                requestId: string,
                workingCopyPath?: string,
            ) => {
                // Construct the request object expected by the IPC handler
                const request: IProcessingRequest = {
                    jobId: requestId,
                    pdfPath,
                    pages,
                    options: {
                        operations: options.operations ?? [
                            'split',
                            'deskew',
                            'dewarp',
                            'crop',
                        ],
                        autoDetectFacingPages: options.autoDetectFacingPages ?? true,
                        forceSplit: options.forceSplit ?? false,
                        minSkewAngle: options.minSkewAngle ?? 0.5,
                        minCurvatureThreshold: options.minCurvatureThreshold ?? 0.1,
                        cropPadding: options.cropPadding ?? 30,
                        outputDpi: options.outputDpi ?? 300,
                        extractionDpi: options.extractionDpi ?? 300,
                    },
                    workingCopyPath,
                };
                return ipcRenderer.invoke('pageProcessing:process', request);
            },

            cancel: (jobId: string) =>
                ipcRenderer.invoke('pageProcessing:cancel', jobId),

            validateTools: () =>
                ipcRenderer.invoke('pageProcessing:validateTools'),

            onProgress: (callback: (progress: IProcessingProgress) => void): (() => void) => {
                const handler = (_event: IpcRendererEvent, progress: IProcessingProgress) =>
                    callback(progress);
                ipcRenderer.on('pageProcessing:progress', handler);
                return () => ipcRenderer.removeListener('pageProcessing:progress', handler);
            },

            onComplete: (callback: (result: IProcessingResult) => void): (() => void) => {
                const handler = (_event: IpcRendererEvent, result: IProcessingResult) =>
                    callback(result);
                ipcRenderer.on('pageProcessing:complete', handler);
                return () => ipcRenderer.removeListener('pageProcessing:complete', handler);
            },
            onLog: (callback: (entry: { jobId: string; level: string; message: string; }) => void): (() => void) => {
                const handler = (_event: IpcRendererEvent, entry: { jobId: string; level: string; message: string; }) =>
                    callback(entry);
                ipcRenderer.on('pageProcessing:log', handler);
                return () => ipcRenderer.removeListener('pageProcessing:log', handler);
            },

            // New Project-Based API
            createProject: (request: ICreateProjectRequest): Promise<ICreateProjectResult> =>
                ipcRenderer.invoke('pageProcessing:createProject', request),

            loadProject: (projectId: string): Promise<ILoadProjectResult> =>
                ipcRenderer.invoke('pageProcessing:loadProject', projectId),

            saveProject: (project: IProcessingProject): Promise<ISaveProjectResult> =>
                ipcRenderer.invoke('pageProcessing:saveProject', project),

            listProjects: (): Promise<{
                success: boolean;
                projects?: Array<{
                    id: string;
                    originalPdfPath: string;
                    createdAt: number;
                    updatedAt: number;
                    status: string;
                }>;
                error?: string;
            }> => ipcRenderer.invoke('pageProcessing:listProjects'),

            deleteProject: (projectId: string): Promise<{
                success: boolean;
                error?: string 
            }> =>
                ipcRenderer.invoke('pageProcessing:deleteProject', projectId),

            runStage: (request: IRunStageRequest): Promise<IRunStageResult> =>
                ipcRenderer.invoke('pageProcessing:runStage', request),

            previewStage: (request: IPreviewStageRequest): Promise<IPreviewStageResult> =>
                ipcRenderer.invoke('pageProcessing:previewStage', request),

            cancelStage: (jobId: string): Promise<{
                cancelled: boolean;
                error?: string 
            }> =>
                ipcRenderer.invoke('pageProcessing:cancelStage', jobId),

            generateOutput: (request: IGenerateOutputRequest): Promise<IGenerateOutputResult> =>
                ipcRenderer.invoke('pageProcessing:generateOutput', request),

            getProjectStatus: (projectId: string): Promise<IProjectStatusResult> =>
                ipcRenderer.invoke('pageProcessing:getProjectStatus', projectId),

            onStageProgress: (callback: (progress: IStageProgress) => void): (() => void) => {
                const handler = (_event: IpcRendererEvent, progress: IStageProgress) =>
                    callback(progress);
                ipcRenderer.on('pageProcessing:stageProgress', handler);
                return () => ipcRenderer.removeListener('pageProcessing:stageProgress', handler);
            },

            onStageComplete: (callback: (result: IRunStageResult) => void): (() => void) => {
                const handler = (_event: IpcRendererEvent, result: IRunStageResult) =>
                    callback(result);
                ipcRenderer.on('pageProcessing:stageComplete', handler);
                return () => ipcRenderer.removeListener('pageProcessing:stageComplete', handler);
            },

            onOutputProgress: (callback: (progress: {
                jobId: string;
                currentPage: number;
                totalPages: number;
                percentage: number;
                message: string;
            }) => void): (() => void) => {
                const handler = (_event: IpcRendererEvent, progress: {
                    jobId: string;
                    currentPage: number;
                    totalPages: number;
                    percentage: number;
                    message: string;
                }) => callback(progress);
                ipcRenderer.on('pageProcessing:outputProgress', handler);
                return () => ipcRenderer.removeListener('pageProcessing:outputProgress', handler);
            },

            onOutputComplete: (callback: (result: IGenerateOutputResult) => void): (() => void) => {
                const handler = (_event: IpcRendererEvent, result: IGenerateOutputResult) =>
                    callback(result);
                ipcRenderer.on('pageProcessing:outputComplete', handler);
                return () => ipcRenderer.removeListener('pageProcessing:outputComplete', handler);
            },
        },
    });
}
