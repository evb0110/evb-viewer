import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TPdfSource } from '@app/types/pdfUi';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';

interface IUsePdfViewerLoadingStateOptions {
    src: ComputedRef<TPdfSource | null>;
    isLoading: Ref<boolean>;
    pdfDocument: Ref<IPdfDocument | null>;
    openSurface: Pick<IDocumentOpenSurfaceSession, 'snapshot'>;
    holdOverlayVisible?: Ref<boolean>;
}

export const usePdfViewerLoadingState = (options: IUsePdfViewerLoadingStateOptions) => {
    // Opening presentation belongs to the shared surface. Rows reached after
    // it commits use their own raster feedback without reopening the overlay.
    const isViewerLoadingOverlayVisible = computed(() => (
        Boolean(options.src.value) && (
            options.isLoading.value
            || (
                Boolean(options.pdfDocument.value)
                && options.openSurface.snapshot.value.phase !== 'ready'
            )
            || options.holdOverlayVisible?.value === true
        )
    ));

    return { isViewerLoadingOverlayVisible };
};
