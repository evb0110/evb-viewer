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

interface IOcrPdfPageRequest {
    pageNumber: number;
    imageData: number[];
    languages: string[];
    dpi: number;
    imageWidth: number;
    imageHeight: number;
}

interface IOcrSearchablePdfResult {
    success: boolean;
    pdfData: number[] | null;
    errors: string[];
}

interface IElectronAPI {
    openPdfDialog: () => Promise<string | null>;
    openPdfDirect: (path: string) => Promise<string | null>;
    readFile: (path: string) => Promise<Uint8Array>;
    writeFile: (path: string, data: Uint8Array) => Promise<boolean>;
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
        pages: IOcrPdfPageRequest[],
        requestId: string,
    ) => Promise<IOcrSearchablePdfResult>;
    onOcrProgress: (callback: (progress: IOcrProgress) => void) => () => void;
}

declare global {
    interface Window {electronAPI: IElectronAPI;}
}

export {};
