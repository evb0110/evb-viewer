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

export type TPdfSource =
    | Blob
    | {
        kind: 'path';
        path: string;
        size: number;
    };

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

export type TPageLabelStyle = 'D' | 'R' | 'r' | 'A' | 'a' | null;

export interface IPdfPageLabelRange {
    startPage: number;
    style: TPageLabelStyle;
    prefix: string;
    startNumber: number;
}

export interface IPdfBookmarkEntry {
    title: string;
    pageIndex: number | null;
    namedDest: string | null;
    items: IPdfBookmarkEntry[];
}

/**
 * The shape returned by `PageViewport.rawDims` at runtime.
 * pdf.js types declare the getter as `Object`, but the actual
 * value always carries the original (unscaled) page dimensions.
 */
export interface IPdfRawDims {
    pageWidth: number;
    pageHeight: number;
}

export type {
    PDFDocumentProxy, PDFPageProxy,
};
