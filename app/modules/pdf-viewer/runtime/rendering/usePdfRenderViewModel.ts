import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import { usePdfViewerLoadingState } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerLoadingState';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
    TFitMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import type {
    IContentInsets,
    TPdfSource,
} from '@app/types/pdfUi';
import type { ILinkAnnotation } from '@app/types/annotations';
import type { IDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';

interface IUsePdfRenderViewModelOptions {
    src: ComputedRef<TPdfSource | null>;
    isLoading: Ref<boolean>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    getPage: (pageNumber: number) => Promise<PDFPageProxy>;
    openSurface: Pick<IDocumentOpenSurfaceSession, 'snapshot' | 'viewportSession'>;
    isVisualReloadTransitionActive: Ref<boolean>;
    suppressLoadingOverlay: ComputedRef<boolean>;
    skeletonContentInsets: Ref<IContentInsets | null>;
    pagesToRender: ComputedRef<number[]>;
    isPageBuffered: (page: number) => boolean;
    isPageRenderedForClass: (page: number) => boolean;
    isPageRendering: (page: number) => boolean;
    isPageRenderFailed: (page: number) => boolean;
    shouldShowSkeleton: (page: number) => boolean;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    currentPage: Ref<number>;
    zoom: ComputedRef<number>;
    zoomMode: ComputedRef<TZoomMode>;
    fitMode: ComputedRef<TFitMode>;
    effectiveScale: Ref<number>;
    continuousScroll: ComputedRef<boolean>;
    numPages: Ref<number>;
    linksByPage: ComputedRef<Record<number, ILinkAnnotation[]>>;
}

const emptyLinksByPage: Record<number, never[]> = {};

export const usePdfRenderViewModel = (options: IUsePdfRenderViewModelOptions) => {
    const { isViewerLoadingOverlayVisible } = usePdfViewerLoadingState({
        src: options.src,
        isLoading: options.isLoading,
        pdfDocument: options.pdfDocument,
        currentPage: options.currentPage,
        openSurface: options.openSurface,
        holdOverlayVisible: options.isVisualReloadTransitionActive,
    });
    const isInitialSkeletonGeometryPending = computed(() => (
        Boolean(options.src.value)
        && Boolean(options.pdfDocument.value)
        && isViewerLoadingOverlayVisible.value
        && options.skeletonContentInsets.value === null
    ));
    const shouldBlockPageSkeletons = computed(() => (
        (
            isViewerLoadingOverlayVisible.value
            && options.isVisualReloadTransitionActive.value
            && !options.suppressLoadingOverlay.value
        )
        || options.suppressLoadingOverlay.value
        || isInitialSkeletonGeometryPending.value
    ));

    const visibleLinksByPage = computed(() => (
        isViewerLoadingOverlayVisible.value
            ? emptyLinksByPage
            : Object.fromEntries(
                Object.entries(options.linksByPage.value).filter(([page]) => options.isPageRenderedForClass(Number(page))),
            )
    ));

    function shouldShowPageSkeleton(page: number) {
        if (options.isPageRenderFailed(page)) {
            return false;
        }
        if (options.isPageBuffered(page)) {
            return false;
        }
        if (options.isPageRenderedForClass(page)) {
            return false;
        }
        if (shouldBlockPageSkeletons.value) {
            return false;
        }
        return options.shouldShowSkeleton(page);
    }

    return {
        isViewerLoadingOverlayVisible,
        visibleLinksByPage,
        shouldShowPageSkeleton,
        isPageRenderFailed: options.isPageRenderFailed,
        markPageRendered: (_pageNumber: number) => {},
    };
};
