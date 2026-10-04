import type { Ref } from 'vue';
import { ZOOM } from '@app/constants/pdfLayout';
import { clampPdfManualZoom } from '@app/modules/pdf-viewer/public';
import type { TPdfSource } from '@app/types/pdfUi';
import type {
    ISettingsData,
    TFitMode,
    TPdfViewMode,
    TPdfViewRotation,
    TZoomMode,
} from '@contracts/shared';
import type { IAnnotationSettings } from '@app/types/annotations';
import type { IWorkspaceCheckpointTab } from '@contracts/workspaceCheckpoint';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';

type TSavedView = Pick<IWorkspaceCheckpointTab, 'zoom' | 'zoomMode' | 'continuousScroll' | 'viewMode' | 'viewRotation'>;

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
    /** The view's viewer, told when the reader zooms, as a scroll tells it. */
    documentViewerRef?: Ref<Pick<IDocumentViewerExpose, 'observeReaderCommand'> | null>;
    viewRotation?: Ref<TPdfViewRotation>;
}

export const useWorkspaceViewerDefaults = (options: IUseWorkspaceViewerDefaultsOptions) => {
    function clampWorkspaceZoomLevel(level: number) {
        return clampPdfManualZoom(level);
    }

    // A custom zoom is the reader's requested display value; a fit mode's
    // display value is the scale the viewer computed for it.
    function resolveDisplayZoom() {
        if (options.zoomMode.value === 'custom') {
            return clampWorkspaceZoomLevel(options.zoom.value);
        }
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

    // The admitted source a seeded view was restored for: when that source is
    // shown, its view stands in for its defaults, through any reset between.
    // Any other shown source takes its defaults and ends the claim.
    let keptViewSource: unknown = null;

    watch(defaultsSourceKey, (sourceKey) => {
        const keepsView = shouldPreserveInitialState || (keptViewSource !== null && (sourceKey === null || sourceKey === keptViewSource));
        if (sourceKey !== null) {
            shouldPreserveInitialState = false;
            keptViewSource = null;
        }
        if (!keepsView) {
            applyWorkspaceViewerDefaults();
        }
    }, {immediate: true});

    // A saved view (a checkpoint, a moved tab, a reading seed) set as state;
    // a null setting keeps the current one.
    function applyView(state: TSavedView) {
        options.continuousScroll.value = state.continuousScroll ?? options.continuousScroll.value;
        options.viewMode.value = state.viewMode ?? options.viewMode.value;
        if (options.viewRotation && state.viewRotation != null) {
            options.viewRotation.value = state.viewRotation;
        }
        if (state.zoomMode === 'fit-width' || state.zoomMode === 'fit-height') {
            options.zoom.value = 1;
            options.fitMode.value = state.zoomMode === 'fit-height' ? 'height' : 'width';
            options.zoomMode.value = state.zoomMode;
        } else if (state.zoom !== null) {
            setCustomZoomFromDisplay(state.zoom);
        }
    }

    // The reader's zoom commands (toolbar, menu, keyboard) move the view;
    // defaults and restored views set the zoom without being a move.
    function zoomAsReader(displayZoom: number) {
        options.documentViewerRef?.value?.observeReaderCommand?.();
        setCustomZoomFromDisplay(displayZoom);
    }

    return {
        handleZoomIn: () => zoomAsReader(resolveDisplayZoom() + ZOOM.STEP),
        handleZoomOut: () => {
            const displayZoom = resolveDisplayZoom();
            if (displayZoom > ZOOM.MIN) {
                zoomAsReader(displayZoom - ZOOM.STEP);
            }
        },
        handleActualSize: () => zoomAsReader(1),
        setCustomZoomFromDisplay,
        applyView,
        /**
         * Sets an open's admitted reading seed for the source it is about to
         * show, where that source's defaults would go when it is shown. Being
         * that document's own view, all of it applies. Returns the withdrawal
         * for when the open ends; a later open's seed stays.
         */
        seedViewForSource: (state: TSavedView, source: unknown) => {
            keptViewSource = source;
            applyView(state);
            return () => {
                if (keptViewSource === source) {
                    keptViewSource = null;
                }
            };
        },
    };
};
