import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from 'electron/ipc-types';
import type { TGroupDirection } from '@app/types/editor-groups';
import type {
    IOcrLanguage,
    IRecentFile,
    ISettingsData,
} from '@app/types/shared';
import type {
    IWindowTabIncomingTransfer,
    IWindowTabTargetWindow,
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
    IWindowTabTransferResult,
    TWindowTabsAction,
} from '@app/types/window-tab-transfer';

interface IOcrRecognizeRequest {
    pageNumber: number;
    imageData: Uint8Array;
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
    pdfData: Uint8Array | null;
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

interface IOpenPdfDirectBatchProgress {
    requestId: string;
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface IPreprocessingValidationResult {
    valid: boolean;
    available: string[];
    missing: string[];
}

interface IPreprocessPageResult {
    success: boolean;
    imageData: Uint8Array;
    message?: string;
    error?: string;
}

type TPageOpsRotationAngle = 90 | 180 | 270;

interface IPageOpsResult {
    success: boolean;
    pageCount?: number;
}

interface IPageOpsExtractResult {
    success: boolean;
    canceled?: boolean;
    destPath?: string;
}

interface IPageOpsInsertResult {
    success: boolean;
    canceled?: boolean;
}

interface IPageOpsAPI {
    delete: (workingCopyPath: string, pages: number[], totalPages: number) => Promise<IPageOpsResult>;
    extract: (workingCopyPath: string, pages: number[]) => Promise<IPageOpsExtractResult>;
    reorder: (workingCopyPath: string, newOrder: number[]) => Promise<IPageOpsResult>;
    insert: (workingCopyPath: string, totalPages: number, afterPage: number) => Promise<IPageOpsInsertResult>;
    insertFile: (workingCopyPath: string, totalPages: number, afterPage: number, sourcePaths: string[]) => Promise<IPageOpsResult>;
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
    jobId?: string;
    error?: string;
}

interface IDjvuConvertResult {
    success: boolean;
    pdfPath?: string;
    jobId?: string;
    error?: string;
}

interface IDjvuViewingReadyEvent {
    pdfPath: string;
    isPartial: boolean;
    jobId?: string;
}

interface IDjvuViewingErrorEvent {
    error: string;
    jobId?: string;
}

interface IWindowTabsApi {
    transfer: (request: IWindowTabTransferRequest) => Promise<IWindowTabTransferResult>;
    transferAck: (ack: IWindowTabTransferAck) => Promise<boolean>;
    listTargetWindows: () => Promise<IWindowTabTargetWindow[]>;
    showContextMenu: (tabId: string) => Promise<void>;
    onIncomingTransfer: (callback: (transfer: IWindowTabIncomingTransfer) => void) => IMenuEventUnsubscribe;
    onWindowAction: (callback: (action: TWindowTabsAction) => void) => IMenuEventUnsubscribe;
}

interface IDjvuAPI {
    openForViewing: (djvuPath: string) => Promise<IDjvuOpenResult>;
    convertToPdf: (djvuPath: string, outputPath: string, options: IDjvuConvertOptions) => Promise<IDjvuConvertResult>;
    cancel: (jobId: string) => Promise<{ canceled: boolean }>;
    getInfo: (djvuPath: string) => Promise<IDjvuInfo>;
    estimateSizes: (djvuPath: string) => Promise<IDjvuSizeEstimate[]>;
    cleanupTemp: (tempPdfPath: string) => Promise<void>;
    onProgress: (callback: (progress: IDjvuProgress) => void) => () => void;
    onViewingReady: (callback: (data: IDjvuViewingReadyEvent) => void) => () => void;
    onViewingError: (callback: (data: IDjvuViewingErrorEvent) => void) => () => void;
}

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

export type TOpenFileResult = IOpenPdfResult | IOpenDjvuResult;

export interface IElectronAPI {
    openPdfDialog: () => Promise<TOpenFileResult | null>;
    openPdfDirect: (path: string) => Promise<TOpenFileResult | null>;
    openPdfDirectBatch: (paths: string[], requestId?: string) => Promise<TOpenFileResult | null>;
    savePdfAs: (workingCopyPath: string) => Promise<string | null>;
    savePdfDialog: (suggestedName: string) => Promise<string | null>;
    saveDocxAs: (workingCopyPath: string) => Promise<string | null>;
    exportPdfToImages: (workingCopyPath: string, pageNumbers?: number[]) => Promise<{
        success: boolean;
        canceled?: boolean;
        outputPaths?: string[];
    }>;
    exportPdfToMultiPageTiff: (workingCopyPath: string, pageNumbers?: number[]) => Promise<{
        success: boolean;
        canceled?: boolean;
        outputPath?: string;
    }>;
    readFile: (path: string) => Promise<Uint8Array>;
    statFile: (path: string) => Promise<{ size: number }>;
    readFileRange: (path: string, offset: number, length: number) => Promise<Uint8Array>;
    readTextFile: (path: string) => Promise<string>;
    fileExists: (path: string) => Promise<boolean>;
    writeFile: (path: string, data: Uint8Array) => Promise<boolean>;
    writeDocxFile: (path: string, data: Uint8Array) => Promise<boolean>;
    createWorkingCopyFromData: (fileName: string, data: Uint8Array, originalPath?: string) => Promise<string>;
    saveFile: (path: string) => Promise<boolean>;
    cleanupFile: (path: string) => Promise<void>;
    cleanupOcrTemp: (path: string) => Promise<void>;
    setWindowTitle: (title: string) => Promise<void>;
    showItemInFolder: (path: string) => Promise<boolean>;
    setMenuDocumentState: (hasDocument: boolean) => Promise<void>;
    setMenuTabCount: (tabCount: number) => Promise<void>;
    closeCurrentWindow: () => Promise<boolean>;
    notifyRendererReady: () => void;
    onMenuOpenPdf: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuSave: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuSaveAs: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuExportDocx: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuExportImages: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuExportMultiPageTiff: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuZoomIn: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuZoomOut: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuActualSize: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuFitWidth: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuFitHeight: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuViewModeSingle: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuViewModeFacing: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuViewModeFacingFirstSingle: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuUndo: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuRedo: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuDeletePages: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuExtractPages: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuRotateCw: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuRotateCcw: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuInsertPages: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;

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
        originalPdfData: Uint8Array,
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

