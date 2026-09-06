import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import type { TPdfViewMode } from '@contracts/shared';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';
import type { IPdfViewportWritePort } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';
import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import type { IPdfNavigationRequest } from '@app/modules/pdf-viewer/engine/viewport/createPageNavigationRequest';

export interface ITransactionVisibleRangeCommitOptions { transactionId?: number | undefined }

export interface IUsePdfSinglePageScrollOptions {
    viewerContainer: Ref<HTMLElement | null>;
    numPages: Ref<number>;
    currentPage: Readonly<Ref<number>>;
    scaledMargin: Ref<number>;
    viewMode: Ref<TPdfViewMode>;
    continuousScroll: Ref<boolean>;
    isResizeTransitionActive?: Ref<boolean> | undefined;
    isLoading: Ref<boolean>;
    pdfDocument: ShallowRef<IPdfDocument | null>;
    getMostVisiblePage: (
        container: HTMLElement | null,
        numPages: number,
    ) => number;
    scrollToPageInternal: (
        container: HTMLElement,
        page: number,
        total: number,
        margin: number,
        options?: IScrollToPageOptions,
    ) => void;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    updateCurrentPage: (
        container: HTMLElement | null,
        numPages: number,
        options?: { requireAuthoritative?: boolean; },
    ) => number;
    commitVisibleRange?: ((
        range: {
            start: number;
            end: number;
        },
        options?: ITransactionVisibleRangeCommitOptions,
    ) => boolean | undefined) | undefined;
    renderVisiblePages: (
        range: {
            start: number;
            end: number
        },
        renderOptions?: IRenderVisiblePagesOptions,
    ) => Promise<void>;
    ensurePageMetricsInRange?: ((startPage: number, endPage: number) => Promise<boolean>) | undefined;
    prepareNavigationLayout?: ((pageNumber: number, signal: AbortSignal) => Promise<void>) | undefined;
    isPageFreshlyRenderedForNavigation?: ((pageNumber: number) => boolean) | undefined;
    waitForPageTextLayerReady?: ((pageNumber: number, signal: AbortSignal) => Promise<boolean>) | undefined;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    emitCurrentPage: (page: number) => void;
    emitNavigationFeedbackPage?: ((page: number | null) => void) | undefined;
    viewportWritePort: IPdfViewportWritePort;
    getPageLayoutMetrics?: (() => IPdfPageLayoutMetrics | null) | undefined;
    onNavigationPostArrival?: ((request: IPdfNavigationRequest, signal: AbortSignal) => Promise<void> | void) | undefined;
}
