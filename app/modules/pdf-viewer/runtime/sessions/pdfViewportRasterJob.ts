import type { IPdfRasterDemand } from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import type {
    IPdfLayerRenderResult, IRenderVisiblePagesOptions,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type { usePdfCanvasRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer';
import type { TPdfViewRotation } from '@contracts/shared';

export type TPdfPageRasterState = 'current' | 'absent' | 'in-flight' | 'stale-scale' | 'failed';

export interface IPdfViewportRasterJob {
    demand: IPdfRasterDemand;
    /** The render key without its scale. */
    rasterIdentity: string;
    rasterState: TPdfPageRasterState;
    renderOptions: IRenderVisiblePagesOptions;
    targetOutputScale: number;
    targetScale: number;
    targetViewRotation: TPdfViewRotation;
}

export interface IViewportRasterJob extends IPdfViewportRasterJob {readonly requestId: number}
export interface IPreparedViewportRaster {
    job: IViewportRasterJob;
    container: HTMLElement;
    canvasHost: HTMLDivElement;
    signal: AbortSignal;
    render: NonNullable<Awaited<ReturnType<ReturnType<typeof usePdfCanvasRenderer>['prepareCanvasRender']>>>;
    /** The committed raster whose canvas `render` shares until it commits. */
    reusedRender?: IPdfLayerRenderResult | undefined;
}
