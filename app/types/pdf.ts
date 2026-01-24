import type {
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';
import type { IOcrWord } from '@app/types/shared';

export type {
    IOcrWord,
    TFitMode,
} from '@app/types/shared';

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

export interface ISearchExcerpt {
    prefix: boolean;
    suffix: boolean;
    before: string;
    match: string;
    after: string;
}

export interface IPdfSearchMatch {
    pageIndex: number;
    pageMatchIndex?: number; // Ordinal on page (0, 1, 2...) - used for direct match mapping from backend
    matchIndex: number;
    startOffset: number;
    endOffset: number;
    excerpt?: ISearchExcerpt;
    words?: IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
}

export interface IPdfPageMatches {
    pageIndex: number;
    pageText: string; // Full page text for reference
    searchQuery: string; // The query that generated these matches
    matches: Array<{
        matchIndex: number;
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
