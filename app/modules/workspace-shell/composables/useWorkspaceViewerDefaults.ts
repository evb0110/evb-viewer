import type { Ref } from 'vue';
import { ZOOM } from '@app/constants/pdfLayout';
import { clampPdfManualZoom } from '@app/modules/pdf-viewer/public';
import type { TPdfSource } from '@app/types/pdfUi';
import type {
    ISettingsData,
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
import type { IAnnotationSettings } from '@app/types/annotations';

interface IUseWorkspaceViewerDefaultsOptions {
    appSettings: Ref<ISettingsData>;
    annotationSettings: Ref<IAnnotationSettings>;
    viewMode: Ref<TPdfViewMode>;
    continuousScroll: Ref<boolean>;
    fitMode: Ref<TFitMode>;
    zoom: Ref<number>;
    effectiveZoom: Ref<number>;
    zoomMode: Ref<TZoomMode>;
    pdfSrc: Ref<TPdfSource | null>;
    documentSourceKey?: Ref<unknown>;
    preserveInitialStateForFirstSource?: boolean | undefined;
}

export const useWorkspaceViewerDefaults = (options: IUseWorkspaceViewerDefaultsOptions) => {
    function clampWorkspaceZoomLevel(level: number) {
        return clampPdfManualZoom(level);
    }

    function resolveDisplayZoom() {
        if (Number.isFinite(options.effectiveZoom.value) && options.effectiveZoom.value > 0) {
            return options.effectiveZoom.value;
        }
        return clampWorkspaceZoomLevel(options.zoom.value);
    }

    function setCustomZoomFromDisplay(displayZoom: number) {
        const targetDisplayZoom = clampWorkspaceZoomLevel(displayZoom);
        options.zoom.value = targetDisplayZoom;
        options.effectiveZoom.value = targetDisplayZoom;
        options.zoomMode.value = 'custom';
    }

    function applyWorkspaceViewerDefaults() {
        const defaultColor = options.appSettings.value.defaultAnnotationColor;
        options.annotationSettings.value = {
            ...options.annotationSettings.value,
            highlightColor: defaultColor,
            underlineColor: defaultColor,
            strikethroughColor: defaultColor,
            squigglyColor: defaultColor,
            inkColor: defaultColor,
            shapeColor: defaultColor,
        };

        options.viewMode.value = options.appSettings.value.defaultViewMode;
        options.continuousScroll.value = options.appSettings.value.defaultContinuousScroll;

        if (options.appSettings.value.defaultZoomPreset === 'fit-width') {
            options.fitMode.value = 'width';
            options.zoom.value = 1;
            options.effectiveZoom.value = 1;
            options.zoomMode.value = 'fit-width';
            return;
        }

        if (options.appSettings.value.defaultZoomPreset === 'fit-height') {
            options.fitMode.value = 'height';
            options.zoom.value = 1;
            options.effectiveZoom.value = 1;
            options.zoomMode.value = 'fit-height';
            return;
        }

        setCustomZoomFromDisplay(Number(options.appSettings.value.defaultZoomPreset) / 100);
    }

    const defaultsSourceKey = computed(() => options.documentSourceKey?.value ?? options.pdfSrc.value);
    let shouldPreserveInitialState = options.preserveInitialStateForFirstSource === true
        || defaultsSourceKey.value !== null;

    watch(defaultsSourceKey, (sourceKey) => {
        if (shouldPreserveInitialState) {
            if (sourceKey !== null) {
                shouldPreserveInitialState = false;
            }
            return;
        }
        applyWorkspaceViewerDefaults();
    }, {immediate: true});

    return {
        handleZoomIn: () => setCustomZoomFromDisplay(resolveDisplayZoom() + ZOOM.STEP),
        handleZoomOut: () => {
            const displayZoom = resolveDisplayZoom();
            if (displayZoom > ZOOM.MIN) {
                setCustomZoomFromDisplay(displayZoom - ZOOM.STEP);
            }
        },
        handleActualSize: () => setCustomZoomFromDisplay(1),
    };
};
