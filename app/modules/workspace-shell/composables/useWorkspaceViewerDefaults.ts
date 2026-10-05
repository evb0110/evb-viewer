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

        const preset = options.appSettings.value.defaultZoomPreset;
        if (preset === 'fit-width' || preset === 'fit-height') {
            setFitMode(preset);
            return;
        }
        setCustomZoomFromDisplay(Number(preset) / 100);
    }

    // A fit mode's scale is the viewer's to measure; until it does, the
    // neutral scale stands in, so a zoom command does not start from the
    // scale of the view it replaced.
    function setFitMode(zoomMode: 'fit-width' | 'fit-height') {
        options.fitMode.value = zoomMode === 'fit-height' ? 'height' : 'width';
        options.zoom.value = 1;
        options.effectiveZoom.value = 1;
        options.zoomMode.value = zoomMode;
    }

    const defaultsSourceKey = computed(() => options.documentSourceKey?.value ?? options.pdfSrc.value);
    let shouldPreserveInitialState = options.preserveInitialStateForFirstSource === true
        || defaultsSourceKey.value !== null;

    // An open's admitted reading seed, kept for the source it admitted: when
    // that source is shown, its view is set where the source's defaults would
    // go, through any reset between. Until then nothing shown changes, so a
    // document still on screen keeps its own view. Any other shown source
    // takes its defaults and ends the claim.
    let seededView: {
        source: unknown;
        view: TSavedView;
    } | null = null;

    watch(defaultsSourceKey, (sourceKey) => {
        const seed = seededView;
        const keepsView = shouldPreserveInitialState || (seed !== null && sourceKey === null);
        if (sourceKey !== null) {
            shouldPreserveInitialState = false;
            seededView = null;
        }
        if (seed && sourceKey !== null && sourceKey === seed.source) {
            applyView(seed.view);
        } else if (!keepsView) {
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
            setFitMode(state.zoomMode);
        } else if (state.zoom !== null || state.zoomMode === 'custom') {
            // A custom mode saved without its scale keeps the scale now shown.
            setCustomZoomFromDisplay(state.zoom ?? resolveDisplayZoom());
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
         * Keeps an open's admitted reading seed for the source it is about to
         * show. Being that document's own view, all of it applies when it is
         * shown. Returns the withdrawal for when the open ends: an unshown seed
         * is dropped; a later open's seed stays.
         */
        seedViewForSource: (view: TSavedView, source: unknown) => {
            const seed = {
                source,
                view,
            };
            seededView = seed;
            return () => {
                if (seededView === seed) {
                    seededView = null;
                }
            };
        },
    };
};
