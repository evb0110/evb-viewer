import type { Ref } from 'vue';
import type { IZoomVirtualizationFreeze } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerVirtualization';

export interface IViewerStateForLog {
    scrollTop: number;
    scrollLeft: number;
    clientWidth: number;
    clientHeight: number;
    scrollWidth: number;
    scrollHeight: number;
}

export interface IZoomVirtualizationLogOptions {
    currentPage: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    virtualizedContinuousMode: Ref<boolean>;
    virtualWindowStart: Ref<number>;
    virtualWindowEnd: Ref<number>;
    zoomVirtualizationFreeze: Ref<IZoomVirtualizationFreeze | null>;
    summarizeViewerStateForLog: () => IViewerStateForLog | null;
}
