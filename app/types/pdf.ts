import type {
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';

export type TFitMode = 'width' | 'height';

export type TContentInsets = {
    top: number;
    right: number;
    bottom: number;
    left: number;
};

export type TScrollSnapshot = {
    width: number;
    height: number;
    centerX: number;
    centerY: number;
};

export interface IPdfDocumentState {
    pdfDocument: PDFDocumentProxy | null;
    numPages: number;
    isLoading: boolean;
    basePageWidth: number | null;
    basePageHeight: number | null;
}

export interface IPdfLinkServiceOptions {
    pagesCount: number;
    currentPage: number;
    goToPage: (page: number) => void;
}

export type { PDFDocumentProxy, PDFPageProxy };
