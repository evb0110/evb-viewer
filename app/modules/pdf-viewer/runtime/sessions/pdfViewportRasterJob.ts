import type { IPdfRasterDemand } from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
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
