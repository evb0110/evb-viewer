import type {IPdfDocument, IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {ComputedRef, Ref, ShallowRef} from 'vue';
import {usePdfViewerLoadingState} from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerLoadingState';
import type {TFitMode, TZoomMode} from '@app/types/pdfContracts';
import type {IContentInsets, TPdfSource} from '@app/types/pdfUi';
import type {ILinkAnnotation} from '@app/types/annotations';
import type {IDocumentOpenSurfaceSession} from '@app/modules/document-viewer/public';

interface IUsePdfRenderViewModelOptions {
    src: ComputedRef<TPdfSource | null>;
    isLoading: Ref<boolean>;
    pdfDocument: ShallowRef<IPdfDocument | null>;
    getPage: (pageNumber: number) => Promise<IPdfPage>;
    openSurface: Pick<IDocumentOpenSurfaceSession, 'snapshot'>;
    isVisualReloadTransitionActive: Ref<boolean>;
    skeletonContentInsets: Readonly<Ref<IContentInsets | null>>;
    isPageBuffered: (page: number) => boolean;
    isPageRenderedForClass: (page: number) => boolean;
    isPageRenderFailed: (page: number) => boolean;
    shouldShowSkeleton: (page: number) => boolean;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    zoom: ComputedRef<number>;
    zoomMode: ComputedRef<TZoomMode>;
    fitMode: ComputedRef<TFitMode>;
    effectiveScale: Ref<number>;
    continuousScroll: ComputedRef<boolean>;
    numPages: Ref<number>;
    linksByPage: ReadonlyMap<number, readonly ILinkAnnotation[]>;
}

const emptyLinksByPage: Record<number, ILinkAnnotation[]> = {};

export const usePdfRenderViewModel = (options: IUsePdfRenderViewModelOptions) => {
    const {isViewerLoadingOverlayVisible} = usePdfViewerLoadingState({
        src: options.src,
        isLoading: options.isLoading,
        pdfDocument: options.pdfDocument,
        openSurface: options.openSurface,
        holdOverlayVisible: options.isVisualReloadTransitionActive,
    });
    const isInitialSkeletonGeometryPending = computed(
        () =>
            Boolean(options.src.value) &&
            Boolean(options.pdfDocument.value) &&
            isViewerLoadingOverlayVisible.value &&
            options.openSurface.snapshot.value.phase !== 'ready' &&
            options.skeletonContentInsets.value === null,
    );

    const visibleLinksByPage = computed<Record<number, ILinkAnnotation[]>>(() => {
        if (isViewerLoadingOverlayVisible.value) {
            return emptyLinksByPage;
        }
        const visible: Record<number, ILinkAnnotation[]> = {};
        for (const [page, links] of options.linksByPage) {
            if (links.length > 0 && options.isPageRenderedForClass(page)) {
                visible[page] = links as ILinkAnnotation[];
            }
        }
        return visible;
    });

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
        if (isInitialSkeletonGeometryPending.value) {
            return false;
        }
        return options.shouldShowSkeleton(page);
    }

    return {
        isViewerLoadingOverlayVisible,
        visibleLinksByPage,
        shouldShowPageSkeleton,
        isPageRenderFailed: options.isPageRenderFailed,
    };
};
