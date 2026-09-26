import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
} from '@app/types/annotations';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';
import type { IPdfPageMetric } from '@app/types/pdfUi';
import type {
    IDocumentPageSource,
    TDocumentPageLabelLookup,
} from '@app/modules/document-viewer/public';
import type {
    TPageMoveOperation,
    TPageSelection,
} from '@contracts/pageNumbers';

/** The viewer's page geometry; a page's presented rotation keys its thumbnail. */
export interface IPdfThumbnailPageGeometry {
    metrics: readonly IPdfPageMetric[];
    version: number;
}

export interface IPdfThumbnailsProps {
    source: IDocumentPageSource | null;
    pageGeometry?: IPdfThumbnailPageGeometry | null | undefined;
    currentPage: number;
    totalPages: number;
    pageLabels?: TDocumentPageLabelLookup | undefined;
    selectedPages?: number[] | undefined;
    selectedPageSelection?: TPageSelection | null | undefined;
    invalidationRequest?: {
        id: number;
        pages: number[];
        /** The revision that carries the change; kept pixels wait for it. */
        expectedDocumentRevision?: string;
        /**
         * Only the pages' rotation changed. Their content is the same in both
         * revisions, so pixels from the current one stay valid once turned.
         */
        rotationOnly?: boolean;
    } | null | undefined;
    hiddenAnnotationIds?: string[] | undefined;
    annotationComments?: IAnnotationCommentSummary[] | undefined;
    annotationSettings?: IAnnotationSettings | null | undefined;
    isActive?: boolean | undefined;
    isResizing?: boolean | undefined;
}

export interface IPdfThumbnailsEmits {
    'go-to-page': [page: number, options?: IScrollToPageOptions];
    'update:selected-pages': [pages: number[]];
    'update:selected-page-selection': [selection: TPageSelection];
    'page-context-menu': [payload: {
        clientX: number;
        clientY: number;
        clickedPage: number;
        pages: number[];
        selection: TPageSelection;
    }];
    reorder: [newOrder: number[]];
    move: [move: TPageMoveOperation];
    'file-drop': [payload: {
        afterPage: number;
        filePaths: TDocumentRef[];
    }];
}
