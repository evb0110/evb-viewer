import type { Ref } from 'vue';

interface IViewerCapabilities {
    conversionBanner?: boolean;
    conversionDialog?: boolean;
}

interface IConversionState {isConverting: boolean;}

interface IDjvuConversionBannerPresentation {
    conversionUiAvailable: boolean;
    documentOpenReady: boolean;
    initialDocumentVisualReady: boolean;
    showDjvuBanner: boolean;
    showDjvuSource: boolean;
}

interface IUseDocumentWorkspaceViewerPresentationOptions {
    activeViewerCapabilities: Readonly<Ref<IViewerCapabilities | null>>;
    canUseDjvu: boolean;
    conversionState: Readonly<Ref<IConversionState>>;
    documentOpenReady: Readonly<Ref<boolean>>;
    djvuOpeningPath: Readonly<Ref<unknown>>;
    djvuShowBanner: Readonly<Ref<boolean>>;
    initialDocumentVisualReady: Readonly<Ref<boolean>>;
    pendingDjvuDocumentOpen: Readonly<Ref<boolean>>;
    showDjvuSource: Readonly<Ref<boolean>>;
    showNativePdfViewer: Readonly<Ref<boolean>>;
    showStandardPdfViewer: Readonly<Ref<boolean>>;
}

export function shouldShowDjvuConversionBanner(
    presentation: IDjvuConversionBannerPresentation,
) {
    return presentation.conversionUiAvailable
        && presentation.documentOpenReady
        && presentation.showDjvuSource
        && presentation.initialDocumentVisualReady
        && presentation.showDjvuBanner;
}

export const useDocumentWorkspaceViewerPresentation = (
    options: IUseDocumentWorkspaceViewerPresentationOptions,
) => {
    const activeDriverCanPresentDocument = computed(() => (
        options.activeViewerCapabilities.value?.closeableDocument === true
    ));
    const showWorkspaceViewerDocument = computed(() => (
        activeDriverCanPresentDocument.value
        && (
            options.showStandardPdfViewer.value
            || options.showNativePdfViewer.value
            || options.showDjvuSource.value
        )
    ));
    const showDjvuConversionUi = computed(() => (
        options.canUseDjvu
        && (
            options.activeViewerCapabilities.value?.conversionBanner === true
            || options.activeViewerCapabilities.value?.conversionDialog === true
            || options.pendingDjvuDocumentOpen.value
            || Boolean(options.djvuOpeningPath.value)
            || options.conversionState.value.isConverting
        )
    ));
    const showDjvuConversionBanner = computed(() => shouldShowDjvuConversionBanner({
        conversionUiAvailable: showDjvuConversionUi.value,
        documentOpenReady: options.documentOpenReady.value,
        initialDocumentVisualReady: options.initialDocumentVisualReady.value,
        showDjvuBanner: options.djvuShowBanner.value,
        showDjvuSource: options.showDjvuSource.value,
    }));

    return {
        showDjvuConversionBanner,
        showDjvuConversionUi,
        showWorkspaceViewerDocument,
    };
};
