import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { IPdfPageRasterScheduler } from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
} from '@app/types/annotations';

interface IPdfThumbnailRenderRuntimeSource {
    currentPage: ComputedRef<number>;
    invalidationRequest: ComputedRef<{
        id: number;
        pages: number[];
    } | null | undefined>;
    isActive: ComputedRef<boolean>;
    pdfDocument: ComputedRef<IPdfDocument | null>;
    rasterScheduler: ComputedRef<IPdfPageRasterScheduler | null>;
    totalPages: ComputedRef<number>;
}

interface IPdfThumbnailRenderRuntimeVisuals {
    annotationComments: ComputedRef<readonly IAnnotationCommentSummary[]>;
    annotationSettings: ComputedRef<IAnnotationSettings | null | undefined>;
    hiddenAnnotationIds: ComputedRef<readonly string[]>;
}

interface IPdfThumbnailRenderRuntimeLayout {
    clearThumbnailAspectRatios: () => void;
    shouldPreferVisibleAnchorOverCurrentPage: () => boolean;
    resolveViewportAnchorPage: () => number | null;
    thumbnailAspectRatios: Ref<Map<number, number>>;
    thumbnailLayoutWidth: Ref<number>;
    thumbnailRenderWidth: Ref<number>;
    viewportPages: ComputedRef<number[]>;
    virtualPages: ComputedRef<number[]>;
    updateThumbnailAspectRatio: (page: number, aspectRatio: number | null) => void;
}

interface IPdfThumbnailRenderRuntimeDom {
    getCanvas: (page: number) => HTMLCanvasElement | null;
    resolveVisibleContainer: (reason: string) => HTMLElement | null;
}

interface IPdfThumbnailRenderRuntimeEffects {
    cancelActivePaneRefresh: () => void;
    measureThumbnailHeight: () => void | Promise<void>;
    onSourceCycleStarted: () => void;
    refreshVisibleThumbnailPane: (reason: string) => void | Promise<void>;
    resetMeasurementState: () => void;
    scheduleActivePaneRefresh: (reason: string) => void;
}

export interface IUsePdfThumbnailRenderRuntimeOptions {
    dom: IPdfThumbnailRenderRuntimeDom;
    effects: IPdfThumbnailRenderRuntimeEffects;
    layout: IPdfThumbnailRenderRuntimeLayout;
    source: IPdfThumbnailRenderRuntimeSource;
    visuals: IPdfThumbnailRenderRuntimeVisuals;
}
