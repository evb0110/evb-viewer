import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
} from '@app/types/annotations';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';
import type { IPdfPageRasterScheduler } from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import type { TDocumentPageLabelLookup } from '@app/utils/document-viewer/pageLabels';
import type {
    TPageMoveOperation,
    TPageSelection,
} from '@contracts/pageNumbers';

export interface IPdfThumbnailsProps {
    pdfDocument: IPdfDocument | null;
    rasterScheduler: IPdfPageRasterScheduler | null;
    currentPage: number;
    totalPages: number;
    pageLabels?: TDocumentPageLabelLookup | undefined;
    selectedPages?: number[] | undefined;
    selectedPageSelection?: TPageSelection | null | undefined;
    invalidationRequest?: {
        id: number;
        pages: number[];
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
