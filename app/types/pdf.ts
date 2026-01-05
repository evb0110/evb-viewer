import type {
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';

export type TFitMode = 'width' | 'height';

export interface IContentInsets {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

export interface IScrollSnapshot {
    width: number;
    height: number;
    centerX: number;
    centerY: number;
}

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

export interface IOcrWord {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface IPdfSearchMatch {
    pageIndex: number;
    matchIndex: number;
    startOffset: number;
    endOffset: number;
    excerpt: {
        prefix: boolean;
        suffix: boolean;
        before: string;
        match: string;
        after: string;
    };
    words?: IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
}

export interface IPdfPageMatches {
    pageIndex: number;
    matches: Array<{
        start: number;
        end: number;
        words?: IOcrWord[];
        pageWidth?: number;
        pageHeight?: number;
    }>;
}

export type TSearchDirection = 'next' | 'previous';

export type {
    PDFDocumentProxy, PDFPageProxy,
};
