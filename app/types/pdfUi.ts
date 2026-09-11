import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IPdfNativeAnnotationIdentityBinding } from '@contracts/electronApiDocuments';
import type { TOcrIndexRotation } from '@contracts/ocrIndex';
import { pageNumberToPageIndex } from '@contracts/pageNumbers';
import type { IDocumentPageRange } from '@app/utils/document-viewer/documentPageRange';
import type {
    IOcrWord,
    IPdfBookmarkEntry,
    IPdfSearchExcerpt,
    IPdfSearchResult,
    IPdfValidationResult,
    ISearchMatchOptions,
    TPageIndex,
    TPdfSaveMode,
} from '@app/types/pdfContracts';

export type TPdfBookmarkChangeHistoryMode = 'record' | 'reset';

export interface IPdfBookmarkChangePayload {
    bookmarks: IPdfBookmarkEntry[];
    dirty: boolean;
    history?: TPdfBookmarkChangeHistoryMode;
}

export interface IContentInsets {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

export interface IPdfPageMetric {
    width: number;
    height: number;
    rotation?: number;
    userUnit?: number;
}

export type IPageRange = IDocumentPageRange;

export interface IScrollSnapshot {
    width: number;
    height: number;
    centerX: number;
    centerY: number;
    anchorPage?: number | null;
    anchorInsidePage?: boolean;
    anchorOffsetRatio?: number;
    anchorContentXRatio?: number;
    anchorContentYRatio?: number;
    anchorPageXRatio?: number;
    anchorPageYRatio?: number;
    anchorPageYOutsideEdge?: TAnchorPageOutsideEdge;
    anchorPageYOutsideOffsetPx?: number | null;
}

export type TAnchorPageOutsideEdge = 'inside' | 'above' | 'below';

export interface IPdfPathSource {
    kind: 'path';
    path: TDocumentRef;
    size: number;
    revision?: TDocumentRevisionToken;
}

export type TPdfSource = Blob | IPdfPathSource;

export interface IPdfUiSearchMatch {
    pageIndex: TPageIndex;
    pageMatchIndex?: number;
    matchIndex: number;
    startOffset: number;
    endOffset: number;
    excerpt?: IPdfSearchExcerpt;
    words?: readonly IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
    rotation?: TOcrIndexRotation;
}

export type IPdfSearchMatch = IPdfUiSearchMatch;

export interface IPdfUiPageMatchEntry {
    matchIndex: number;
    start: number;
    end: number;
    words?: readonly IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
    rotation?: TOcrIndexRotation;
}

export interface IPdfUiPageMatches {
    pageIndex: TPageIndex;
    pageText: string;
    searchQuery: string;
    signatureToken?: string;
    searchOptions?: ISearchMatchOptions;
    matches: IPdfUiPageMatchEntry[];
}

export type IPdfPageMatches = IPdfUiPageMatches;

export type TPdfUiSearchDirection = 'next' | 'previous';
export type TSearchDirection = TPdfUiSearchDirection;

export interface IPdfUiPageRange {
    startPage: number;
    endPage: number;
}

export type IPdfPageRange = IPdfUiPageRange;

export interface IPdfRawDims {
    pageWidth: number;
    pageHeight: number;
    pageX?: number;
    pageY?: number;
}

export interface IPdfSaveResult {
    finalBytes: Uint8Array;
    saveMode: TPdfSaveMode;
    warnings: string[];
    validation: IPdfValidationResult;
}

export interface IPdfPersistResult {
    success: boolean;
    outPath: TDocumentRef | null;
    saveMode: TPdfSaveMode;
    didSaveAs: boolean;
    /** Native incremental saves may bind newly authored app identities to PDF refs. */
    materializedIdentityBindings?: readonly IPdfNativeAnnotationIdentityBinding[];
    /**
     * Why a `success: false` result stopped when nothing went wrong:
     * `cancelled` for a dismissed Save As dialog, `stale` for a document that
     * was replaced before the write completed. Absent means the write was
     * attempted and refused.
     */
    abortReason?: 'cancelled' | 'stale' | undefined;
}

export function mapPdfSearchResultToUiMatch(result: IPdfSearchResult): IPdfUiSearchMatch {
    return {
        pageIndex: pageNumberToPageIndex(result.pageNumber),
        pageMatchIndex: result.pageMatchIndex,
        matchIndex: result.matchIndex,
        startOffset: result.startOffset,
        endOffset: result.endOffset,
        excerpt: result.excerpt,
        ...(result.words !== undefined ? { words: result.words } : {}),
        ...(result.pageWidth !== undefined ? { pageWidth: result.pageWidth } : {}),
        ...(result.pageHeight !== undefined ? { pageHeight: result.pageHeight } : {}),
        ...(result.rotation !== undefined ? { rotation: result.rotation } : {}),
    };
}

export function mapPdfSearchResultToUiPageMatchEntry(result: IPdfSearchResult): IPdfUiPageMatchEntry {
    return {
        matchIndex: result.matchIndex,
        start: result.startOffset,
        end: result.endOffset,
        ...(result.words !== undefined ? { words: result.words } : {}),
        ...(result.pageWidth !== undefined ? { pageWidth: result.pageWidth } : {}),
        ...(result.pageHeight !== undefined ? { pageHeight: result.pageHeight } : {}),
        ...(result.rotation !== undefined ? { rotation: result.rotation } : {}),
    };
}
