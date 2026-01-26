import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from 'electron/ipc-types';
import type {
    IOcrLanguage,
    IRecentFile,
} from '@app/types/shared';
import type {
    IProcessingOptions,
    IProcessingProgress,
    IProcessingResult,
} from '@app/types/page-processing';
import type { IToolValidation } from 'electron/page-processing/paths';
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

interface IOcrRecognizeRequest {
    pageNumber: number;
    imageData: number[];
    languages: string[];
}

interface IOcrRecognizeResult {
    pageNumber: number;
    success: boolean;
    text: string;
    error?: string;
}

interface IOcrProgress {
    requestId: string;
    currentPage: number;
    processedCount: number;
    totalPages: number;
}

interface IOcrJobStartResult {
    started: boolean;
    jobId: string;
    error?: string;
}

interface IOcrCompleteResult {
    requestId: string;
    success: boolean;
    pdfData: number[] | null;
    pdfPath?: string;
    errors: string[];
}

interface IPdfSearchExcerpt {
    prefix: boolean;
    suffix: boolean;
    before: string;
    match: string;
    after: string;
}

interface IPdfSearchResult {
    pageNumber: number;
    pageMatchIndex?: number;
    matchIndex: number;
    startOffset: number;
    endOffset: number;
    excerpt: IPdfSearchExcerpt;
}

interface IPdfSearchResponse {
    results: IPdfSearchResult[];
    truncated: boolean;
}

interface IPdfSearchProgress {
    requestId: string;
    processed: number;
    total: number;
}

interface IPreprocessingValidationResult {
    valid: boolean;
    available: string[];
    missing: string[];
}

interface IPreprocessPageResult {
    success: boolean;
    imageData: number[];
    message?: string;
    error?: string;
}

interface IElectronAPI {
    openPdfDialog: () => Promise<string | null>;
    openPdfDirect: (path: string) => Promise<string | null>;
    savePdfAs: (workingCopyPath: string) => Promise<string | null>;
    readFile: (path: string) => Promise<Uint8Array>;
    statFile: (path: string) => Promise<{ size: number }>;
    readFileRange: (path: string, offset: number, length: number) => Promise<Uint8Array>;
    readTextFile: (path: string) => Promise<string>;
    fileExists: (path: string) => Promise<boolean>;
    writeFile: (path: string, data: Uint8Array) => Promise<boolean>;
    saveFile: (path: string) => Promise<boolean>;
    cleanupFile: (path: string) => Promise<void>;
    setWindowTitle: (title: string) => Promise<void>;
    onMenuOpenPdf: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuSave: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuSaveAs: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuZoomIn: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuZoomOut: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuActualSize: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuFitWidth: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuFitHeight: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuAbout: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;

    // OCR API
    ocrRecognize: (request: IOcrRecognizeRequest) => Promise<IOcrRecognizeResult>;
    ocrRecognizeBatch: (
        pages: IOcrRecognizeRequest[],
        requestId: string,
    ) => Promise<{
        results: Record<number, string>;
        errors: string[];
    }>;
    ocrGetLanguages: () => Promise<IOcrLanguage[]>;
    ocrCreateSearchablePdf: (
        originalPdfData: Uint8Array,  // Electron IPC transfers Uint8Array efficiently
        pages: Array<{
            pageNumber: number;
            languages: string[];
        }>,
        requestId: string,
        workingCopyPath?: string | null,
        renderDpi?: number,
    ) => Promise<IOcrJobStartResult>;
    onOcrProgress: (callback: (progress: IOcrProgress) => void) => () => void;
    onOcrComplete: (callback: (result: IOcrCompleteResult) => void) => () => void;

    // Search API
    pdfSearch: (
        pdfPath: string,
        query: string,
        options?: {
            requestId?: string;
            pageCount?: number;
        },
    ) => Promise<IPdfSearchResponse>;
    onPdfSearchProgress: (callback: (progress: IPdfSearchProgress) => void) => () => void;
    pdfSearchResetCache: () => Promise<boolean>;

    // Preprocessing API
    preprocessing: {
        validate: () => Promise<IPreprocessingValidationResult>;
        preprocessPage: (imageData: number[], usePreprocessing: boolean) => Promise<IPreprocessPageResult>;
    };

    // Recent Files API
    recentFiles: {
        get: () => Promise<IRecentFile[]>;
        add: (path: string) => Promise<void>;
        remove: (path: string) => Promise<void>;
        clear: () => Promise<void>;
    };
    onMenuOpenRecentFile: (callback: (path: string) => void) => IMenuEventUnsubscribe;
    onMenuClearRecentFiles: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;

    // Page Processing API (Legacy)
    pageProcessing: {
        process: (
            pdfPath: string,
            pages: number[],
            options: Partial<IProcessingOptions>,
            requestId: string,
            workingCopyPath?: string,
        ) => Promise<{
            started: boolean;
            jobId: string;
            error?: string
        }>;
        cancel: (jobId: string) => Promise<{ success: boolean }>;
        validateTools: () => Promise<IToolValidation>;
        onProgress: (callback: (progress: IProcessingProgress) => void) => () => void;
        onComplete: (callback: (result: IProcessingResult) => void) => () => void;
        onLog: (callback: (entry: { jobId: string; level: string; message: string; }) => void) => () => void;

        // New Project-Based API
        createProject: (request: ICreateProjectRequest) => Promise<ICreateProjectResult>;
        loadProject: (projectId: string) => Promise<ILoadProjectResult>;
        saveProject: (project: IProcessingProject) => Promise<ISaveProjectResult>;
        listProjects: () => Promise<{
            success: boolean;
            projects?: Array<{
                id: string;
                originalPdfPath: string;
                createdAt: number;
                updatedAt: number;
                status: string;
            }>;
            error?: string;
        }>;
        deleteProject: (projectId: string) => Promise<{
            success: boolean;
            error?: string 
        }>;
        runStage: (request: IRunStageRequest) => Promise<IRunStageResult>;
        previewStage: (request: IPreviewStageRequest) => Promise<IPreviewStageResult>;
        cancelStage: (jobId: string) => Promise<{
            cancelled: boolean;
            error?: string 
        }>;
        generateOutput: (request: IGenerateOutputRequest) => Promise<IGenerateOutputResult>;
        getProjectStatus: (projectId: string) => Promise<IProjectStatusResult>;
        onStageProgress: (callback: (progress: IStageProgress) => void) => () => void;
        onStageComplete: (callback: (result: IRunStageResult) => void) => () => void;
        onOutputProgress: (callback: (progress: {
            jobId: string;
            currentPage: number;
            totalPages: number;
            percentage: number;
            message: string;
        }) => void) => () => void;
        onOutputComplete: (callback: (result: IGenerateOutputResult) => void) => () => void;
    };
}

declare global {
    interface Window {
        electronAPI: IElectronAPI;
        __openFileDirect?: (path: string) => Promise<void>;
        __appReady?: boolean;
    }
}

export {};
