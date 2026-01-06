import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from 'electron/ipc-types';

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

interface IOcrLanguage {
    code: string;
    name: string;
    script: 'latin' | 'cyrillic' | 'rtl';
}

interface IOcrProgress {
    requestId: string;
    currentPage: number;
    processedCount: number;
    totalPages: number;
}

interface IOcrSearchablePdfResult {
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
    readFile: (path: string) => Promise<Uint8Array>;
    writeFile: (path: string, data: Uint8Array) => Promise<boolean>;
    saveFile: (path: string) => Promise<boolean>;
    setWindowTitle: (title: string) => Promise<void>;
    onMenuOpenPdf: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuSave: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
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
    ) => Promise<Record<number, string>>;
    ocrGetLanguages: () => Promise<IOcrLanguage[]>;
    ocrCreateSearchablePdf: (
        originalPdfData: number[],
        pages: Array<{
            pageNumber: number;
            languages: string[];
        }>,
        requestId: string,
        workingCopyPath?: string | null,
    ) => Promise<IOcrSearchablePdfResult>;
    onOcrProgress: (callback: (progress: IOcrProgress) => void) => () => void;

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
}

declare global {
    interface Window {
        electronAPI: IElectronAPI;
        __openFileDirect?: string;
        __appReady?: boolean;
    }
}

export {};
