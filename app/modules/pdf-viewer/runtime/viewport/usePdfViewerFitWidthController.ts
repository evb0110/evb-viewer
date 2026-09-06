import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type {
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import type { IPageRange } from '@app/types/pdfUi';
import { PDF_RERENDER_SOURCE } from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';
import type { TPdfRerenderSource } from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';


interface IUsePdfViewerFitWidthControllerOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<IPdfDocument | null>;
    isLoading: Ref<boolean>;
    continuousScroll: ComputedRef<boolean>;
    fitMode: ComputedRef<TFitMode>;
    zoomMode: ComputedRef<TZoomMode>;
    zoom: ComputedRef<number>;
    effectiveScale: ComputedRef<number>;
    fitWidthScale: Ref<number>;
    viewMode: ComputedRef<TPdfViewMode>;
    currentPage: Ref<number>;
    numPages: Ref<number>;
    pageMetricsVersion: Ref<number>;
    visibleRange: Ref<IPageRange>;
    computeFitWidthScale: (container: HTMLElement | null) => boolean;
    isFitWidthScaleCurrent: (container: HTMLElement | null) => boolean;
    syncHorizontalScrollForZoomMode: () => void;
    cancelInFlightRenders: () => Promise<void> | void;
    reRenderAllVisiblePages: (
        getRange: () => IPageRange,
        options: {
            rerenderSource?: TPdfRerenderSource;
            renderBufferOverride?: number;
        },
    ) => Promise<void>;
    emitZoomMode: (mode: TZoomMode) => void;
}

export const usePdfViewerFitWidthController = (options: IUsePdfViewerFitWidthControllerOptions) => {
    async function applyFitWidthToCurrentPage() {
        if (!options.pdfDocument.value || options.isLoading.value) {
            return false;
        }

        const updated = options.computeFitWidthScale(options.viewerContainer.value);
        if (!updated) {
            options.syncHorizontalScrollForZoomMode();
            return false;
        }

        void options.cancelInFlightRenders();
        await options.reRenderAllVisiblePages(
            () => ({ ...options.visibleRange.value }),
            {
                rerenderSource: PDF_RERENDER_SOURCE.FitWidthExplicit,
                renderBufferOverride: 0,
            },
        );
        options.syncHorizontalScrollForZoomMode();
        return true;
    }

    function isEffectiveScaleAtFitWidthScale() {
        return Math.abs(options.effectiveScale.value - options.fitWidthScale.value) < 0.001;
    }

    function syncFitWidthZoomModeForCurrentPage() {
        if (
            !options.continuousScroll.value
            || options.fitMode.value !== 'width'
            || !options.viewerContainer.value
            || !options.pdfDocument.value
            || options.isLoading.value
        ) {
            return;
        }

        if (options.zoomMode.value !== 'custom') {
            return;
        }

        if (
            isEffectiveScaleAtFitWidthScale()
            && options.isFitWidthScaleCurrent(options.viewerContainer.value)
        ) {
            options.emitZoomMode('fit-width');
        }
    }

    watch(
        () => [
            options.fitMode.value,
            options.continuousScroll.value,
            options.zoom.value,
            options.effectiveScale.value,
            options.viewMode.value,
            options.currentPage.value,
            options.numPages.value,
            options.pageMetricsVersion.value,
        ] as const,
        () => {
            syncFitWidthZoomModeForCurrentPage();
            options.syncHorizontalScrollForZoomMode();
        },
    );

    return { applyFitWidthToCurrentPage };
};
