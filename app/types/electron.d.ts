import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from 'electron/ipc-types';
import type {
    IOcrLanguage,
    IRecentFile,
    ISettingsData,
} from '@app/types/shared';

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

type TPageOpsRotationAngle = 90 | 180 | 270;

interface IPageOpsResult {
    success: boolean;
    pageCount?: number;
    pdfData?: Uint8Array;
}

interface IPageOpsExtractResult {
    success: boolean;
    canceled?: boolean;
    destPath?: string;
}

interface IPageOpsInsertResult {
    success: boolean;
    canceled?: boolean;
    pdfData?: Uint8Array;
}

interface IPageOpsAPI {
    delete: (workingCopyPath: string, pages: number[], totalPages: number) => Promise<IPageOpsResult>;
    extract: (workingCopyPath: string, pages: number[]) => Promise<IPageOpsExtractResult>;
    reorder: (workingCopyPath: string, newOrder: number[]) => Promise<IPageOpsResult>;
    insert: (workingCopyPath: string, totalPages: number, afterPage: number) => Promise<IPageOpsInsertResult>;
    insertFile: (workingCopyPath: string, totalPages: number, afterPage: number, sourcePath: string) => Promise<IPageOpsResult>;
    rotate: (workingCopyPath: string, pages: number[], angle: TPageOpsRotationAngle) => Promise<IPageOpsResult>;
}

interface IDjvuProgress {
    jobId: string;
    phase: 'converting' | 'bookmarks' | 'loading';
    current?: number;
    total?: number;
    percent: number;
}

interface IDjvuInfo {
    pageCount: number;
    sourceDpi: number;
    hasBookmarks: boolean;
    hasText: boolean;
    metadata: Record<string, string>;
}

interface IDjvuSizeEstimate {
    subsample: number;
    label: string;
    description: string;
    resultingDpi: number;
    estimatedBytes: number;
}

interface IDjvuConvertOptions {
    subsample?: number;
    preserveBookmarks?: boolean;
}

interface IDjvuOpenResult {
    success: boolean;
    pdfPath?: string;
    pageCount?: number;
    error?: string;
}

interface IDjvuConvertResult {
    success: boolean;
    pdfPath?: string;
    error?: string;
}

interface IDjvuAPI {
    openForViewing: (djvuPath: string) => Promise<IDjvuOpenResult>;
    convertToPdf: (djvuPath: string, outputPath: string, options: IDjvuConvertOptions) => Promise<IDjvuConvertResult>;
    cancel: (jobId: string) => Promise<{ canceled: boolean }>;
    getInfo: (djvuPath: string) => Promise<IDjvuInfo>;
    estimateSizes: (djvuPath: string) => Promise<IDjvuSizeEstimate[]>;
    cleanupTemp: (tempPdfPath: string) => Promise<void>;
    onProgress: (callback: (progress: IDjvuProgress) => void) => () => void;
    onViewingReady: (callback: (data: {
        pdfPath: string;
        isPartial: boolean 
    }) => void) => () => void;
    onViewingError: (callback: (data: { error: string }) => void) => () => void;
}

interface IOpenPdfResult {
    workingPath: string;
    originalPath: string;
}

interface IElectronAPI {
    openPdfDialog: () => Promise<IOpenPdfResult | null>;
    openPdfDirect: (path: string) => Promise<IOpenPdfResult | null>;
    savePdfAs: (workingCopyPath: string) => Promise<string | null>;
    savePdfDialog: (suggestedName: string) => Promise<string | null>;
    saveDocxAs: (workingCopyPath: string) => Promise<string | null>;
    readFile: (path: string) => Promise<Uint8Array>;
    statFile: (path: string) => Promise<{ size: number }>;
    readFileRange: (path: string, offset: number, length: number) => Promise<Uint8Array>;
    readTextFile: (path: string) => Promise<string>;
    fileExists: (path: string) => Promise<boolean>;
    writeFile: (path: string, data: Uint8Array) => Promise<boolean>;
    writeDocxFile: (path: string, data: Uint8Array) => Promise<boolean>;
    saveFile: (path: string) => Promise<boolean>;
    cleanupFile: (path: string) => Promise<void>;
    cleanupOcrTemp: (path: string) => Promise<void>;
    setWindowTitle: (title: string) => Promise<void>;
    onMenuOpenPdf: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuSave: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuSaveAs: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuExportDocx: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuZoomIn: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuZoomOut: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuActualSize: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuFitWidth: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuFitHeight: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuUndo: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuRedo: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuDeletePages: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuExtractPages: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuRotateCw: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuRotateCcw: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuInsertPages: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;

    // OCR API
    ocrRecognize: (request: IOcrRecognizeRequest) => Promise<IOcrRecognizeResult>;
    ocrRecognizeBatch: (
        pages: IOcrRecognizeRequest[],
        requestId: string,
    ) => Promise<{
        results: Record<number, string>;
        errors: string[];
    }>;
    ocrCancel: (requestId: string) => Promise<{ canceled: boolean }>;
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

    // Settings API
    settings: {
        get: () => Promise<ISettingsData>;
        save: (settings: ISettingsData) => Promise<void>;
    };
    onMenuOpenSettings: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;

    // Page Operations API
    pageOps: IPageOpsAPI;

    // DjVu API
    djvu: IDjvuAPI;

    onMenuConvertToPdf: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;

    // Electron webUtils
    getPathForFile: (file: File) => string;
}

declare global {
    interface Window {
        electronAPI: IElectronAPI;
        __openFileDirect?: (path: string) => Promise<void>;
        __appReady?: boolean;
        __logLevel?: unknown;
    }
}

export {};