    pdfSearch: (
        pdfPath: string,
        query: string,
        options?: {
            requestId?: string;
            pageCount?: number;
        },
    ) => Promise<IPdfSearchResponse>;
    pdfSearchCancel: (requestId?: string) => Promise<{ canceled: boolean }>;
    onPdfSearchProgress: (callback: (progress: IPdfSearchProgress) => void) => () => void;
    pdfSearchResetCache: () => Promise<boolean>;

    preprocessing: {
        validate: () => Promise<IPreprocessingValidationResult>;
        preprocessPage: (imageData: Uint8Array, usePreprocessing: boolean) => Promise<IPreprocessPageResult>;
    };

    recentFiles: {
        get: () => Promise<IRecentFile[]>;
        add: (path: string) => Promise<void>;
        remove: (path: string) => Promise<void>;
        clear: () => Promise<void>;
    };
    onMenuOpenRecentFile: (callback: (path: string) => void) => IMenuEventUnsubscribe;
    onMenuOpenExternalPaths: (callback: (paths: string[]) => void) => IMenuEventUnsubscribe;
    onMenuClearRecentFiles: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onOpenPdfDirectBatchProgress: (callback: (progress: IOpenPdfDirectBatchProgress) => void) => IMenuEventUnsubscribe;

    settings: {
        get: () => Promise<ISettingsData>;
        save: (settings: ISettingsData) => Promise<void>;
    };
    onMenuOpenSettings: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;

    pageOps: IPageOpsAPI;

    djvu: IDjvuAPI;

    onMenuConvertToPdf: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;

    onMenuNewTab: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuCloseTab: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuSplitEditor: (callback: (direction: TGroupDirection) => void) => IMenuEventUnsubscribe;
    onMenuFocusEditorGroup: (callback: (direction: TGroupDirection) => void) => IMenuEventUnsubscribe;
    onMenuMoveTabToGroup: (callback: (direction: TGroupDirection) => void) => IMenuEventUnsubscribe;
    onMenuCopyTabToGroup: (callback: (direction: TGroupDirection) => void) => IMenuEventUnsubscribe;

    getPathForFile: (file: File) => string;

    tabs: IWindowTabsApi;
}
