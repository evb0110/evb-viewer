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
        expectedDocumentRevision?: string;
        rotationOnly?: boolean;
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
    getThumbnailAspectRatio: (page: number) => number;
    /** Presented page rotation from the document session's geometry, when known. */
    getPageRotation: (page: number) => number | undefined;
    resetThumbnailLayout: () => void;
    shouldPreferVisibleAnchorOverCurrentPage: () => boolean;
    resolveViewportAnchorPage: () => number | null;
    thumbnailLayoutWidth: Ref<number>;
    thumbnailRenderWidth: Ref<number>;
    viewportPages: ComputedRef<number[]>;
    virtualPages: ComputedRef<number[]>;
}

interface IPdfThumbnailRenderRuntimeDom {
    getCanvas: (page: number) => HTMLCanvasElement | null;
    resolveVisibleContainer: (reason: string) => HTMLElement | null;
}

/**
 * A forced refresh reveals the current page even while the rail would normally
 * leave a manually scrolled viewport alone. Reactivating the pane is such a
 * moment: the user asked to see the sidebar again, not the spot they left.
 */
export interface IPdfThumbnailPaneRefreshOptions {force?: boolean;}

interface IPdfThumbnailRenderRuntimeEffects {
    cancelActivePaneRefresh: () => void;
    measureThumbnailHeight: () => void | Promise<void>;
    onSourceCycleStarted: () => void;
    refreshVisibleThumbnailPane: (
        reason: string,
        options?: IPdfThumbnailPaneRefreshOptions,
    ) => void | Promise<void>;
    resetMeasurementState: () => void;
    scheduleActivePaneRefresh: (
        reason: string,
        options?: IPdfThumbnailPaneRefreshOptions,
    ) => void;
}

export interface IUsePdfThumbnailRenderRuntimeOptions {
    dom: IPdfThumbnailRenderRuntimeDom;
    effects: IPdfThumbnailRenderRuntimeEffects;
    layout: IPdfThumbnailRenderRuntimeLayout;
    source: IPdfThumbnailRenderRuntimeSource;
    visuals: IPdfThumbnailRenderRuntimeVisuals;
}
