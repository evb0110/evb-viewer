import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { TPageNumber } from '@contracts/pageNumbers';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import type { TPdfViewMode } from '@contracts/shared';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';
import type { IPdfViewportWritePort } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';
import type {IPdfPageLayoutMetrics} from '@app/modules/document-viewer/public';

export interface IUsePdfSinglePageScrollOptions {
    viewerContainer: Ref<HTMLElement | null>;
    numPages: Ref<number>;
    currentPage: Readonly<Ref<number>>;
    scaledMargin: Ref<number>;
    viewMode: Ref<TPdfViewMode>;
    continuousScroll: Ref<boolean>;
    isLoading: Ref<boolean>;
    pdfDocument: ShallowRef<IPdfDocument | null>;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    renderVisiblePages: (
        range: {
            start: number;
            end: number
        },
        renderOptions?: IRenderVisiblePagesOptions,
    ) => Promise<boolean>;
    /** Resolves once the target pages have a size exact enough to place them. */
    prepareNavigationLayout?: ((pageNumber: TPageNumber, signal: AbortSignal) => Promise<void>) | undefined;
    isPageFreshlyRenderedForNavigation?: ((pageNumber: TPageNumber) => boolean) | undefined;
    waitForPageTextLayerReady?: ((pageNumber: TPageNumber, signal: AbortSignal) => Promise<boolean>) | undefined;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    viewportWritePort: IPdfViewportWritePort;
    getPhysicalScrollOrigin: () => number;
    getPageLayoutMetrics?: (() => IPdfPageLayoutMetrics | null) | undefined;
}
