import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TPdfSource } from '@app/types/pdfUi';
import type { IDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';

interface IUsePdfViewerLoadingStateOptions {
    src: ComputedRef<TPdfSource | null>;
    isLoading: Ref<boolean>;
    pdfDocument: Ref<IPdfDocument | null>;
    currentPage: Ref<number>;
    openSurface: Pick<IDocumentOpenSurfaceSession, 'snapshot' | 'viewportSession'>;
    holdOverlayVisible?: Ref<boolean>;
}

export const usePdfViewerLoadingState = (options: IUsePdfViewerLoadingStateOptions) => {
    const isCurrentPageOpenSurfaceReady = computed(() => {
        const snapshot = options.openSurface.snapshot.value;
        const viewport = options.openSurface.viewportSession.value;
        const identity = snapshot.identity;
        const render = snapshot.committedRender;
        const committedViewport = snapshot.committedViewport;
        const currentPage = Math.max(1, Math.trunc(options.currentPage.value));
        return snapshot.phase === 'ready'
            && identity !== null
            && render !== null
            && committedViewport !== null
            && render.generation === snapshot.generation
            && render.documentRevision === identity.documentRevision
            && render.pageNumber === currentPage
            && committedViewport.generation === snapshot.generation
            && committedViewport.documentRevision === identity.documentRevision
            && committedViewport.pageNumber === currentPage
            && viewport.generation === snapshot.generation
            && viewport.identity?.revision === identity.documentRevision
            && viewport.requestedPage === currentPage
            && viewport.committedPage === currentPage;
    });

    const isViewerLoadingOverlayVisible = computed(() => (
        Boolean(options.src.value) && (
            options.isLoading.value
            || (
                Boolean(options.pdfDocument.value)
                && !isCurrentPageOpenSurfaceReady.value
            )
            || options.holdOverlayVisible?.value === true
        )
    ));

    return { isViewerLoadingOverlayVisible };
};
