import type {
    ComputedRef,
    Ref,
} from 'vue';
import { resolveVisiblePageLabelsDuringMetadataRefresh } from '@app/modules/pdf-viewer/public';
import type {
    IDocumentPageLabelModel,
    TDocumentPageLabelLookup,
} from '@app/modules/document-viewer/public';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

interface IDocumentWorkspaceVisualOpeningStateOptions {
    toolbarHasPdf: TReadableRef<boolean>;
    isLoading: TReadableRef<boolean>;
    initialDocumentVisualReady: TReadableRef<boolean>;
    openingPreviewReady: TReadableRef<boolean>;
    pdfError: TReadableRef<string | null>;
    djvuError: TReadableRef<string | null>;
    isOpeningDocumentForToolbar: TReadableRef<boolean>;
    toolbarDocumentBusy: TReadableRef<boolean>;
    canRepairSave: TReadableRef<boolean>;
    canOptimizePdf: TReadableRef<boolean>;
    statusZoomLabel: TReadableRef<string>;
    totalPages: TReadableRef<number>;
    pageLabels: TReadableRef<string[] | null>;
    pageLabelModel?: TReadableRef<IDocumentPageLabelModel | null> | undefined;
    pageLabelsResolved: TReadableRef<boolean>;
    isAnySaving: TReadableRef<boolean>;
    t: (key: 'status.zoomUnknown') => string;
}

export const useDocumentWorkspaceVisualOpeningState = (options: IDocumentWorkspaceVisualOpeningStateOptions) => {
    const documentInitialVisualPending = computed(() => (
        options.toolbarHasPdf.value
        && options.isLoading.value
        && !options.initialDocumentVisualReady.value
        && !options.pdfError.value
        && !options.djvuError.value
    ));
    const isOpeningDocumentForToolbarDisplay = computed(() => (
        options.isOpeningDocumentForToolbar.value || documentInitialVisualPending.value
    ));
    const toolbarDocumentBusyForDisplay = computed(() => (
        options.toolbarDocumentBusy.value || documentInitialVisualPending.value
    ));
    const canRepairSaveForDisplay = computed(() => (
        options.canRepairSave.value && !documentInitialVisualPending.value
    ));
    const canOptimizePdfForDisplay = computed(() => (
        options.canOptimizePdf.value && !documentInitialVisualPending.value
    ));
    const statusZoomLabelForDisplay = computed(() => (
        documentInitialVisualPending.value && !options.openingPreviewReady.value
            ? options.t('status.zoomUnknown')
            : options.statusZoomLabel.value
    ));
    const documentMetadataReady = computed(() => (
        options.toolbarHasPdf.value
        && options.totalPages.value > 0
        && (
            !isOpeningDocumentForToolbarDisplay.value
            || options.openingPreviewReady.value
        )
    ));
    const toolbarPageLabels = computed<TDocumentPageLabelLookup>(() => {
        if (!documentMetadataReady.value) {
            return null;
        }
        const visiblePageLabels = resolveVisiblePageLabelsDuringMetadataRefresh({
            pageLabels: options.pageLabels.value,
            pageLabelsResolved: options.pageLabelsResolved.value,
            isSaving: options.isAnySaving.value,
            totalPages: options.totalPages.value,
        });
        if (!options.pageLabelsResolved.value && !options.isAnySaving.value) {
            return visiblePageLabels;
        }
        const model = options.pageLabelModel?.value;
        return model?.totalPages === options.totalPages.value ? model : visiblePageLabels;
    });
    const toolbarControlsDisabled = computed(() => (
        !documentMetadataReady.value
        || toolbarDocumentBusyForDisplay.value && !options.openingPreviewReady.value
    ));

    return {
        canOptimizePdfForDisplay,
        canRepairSaveForDisplay,
        documentInitialVisualPending,
        documentMetadataReady,
        isOpeningDocumentForToolbarDisplay,
        statusZoomLabelForDisplay,
        toolbarControlsDisabled,
        toolbarDocumentBusyForDisplay,
        toolbarPageLabels,
    };
};
